# Ozzu offense-model GPU image — SERVE (vLLM) + TRAIN (QLoRA SFT/GRPO) in one box.
# dir_1781203380739.
#
# WHY THIS EXISTS: every fresh vast.ai rental was burning ~1h on dependency setup —
# pip building vLLM from scratch, the PyJWT/pypi-timeout hell, the hf_transfer trap,
# and the `pip install torch` cu130-too-new trap (see tools/sft-train/gpu-setup.sh comments).
# Baking it freezes that hour to ZERO. The only unavoidable runtime cost is the ~57GB
# bf16 base-model pull (this MoE's experts don't 4bit-quantize -> needs a 141GB card).
#
# BASE: the OFFICIAL vLLM image already ships a known-good torch+CUDA+vLLM trio, which is
# exactly the part that fought us. We add only the training deps on top of its torch.
ARG VLLM_TAG=v0.23.0
FROM vllm/vllm-openai:${VLLM_TAG}

# Training stack on top of vLLM's own torch (so SFT/GRPO run in the SAME image / same CUDA).
# No separate cu126 torch install -> avoids the gpu-setup.sh driver-mismatch trap entirely,
# because vLLM's image already pins a torch that matches its CUDA.
RUN pip install --no-cache-dir \
        peft bitsandbytes accelerate datasets trl safetensors \
        "huggingface_hub>=0.24" hf_transfer

# Reliable fast pulls: hf_transfer guaranteed present + enabled, so the silent-no-op
# download trap (hf_transfer missing -> snapshot_download errors instantly) can't happen.
ENV HF_HUB_ENABLE_HF_TRANSFER=1 \
    BASE_MODEL=Qwen/Qwen3-Coder-30B-A3B-Instruct \
    BASE_DIR=/root/coder-bf16 \
    ADAPTER_DIR=/adapters \
    PORT=8000 \
    MAX_MODEL_LEN=16384 \
    MAX_LORA_RANK=32

COPY serve.sh /opt/ozzu/serve.sh
RUN chmod +x /opt/ozzu/serve.sh

# vLLM's image sets its own entrypoint; replace it with our serve orchestrator
# (pull base if missing -> auto-discover adapters -> serve).
ENTRYPOINT []
CMD ["/opt/ozzu/serve.sh"]
