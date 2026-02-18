#!/usr/bin/env bash
# cipher-session-save.sh — Claude Code SessionEnd hook
# Reads session info from stdin, extracts text turns from JSONL transcript,
# and POSTs them to the bridge for summarization + storage.

set -euo pipefail

LOG_DIR="/tmp/ozzu-bridge"
LOG_FILE="$LOG_DIR/cipher-session-save.log"
BRIDGE_URL="http://localhost:3333/cipher/session-save"

mkdir -p "$LOG_DIR"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"; }

# Read stdin JSON from Claude Code hook
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  log "No transcript file found: $TRANSCRIPT_PATH"
  exit 0
fi

log "Processing session $SESSION_ID from $TRANSCRIPT_PATH"

# Extract user/assistant text turns from JSONL transcript using jq.
# - user messages: type="user", content is a string
# - assistant messages: type="assistant", content is an array, extract type="text" entries
# Skip tool_use, tool_result, thinking, file-history-snapshot entries.
TURNS=$(jq -c '
  if .type == "user" and (.message.content | type) == "string" and (.message.content | length) > 0 then
    { role: "user", content: .message.content }
  elif .type == "assistant" and (.message.content | type) == "array" then
    (.message.content[] | select(.type == "text" and (.text | test("\\S")))) as $t |
    { role: "assistant", content: $t.text }
  else
    empty
  end
' "$TRANSCRIPT_PATH" 2>/dev/null | head -200)

TURN_COUNT=$(echo "$TURNS" | grep -c '^{' || true)

if [ "$TURN_COUNT" -lt 4 ]; then
  log "Only $TURN_COUNT turns — skipping (minimum 4)"
  exit 0
fi

# Build JSON payload: { sessionId, turns: [...] }
PAYLOAD=$(echo "$TURNS" | jq -s '{ sessionId: "'"$SESSION_ID"'", turns: . }')

# POST to bridge in background so we don't block session exit
(
  RESPONSE=$(curl -sf -X POST "$BRIDGE_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --max-time 30 2>&1) || true
  log "Bridge response: $RESPONSE"
) &

log "Dispatched save for session $SESSION_ID ($TURN_COUNT turns)"
