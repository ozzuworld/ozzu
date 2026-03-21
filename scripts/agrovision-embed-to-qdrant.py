#!/usr/bin/env python3
"""
AgroVisión — Embed all dataset images into Qdrant plant_diseases collection.
Directive: dir_1774099821063

Uses the trained ONNX model to extract 512-D embeddings from all images,
then batch-inserts them into Qdrant with full metadata (crop, disease, treatment).

Usage:
  python agrovision-embed-to-qdrant.py --model /path/to/agrovision_embed.onnx \
      --data /path/to/agrovision --metadata /path/to/disease_metadata.json

  # With GPU acceleration
  python agrovision-embed-to-qdrant.py --model models/agrovision_embed.onnx --data datasets/ --gpu
"""

import os
import sys
import json
import uuid
import time
import argparse
from pathlib import Path
from collections import defaultdict

import numpy as np
from PIL import Image

QDRANT_COLLECTION = "plant_diseases"
QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
EMBEDDING_DIM = 512
BATCH_SIZE = 2000  # Qdrant max safe batch (>5000 hits 32MB limit)
IMG_SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def preprocess(img_path, size=IMG_SIZE):
    """Load and preprocess image for DINOv2 (224x224, ImageNet normalization)."""
    img = Image.open(img_path).convert("RGB")
    # Resize preserving aspect ratio, then center crop
    w, h = img.size
    scale = size / min(w, h)
    img = img.resize((int(w * scale), int(h * scale)), Image.BILINEAR)
    w, h = img.size
    left = (w - size) // 2
    top = (h - size) // 2
    img = img.crop((left, top, left + size, top + size))

    arr = np.array(img, dtype=np.float32) / 255.0
    arr = (arr - MEAN) / STD
    arr = arr.transpose(2, 0, 1)  # HWC → CHW
    return arr


def collect_images(data_dir, class_map_path=None):
    """Collect all images with their disease class labels."""
    data_root = Path(data_dir)
    images = []  # [(path, class_name, dataset_source)]

    # Load class map if available (maps folder names to canonical disease IDs)
    class_map = {}
    if class_map_path and Path(class_map_path).exists():
        with open(class_map_path) as f:
            cm = json.load(f)
            class_map = cm.get("idx_to_class", {})

    for subdir in ["plantvillage", "mango", "plantdoc"]:
        root = data_root / subdir
        if not root.exists():
            continue
        for class_dir in sorted(root.iterdir()):
            if not class_dir.is_dir():
                continue
            class_name = class_dir.name.replace(" ", "_")
            for ext in ["*.jpg", "*.JPG", "*.png", "*.jpeg"]:
                for img_path in class_dir.glob(ext):
                    images.append((str(img_path), class_name, subdir))

    # Cassava (CSV-based)
    cassava_csv = data_root / "cassava" / "train.csv"
    if cassava_csv.exists():
        import csv
        cassava_classes = {
            "0": "Cassava_Bacterial_Blight",
            "1": "Cassava_Brown_Streak",
            "2": "Cassava_Green_Mottle",
            "3": "Cassava_Mosaic",
            "4": "Cassava_healthy",
        }
        with open(cassava_csv) as f:
            reader = csv.DictReader(f)
            for row in reader:
                img_path = data_root / "cassava" / "train_images" / row["image_id"]
                if img_path.exists():
                    cls = cassava_classes.get(row["label"], f"cassava_{row['label']}")
                    images.append((str(img_path), cls, "cassava"))

    print(f"[collect] Found {len(images)} images")
    class_counts = defaultdict(int)
    for _, c, _ in images:
        class_counts[c] += 1
    for c in sorted(class_counts):
        print(f"  {c}: {class_counts[c]}")

    return images


