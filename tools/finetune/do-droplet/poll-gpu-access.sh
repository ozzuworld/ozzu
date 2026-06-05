#!/usr/bin/env bash
# poll-gpu-access.sh
#
# Polls DigitalOcean's /sizes API every 5 min for GPU droplet availability.
# On success:
#   - prints kick-off command
#   - writes /tmp/do-gpu-ready marker file with JSON + the launch command
#   - creates a notification directive in the bridge so King Kazuma sees
#     it in the Ozzu app
#   - exits cleanly
#
# Run via tmux/screen so it survives terminal disconnect:
#   tmux new-session -d -s gpu-poll 'bash poll-gpu-access.sh'

set -uo pipefail

POLL_INTERVAL_MIN="${POLL_INTERVAL_MIN:-5}"
TARGET_SLUG="${TARGET_SLUG:-gpu-mi300x1-192gb}"
MARKER="/tmp/do-gpu-ready"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"
SSH_KEY_ID="${SSH_KEY_ID:-56866171}"
DATASET_DIR="${DATASET_DIR:-/home/gcp/ozzu/private/finetune/dataset-v1.3}"
GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'

TOK=$(sudo cat /root/.config/digitalocean/access_token 2>/dev/null)
if [[ -z "$TOK" ]]; then
  echo "FATAL: no DO token at /root/.config/digitalocean/access_token"
  exit 2
fi

# Pull bridge API key for directive creation
BRIDGE_API_KEY=$(grep -E '^BRIDGE_API_KEY=' /home/gcp/ozzu/backend/.env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)

echo "[poll-gpu-access] target: $TARGET_SLUG"
echo "[poll-gpu-access] poll interval: $POLL_INTERVAL_MIN min"
echo "[poll-gpu-access] marker on success: $MARKER"
echo "[poll-gpu-access] notify directive on bridge: $BRIDGE_URL"
echo

create_notification_directive() {
  local regions="$1"
  if [[ -z "$BRIDGE_API_KEY" ]]; then
    echo "[poll-gpu-access] WARN: no BRIDGE_API_KEY in /home/gcp/ozzu/backend/.env — skipping directive notification"
    return 1
  fi
  curl -sf -X POST "$BRIDGE_URL/directives" \
    -H "Authorization: Bearer $BRIDGE_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(cat <<EOF
{
  "title": "🚀 DO MI300X access GRANTED — ready to train",
  "description": "DigitalOcean GPU access just landed. $TARGET_SLUG is available in regions: $regions. Kick-off command (preflight already passed):\n\n  bash /home/gcp/ozzu/tools/finetune/run-finetune.sh \\\\\n    --ssh-key-id $SSH_KEY_ID \\\\\n    --dataset-dir $DATASET_DIR\n\nCost: ~\$30-40, wall-clock ~10-20h. Watch /root/train.log per SOC-TRAINING-HYPERPARAMS.md first-30-min checklist.",
  "type": "quick",
  "emoji": "🚀"
}
EOF
    )" > /tmp/poll-gpu-notify.log 2>&1
  echo "[poll-gpu-access] directive notification: $(cat /tmp/poll-gpu-notify.log | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id", "FAIL"))' 2>/dev/null || echo 'FAIL')"
}

CHECK=0
while :; do
  CHECK=$((CHECK + 1))
  TS=$(date '+%Y-%m-%d %H:%M:%S')
  REGIONS=$(curl -sH "Authorization: Bearer $TOK" \
    "https://api.digitalocean.com/v2/sizes?per_page=200" \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
for s in d.get('sizes', []):
    if s.get('slug') == '$TARGET_SLUG':
        print(','.join(s.get('regions', [])))
        break
" 2>/dev/null)

  if [[ -n "$REGIONS" ]]; then
    echo "[$TS] check #$CHECK: ${GREEN}✓ AVAILABLE${RESET} in regions: $REGIONS"
    cat <<EOF > "$MARKER"
{
  "slug": "$TARGET_SLUG",
  "regions": "$REGIONS",
  "ready_at": "$TS",
  "kick_off_command": "bash /home/gcp/ozzu/tools/finetune/run-finetune.sh --ssh-key-id $SSH_KEY_ID --dataset-dir $DATASET_DIR"
}
EOF
    create_notification_directive "$REGIONS"
    echo
    echo "${GREEN}🎯 GPU ACCESS GRANTED${RESET}"
    echo "Marker file: $MARKER"
    echo "Notification directive sent to bridge."
    echo
    echo "Kick off training:"
    echo
    echo "  bash /home/gcp/ozzu/tools/finetune/run-finetune.sh \\"
    echo "    --ssh-key-id $SSH_KEY_ID \\"
    echo "    --dataset-dir $DATASET_DIR"
    exit 0
  fi
  echo "[$TS] check #$CHECK: ${YELLOW}not yet${RESET} — sleeping ${POLL_INTERVAL_MIN}m"
  sleep "$((POLL_INTERVAL_MIN * 60))"
done
