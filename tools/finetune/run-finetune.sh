#!/usr/bin/env bash
# run-finetune.sh — Step 9.10 of OFFENSE-FINETUNE-DESIGN.md (dir_1780597215635)
#
# One-command operator wrapper. Chains the existing scripts:
#   1. dataset/build-wrn.py        — WhiteRabbitNeo HF download
#   2. dataset/scrape-writeups.py  — 0xdf writeups (optional, --writeups-repo)
#   3. dataset/export-our-transcripts.py — telemetry → JSONL (optional)
#   4. dataset/merge.py            — combine + train/eval split
#   5. do-droplet/do-gpu.js create — rent MI300X
#   6. bootstrap.sh                — install ROCm+PyTorch+HF on droplet
#   7. scp dataset                 — push train+eval to droplet
#   8. ssh tmux train.py           — kick off training (detached)
#
# Output: prints the droplet IP + tmux session name. Operator then runs:
#   ssh root@<ip> 'tail -f /root/train.log'           # watch progress
#   ssh root@<ip> 'tmux attach -t train'              # attach + detach with Ctrl-b d
#   ./tools/finetune/pull-adapter.sh <droplet-id>     # when finished (TBD)
#   node tools/finetune/do-droplet/do-gpu.js destroy <droplet-id>   # CRITICAL stop billing
#
# Never auto-destroys the droplet. That's a deliberate manual step for safety
# (operator confirms training succeeded + adapter scp'd back BEFORE killing).

set -euo pipefail

# ─────────────────────────────── defaults + args ───────────────────────────────
SSH_KEY_ID=""
MAX_HOURS=20
WRITEUPS_REPO=""
SKIP_TRANSCRIPTS=0
DATASET_DIR=/tmp/finetune
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-key-id)        SSH_KEY_ID="$2"; shift 2 ;;
    --max-hours)         MAX_HOURS="$2"; shift 2 ;;
    --writeups-repo)     WRITEUPS_REPO="$2"; shift 2 ;;
    --skip-transcripts)  SKIP_TRANSCRIPTS=1; shift ;;
    --dataset-dir)       DATASET_DIR="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage: run-finetune.sh --ssh-key-id <id> [opts]

Required:
  --ssh-key-id <id>          DO SSH key id (look up via DO API or web dashboard)

Optional:
  --max-hours N              Budget annotation (default 20 → ~\$$(awk "BEGIN{printf \"%.2f\", $MAX_HOURS * 1.99}") max @ \$1.99/hr)
  --writeups-repo PATH       Local clone of 0xdf's gitlab repo; omit to skip writeups corpus
  --skip-transcripts         Skip the export-our-transcripts.py step
  --dataset-dir PATH         Where to assemble corpora (default ${DATASET_DIR})
  -h, --help                 This message
EOF
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SSH_KEY_ID" ]]; then
  echo "[run-finetune] FATAL: --ssh-key-id is required (DO needs a key to authorize root@droplet)" >&2
  echo "[run-finetune] To list: curl -H \"Authorization: Bearer \$(sudo cat /root/.config/digitalocean/access_token)\" https://api.digitalocean.com/v2/account/keys" >&2
  exit 2
fi

log() { echo "[run-finetune $(date +%H:%M:%S)] $*"; }

# ─────────────────────────────── step 1-4: dataset ───────────────────────────────
mkdir -p "$DATASET_DIR"
log "=== STEP 1/8: build WhiteRabbitNeo corpus ==="
python3 "$ROOT/finetune/dataset/build-wrn.py" --out "$DATASET_DIR/wrn.jsonl"

if [[ -n "$WRITEUPS_REPO" ]]; then
  log "=== STEP 2/8: scrape 0xdf writeups from $WRITEUPS_REPO ==="
  python3 "$ROOT/finetune/dataset/scrape-writeups.py" --repo "$WRITEUPS_REPO" --out "$DATASET_DIR/writeups.jsonl"
  INCLUDE_WRITEUPS="$DATASET_DIR/writeups.jsonl"
else
  log "=== STEP 2/8: skipping writeups corpus (no --writeups-repo)"
  INCLUDE_WRITEUPS=""
fi

if [[ "$SKIP_TRANSCRIPTS" -eq 0 ]]; then
  log "=== STEP 3/8: export our agent transcripts (anonymized) ==="
  PGHOST="${PGHOST:-postgres}" \
  PGUSER="${PGUSER:-ozzu}" \
  PGPASSWORD="${PGPASSWORD:-$(grep -E '^POSTGRES_PASSWORD=' /home/gcp/ozzu/backend/.env | cut -d= -f2- | tr -d '"')}" \
    python3 "$ROOT/finetune/dataset/export-our-transcripts.py" --out "$DATASET_DIR/agent.jsonl" \
      --statuses completed,idle --min-iter 3 \
      || log "WARN: transcript export failed (likely no completed engagements yet) — continuing without it"
  [[ -s "$DATASET_DIR/agent.jsonl" ]] && INCLUDE_AGENT="$DATASET_DIR/agent.jsonl" || INCLUDE_AGENT=""
