#!/usr/bin/env bash
# sync-token-usage.sh — Parse Claude Code JSONL session files and extract token usage to postgres
# Designed to run via cron alongside sync-sessions-to-db.sh
set -euo pipefail

PROJECTS_DIR="$HOME/.claude/projects"
DB_NAME="ozzu"
DB_USER="ozzu"
DB_HOST="127.0.0.1"
MARKER_FILE="/tmp/ozzu-bridge/token-sync-marker"
LOG_FILE="/tmp/ozzu-bridge/token-sync.log"

mkdir -p /tmp/ozzu-bridge

log() { echo "[$(date -Is)] $*" >> "$LOG_FILE"; }

# Find all JSONL session files modified since last sync
LAST_SYNC=0
if [[ -f "$MARKER_FILE" ]]; then
  LAST_SYNC=$(cat "$MARKER_FILE")
fi

SYNCED=0

find "$PROJECTS_DIR" -name "*.jsonl" -newer "$MARKER_FILE" 2>/dev/null | while read -r jsonl_file; do
  session_id=$(basename "$jsonl_file" .jsonl)

  # Check if we already synced this session's tokens
  EXISTS=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT COUNT(*) FROM token_usage WHERE session_id = '$session_id' AND source = 'cli_session'" 2>/dev/null || echo "0")

  if [[ "$EXISTS" != "0" ]]; then
    continue
  fi

  # Extract token usage from all assistant messages in the JSONL
  # Each line with "usage" contains token counts
  USAGE=$(python3 -c "
import json, sys

input_tokens = 0
output_tokens = 0
cache_read = 0
cache_create = 0
model = ''

with open('$jsonl_file', 'r') as f:
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
    print(f'{model}|{input_tokens}|{output_tokens}|{cache_read}|{cache_create}')
else:
    print('')
" 2>/dev/null || echo "")

  if [[ -z "$USAGE" ]]; then
    continue
  fi

  IFS='|' read -r MODEL INPUT OUTPUT CACHE_READ CACHE_CREATE <<< "$USAGE"

  # Insert into postgres
  psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c \
    "INSERT INTO token_usage (source, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, metadata)
     VALUES ('cli_session', '$session_id', '$MODEL', $INPUT, $OUTPUT, $CACHE_READ, $CACHE_CREATE, 0, '{}'::jsonb)
     ON CONFLICT DO NOTHING" 2>/dev/null && {
    SYNCED=$((SYNCED + 1))
    log "Synced session $session_id: ${MODEL} in=${INPUT} out=${OUTPUT} cache_r=${CACHE_READ} cache_c=${CACHE_CREATE}"
  }
done

# Update marker
touch "$MARKER_FILE"

if [[ "$SYNCED" -gt 0 ]]; then
  log "Synced $SYNCED sessions"
fi
