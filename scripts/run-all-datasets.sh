#!/bin/bash
# Run all face embedding pipelines in sequence on Vast.ai GPU
# Usage: nohup bash run-all-datasets.sh > /tmp/all-datasets.log 2>&1 &

set -e

export LD_LIBRARY_PATH=/usr/local/lib/python3.10/dist-packages/nvidia/cudnn/lib:/usr/local/lib/python3.10/dist-packages/nvidia/cuda_runtime/lib:/usr/local/cuda/lib64:$LD_LIBRARY_PATH
export QDRANT_URL=http://127.0.0.1:6333
export ONNXRUNTIME_LOG_LEVEL=3

echo "=========================================="
echo "FACE EMBEDDING PIPELINE ORCHESTRATOR"
echo "Started: $(date)"
echo "=========================================="

# 1. Check if Glint360K is still running
if pgrep -f "embed-glint-v3.py" > /dev/null 2>&1; then
    echo "[wait] Glint360K still running, waiting..."
    while pgrep -f "embed-glint-v3.py" > /dev/null 2>&1; do
        sleep 60
    done
    echo "[done] Glint360K finished at $(date)"
fi

# Qdrant status check
echo "[check] Qdrant status..."
curl -s $QDRANT_URL/collections/faces | python3 -c "
import json,sys
d=json.load(sys.stdin)['result']
print(f'  Points: {d[\"points_count\"]:,}')
print(f'  Status: {d[\"status\"]}')
"

# 2. MS1MV3 (5.2M images, 100 tar shards from HuggingFace)
echo ""
echo "=========================================="
echo "PHASE 2: MS1MV3 (5.2M faces)"
echo "Started: $(date)"
echo "=========================================="
python3 -u /root/embed-ms1mv3.py 0 100

echo "[check] Qdrant after MS1MV3..."
curl -s $QDRANT_URL/collections/faces | python3 -c "
import json,sys
d=json.load(sys.stdin)['result']
print(f'  Points: {d[\"points_count\"]:,}')
"

# 3. MS1MV2 (5.8M images, RecordIO format)
# Need to download first if not present
if [ -d "/root/ms1mv2" ] && [ -f "/root/ms1mv2/train.rec" ]; then
    echo ""
    echo "=========================================="
    echo "PHASE 3: MS1MV2 (5.8M faces)"
    echo "Started: $(date)"
    echo "=========================================="
    python3 -u /root/embed-ms1mv2.py /root/ms1mv2/
else
    echo ""
    echo "[skip] MS1MV2 not downloaded yet."
    echo "  Download from HuggingFace: huggingface-cli download gaunernst/ms1mv3-recordio --local-dir /root/ms1mv2"
    echo "  Or from Kaggle: kaggle datasets download -d rookie11/ms1m-arcface -p /root/ms1mv2"
    echo "  Then re-run this script."
fi

echo ""
echo "=========================================="
echo "ALL PIPELINES COMPLETE"
echo "Finished: $(date)"
echo "=========================================="

# Final stats
curl -s $QDRANT_URL/collections/faces | python3 -c "
import json,sys
d=json.load(sys.stdin)['result']
print(f'  Total faces in Qdrant: {d[\"points_count\"]:,}')
print(f'  Status: {d[\"status\"]}')
"
