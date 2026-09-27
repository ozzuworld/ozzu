#!/usr/bin/env bash
# suricata-alert-poller.sh — incrementally pull EVE alerts from ozzu-edge over ssh,
# append to daily JSONL under private/defensive-sensor-grid/alerts/ and keep a rolling
# status JSON the bridge can serve later. Pattern: wg-state-poller.sh (oneshot + 60s timer).
# Engagement SKYLINE-SOC-2026-106 · 2026-09-25
set -euo pipefail

EDGE="${SURICATA_EDGE:-root@32.195.174.19}"
EVE="/var/log/suricata/eve.json"
STATE_DIR="/home/gcp/ozzu/data/infra"
OFFSET_FILE="$STATE_DIR/suricata-eve.offset"
OUT_DIR="/home/gcp/ozzu/private/defensive-sensor-grid/alerts"
STATUS="$STATE_DIR/suricata-status.json"
mkdir -p "$OUT_DIR" "$STATE_DIR"
now=$(date +%s)

offset=$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)
size=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$EDGE" "stat -c%s $EVE 2>/dev/null || echo 0")
size=${size:-0}

# log rotation on edge: size shrank below offset -> restart from 0
[ "$size" -lt "$offset" ] && offset=0

write_status() { # $1=new_alerts
  local new="$1" top='[]' t
  if compgen -G "$OUT_DIR/alerts-*.jsonl" >/dev/null 2>&1; then
    t=$(tail -n 2000 "$OUT_DIR"/alerts-*.jsonl \
        | jq -r 'select(.event_type=="alert") | .alert.signature' 2>/dev/null \
        | sort | uniq -c | sort -rn | head -5 | sed 's/^ *//' | jq -R . | jq -s . 2>/dev/null) || true
    [ -n "${t:-}" ] && top="$t"
  fi
  jq -n --argjson now "$now" --argjson new "$new" --argjson size "$size" --argjson off "$offset" --argjson top "$top" \
    '{generated_at:$now, eve_bytes:$size, offset:$off, new_alerts_last_run:$new, top_signatures_rolling:$top}' > "$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
}

if [ "$size" -le "$offset" ]; then
  write_status 0
  echo "$size" > "$OFFSET_FILE"
  exit 0
fi

chunk=$(mktemp)
trap 'rm -f "$chunk"' EXIT
ssh -o BatchMode=yes -o ConnectTimeout=10 "$EDGE" "tail -c +$((offset+1)) $EVE" > "$chunk"
new=$(grep -c '"event_type":"alert"' "$chunk" 2>/dev/null || true)
new=${new:-0}
if [ "$new" -gt 0 ]; then
  grep '"event_type":"alert"' "$chunk" >> "$OUT_DIR/alerts-$(date -u +%Y%m%d).jsonl"
fi
echo "$size" > "$OFFSET_FILE"
write_status "$new"
