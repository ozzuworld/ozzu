#!/usr/bin/env bash
# sync-token-usage.sh — Parse Claude Code JSONL session files and extract token usage to postgres
# Uses bridge API (not psql directly). Runs every 5 min via cron.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

BRIDGE_URL="http://localhost:3333"
JSONL_DIR="/root/.claude/projects/-home-gcp-ozzu-scripts"
MARKER_FILE="/tmp/ozzu-bridge/token-sync-marker"
LOG_FILE="/tmp/ozzu-bridge/token-sync.log"
LOCK_FILE="/tmp/ozzu-bridge/token-sync.lock"
STATE_FILE="/tmp/ozzu-bridge/token-synced-sessions.txt"

mkdir -p /tmp/ozzu-bridge
touch "$STATE_FILE"

log() { echo "[$(date -Is)] $*" >> "$LOG_FILE"; }

# Prevent concurrent runs
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -lt 300 ]; then
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Check bridge is up
if ! curl -sf "$BRIDGE_URL/health" > /dev/null 2>&1; then
  exit 0
fi

SYNCED=0

for jsonl_file in "$JSONL_DIR"/*.jsonl; do
  [ -f "$jsonl_file" ] || continue

  session_id=$(basename "$jsonl_file" .jsonl)

  # Skip if already synced
  if grep -qF "$session_id" "$STATE_FILE" 2>/dev/null; then
    continue
  fi

  # Only sync sessions that haven't been modified in 2+ minutes (likely closed)
  FILE_AGE=$(( $(date +%s) - $(stat -c %Y "$jsonl_file" 2>/dev/null || echo 0) ))
  if [ "$FILE_AGE" -lt 120 ]; then
    continue
  fi

  # Extract token usage with python
  USAGE=$(python3 -c "
import json, sys

input_tokens = 0
output_tokens = 0
cache_read = 0
cache_create = 0
model = ''

with open(sys.argv[1], 'r') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except:
            continue
        if msg.get('type') != 'assistant':
            continue
        m = msg.get('message', {})
        if not model and m.get('model'):
            model = m['model']
        u = m.get('usage', {})
        input_tokens += u.get('input_tokens', 0)
        output_tokens += u.get('output_tokens', 0)
        cache_read += u.get('cache_read_input_tokens', 0)
        cache_create += u.get('cache_creation_input_tokens', 0)

if input_tokens + output_tokens > 0:
    print(json.dumps({
        'model': model,
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'cache_read': cache_read,
        'cache_create': cache_create
    }))
" "$jsonl_file" 2>/dev/null || echo "")

  if [ -z "$USAGE" ]; then
    echo "$session_id" >> "$STATE_FILE"
    continue
  fi

  # POST to bridge — use a dedicated endpoint for token ingestion
  RESULT=$(curl -sf -X POST "$BRIDGE_URL/ops/token-usage/ingest" \
    -H "Content-Type: application/json" \
    -d "{\"source\":\"cli_session\",\"session_id\":\"$session_id\",\"usage\":$USAGE}" 2>/dev/null || echo "")

  if echo "$RESULT" | grep -q '"ok":true' 2>/dev/null; then
    echo "$session_id" >> "$STATE_FILE"
    SYNCED=$((SYNCED + 1))
    log "Synced $session_id"
  fi
done

if [ "$SYNCED" -gt 0 ]; then
  log "Synced $SYNCED sessions"
fi
