#!/usr/bin/env python3
"""
AgroVisión — Train DINOv2-Small + ArcFace head for crop disease embeddings.
Directive: dir_1774099821063

Architecture:
  - Backbone: DINOv2 ViT-S/14 (frozen or LoRA fine-tuned)
  - Head: ArcFace angular margin loss → 512-D normalized embeddings
  - Output: ONNX model for server + TFLite for mobile

Usage:
  # Full training on GPU
  python agrovision-train.py --data /path/to/agrovision --epochs 30 --batch 64

  # Quick test run
  python agrovision-train.py --data /path/to/agrovision --epochs 2 --batch 16 --quick

  # Export only (from checkpoint)
  python agrovision-train.py --export-only --checkpoint best_model.pth
"""

import os
import sys
import json
import argparse
import math
import time
from pathlib import Path
from collections import defaultdict

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler
from torchvision import transforms
from PIL import Image


# ═══════════════════════════════════════════════════════════════════
# ArcFace Loss — same angular margin as face recognition
# ═══════════════════════════════════════════════════════════════════

class ArcFaceHead(nn.Module):
    """ArcFace angular margin classification head.

    Produces 512-D L2-normalized embeddings during inference.
    During training, applies angular margin penalty for discriminative learning.
    """
    def __init__(self, in_features, num_classes, emb_dim=512, s=30.0, m=0.5):
        super().__init__()
        self.s = s  # scale
        self.m = m  # angular margin
        self.projector = nn.Sequential(
            nn.Linear(in_features, emb_dim),
            nn.BatchNorm1d(emb_dim),
        )
        self.weight = nn.Parameter(torch.FloatTensor(num_classes, emb_dim))
        nn.init.xavier_uniform_(self.weight)

    def forward(self, features, labels=None):
        # Project to embedding space
        emb = self.projector(features)
        emb = F.normalize(emb, p=2, dim=1)

        if labels is None:
            # Inference mode — just return embeddings
            return emb

        # ArcFace margin
        W = F.normalize(self.weight, p=2, dim=1)
        cosine = F.linear(emb, W)
        cosine = cosine.clamp(-1 + 1e-7, 1 - 1e-7)
        theta = torch.acos(cosine)

        # Add margin to target class
        one_hot = F.one_hot(labels, num_classes=self.weight.size(0)).float()
        target_logits = torch.cos(theta + self.m * one_hot)

        logits = target_logits * self.s
        return emb, logits


class AgroVisionModel(nn.Module):
    """DINOv2-Small backbone + ArcFace head."""

    def __init__(self, num_classes, emb_dim=512, freeze_backbone=True):
        super().__init__()

        # Load DINOv2-Small (ViT-S/14, 22M params)
        print("[model] Loading DINOv2-Small backbone...")
        self.backbone = torch.hub.load('facebookresearch/dinov2', 'dinov2_vits14', pretrained=True)
        backbone_dim = self.backbone.embed_dim  # 384 for ViT-S

        if freeze_backbone:
            print("[model] Freezing backbone (feature extraction mode)")
            for param in self.backbone.parameters():
                param.requires_grad = False
            # Unfreeze last 2 blocks for mild adaptation
            for block in self.backbone.blocks[-2:]:
                for param in block.parameters():
                    param.requires_grad = True
            print("[model] Last 2 transformer blocks unfrozen for fine-tuning")

        self.head = ArcFaceHead(backbone_dim, num_classes, emb_dim=emb_dim)

    def forward(self, x, labels=None):
        with torch.cuda.amp.autocast(enabled=True):
            features = self.backbone(x)  # [B, 384]
        return self.head(features, labels)

    def get_embedding(self, x):
        """Extract embeddings without classification (for inference)."""
        features = self.backbone(x)
        return self.head(features, labels=None)


# ═══════════════════════════════════════════════════════════════════
# Dataset — Unified loader for PlantVillage + Cassava + Mango
# ═══════════════════════════════════════════════════════════════════