else
  log "=== STEP 3/8: skipping transcripts (--skip-transcripts)"
  INCLUDE_AGENT=""
fi

log "=== STEP 4/8: merge corpora into train + eval ==="
INPUTS=("$DATASET_DIR/wrn.jsonl")
[[ -n "$INCLUDE_WRITEUPS" ]] && INPUTS+=("$INCLUDE_WRITEUPS")
[[ -n "$INCLUDE_AGENT"   ]] && INPUTS+=("$INCLUDE_AGENT")
python3 "$ROOT/finetune/dataset/merge.py" \
  --inputs "${INPUTS[@]}" \
  --out "$DATASET_DIR/train.jsonl" \
  --eval-out "$DATASET_DIR/eval.jsonl" \
  --eval-frac 0.05 --seed 42

TRAIN_LINES=$(wc -l < "$DATASET_DIR/train.jsonl")
EVAL_LINES=$(wc -l < "$DATASET_DIR/eval.jsonl")
log "dataset assembled: $TRAIN_LINES training rows, $EVAL_LINES eval rows"

# ─────────────────────────────── step 5: provision droplet ───────────────────────────────
log "=== STEP 5/8: provision DO MI300X droplet (real spend starts now @ \$1.99/hr) ==="
CREATE_OUT=$(sudo node "$ROOT/finetune/do-droplet/do-gpu.js" create \
  --ssh-key-id "$SSH_KEY_ID" --max-hours "$MAX_HOURS" 2>&1)
echo "$CREATE_OUT"

DROPLET_ID=$(echo "$CREATE_OUT" | grep -oP 'droplet created: id=\K\d+' | head -1)
DROPLET_IP=$(echo "$CREATE_OUT" | grep -oP 'active\. id=\d+ ip=\K[\d.]+' | head -1)

if [[ -z "$DROPLET_ID" || -z "$DROPLET_IP" ]]; then
  log "FATAL: failed to extract droplet id/ip from create output. Check DO dashboard." >&2
  exit 3
fi
log "droplet ready: id=$DROPLET_ID ip=$DROPLET_IP"

# Stash IDs so the operator can recover them later
echo "$DROPLET_ID" > "$DATASET_DIR/.droplet-id"
echo "$DROPLET_IP" > "$DATASET_DIR/.droplet-ip"

# ─────────────────────────────── step 6-7: bootstrap + push ───────────────────────────────
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)

log "=== STEP 6/8: bootstrap droplet (~10-15 min) ==="
ssh "${SSH_OPTS[@]}" "root@$DROPLET_IP" 'bash -s' < "$ROOT/finetune/do-droplet/bootstrap.sh" 2>&1 | sed 's/^/  | /'

log "=== STEP 7/8: scp dataset + train.py to droplet ==="
ssh "${SSH_OPTS[@]}" "root@$DROPLET_IP" 'mkdir -p /root/dataset'
scp "${SSH_OPTS[@]}" "$DATASET_DIR/train.jsonl" "$DATASET_DIR/eval.jsonl" "root@$DROPLET_IP:/root/dataset/"
scp "${SSH_OPTS[@]}" "$ROOT/finetune/do-droplet/train.py"              "root@$DROPLET_IP:/root/"

# ─────────────────────────────── step 8: kick off training ───────────────────────────────
log "=== STEP 8/8: kick off training under tmux (detached) ==="
TRAIN_CMD="cd /root && source /opt/ozzu-train/venv/bin/activate && python3 train.py \
  --base-model Qwen/Qwen3-32B \
  --dataset /root/dataset/train.jsonl \
  --eval-dataset /root/dataset/eval.jsonl \
  --output-dir /root/output/ozzu-soc-v1 \
  --epochs 3 2>&1 | tee /root/train.log"
ssh "${SSH_OPTS[@]}" "root@$DROPLET_IP" "tmux new-session -d -s train \"$TRAIN_CMD\""

cat <<EOF

═══════════════════════════════════════════════════════════════════════════
  TRAINING KICKED OFF — droplet id=$DROPLET_ID @ \$1.99/hr
═══════════════════════════════════════════════════════════════════════════

Watch progress:
  ssh root@$DROPLET_IP 'tail -f /root/train.log'

Attach to tmux (Ctrl-b d to detach):
  ssh root@$DROPLET_IP 'tmux attach -t train'

When training completes (log shows DONE):
  mkdir -p /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1
  scp -r root@$DROPLET_IP:/root/output/ozzu-soc-v1/. \\
         /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/
  bash $ROOT/finetune/deploy/load.sh \\
       --manifest /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/manifest.json

CRITICAL — destroy droplet when done (stops billing):
  sudo node $ROOT/finetune/do-droplet/do-gpu.js destroy $DROPLET_ID

Budget annotation: --max-hours $MAX_HOURS → roughly \$$(awk "BEGIN{printf \"%.2f\", $MAX_HOURS * 1.99}") at cap
EOF
