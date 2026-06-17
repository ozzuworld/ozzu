#!/usr/bin/env bash
# Ozzu offense-model serve orchestrator (baked into the GPU image).
# dir_1781203380739.
#   1. ensure the bf16 base model is present (pull via hf_transfer if missing)
#   2. auto-discover LoRA adapters under $ADAPTER_DIR (each subdir = one served name)
#   3. serve vLLM with the proven offense-model flags
#
# Adapters reach the box one of two ways, both land in $ADAPTER_DIR:
#   - mount:  docker run -v /root/adapters:/adapters ...
#   - rsync:  rsync the adapter dirs into the running container's /adapters
# Each adapter subdir must contain adapter_config.json; it's served as
# "qwen3-coder-30b-<dirname>" (so a dir named `grpo3` -> qwen3-coder-30b-grpo3).
set -euo pipefail

: "${BASE_MODEL:=Qwen/Qwen3-Coder-30B-A3B-Instruct}"
: "${BASE_DIR:=/root/coder-bf16}"
: "${ADAPTER_DIR:=/adapters}"
: "${PORT:=8000}"
: "${MAX_MODEL_LEN:=16384}"
: "${MAX_LORA_RANK:=32}"
export HF_HUB_ENABLE_HF_TRANSFER=1

echo "=== [serve] $(date -u) ==="
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo "[serve] WARN: no nvidia-smi"

# ── 1. base model ────────────────────────────────────────────────────────────
if [ -f "$BASE_DIR/config.json" ] && [ "$(ls "$BASE_DIR"/*.safetensors 2>/dev/null | wc -l)" -ge 1 ]; then
  echo "[serve] base model present at $BASE_DIR ($(du -sh "$BASE_DIR" 2>/dev/null | cut -f1))"
else
  echo "[serve] pulling base $BASE_MODEL -> $BASE_DIR (hf_transfer)…"
  python3 - <<PY
from huggingface_hub import snapshot_download
snapshot_download("${BASE_MODEL}", local_dir="${BASE_DIR}", ignore_patterns=["*.pth","original/*"])
PY
  echo "[serve] pulled: $(ls "$BASE_DIR"/*.safetensors 2>/dev/null | wc -l) safetensors, $(du -sh "$BASE_DIR" 2>/dev/null | cut -f1)"
fi

# ── 2. auto-discover adapters ────────────────────────────────────────────────
LORA_ARGS=()
if [ -d "$ADAPTER_DIR" ]; then
  for d in "$ADAPTER_DIR"/*/; do
    [ -f "${d}adapter_config.json" ] || continue
    LORA_ARGS+=( "qwen3-coder-30b-$(basename "$d")=${d%/}" )
  done
fi
echo "[serve] adapters discovered: ${LORA_ARGS[*]:-<none — serving base only>}"

# ── 3. serve ─────────────────────────────────────────────────────────────────
EXTRA=()
if [ ${#LORA_ARGS[@]} -gt 0 ]; then
  EXTRA+=( --enable-lora --max-lora-rank "$MAX_LORA_RANK" --max-loras "${#LORA_ARGS[@]}" --lora-modules "${LORA_ARGS[@]}" )
fi

echo "[serve] starting vLLM on :$PORT (max-model-len $MAX_MODEL_LEN)…"
exec vllm serve "$BASE_DIR" \
  --served-model-name qwen3-coder-30b-base \
  --max-model-len "$MAX_MODEL_LEN" \
  --host 0.0.0.0 --port "$PORT" \
  "${EXTRA[@]}"
