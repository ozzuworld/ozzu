#!/usr/bin/env bash
# bootstrap.sh — Step 9.3 of OFFENSE-FINETUNE-DESIGN.md (dir_1780595203692)
#
# Runs ON a freshly-provisioned DigitalOcean gpu-mi300x1-192gb droplet to
# install everything train.py needs: ROCm-flavored PyTorch + HuggingFace
# stack + FlashAttention CK + (optional) DeepSpeed.
#
# Usage from the bridge:
#   ssh root@<droplet-ip> 'bash -s' < tools/finetune/do-droplet/bootstrap.sh
#
# Idempotent — re-running is a no-op for already-installed pieces. Pinned
# versions for reproducibility. Single-GPU path by default (no DeepSpeed
# needed for ONE MI300X with 192 GB VRAM — full bf16 LoRA fits easily).

set -euo pipefail

# ─────────────────────────────── version pins ───────────────────────────────
# Bumped 2026-06-04 to versions known to work together on ROCm 6.2.
ROCM_VERSION="6.2"
PYTORCH_INDEX="https://download.pytorch.org/whl/rocm${ROCM_VERSION}"
TORCH_VERSION="2.5.1+rocm${ROCM_VERSION}"
TRANSFORMERS_VERSION="4.46.3"
PEFT_VERSION="0.13.2"
ACCELERATE_VERSION="1.1.1"
DATASETS_VERSION="3.1.0"
TRL_VERSION="0.12.1"
DEEPSPEED_VERSION="0.16.1"   # optional; only needed for multi-GPU scaling
INSTALL_DEEPSPEED="${INSTALL_DEEPSPEED:-0}"   # set =1 to install
INSTALL_FLASH_ATTN="${INSTALL_FLASH_ATTN:-1}" # set =0 to skip (CK build takes time)

log() { echo "[bootstrap] $*" >&2; }

# ─────────────────────────────── preflight ───────────────────────────────
if [[ "$(id -u)" -ne 0 ]]; then
  echo "[bootstrap] FATAL: must run as root on the droplet" >&2
  exit 2
fi

log "OS: $(uname -srm)"
log "Distro: $(lsb_release -ds 2>/dev/null || cat /etc/os-release | grep PRETTY_NAME | head -1)"

# ─────────────────────────────── system deps ───────────────────────────────
log "apt update + base build deps"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq --no-install-recommends \
  build-essential ca-certificates curl git gnupg2 lsb-release \
  python3 python3-pip python3-venv python3-dev \
  pkg-config libnuma1 libnuma-dev \
  htop ncdu jq tmux

# ─────────────────────────────── ROCm sanity ───────────────────────────────
# DO MI300X droplets should ship with ROCm pre-installed. If rocm-smi isn't
# there, fail loudly — we don't try to install ROCm from scratch on a generic
# Ubuntu image (that's a separate ~30-min build).
if ! command -v rocm-smi >/dev/null 2>&1; then
  log "FATAL: rocm-smi not on PATH. The droplet doesn't have ROCm installed."
  log "       This script assumes DO's GPU-ready image (gpu-h100x1-base or similar)."
  log "       To install ROCm from scratch, follow: https://rocm.docs.amd.com/projects/install-on-linux/"
  exit 3
fi
log "ROCm detected: $(rocm-smi --showproductname 2>/dev/null | head -3 | tail -1 || echo 'OK')"
log "GPU(s) visible:"
rocm-smi --showid --showtemp --showuse --showvbios 2>&1 | head -20 || true

# ─────────────────────────────── python env ───────────────────────────────
# Use a venv in /opt/ozzu-train so we don't pollute system pip.
VENV=/opt/ozzu-train/venv
if [[ ! -d "$VENV" ]]; then
  log "creating venv at $VENV"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --upgrade pip wheel setuptools >/dev/null

# ─────────────────────────────── pytorch (ROCm) ───────────────────────────────
if python3 -c "import torch; assert '$ROCM_VERSION' in torch.__version__" 2>/dev/null; then
  log "PyTorch already installed: $(python3 -c 'import torch; print(torch.__version__)')"
else
  log "installing PyTorch $TORCH_VERSION from $PYTORCH_INDEX (this is ~3 GB, ~5 min)"
  pip install --index-url "$PYTORCH_INDEX" \
    "torch==$TORCH_VERSION" torchvision torchaudio 2>&1 | tail -3