def setup_qdrant(qdrant_url):
    """Create plant_diseases collection if it doesn't exist."""
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams

    client = QdrantClient(url=qdrant_url, timeout=30)
    collections = [c.name for c in client.get_collections().collections]

    if QDRANT_COLLECTION not in collections:
        client.create_collection(
            collection_name=QDRANT_COLLECTION,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
        print(f"[qdrant] Created collection '{QDRANT_COLLECTION}'")
    else:
        info = client.get_collection(QDRANT_COLLECTION)
        print(f"[qdrant] Collection '{QDRANT_COLLECTION}' exists — {info.points_count} points")

    return client


def embed_and_insert(args):
    """Main pipeline: load model, embed all images, insert into Qdrant."""
    import onnxruntime as ort

    # Load ONNX model
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if args.gpu else ["CPUExecutionProvider"]
    print(f"[model] Loading {args.model} with providers: {providers}")
    sess = ort.InferenceSession(args.model, providers=providers)
    inp_name = sess.get_inputs()[0].name
    print(f"[model] Input: {inp_name} → output: {sess.get_outputs()[0].name}")

    # Load disease metadata for enriched payloads
    metadata = {}
    if args.metadata and Path(args.metadata).exists():
        with open(args.metadata) as f:
            md = json.load(f)
            metadata = md.get("diseases", {})
            # Also load PlantVillage class name → disease ID mapping
            pv_map = md.get("plantvillage_class_map", {})
    else:
        pv_map = {}

    # Collect images
    images = collect_images(args.data, args.class_map)

    # Setup Qdrant
    client = setup_qdrant(args.qdrant_url)
    from qdrant_client.models import PointStruct

    # Process in GPU batches
    gpu_batch = args.gpu_batch
    total = len(images)
    embedded = 0
    points_buffer = []
    t0 = time.time()

    for batch_start in range(0, total, gpu_batch):
        batch_end = min(batch_start + gpu_batch, total)
        batch_images = images[batch_start:batch_end]

        # Preprocess batch
        batch_arrays = []
        batch_valid = []
        for img_path, class_name, source in batch_images:
            try:
                arr = preprocess(img_path)
                batch_arrays.append(arr)
                batch_valid.append((img_path, class_name, source))
            except Exception as e:
                continue

        if not batch_arrays:
            continue

        # Run inference
        batch_input = np.stack(batch_arrays, axis=0)
        embeddings = sess.run(None, {inp_name: batch_input})[0]  # [B, 512]

        # Normalize (should already be normalized, but ensure)
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        norms[norms == 0] = 1
        embeddings = embeddings / norms

        # Build Qdrant points
        for i, (img_path, class_name, source) in enumerate(batch_valid):
            # Map class name to disease ID
            disease_id = pv_map.get(class_name, class_name.lower().replace(" ", "_"))
            disease_info = metadata.get(disease_id, {})

            # Determine crop from class name or metadata
            crop = disease_info.get("crop", "Unknown")
            if "cassava" in class_name.lower() or "yuca" in class_name.lower():
                crop = "Cassava/Yuca"
            elif "mango" in class_name.lower():
                crop = "Mango"

            point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"agrovision/{source}/{Path(img_path).name}"))

            points_buffer.append(PointStruct(
                id=point_id,
                vector=embeddings[i].tolist(),
                payload={
                    "disease_id": disease_id,
                    "disease_name": disease_info.get("name", class_name),
                    "scientific_name": disease_info.get("scientific", ""),
                    "crop": crop,
                    "severity": disease_info.get("severity", "unknown"),
                    "treatment": disease_info.get("treatment", ""),
                    "prevention": disease_info.get("prevention", ""),
                    "source_dataset": source,
                    "source_class": class_name,
                    "image_path": os.path.basename(img_path),
                },
            ))
            embedded += 1

        # Flush to Qdrant when buffer is full
        if len(points_buffer) >= BATCH_SIZE:
            client.upsert(collection_name=QDRANT_COLLECTION, points=points_buffer[:BATCH_SIZE], wait=False)
            points_buffer = points_buffer[BATCH_SIZE:]
            elapsed = time.time() - t0
            rate = embedded / elapsed
            print(f"[embed] {embedded}/{total} ({100*embedded/total:.1f}%) | {rate:.0f} img/s | "
                  f"ETA: {(total - embedded) / max(rate, 1):.0f}s")

    # Flush remaining
    if points_buffer:
        client.upsert(collection_name=QDRANT_COLLECTION, points=points_buffer, wait=True)

    elapsed = time.time() - t0
    print(f"\n[done] Embedded {embedded} images in {elapsed:.0f}s ({embedded/elapsed:.0f} img/s)")

    # Final stats
    info = client.get_collection(QDRANT_COLLECTION)
    print(f"[qdrant] Collection '{QDRANT_COLLECTION}': {info.points_count} total points")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AgroVisión — Embed datasets to Qdrant")
    parser.add_argument("--model", required=True, help="Path to agrovision_embed.onnx")
    parser.add_argument("--data", default="/home/gcp/ozzu/data/agrovision", help="Dataset root dir")
    parser.add_argument("--metadata", default="/home/gcp/ozzu/backend/agrovision/disease_metadata.json")
    parser.add_argument("--class-map", default=None, help="Path to class_map.json from training")
    parser.add_argument("--qdrant-url", default=QDRANT_URL)
    parser.add_argument("--gpu", action="store_true", help="Use GPU for inference")
    parser.add_argument("--gpu-batch", type=int, default=128, help="GPU batch size")

    args = parser.parse_args()
    embed_and_insert(args)
