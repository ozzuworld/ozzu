#!/usr/bin/env bash
# poll-gpu-access.sh
#
# Polls DigitalOcean's /sizes API every N minutes and surfaces when
# GPU droplets become available — i.e., when King Kazuma's account
# is approved for GPU access.
#
# Writes a marker file at /tmp/do-gpu-ready when approval lands so
# downstream tools / human eyes can detect the state change.
#
# Run in a tmux/screen or backgrounded; it'll exit cleanly after the
# first successful detection (or on Ctrl-C).
#
# Usage:
#   bash /home/gcp/ozzu/tools/finetune/do-droplet/poll-gpu-access.sh
#   POLL_INTERVAL_MIN=10 bash poll-gpu-access.sh   # poll every 10 min instead of 15

set -uo pipefail

POLL_INTERVAL_MIN="${POLL_INTERVAL_MIN:-15}"
TARGET_SLUG="${TARGET_SLUG:-gpu-mi300x1-192gb}"
MARKER="/tmp/do-gpu-ready"
GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'

TOK=$(sudo cat /root/.config/digitalocean/access_token 2>/dev/null)
if [[ -z "$TOK" ]]; then
  echo "FATAL: no DO token at /root/.config/digitalocean/access_token"
  exit 2
fi

echo "[poll-gpu-access] watching for $TARGET_SLUG availability"
echo "[poll-gpu-access] poll interval: $POLL_INTERVAL_MIN min"
echo "[poll-gpu-access] marker on success: $MARKER"
echo

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
    echo "{\"slug\":\"$TARGET_SLUG\",\"regions\":\"$REGIONS\",\"ready_at\":\"$TS\"}" > "$MARKER"
    echo
    echo "${GREEN}🎯 GPU ACCESS GRANTED${RESET} — kick off training:"
    echo
    echo "  bash /home/gcp/ozzu/tools/finetune/run-finetune.sh \\"
    echo "    --ssh-key-id 56866171 \\"
    echo "    --dataset-dir /home/gcp/ozzu/private/finetune/dataset-v1.1"
    echo
    echo "(marker file: $MARKER)"
    exit 0
  fi
  echo "[$TS] check #$CHECK: ${YELLOW}not yet${RESET} (regions empty) — sleeping ${POLL_INTERVAL_MIN}m"
  sleep "$((POLL_INTERVAL_MIN * 60))"
done
