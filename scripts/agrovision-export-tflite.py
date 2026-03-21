#!/usr/bin/env python3
"""
AgroVisión — Export trained model to TFLite classifier for on-device inference.
Directive: dir_1774111492905

Exports DINOv2-Small + ArcFace as a TFLite classifier that outputs
disease class probabilities. Fully offline, no server needed.

Usage:
  python agrovision-export-tflite.py \
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


class AgroVisionClassifier(nn.Module):
    """Wraps trained model as a pure classifier (softmax output).

    Input: uint8 RGB image [1, 224, 224, 3] in NHWC format (0-255)
    Output: class probabilities [1, 46]

    Preprocessing is embedded in the model:
    - uint8 → float32
    - Scale to 0-1
    - ImageNet normalization
    - NHWC → NCHW transpose
    """

    def __init__(self, model):
        super().__init__()
        self.backbone = model.backbone
        self.projector = model.head.projector
        self.class_weights = F.normalize(model.head.weight.data, p=2, dim=1)
        self.register_buffer('mean', torch.tensor([0.485, 0.456, 0.406]).reshape(1, 1, 1, 3))
        self.register_buffer('std', torch.tensor([0.229, 0.224, 0.225]).reshape(1, 1, 1, 3))

    def forward(self, x):
        # x: [B, 224, 224, 3] float32 (from uint8 0-255)
        x = x / 255.0
        x = (x - self.mean) / self.std
        x = x.permute(0, 3, 1, 2)  # NHWC → NCHW
        features = self.backbone(x)
        emb = self.projector(features)
        emb = F.normalize(emb, p=2, dim=1)
        logits = F.linear(emb, self.class_weights) * 30.0
        probs = F.softmax(logits, dim=1)
        return probs


def main(args):
    print("[export] Loading checkpoint...")
    ckpt = torch.load(args.checkpoint, map_location='cpu')
    num_classes = ckpt['num_classes']
    emb_dim = ckpt['emb_dim']
    classes = ckpt['classes']
    val_acc = ckpt['val_acc']

    print(f"[export] Model: {num_classes} classes, {emb_dim}-D embeddings, val_acc={val_acc:.1f}%")
    print(f"[export] Classes: {classes}")

    # Rebuild model and load weights
    model = AgroVisionModel(num_classes=num_classes, emb_dim=emb_dim, freeze_backbone=True)
    model.load_state_dict(ckpt['model_state_dict'])
    model.eval()

    # Wrap as classifier
    classifier = AgroVisionClassifier(model)
    classifier.eval()

    # Test with dummy input — NHWC uint8-scale float
    dummy = torch.randint(0, 256, (1, 224, 224, 3), dtype=torch.float32)
    with torch.no_grad():
        probs = classifier(dummy)
    print(f"[export] Test output shape: {probs.shape}, sum={probs.sum().item():.4f}")
    print(f"[export] Top prediction: {classes[probs.argmax().item()]} ({probs.max().item():.4f})")

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Export directly to TFLite via ai_edge_torch
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
    print(f"[export] TFLite saved: {tflite_path.stat().st_size / 1e6:.1f}MB")

    # Step 3: Save class metadata for the app
    metadata = {
        "num_classes": num_classes,
        "classes": classes,
        "input_size": 224,
        "model_accuracy": round(val_acc, 2),
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
    if tflite_path.exists():
        print(f"  TFLite:   {tflite_path}")
    print(f"  Metadata: {meta_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AgroVisión — Export TFLite classifier")
    parser.add_argument("--checkpoint", required=True, help="Path to best_model.pth")
    parser.add_argument("--output", default="/home/gcp/ozzu/data/agrovision/models/tflite")
    args = parser.parse_args()
    main(args)
