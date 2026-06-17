import os
from huggingface_hub import snapshot_download
# dir_1781203380739: pull the bf16 base the adapters were trained on. Skip .pth/.bin/original
# duplicates so a 30B model stays ~61 GB (safetensors only) on the 80 GB box.
p = snapshot_download(
    "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    local_dir="/root/coder-bf16",
    ignore_patterns=["*.pth", "*.bin", "original/*", "consolidated*"],
)
print("DL_DONE", p)
