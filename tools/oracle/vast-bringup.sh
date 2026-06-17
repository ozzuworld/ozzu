#!/bin/bash
# dir_1781203380739: bring up the offense model on a fresh vast.ai box.
# Install vLLM (pulls torch/cuda), then pull the bf16 base the adapters were trained on.
# Launched detached; progress in /root/bringup.log. Adapters are rsync'd separately, then served.
exec > /root/bringup.log 2>&1
set -x
echo "=== START ==="; date; df -h /
echo "=== install vllm (pulls torch/cuda) ==="
pip3 install --break-system-packages -q -U vllm huggingface_hub hf_transfer 2>&1 | tail -6
python3 -c "import vllm; print('VLLM_OK', vllm.__version__)" 2>&1 | tail -1
df -h /
echo "=== download base bf16 (safetensors only) ==="
export HF_HUB_ENABLE_HF_TRANSFER=1
python3 -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-Coder-30B-A3B-Instruct', local_dir='/root/coder-bf16', ignore_patterns=['*.pth','original/*'])" 2>&1 | tail -3
echo "=== DOWNLOAD_DONE ==="; du -sh /root/coder-bf16 2>/dev/null; echo "safetensors: $(ls /root/coder-bf16/*.safetensors 2>/dev/null | wc -l)"; df -h /
echo "=== BRINGUP_DONE ==="; date