fi

# Sanity — does PyTorch see the MI300X?
python3 - <<'PY'
import torch
print(f"[bootstrap] torch={torch.__version__}")
print(f"[bootstrap] cuda.is_available={torch.cuda.is_available()}")
if torch.cuda.is_available():
    for i in range(torch.cuda.device_count()):
        p = torch.cuda.get_device_properties(i)
        print(f"[bootstrap] device {i}: {p.name} · {p.total_memory / 1024**3:.1f} GiB · CC {p.major}.{p.minor}")
else:
    print("[bootstrap] WARNING: PyTorch does NOT see the GPU. Check ROCm install + HSA_OVERRIDE_GFX_VERSION env.")
PY

# ─────────────────────────────── HF stack ───────────────────────────────
log "installing HuggingFace stack"
pip install \
  "transformers==$TRANSFORMERS_VERSION" \
  "peft==$PEFT_VERSION" \
  "accelerate==$ACCELERATE_VERSION" \
  "datasets==$DATASETS_VERSION" \
  "trl==$TRL_VERSION" \
  bitsandbytes-rocm \
  sentencepiece einops \
  2>&1 | tail -3 || {
  log "WARNING: bitsandbytes-rocm may have failed — that's OK for bf16-LoRA (we don't need 4-bit on 192GB VRAM)"
}

# ─────────────────────────────── deepspeed (optional) ───────────────────────────────
if [[ "$INSTALL_DEEPSPEED" == "1" ]]; then
  log "installing DeepSpeed $DEEPSPEED_VERSION (multi-GPU support — not needed for 1× MI300X)"
  pip install "deepspeed==$DEEPSPEED_VERSION" 2>&1 | tail -3
else
  log "skipping DeepSpeed (single MI300X has enough VRAM; set INSTALL_DEEPSPEED=1 to install)"
fi

# ─────────────────────────────── flash-attention (CK backend) ───────────────────────────────
# AMD's flash-attention port is at github.com/ROCm/flash-attention. Building it
# from source is ~10-15 min. PyTorch ROCm 2.5+ also has SDPA's built-in flash
# kernel so this is mostly a perf optimization — not strictly required.
if [[ "$INSTALL_FLASH_ATTN" == "1" ]]; then
  if python3 -c "import flash_attn" 2>/dev/null; then
    log "flash-attention already installed"
  else
    log "building flash-attention from source (CK backend, ~10-15 min)"
    cd /tmp
    if [[ ! -d flash-attention ]]; then
      git clone --depth 1 --branch main_perf https://github.com/ROCm/flash-attention.git
    fi
    cd flash-attention
    export FLASH_ATTENTION_FORCE_BUILD=TRUE
    pip install . 2>&1 | tail -5 || {
      log "WARNING: flash-attention build failed — falling back to PyTorch SDPA"
    }
    cd /
  fi
else
  log "skipping flash-attention (using PyTorch SDPA fallback)"
fi

# ─────────────────────────────── disk + workspace ───────────────────────────────
mkdir -p /root/dataset /root/output /root/cache
export HF_HOME=/root/cache/hf
export TRANSFORMERS_CACHE=/root/cache/hf/transformers
export HF_DATASETS_CACHE=/root/cache/hf/datasets
# Persist these in the venv activate so train.py picks them up
cat >> "$VENV/bin/activate" <<'EOF'

# ozzu-train cache paths (set by bootstrap.sh)
export HF_HOME=/root/cache/hf
export TRANSFORMERS_CACHE=/root/cache/hf/transformers
export HF_DATASETS_CACHE=/root/cache/hf/datasets
EOF

# ─────────────────────────────── done ───────────────────────────────
log ""
log "=== bootstrap complete ==="
log "venv:           $VENV"
log "dataset path:   /root/dataset/"
log "output path:    /root/output/"
log "HF cache:       /root/cache/hf/"
log ""
log "next: scp your train.jsonl to /root/dataset/, then run train.py"
log "      (train.py lands in a future directive)"
log ""
log "verify GPU access one more time:"
python3 -c "import torch; print('  torch.cuda.is_available:', torch.cuda.is_available()); print('  device count:', torch.cuda.device_count() if torch.cuda.is_available() else 0)"
