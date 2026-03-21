#!/usr/bin/env python3
"""
AgroVisión — Export TFLite with attention heatmap for AR dot positioning.
Directive: dir_1774129543992

Exports DINOv2-Small + ArcFace as a TFLite model that outputs:
  1. Class probabilities [1, 46]
  2. Attention heatmap [1, 16, 16] — CLS token attention over patches

The attention map shows WHERE the model is looking, so the app can
position the annotation dot on the actual disease location.

Usage:
  python agrovision-export-tflite-attn.py \
    --checkpoint /path/to/best_model.pth \
    --output /path/to/output/
"""

import os
import sys
import json
import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class ArcFaceHead(nn.Module):
    def __init__(self, in_features, num_classes, emb_dim=512, s=30.0, m=0.5):
        super().__init__()
        self.s = s
        self.m = m
        self.projector = nn.Sequential(
            nn.Linear(in_features, emb_dim),
            nn.BatchNorm1d(emb_dim),
        )
        self.weight = nn.Parameter(torch.FloatTensor(num_classes, emb_dim))
        nn.init.xavier_uniform_(self.weight)

    def forward(self, features, labels=None):
        emb = self.projector(features)
        emb = F.normalize(emb, p=2, dim=1)
        if labels is None:
            return emb
        W = F.normalize(self.weight, p=2, dim=1)
        cosine = F.linear(emb, W)
        cosine = cosine.clamp(-1 + 1e-7, 1 - 1e-7)
        theta = torch.acos(cosine)
        one_hot = F.one_hot(labels, num_classes=self.weight.size(0)).float()
        target_logits = torch.cos(theta + self.m * one_hot)
        logits = target_logits * self.s
        return emb, logits


class AgroVisionModel(nn.Module):
    def __init__(self, num_classes, emb_dim=512, freeze_backbone=True):
        super().__init__()
        self.backbone = torch.hub.load('facebookresearch/dinov2', 'dinov2_vits14', pretrained=True)
        backbone_dim = self.backbone.embed_dim
        if freeze_backbone:
            for param in self.backbone.parameters():
                param.requires_grad = False
            for block in self.backbone.blocks[-2:]:
                for param in block.parameters():
                    param.requires_grad = True
        self.head = ArcFaceHead(backbone_dim, num_classes, emb_dim)

    def forward(self, x, labels=None):
        features = self.backbone(x)
        return self.head(features, labels)


