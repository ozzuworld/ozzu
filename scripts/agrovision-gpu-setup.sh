#!/bin/bash
# AgroVisión — Setup Vast.ai GPU instance for training
# Directive: dir_1774099821063
#
# Usage:
#   ./agrovision-gpu-setup.sh <vast-host> <vast-port> [--start]
#
# Prerequisites: vast.ai instance with CUDA 12+, >= 16GB VRAM
# The --start flag downloads datasets and launches training after setup.

set -euo pipefail

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <vast-host> <vast-port> [--start]"
    echo "Example: $0 ssh5.vast.ai 12345 --start"
    exit 1
fi

HOST="$1"
PORT="$2"
START="${3:-}"
SSH="ssh -o StrictHostKeyChecking=no -p $PORT root@$HOST"
SCP="scp -o StrictHostKeyChecking=no -P $PORT"

echo "╔══════════════════════════════════════════╗"
echo "║  AgroVisión — GPU Training Setup         ║"
echo "║  Host: $HOST:$PORT                       ║"
echo "╚══════════════════════════════════════════╝"

# ── 1. System dependencies ──
echo "[1/5] Installing system dependencies..."
$SSH "apt-get update -qq && apt-get install -y -qq python3-pip tmux pigz unzip > /dev/null 2>&1"

# ── 2. Python packages ──
echo "[2/5] Installing Python packages..."
$SSH "pip3 install --quiet \
    torch torchvision \
    onnx onnxruntime-gpu \
    qdrant-client \
    Pillow \
    timm \
    kaggle"

# ── 3. Copy training scripts ──
echo "[3/5] Uploading training scripts..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
$SCP "$SCRIPT_DIR/agrovision-train.py" "root@$HOST:/root/agrovision-train.py"
$SCP "$SCRIPT_DIR/agrovision-download-datasets.sh" "root@$HOST:/root/agrovision-download-datasets.sh"
$SCP "$SCRIPT_DIR/agrovision-embed-to-qdrant.py" "root@$HOST:/root/agrovision-embed-to-qdrant.py"

# Copy disease metadata
$SCP "$(dirname "$SCRIPT_DIR")/backend/agrovision/disease_metadata.json" "root@$HOST:/root/disease_metadata.json"

# Copy kaggle credentials if available
if [ -f "$HOME/.kaggle/kaggle.json" ]; then
    echo "[3/5] Uploading Kaggle credentials..."
    $SSH "mkdir -p /root/.kaggle"
    $SCP "$HOME/.kaggle/kaggle.json" "root@$HOST:/root/.kaggle/kaggle.json"
    $SSH "chmod 600 /root/.kaggle/kaggle.json"
fi

# ── 4. Verify GPU ──
echo "[4/5] Checking GPU..."
$SSH "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"

# ── 5. Optional: download + train ──
if [ "$START" = "--start" ]; then
    echo "[5/5] Starting dataset download + training in tmux..."
    $SSH "tmux new-session -d -s agrovision 'bash /root/agrovision-download-datasets.sh /root/data && python3 /root/agrovision-train.py --data /root/data --output /root/models --epochs 30 --batch 64 2>&1 | tee /root/training.log'"
    echo ""
    echo "Training started in tmux session 'agrovision'"
    echo "Monitor with: ssh -p $PORT root@$HOST 'tmux attach -t agrovision'"
    echo "Or check log: ssh -p $PORT root@$HOST 'tail -f /root/training.log'"
else
    echo "[5/5] Setup complete. To start training:"
    echo ""
    echo "  ssh -p $PORT root@$HOST"
    echo "  tmux new -s agrovision"
    echo "  bash /root/agrovision-download-datasets.sh /root/data"
    echo "  python3 /root/agrovision-train.py --data /root/data --output /root/models --epochs 30 --batch 64"
fi

echo ""
echo "After training, copy model back:"
echo "  scp -P $PORT root@$HOST:/root/models/agrovision_embed.onnx /home/gcp/ozzu/data/agrovision/models/"
echo "  scp -P $PORT root@$HOST:/root/models/class_map.json /home/gcp/ozzu/data/agrovision/models/"
echo "  scp -P $PORT root@$HOST:/root/models/model_info.json /home/gcp/ozzu/data/agrovision/models/"
echo ""
echo "Then embed into Qdrant:"
echo "  python3 agrovision-embed-to-qdrant.py --model /home/gcp/ozzu/data/agrovision/models/agrovision_embed.onnx --data /home/gcp/ozzu/data/agrovision"
