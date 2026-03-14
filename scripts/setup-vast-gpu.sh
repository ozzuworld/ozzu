#!/bin/bash
# setup-vast-gpu.sh — One-shot setup for vast.ai GPU instances
# Usage: ./setup-vast-gpu.sh <host> <port> [--start]
# Example: ./setup-vast-gpu.sh 74.48.78.46 24588
# Example: ./setup-vast-gpu.sh 74.48.78.46 24588 --start
#
# Does everything:
#   1. Installs Python deps
#   2. Fixes CUDA 12/13 compat
#   3. Copies pipeline script + progress file (skips completed datasets)
#   4. Downloads Qdrant binary for local mode
#   5. Creates launch wrapper with env vars + --local-qdrant + disk watchdog
#   6. Verifies GPU works
#   7. Optionally starts the pipeline immediately (remaining datasets only)
#
# CRITICAL: Pipeline ALWAYS runs with --local-qdrant.
# Without it: 15-20K/min. With it: 85K/min. NEVER launch without it.
#
# CRITICAL: Progress file is transferred so completed datasets are SKIPPED.
# Without it: every new VM re-processes ALL datasets from scratch.
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

# Completed datasets — these are already in home Qdrant (48M+ faces).
# The pipeline checks ~/.pipeline-progress.json and skips "completed" entries.
# UPDATE THIS LIST when new datasets finish processing.
COMPLETED_DATASETS=("webface4m" "ms1mv3" "vggface2" "vggface2_wds" "glint360k" "arc2face")

# Remaining datasets — these are NOT yet in Qdrant
REMAINING_DATASETS=("ms1mv2" "casia" "imdb_wiki" "celeba")

echo "=== Vast.ai GPU Setup ==="
echo "Target: root@$HOST:$PORT"
echo "Completed datasets: ${COMPLETED_DATASETS[*]}"
echo "Will process: ${REMAINING_DATASETS[*]}"
echo ""

# Step 1: Install Python deps
echo "[1/8] Installing Python dependencies..."
$SSH "pip install -q insightface onnxruntime-gpu opencv-python-headless pyarrow qdrant-client huggingface_hub requests 'PyTurboJPEG<2.0' 2>&1 | tail -3"
$SSH "apt-get update -qq 2>/dev/null && apt-get install -y -qq libturbojpeg0-dev 2>&1 | tail -2"
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