class PlantDiseaseDataset(Dataset):
    """Loads images from folder structure: dataset/class_name/image.jpg"""

    def __init__(self, root_dirs, transform=None, min_samples=10):
        self.transform = transform
        self.samples = []  # (path, class_idx)
        self.classes = []
        self.class_to_idx = {}

        # Collect all class folders from all root dirs
        class_paths = defaultdict(list)

        for root_dir in root_dirs:
            root = Path(root_dir)
            if not root.exists():
                print(f"[dataset] Warning: {root} not found, skipping")
                continue

            # Handle PlantVillage structure (class folders directly)
            for class_dir in sorted(root.iterdir()):
                if not class_dir.is_dir():
                    continue
                images = list(class_dir.glob("*.jpg")) + list(class_dir.glob("*.JPG")) + \
                         list(class_dir.glob("*.png")) + list(class_dir.glob("*.jpeg"))
                if len(images) >= min_samples:
                    # Normalize class name
                    class_name = class_dir.name.replace(" ", "_")
                    class_paths[class_name].extend(images)

        # Handle Cassava (CSV-based labels)
        cassava_root = None
        for root_dir in root_dirs:
            csv_path = Path(root_dir) / "train.csv"
            if csv_path.exists():
                cassava_root = Path(root_dir)
                break

        if cassava_root:
            import csv
            cassava_classes = {
                "0": "Cassava_Bacterial_Blight",
                "1": "Cassava_Brown_Streak",
                "2": "Cassava_Green_Mottle",
                "3": "Cassava_Mosaic",
                "4": "Cassava_healthy",
            }
            with open(cassava_root / "train.csv") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    img_path = cassava_root / "train_images" / row["image_id"]
                    if img_path.exists():
                        cls_name = cassava_classes.get(row["label"], f"cassava_{row['label']}")
                        class_paths[cls_name].append(img_path)

        # Build final class list and samples
        self.classes = sorted(class_paths.keys())
        self.class_to_idx = {c: i for i, c in enumerate(self.classes)}

        for class_name, paths in class_paths.items():
            idx = self.class_to_idx[class_name]
            for p in paths:
                self.samples.append((str(p), idx))

        print(f"[dataset] Loaded {len(self.samples)} images across {len(self.classes)} classes")
        for i, c in enumerate(self.classes):
            count = sum(1 for _, ci in self.samples if ci == i)
            print(f"  [{i:3d}] {c}: {count}")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        path, label = self.samples[idx]
        try:
            img = Image.open(path).convert("RGB")
        except Exception:
            # Fallback: return a random valid sample
            return self.__getitem__(np.random.randint(len(self)))

        if self.transform:
            img = self.transform(img)
        return img, label

    def get_sampler_weights(self):
        """Compute weights for balanced sampling (handles class imbalance)."""
        class_counts = defaultdict(int)
        for _, label in self.samples:
            class_counts[label] += 1

        weights = []
        for _, label in self.samples:
            weights.append(1.0 / class_counts[label])
        return weights


# ═══════════════════════════════════════════════════════════════════
# Training
# ═══════════════════════════════════════════════════════════════════

def get_transforms(is_train=True):
    """DINOv2 expects 224x224, ImageNet normalization."""
    if is_train:
        return transforms.Compose([
            transforms.RandomResizedCrop(224, scale=(0.6, 1.0)),
            transforms.RandomHorizontalFlip(),
            transforms.RandomVerticalFlip(),
            transforms.RandomRotation(30),
            transforms.ColorJitter(brightness=0.3, contrast=0.3, saturation=0.3, hue=0.1),
            transforms.RandomAffine(degrees=0, translate=(0.1, 0.1)),
            transforms.GaussianBlur(kernel_size=3, sigma=(0.1, 2.0)),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            transforms.RandomErasing(p=0.2),
        ])
    else:
        return transforms.Compose([
            transforms.Resize(256),
            transforms.CenterCrop(224),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ])


