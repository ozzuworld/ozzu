#!/bin/bash
# Fresh vast.ai CUDA box -> ready to QLoRA-SFT Qwen3-Coder-30B-A3B.
# dir_1781203380739. Run on the rented box (scp this over, then bash it).
#
# KEY: install torch from the cu126 index, NOT the default `pip install torch`.
# The default grabs a cu130 wheel that is too new for vast's CUDA 12.8 drivers
# (torch.cuda.is_available() == False). cu126 is forward-compatible with 12.6-12.8.
#
# The bf16 base loads at ~60GB on GPU (this MoE's experts do NOT 4bit-quantize,
# only attention does) -> needs a 141GB card. See memory: reference_moe_expert_4bit_not_quantized.
set -e
export DEBIAN_FRONTEND=noninteractive

echo "=== [1/4] apt deps ==="
# NO `| tail` here: a pipe makes the pipeline exit status that of `tail` (0), masking an
# apt failure from `set -e` -> the script ran on to build a pip-less venv (cost a setup 2026-06-15).
apt-get update && apt-get install -y python3-venv python3-pip python3-dev git

echo "=== [2/4] venv ==="
python3 -m venv /root/sftvenv
/root/sftvenv/bin/pip install -q --upgrade pip 2>&1 | tail -1

echo "=== [3/4] torch cu126 (matches driver) + training deps ==="
/root/sftvenv/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cu126 2>&1 | tail -2
/root/sftvenv/bin/pip install -q transformers peft bitsandbytes accelerate huggingface_hub datasets safetensors 2>&1 | tail -2
/root/sftvenv/bin/python -c "import torch; print('torch', torch.__version__, '| CUDA', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NO-GPU')"

echo "=== [4/4] base model pull (~57GB) ==="
/root/sftvenv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-Coder-30B-A3B-Instruct', local_dir='/root/coder-bf16', ignore_patterns=['*.pth','original/*'])"
echo "SAFETENSORS: $(ls /root/coder-bf16/*.safetensors 2>/dev/null | wc -l) | SIZE: $(du -sh /root/coder-bf16 2>/dev/null | cut -f1)"
echo "GPU_SETUP_DONE"
