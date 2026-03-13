#!/bin/bash
# setup-vast-gpu.sh — One-shot setup for vast.ai GPU instances
# Usage: ./setup-vast-gpu.sh <host> <port> [--start]
# Example: ./setup-vast-gpu.sh 74.48.78.46 24588
# Example: ./setup-vast-gpu.sh 74.48.78.46 24588 --start
#
# Does everything:
#   1. Installs Python deps
#   2. Fixes CUDA 12/13 compat
#   3. Copies pipeline script
#   4. Downloads Qdrant binary for local mode
#   5. Creates launch wrapper with env vars + --local-qdrant
#   6. Verifies GPU works
#   7. Optionally starts the pipeline immediately
#
# CRITICAL: Pipeline ALWAYS runs with --local-qdrant.
# Without it: 15-20K/min. With it: 85K/min. NEVER launch without it.
#
# After setup, SSH in and run: tmux attach -t pipeline
# Or just: ./setup-vast-gpu.sh host port --start

set -euo pipefail

HOST="${1:?Usage: $0 <host> <port> [--start]}"
PORT="${2:?Usage: $0 <host> <port> [--start]}"
START="${3:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SSH="ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=no -p $PORT root@$HOST"
SCP="scp -o ConnectTimeout=15 -o StrictHostKeyChecking=no -P $PORT"

echo "=== Vast.ai GPU Setup ==="
echo "Target: root@$HOST:$PORT"
echo ""

# Step 1: Install Python deps
echo "[1/7] Installing Python dependencies..."
$SSH "pip install -q insightface onnxruntime-gpu opencv-python-headless pyarrow qdrant-client huggingface_hub requests 2>&1 | tail -3"
echo "  Done."

# Step 2: Fix CUDA 12/13 compatibility
echo "[2/7] Fixing CUDA compatibility..."
$SSH '
CUDA_VER=$(nvcc --version 2>/dev/null | grep -oP "release \K[0-9]+" | head -1)
if [ "$CUDA_VER" -ge 13 ] 2>/dev/null; then
  echo "  CUDA $CUDA_VER detected, installing CUDA 12.8 compat libs..."
  apt-get update -qq 2>/dev/null
  apt-get install -y --no-install-recommends \
    libcufft-12-8 libcurand-12-8 libcusparse-12-8 \
    libcusolver-12-8 cuda-cudart-12-8 libcublas-12-8 \
    2>&1 | tail -3
  ldconfig
  echo "  CUDA 12.8 compat libs installed."
else
  echo "  CUDA $CUDA_VER — no compat fix needed."
fi
'

# Step 3: Copy pipeline script
echo "[3/7] Copying pipeline script..."
$SCP "$SCRIPT_DIR/embed-pipeline-v2.py" "root@$HOST:/root/embed-pipeline-v2.py"
echo "  Done."

# Step 4: Download Qdrant binary for local mode
echo "[4/7] Downloading Qdrant binary..."
$SSH '
if [ ! -f /root/qdrant ]; then
  QDRANT_VER="v1.13.2"
  curl -sL "https://github.com/qdrant/qdrant/releases/download/${QDRANT_VER}/qdrant-x86_64-unknown-linux-musl.tar.gz" | tar xz -C /root
  chmod +x /root/qdrant
  echo "  Qdrant ${QDRANT_VER} downloaded."
else
  echo "  Qdrant already present, skipping."
fi
'

# Step 5: Create launch wrapper
echo "[5/7] Creating launch wrapper..."
cat > /tmp/vast-run-pipeline.sh << 'WRAPPER'
#!/bin/bash
# Auto-detect CUDA 12.x lib path
CUDA12_LIB=$(ls -d /usr/local/cuda-12.*/lib64 2>/dev/null | sort -V | tail -1)
if [ -n "$CUDA12_LIB" ]; then
  export LD_LIBRARY_PATH="$CUDA12_LIB:${LD_LIBRARY_PATH:-}"
fi

export QDRANT_URL="${QDRANT_URL:-https://home.ozzu.world:443}"
export QDRANT_PREFIX="${QDRANT_PREFIX:-qdrant}"
export BRIDGE_URL="${BRIDGE_URL:-https://home.ozzu.world/bridge}"
export GPU_BATCH="${GPU_BATCH:-512}"

echo "=== Pipeline Launch ==="
echo "QDRANT_URL: $QDRANT_URL"
echo "BRIDGE_URL: $BRIDGE_URL"
echo "GPU_BATCH: $GPU_BATCH"
echo "LD_LIBRARY_PATH: $LD_LIBRARY_PATH"
echo "Args: $@"
echo "========================"

# ALWAYS use --local-qdrant (15K→85K/min difference). NEVER launch without it.
exec python3 -u /root/embed-pipeline-v2.py --local-qdrant "$@"
WRAPPER
$SCP /tmp/vast-run-pipeline.sh "root@$HOST:/root/run-pipeline.sh"
$SSH "chmod +x /root/run-pipeline.sh"
echo "  Done."

# Step 6: Verify GPU works
echo "[6/7] Verifying GPU inference..."
$SSH '
CUDA12_LIB=$(ls -d /usr/local/cuda-12.*/lib64 2>/dev/null | sort -V | tail -1)
export LD_LIBRARY_PATH="$CUDA12_LIB:${LD_LIBRARY_PATH:-}"
python3 -c "
import onnxruntime as ort
providers = ort.get_available_providers()
if \"CUDAExecutionProvider\" in providers:
    print(\"  GPU: OK (CUDAExecutionProvider available)\")
else:
    print(\"  GPU: FAILED — only\", providers)
    exit(1)
"
'

echo ""
echo "=== Setup Complete (7/7) ==="
echo ""
echo "NOTE: run-pipeline.sh ALWAYS passes --local-qdrant automatically."
echo "      Extra args you pass are ADDED to --local-qdrant."
echo ""
echo "To start pipeline:"
echo "  $SSH \"tmux new-session -d -s pipeline '/root/run-pipeline.sh --all 2>&1 | tee /root/pipeline.log'\""
echo ""
echo "To monitor:"
echo "  $SSH \"tail -f /root/pipeline.log\""
echo ""
echo "To attach tmux:"
echo "  $SSH -t \"tmux attach -t pipeline\""

# Optionally start immediately
if [ "$START" = "--start" ]; then
  echo ""
  echo "=== Starting pipeline (--all --local-qdrant) ==="
  $SSH "tmux kill-session -t pipeline 2>/dev/null; tmux new-session -d -s pipeline '/root/run-pipeline.sh --all 2>&1 | tee /root/pipeline.log'"
  echo "Pipeline started in tmux session 'pipeline'."
  echo "Monitor: $SSH \"tail -f /root/pipeline.log\""
fi