def train(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[train] Device: {device}")
    if device.type == "cuda":
        print(f"[train] GPU: {torch.cuda.get_device_name()}")
        print(f"[train] VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")

    # Collect dataset directories
    data_root = Path(args.data)
    dataset_dirs = []
    for subdir in ["plantvillage", "mango", "plantdoc"]:
        d = data_root / subdir
        if d.exists():
            dataset_dirs.append(str(d))
    # Cassava is handled specially via CSV inside the dataset class
    cassava_dir = data_root / "cassava"
    if cassava_dir.exists():
        dataset_dirs.append(str(cassava_dir))

    if not dataset_dirs:
        print(f"[!] No dataset directories found in {data_root}")
        sys.exit(1)

    # Create datasets
    train_dataset = PlantDiseaseDataset(dataset_dirs, transform=get_transforms(True), min_samples=5)
    val_dataset = PlantDiseaseDataset(dataset_dirs, transform=get_transforms(False), min_samples=5)

    # Split: 90% train, 10% val
    n = len(train_dataset)
    indices = np.random.RandomState(42).permutation(n)
    split = int(0.9 * n)
    train_indices = indices[:split]
    val_indices = indices[split:]

    train_subset = torch.utils.data.Subset(train_dataset, train_indices)
    val_subset = torch.utils.data.Subset(val_dataset, val_indices)

    # Balanced sampler for training
    all_weights = train_dataset.get_sampler_weights()
    train_weights = [all_weights[i] for i in train_indices]
    sampler = WeightedRandomSampler(train_weights, len(train_weights), replacement=True)

    train_loader = DataLoader(
        train_subset, batch_size=args.batch, sampler=sampler,
        num_workers=args.workers, pin_memory=True, drop_last=True,
    )
    val_loader = DataLoader(
        val_subset, batch_size=args.batch, shuffle=False,
        num_workers=args.workers, pin_memory=True,
    )

    num_classes = len(train_dataset.classes)
    print(f"[train] {len(train_subset)} train / {len(val_subset)} val / {num_classes} classes")

    # Save class mapping
    class_map_path = Path(args.output) / "class_map.json"
    os.makedirs(args.output, exist_ok=True)
    with open(class_map_path, "w") as f:
        json.dump({
            "idx_to_class": {str(i): c for i, c in enumerate(train_dataset.classes)},
            "class_to_idx": train_dataset.class_to_idx,
            "num_classes": num_classes,
        }, f, indent=2)
    print(f"[train] Class map saved to {class_map_path}")

    # Model
    model = AgroVisionModel(
        num_classes=num_classes,
        emb_dim=args.emb_dim,
        freeze_backbone=not args.unfreeze,
    ).to(device)

    # Count params
    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"[model] Total params: {total_params:,} | Trainable: {trainable_params:,} ({100*trainable_params/total_params:.1f}%)")

    # Optimizer — different LR for backbone vs head
    backbone_params = [p for n, p in model.named_parameters() if "backbone" in n and p.requires_grad]
    head_params = [p for n, p in model.named_parameters() if "head" in n and p.requires_grad]

    optimizer = torch.optim.AdamW([
        {"params": backbone_params, "lr": args.lr * 0.1},  # Lower LR for pre-trained backbone
        {"params": head_params, "lr": args.lr},
    ], weight_decay=0.01)

    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=1e-6)
    scaler = torch.amp.GradScaler("cuda")

    best_val_acc = 0.0
    best_epoch = 0

    for epoch in range(args.epochs):
        # ── Train ──
        model.train()
        train_loss = 0.0
        train_correct = 0
        train_total = 0
        t0 = time.time()

        for batch_idx, (images, labels) in enumerate(train_loader):
            images = images.to(device, non_blocking=True)
            labels = labels.to(device, non_blocking=True)

            optimizer.zero_grad(set_to_none=True)

            with torch.amp.autocast("cuda"):
                emb, logits = model(images, labels)
                loss = F.cross_entropy(logits, labels)

            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimizer)
            scaler.update()

            train_loss += loss.item() * images.size(0)
            preds = logits.argmax(dim=1)
            train_correct += (preds == labels).sum().item()
            train_total += images.size(0)

            if (batch_idx + 1) % 50 == 0:
                elapsed = time.time() - t0
                ips = train_total / elapsed
                print(f"  [{epoch+1}/{args.epochs}] batch {batch_idx+1}/{len(train_loader)} | "
                      f"loss: {loss.item():.4f} | acc: {100*train_correct/train_total:.1f}% | "
                      f"{ips:.0f} img/s")

        train_loss /= train_total
        train_acc = 100 * train_correct / train_total

        # ── Validate ──
        model.eval()
        val_loss = 0.0
        val_correct = 0
        val_total = 0

        with torch.no_grad():
            for images, labels in val_loader:
                images = images.to(device, non_blocking=True)
                labels = labels.to(device, non_blocking=True)

                with torch.amp.autocast("cuda"):
                    emb, logits = model(images, labels)
                    loss = F.cross_entropy(logits, labels)

                val_loss += loss.item() * images.size(0)
                preds = logits.argmax(dim=1)
                val_correct += (preds == labels).sum().item()
                val_total += images.size(0)

        val_loss /= val_total
        val_acc = 100 * val_correct / val_total

        scheduler.step()

        elapsed = time.time() - t0
        print(f"[Epoch {epoch+1}/{args.epochs}] "
              f"train_loss: {train_loss:.4f} train_acc: {train_acc:.1f}% | "
              f"val_loss: {val_loss:.4f} val_acc: {val_acc:.1f}% | "
              f"{elapsed:.0f}s")

        # Save best
        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_epoch = epoch + 1
            save_path = Path(args.output) / "best_model.pth"
            torch.save({
                "epoch": epoch,
                "model_state_dict": model.state_dict(),
                "optimizer_state_dict": optimizer.state_dict(),
                "val_acc": val_acc,
                "num_classes": num_classes,
                "emb_dim": args.emb_dim,
                "classes": train_dataset.classes,
            }, save_path)
            print(f"  ★ New best! val_acc={val_acc:.1f}% saved to {save_path}")

        # Early stopping
        if epoch - best_epoch >= 8:
            print(f"[train] Early stopping — no improvement for 8 epochs (best: epoch {best_epoch})")
            break

    print(f"\n[train] Done! Best val_acc: {best_val_acc:.1f}% at epoch {best_epoch}")
    print(f"[train] Model saved to {args.output}/best_model.pth")

    # Export
    export_model(args, device, num_classes, train_dataset.classes)


