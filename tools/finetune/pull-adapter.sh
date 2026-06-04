#!/usr/bin/env bash
# pull-adapter.sh — Step 9.11 of OFFENSE-FINETUNE-DESIGN.md (dir_1780597331238)
#
# Closes the training loop after run-finetune.sh + tmux session completes.
# Reads the droplet id/ip stashed at $DATASET_DIR/.droplet-{id,ip}, scp's the
# adapter back, registers it in Ollama, and (after operator confirmation)
# destroys the droplet to stop billing.
#
# Usage:
#   ./tools/finetune/pull-adapter.sh                       # auto-discovers droplet
#   ./tools/finetune/pull-adapter.sh --droplet-id 12345    # explicit override
#   ./tools/finetune/pull-adapter.sh --no-destroy          # skip the destroy prompt

set -euo pipefail

DATASET_DIR=/tmp/finetune
DROPLET_ID=""
DROPLET_IP=""
NO_DESTROY=0
ADAPTER_HOME=/home/gcp/ozzu/private/finetune
ADAPTER_NAME=qwen3-32b-ozzu-soc-v1
OLLAMA_TAG=ozzu-soc-v1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --droplet-id)  DROPLET_ID="$2"; shift 2 ;;
    --droplet-ip)  DROPLET_IP="$2"; shift 2 ;;
    --dataset-dir) DATASET_DIR="$2"; shift 2 ;;
    --no-destroy)  NO_DESTROY=1; shift ;;
    --adapter-name) ADAPTER_NAME="$2"; shift 2 ;;
    --ollama-tag)  OLLAMA_TAG="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage: pull-adapter.sh [opts]

Auto-discovers droplet from $DATASET_DIR/.droplet-{id,ip} files (set by
run-finetune.sh). Override with --droplet-id / --droplet-ip if needed.

Options:
  --droplet-id <id>          Override stashed droplet id
  --droplet-ip <ip>          Override stashed droplet ip
  --dataset-dir PATH         Where run-finetune.sh stashed state (default /tmp/finetune)
  --no-destroy               Skip the destroy prompt (operator destroys later manually)
  --adapter-name NAME        Local dir name (default qwen3-32b-ozzu-soc-v1)
  --ollama-tag TAG           Registered model tag (default ozzu-soc-v1)
EOF
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[pull-adapter $(date +%H:%M:%S)] $*"; }

# ─────────────────────────────── auto-discover droplet ───────────────────────────────
if [[ -z "$DROPLET_ID" ]]; then
  if [[ -f "$DATASET_DIR/.droplet-id" ]]; then
    DROPLET_ID=$(cat "$DATASET_DIR/.droplet-id")
    log "auto-discovered droplet id: $DROPLET_ID"
  else
    log "FATAL: no droplet id provided AND no $DATASET_DIR/.droplet-id file. Pass --droplet-id <id>."
    exit 2
  fi
fi
if [[ -z "$DROPLET_IP" ]]; then
  if [[ -f "$DATASET_DIR/.droplet-ip" ]]; then
    DROPLET_IP=$(cat "$DATASET_DIR/.droplet-ip")
    log "auto-discovered droplet ip: $DROPLET_IP"
  else
    # Fall back to DO API lookup
    log "looking up droplet ip from DO API …"
    TOK=$(sudo cat /root/.config/digitalocean/access_token)
    DROPLET_IP=$(curl -sH "Authorization: Bearer $TOK" \
      "https://api.digitalocean.com/v2/droplets/$DROPLET_ID" \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((n['ip_address'] for n in d['droplet']['networks']['v4'] if n['type']=='public'), ''))")
    [[ -z "$DROPLET_IP" ]] && { log "FATAL: could not resolve droplet $DROPLET_ID public ip"; exit 3; }
    log "got ip from DO API: $DROPLET_IP"
  fi
fi

# ─────────────────────────────── step 1: verify training finished ───────────────────────────────
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)