class AgroVisionClassifierWithAttn(nn.Module):
    """Classifier that also outputs DINOv2 attention heatmap.

    Input:  [1, 224, 224, 3] float32 (0-255 range, NHWC)
    Output: (probs [1, 46], attn_map [1, 16, 16])

    The attention map is the average CLS attention from the last
    transformer block, reshaped to the patch grid (16x16 for 224px/14px).
    """

    def __init__(self, model):
        super().__init__()
        self.backbone = model.backbone
        self.projector = model.head.projector
        self.class_weights = F.normalize(model.head.weight.data, p=2, dim=1)
        self.register_buffer('mean', torch.tensor([0.485, 0.456, 0.406]).reshape(1, 1, 1, 3))
        self.register_buffer('std', torch.tensor([0.229, 0.224, 0.225]).reshape(1, 1, 1, 3))

        # DINOv2 ViT-S/14: 224/14 = 16 patches per side
        self.patch_grid = 16

    def forward(self, x):
        # x: [B, 224, 224, 3] float32 (0-255)
        x = x / 255.0
        x = (x - self.mean) / self.std
        x = x.permute(0, 3, 1, 2)  # NHWC → NCHW

        # --- Run backbone with attention extraction ---
        # DINOv2's forward_features gives us intermediate access
        # We need to manually run the ViT to capture attention

        # Patch embed
        x = self.backbone.prepare_tokens_with_masks(x)

        # Run all blocks, capture last block's attention
        for i, blk in enumerate(self.backbone.blocks):
            if i == len(self.backbone.blocks) - 1:
                # Last block — extract attention
                attn_map = self._get_block_attention(blk, x)
            x = blk(x)

        x = self.backbone.norm(x)
        features = x[:, 0]  # CLS token

        # Classification
        emb = self.projector(features)
        emb = F.normalize(emb, p=2, dim=1)
        logits = F.linear(emb, self.class_weights) * 30.0
        probs = F.softmax(logits, dim=1)

        # Reshape attention to patch grid
        # attn_map: [B, num_patches] → [B, 16, 16]
        attn_map = attn_map.reshape(-1, self.patch_grid, self.patch_grid)

        return probs, attn_map

    def _get_block_attention(self, blk, x):
        """Extract CLS→patch attention from a ViT block's self-attention."""
        B, N, C = x.shape
        attn = blk.attn

        qkv = attn.qkv(blk.norm1(x))
        qkv = qkv.reshape(B, N, 3, attn.num_heads, C // attn.num_heads)
        qkv = qkv.permute(2, 0, 3, 1, 4)  # [3, B, heads, N, dim]
        q, k, v = qkv[0], qkv[1], qkv[2]

        # Compute attention weights
        scale = (C // attn.num_heads) ** -0.5
        attn_weights = (q @ k.transpose(-2, -1)) * scale
        attn_weights = F.softmax(attn_weights, dim=-1)

        # CLS token attention over patches (exclude CLS→CLS)
        # Shape: [B, heads, N, N] → take CLS row (index 0), skip CLS column
        cls_attn = attn_weights[:, :, 0, 1:]  # [B, heads, num_patches]

        # Average across heads
        cls_attn = cls_attn.mean(dim=1)  # [B, num_patches]

        return cls_attn


def main(args):
    print("[export] Loading checkpoint...")
    ckpt = torch.load(args.checkpoint, map_location='cpu')
    num_classes = ckpt['num_classes']
    emb_dim = ckpt['emb_dim']
    classes = ckpt['classes']
    val_acc = ckpt['val_acc']

    print(f"[export] Model: {num_classes} classes, {emb_dim}-D, val_acc={val_acc:.1f}%")

    # Rebuild model and load weights
    model = AgroVisionModel(num_classes=num_classes, emb_dim=emb_dim, freeze_backbone=True)
    model.load_state_dict(ckpt['model_state_dict'])
    model.eval()

    # Wrap as classifier with attention
    classifier = AgroVisionClassifierWithAttn(model)
    classifier.eval()

    # Test with dummy input
    dummy = torch.randint(0, 256, (1, 224, 224, 3), dtype=torch.float32)
    with torch.no_grad():
        probs, attn = classifier(dummy)
    print(f"[export] Probs shape: {probs.shape}, sum={probs.sum().item():.4f}")
    print(f"[export] Attn shape: {attn.shape}, min={attn.min().item():.4f}, max={attn.max().item():.4f}")
    print(f"[export] Top prediction: {classes[probs.argmax().item()]} ({probs.max().item():.4f})")

    # Show attention peak location
    attn_np = attn[0].numpy()
    peak_y, peak_x = np.unravel_index(attn_np.argmax(), attn_np.shape)
    print(f"[export] Attention peak: ({peak_x}, {peak_y}) in 16x16 grid")

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Export to TFLite
    tflite_path = output_dir / "agrovision_classifier.tflite"
    print(f"[export] Converting to TFLite → {tflite_path}")

    try:
        import litert_torch
        sample = torch.randint(0, 256, (1, 224, 224, 3), dtype=torch.float32)
        edge_model = litert_torch.convert(classifier, (sample,))
        edge_model.export(str(tflite_path))
    except (ImportError, AttributeError):
        import ai_edge_torch
        sample = torch.randint(0, 256, (1, 224, 224, 3), dtype=torch.float32)
        edge_model = ai_edge_torch.convert(classifier, (sample,))
        edge_model.export(str(tflite_path))

    size_mb = tflite_path.stat().st_size / 1e6
    print(f"[export] TFLite saved: {size_mb:.1f}MB")

    # Save metadata
    metadata = {
        "num_classes": num_classes,
        "classes": classes,
        "input_size": 224,
        "model_accuracy": round(val_acc, 2),
        "patch_grid": 16,
        "outputs": ["probabilities", "attention_map"],
        "normalization": {
            "mean": [0.485, 0.456, 0.406],
            "std": [0.229, 0.224, 0.225]
        }
    }
    meta_path = output_dir / "classifier_metadata.json"
    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"[export] Metadata saved: {meta_path}")

    print("\n[done] Export complete!")
    print(f"  TFLite:   {tflite_path} ({size_mb:.1f}MB)")
    print(f"  Outputs:  probs [1,{num_classes}] + attn [1,16,16]")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AgroVisión — Export TFLite with attention")
    parser.add_argument("--checkpoint", default="/home/gcp/ozzu/data/agrovision/models/best_model.pth")
    parser.add_argument("--output", default="/home/gcp/ozzu/data/agrovision/models/tflite")
    args = parser.parse_args()
    main(args)