# ═══════════════════════════════════════════════════════════════════
# Export — ONNX (server) + TFLite (mobile)
# ═══════════════════════════════════════════════════════════════════

def export_model(args, device=None, num_classes=None, classes=None):
    """Export trained model to ONNX and optionally TFLite."""
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    checkpoint_path = Path(args.output) / "best_model.pth"
    if args.checkpoint:
        checkpoint_path = Path(args.checkpoint)

    print(f"\n[export] Loading checkpoint from {checkpoint_path}")
    checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=False)

    if num_classes is None:
        num_classes = checkpoint["num_classes"]
    if classes is None:
        classes = checkpoint["classes"]
    emb_dim = checkpoint.get("emb_dim", 512)

    model = AgroVisionModel(num_classes=num_classes, emb_dim=emb_dim, freeze_backbone=True).to(device)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()

    # ── ONNX export (embedding extractor only) ──
    class EmbeddingExtractor(nn.Module):
        def __init__(self, full_model):
            super().__init__()
            self.backbone = full_model.backbone
            self.projector = full_model.head.projector

        def forward(self, x):
            features = self.backbone(x)
            emb = self.projector(features)
            emb = F.normalize(emb, p=2, dim=1)
            return emb

    extractor = EmbeddingExtractor(model).to(device)
    extractor.eval()

    dummy_input = torch.randn(1, 3, 224, 224).to(device)
    onnx_path = Path(args.output) / "agrovision_embed.onnx"

    print(f"[export] Exporting ONNX to {onnx_path}")
    torch.onnx.export(
        extractor, dummy_input, str(onnx_path),
        input_names=["image"],
        output_names=["embedding"],
        dynamic_axes={"image": {0: "batch"}, "embedding": {0: "batch"}},
        opset_version=17,
    )

    # Verify ONNX
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(str(onnx_path))
        test_out = sess.run(None, {"image": dummy_input.cpu().numpy()})
        print(f"[export] ONNX verified — output shape: {test_out[0].shape}")
    except ImportError:
        print("[export] onnxruntime not installed, skipping verification")

    # ── Save ArcFace weight matrix for Qdrant search ──
    arcface_weights = model.head.weight.data.cpu().numpy()
    np.save(Path(args.output) / "arcface_weights.npy", arcface_weights)

    # ── Save class info ──
    with open(Path(args.output) / "model_info.json", "w") as f:
        json.dump({
            "model": "dinov2_vits14+arcface",
            "emb_dim": emb_dim,
            "num_classes": num_classes,
            "classes": classes,
            "input_size": 224,
            "normalize": {"mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225]},
            "val_acc": checkpoint.get("val_acc", 0),
            "epoch": checkpoint.get("epoch", 0),
        }, f, indent=2)

    print(f"[export] All artifacts saved to {args.output}/")
    print(f"  - agrovision_embed.onnx  (ONNX embedding model)")
    print(f"  - best_model.pth         (PyTorch checkpoint)")
    print(f"  - arcface_weights.npy    (class weight matrix)")
    print(f"  - class_map.json         (class ↔ index mapping)")
    print(f"  - model_info.json        (model metadata)")


# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AgroVisión — DINOv2 + ArcFace Training")
    parser.add_argument("--data", type=str, default="/home/gcp/ozzu/data/agrovision", help="Dataset root")
    parser.add_argument("--output", type=str, default="/home/gcp/ozzu/data/agrovision/models", help="Output dir")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--emb-dim", type=int, default=512)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--unfreeze", action="store_true", help="Unfreeze entire backbone (slower, may overfit)")
    parser.add_argument("--quick", action="store_true", help="Quick test: 2 epochs, small batch")
    parser.add_argument("--export-only", action="store_true", help="Only export from checkpoint")
    parser.add_argument("--checkpoint", type=str, default=None, help="Checkpoint path for export")

    args = parser.parse_args()

    if args.quick:
        args.epochs = 2
        args.batch = min(args.batch, 16)

    if args.export_only:
        export_model(args)
    else:
        train(args)