# Step 3: Generate and transfer progress file (marks completed datasets)
echo "[3/8] Generating progress file for completed datasets..."
PROGRESS_JSON=$(python3 -c "
import json, time
completed = '${COMPLETED_DATASETS[*]}'.split()
progress = {'datasets': {}}
for ds in completed:
    progress['datasets'][ds] = {
        'status': 'completed',
        'description': f'{ds} (pre-seeded from home Qdrant)',
        'completedAt': time.time(),
        'indexed': 0,
        'note': 'Already in home Qdrant — skipped on this VM'
    }
print(json.dumps(progress, indent=2))
")
echo "$PROGRESS_JSON" > /tmp/vast-pipeline-progress.json
$SCP /tmp/vast-pipeline-progress.json "root@$HOST:/root/.pipeline-progress.json"
echo "  Marked ${#COMPLETED_DATASETS[@]} datasets as completed."

# Step 4: Copy pipeline script
echo "[4/8] Copying pipeline script..."
$SCP "$SCRIPT_DIR/embed-pipeline-v2.py" "root@$HOST:/root/embed-pipeline-v2.py"
echo "  Done."

# Step 5: Download Qdrant binary for local mode
echo "[5/8] Downloading Qdrant binary..."
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

# Step 6: Create launch wrapper with disk watchdog
echo "[6/8] Creating launch wrapper..."
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
echo ""

# Show progress file status
if [ -f /root/.pipeline-progress.json ]; then
  SKIP_COUNT=$(python3 -c "import json; d=json.load(open('/root/.pipeline-progress.json')); print(sum(1 for v in d.get('datasets',{}).values() if v.get('status')=='completed'))" 2>/dev/null || echo "?")
  echo "Progress file: $SKIP_COUNT datasets already completed (will skip)"
else
  echo "WARNING: No progress file — ALL datasets will run from scratch!"
fi

# Show disk space
DISK_AVAIL=$(df -BG /root | tail -1 | awk '{print $4}')
echo "Disk available: $DISK_AVAIL"
echo "========================"

# Start disk watchdog in background — kills pipeline if disk >90% full
(
  while true; do
    sleep 120
    USE_PCT=$(df /root | tail -1 | awk '{print $5}' | tr -d '%')
    if [ "$USE_PCT" -ge 90 ] 2>/dev/null; then
      echo "[WATCHDOG] Disk at ${USE_PCT}% — triggering sync before disk fills!"
      # Signal the pipeline to pause and sync
      kill -USR1 $PIPELINE_PID 2>/dev/null || true
    fi
    if [ "$USE_PCT" -ge 95 ] 2>/dev/null; then
      echo "[WATCHDOG] Disk at ${USE_PCT}% — KILLING pipeline to prevent corruption!"
      kill $PIPELINE_PID 2>/dev/null || true
      break
    fi
  done
) &
WATCHDOG_PID=$!

# ALWAYS use --local-qdrant (15K→85K/min difference). NEVER launch without it.
python3 -u /root/embed-pipeline-v2.py --local-qdrant "$@" &
PIPELINE_PID=$!
wait $PIPELINE_PID
EXIT_CODE=$?
kill $WATCHDOG_PID 2>/dev/null || true
exit $EXIT_CODE
WRAPPER
$SCP /tmp/vast-run-pipeline.sh "root@$HOST:/root/run-pipeline.sh"
$SSH "chmod +x /root/run-pipeline.sh"
echo "  Done."

# Step 7: Verify GPU works
echo "[7/8] Verifying GPU inference..."
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

# Step 8: Verify disk space is adequate
echo "[8/8] Checking disk space..."
$SSH '
AVAIL_GB=$(df -BG /root | tail -1 | awk "{print \$4}" | tr -d "G")
echo "  Available: ${AVAIL_GB}GB"
if [ "$AVAIL_GB" -lt 100 ] 2>/dev/null; then
  echo "  WARNING: Less than 100GB free. Qdrant WAL may fill disk."
  echo "  Consider a larger instance (200GB+ recommended)."
fi
'

REMAINING_ARGS="${REMAINING_DATASETS[*]}"

echo ""
echo "=== Setup Complete (8/8) ==="
echo ""
echo "NOTE: run-pipeline.sh ALWAYS passes --local-qdrant automatically."
echo "      Progress file marks ${#COMPLETED_DATASETS[@]} datasets as completed (will skip)."
echo "      Remaining: ${REMAINING_ARGS}"
echo ""
echo "To start remaining datasets:"
echo "  $SSH \"tmux new-session -d -s pipeline '/root/run-pipeline.sh ${REMAINING_ARGS} 2>&1 | tee /root/pipeline.log'\""
echo ""
echo "To start ALL (will auto-skip completed):"
echo "  $SSH \"tmux new-session -d -s pipeline '/root/run-pipeline.sh --all 2>&1 | tee /root/pipeline.log'\""
echo ""
echo "To monitor:"
echo "  $SSH \"tail -f /root/pipeline.log\""
echo ""
echo "To attach tmux:"
echo "  $SSH -t \"tmux attach -t pipeline\""

# Optionally start immediately — runs only remaining datasets
if [ "$START" = "--start" ]; then
  echo ""
  echo "=== Starting pipeline (remaining: ${REMAINING_ARGS}) ==="
  $SSH "tmux kill-session -t pipeline 2>/dev/null; tmux new-session -d -s pipeline '/root/run-pipeline.sh ${REMAINING_ARGS} 2>&1 | tee /root/pipeline.log'"
  echo "Pipeline started in tmux session 'pipeline'."
  echo "Monitor: $SSH \"tail -f /root/pipeline.log\""
fi
