#!/bin/bash
# AgroVisión — Download all training datasets
# Directive: dir_1774099821063
#
# Datasets:
#   1. PlantVillage  — 54K images, 38 classes (Kaggle)
#   2. Cassava       — 21K images, 5 classes (Kaggle)
#   3. MangoLeafBD   — 4K images, 7 classes (Kaggle)
#   4. PlantDoc      — 2.5K images, 27 classes (real-world supplement)

set -euo pipefail

DATA_DIR="${1:-/home/gcp/ozzu/data/agrovision}"
mkdir -p "$DATA_DIR"

echo "╔══════════════════════════════════════╗"
echo "║  AgroVisión — Dataset Downloader     ║"
echo "╚══════════════════════════════════════╝"
echo "Target: $DATA_DIR"
echo ""

# Check for kaggle CLI
if ! command -v kaggle &> /dev/null; then
    echo "[!] kaggle CLI not found. Installing..."
    pip3 install --quiet kaggle
fi

# Verify kaggle credentials
if [ ! -f "$HOME/.kaggle/kaggle.json" ]; then
    echo "[!] No kaggle.json found at ~/.kaggle/kaggle.json"
    echo "    Get your API key from: https://www.kaggle.com/settings"
    echo "    Then: mkdir -p ~/.kaggle && echo '{\"username\":\"...\",\"key\":\"...\"}' > ~/.kaggle/kaggle.json && chmod 600 ~/.kaggle/kaggle.json"
    exit 1
fi

# ── 1. PlantVillage ──
PV_DIR="$DATA_DIR/plantvillage"
if [ -d "$PV_DIR" ] && [ "$(find "$PV_DIR" -name '*.jpg' -o -name '*.JPG' -o -name '*.png' | head -1)" ]; then
    echo "[✓] PlantVillage already downloaded ($(find "$PV_DIR" -type f -name '*.jpg' -o -name '*.JPG' -o -name '*.png' | wc -l) images)"
else
    echo "[↓] Downloading PlantVillage (~2.3GB)..."
    mkdir -p "$PV_DIR"
    kaggle datasets download -d abdallahalidev/plantvillage-dataset -p "$PV_DIR" --unzip
    # Flatten — the dataset has color/, grayscale/, segmented/ dirs. We want color only.
    if [ -d "$PV_DIR/plantvillage dataset/color" ]; then
        mv "$PV_DIR/plantvillage dataset/color/"* "$PV_DIR/" 2>/dev/null || true
        rm -rf "$PV_DIR/plantvillage dataset"
    fi
    echo "[✓] PlantVillage: $(find "$PV_DIR" -type f -name '*.jpg' -o -name '*.JPG' -o -name '*.png' | wc -l) images"
fi

# ── 2. Cassava Leaf Disease ──
CS_DIR="$DATA_DIR/cassava"
if [ -d "$CS_DIR" ] && [ "$(find "$CS_DIR" -name '*.jpg' | head -1)" ]; then
    echo "[✓] Cassava already downloaded ($(find "$CS_DIR" -type f -name '*.jpg' | wc -l) images)"
else
    echo "[↓] Downloading Cassava Leaf Disease (~3.4GB)..."
    mkdir -p "$CS_DIR"
    kaggle competitions download -c cassava-leaf-disease-classification -p "$CS_DIR"
    cd "$CS_DIR" && unzip -qo "*.zip" && rm -f *.zip
    cd -
    echo "[✓] Cassava: $(find "$CS_DIR" -type f -name '*.jpg' | wc -l) images"
fi

# ── 3. MangoLeafBD ──
MG_DIR="$DATA_DIR/mango"
if [ -d "$MG_DIR" ] && [ "$(find "$MG_DIR" -name '*.jpg' -o -name '*.JPG' | head -1)" ]; then
    echo "[✓] MangoLeafBD already downloaded ($(find "$MG_DIR" -type f -name '*.jpg' -o -name '*.JPG' | wc -l) images)"
else
    echo "[↓] Downloading MangoLeafBD..."
    mkdir -p "$MG_DIR"
    kaggle datasets download -d aryashah2k/mango-leaf-disease-dataset -p "$MG_DIR" --unzip
    echo "[✓] MangoLeafBD: $(find "$MG_DIR" -type f -name '*.jpg' -o -name '*.JPG' | wc -l) images"
fi

# ── 4. PlantDoc (real-world supplement) ──
PD_DIR="$DATA_DIR/plantdoc"
if [ -d "$PD_DIR" ] && [ "$(find "$PD_DIR" -name '*.jpg' -o -name '*.JPG' | head -1)" ]; then
    echo "[✓] PlantDoc already downloaded ($(find "$PD_DIR" -type f -name '*.jpg' -o -name '*.JPG' | wc -l) images)"
else
    echo "[↓] Downloading PlantDoc..."
    mkdir -p "$PD_DIR"
    kaggle datasets download -d pratikkayal/plantdoc-dataset -p "$PD_DIR" --unzip
    echo "[✓] PlantDoc: $(find "$PD_DIR" -type f -name '*.jpg' -o -name '*.JPG' | wc -l) images"
fi

echo ""
echo "════════════════════════════════════════"
echo "  All datasets downloaded to: $DATA_DIR"
echo ""
echo "  Directory structure:"
echo "    plantvillage/  — 38 class folders (Apple_scab, Tomato_healthy, etc.)"
echo "    cassava/       — train_images/ + train.csv (label: 0-4)"
echo "    mango/         — 7 class folders"
echo "    plantdoc/      — real-world mixed conditions"
echo ""
echo "  Next: run agrovision-train.py to train DINOv2 + ArcFace"
echo "════════════════════════════════════════"