log "=== step 1/4: verify training finished on droplet ==="
TRAIN_STATUS=$(ssh "${SSH_OPTS[@]}" "root@$DROPLET_IP" \
  "tail -c 4000 /root/train.log 2>/dev/null | grep -c 'DONE.*adapter at' || true")
if [[ "${TRAIN_STATUS:-0}" -eq 0 ]]; then
  log "WARN: /root/train.log doesn't contain 'DONE — adapter at' marker."
  log "      Training may still be in progress. Check with:"
  log "        ssh root@$DROPLET_IP 'tail -f /root/train.log'"
  read -r -p "  Continue anyway and pull whatever's on the droplet? [y/N] " GO
  [[ "${GO,,}" =~ ^y(es)?$ ]] || { log "aborted"; exit 4; }
fi

# Verify the output dir exists on the droplet
REMOTE_OUT=$(ssh "${SSH_OPTS[@]}" "root@$DROPLET_IP" \
  "ls -d /root/output/ozzu-soc-v1 2>/dev/null && ls /root/output/ozzu-soc-v1/final-adapter/ 2>/dev/null | head -5")
if [[ -z "$REMOTE_OUT" ]]; then
  log "FATAL: no /root/output/ozzu-soc-v1/ on droplet. Training never produced output."
  exit 5
fi
log "remote output verified:"
echo "$REMOTE_OUT" | sed 's/^/  | /'

# ─────────────────────────────── step 2: scp adapter back ───────────────────────────────
LOCAL_DIR="$ADAPTER_HOME/$ADAPTER_NAME"
log "=== step 2/4: scp adapter back to $LOCAL_DIR ==="
mkdir -p "$LOCAL_DIR"
scp -r "${SSH_OPTS[@]}" "root@$DROPLET_IP:/root/output/ozzu-soc-v1/." "$LOCAL_DIR/"

# Sanity-check files
for required in manifest.json final-adapter/adapter_config.json final-adapter/adapter_model.safetensors; do
  if [[ ! -e "$LOCAL_DIR/$required" ]]; then
    log "FATAL: expected file missing after scp: $LOCAL_DIR/$required"
    exit 6
  fi
done
log "adapter files verified locally"

# ─────────────────────────────── step 3: register in Ollama ───────────────────────────────
log "=== step 3/4: register adapter with Ollama as $OLLAMA_TAG ==="
bash "$ROOT/deploy/load.sh" \
  --manifest "$LOCAL_DIR/manifest.json" \
  --tag "$OLLAMA_TAG"

# ─────────────────────────────── step 4: prompt destroy ───────────────────────────────
log "=== step 4/4: destroy droplet (CRITICAL — stop \$1.99/hr billing) ==="
if [[ "$NO_DESTROY" -eq 1 ]]; then
  log "skipping destroy (--no-destroy). Run manually when done:"
  log "  sudo node $ROOT/do-droplet/do-gpu.js destroy $DROPLET_ID"
  exit 0
fi

read -r -p "Destroy droplet $DROPLET_ID now? [Y/n] " GO
GO=${GO:-Y}
if [[ "${GO,,}" =~ ^y(es)?$ ]]; then
  sudo node "$ROOT/do-droplet/do-gpu.js" destroy "$DROPLET_ID"
  # Clean up stash files
  rm -f "$DATASET_DIR/.droplet-id" "$DATASET_DIR/.droplet-ip" 2>/dev/null || true
  log "DONE. Adapter at $LOCAL_DIR. Registered as $OLLAMA_TAG. Billing stopped."
  log ""
  log "Next: when eval confirms ozzu-soc-v1 beats base qwen3:32b, swap the bridge default:"
  log "  sudo sed -i 's/^OFFENSE_MODEL_NAME=.*/OFFENSE_MODEL_NAME=$OLLAMA_TAG/' /home/gcp/ozzu/backend/.env"
  log "  cd /home/gcp/ozzu/backend && docker compose up -d bridge"
else
  log "skipped destroy. Run manually when done:"
  log "  sudo node $ROOT/do-droplet/do-gpu.js destroy $DROPLET_ID"
fi
