#!/usr/bin/env bash
# cipher-session-save.sh — Claude Code SessionEnd hook
# Reads session info from stdin, extracts ALL text turns from JSONL transcript,
# and POSTs them to the bridge for storage in postgres.
# Every word, every turn, no truncation, no limits.

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

# Extract ALL user/assistant text turns from JSONL transcript.
# No head limit — every single turn gets saved.
TURNS=$(jq -c '
  if .type == "user" and (.message.content | type) == "string" and (.message.content | length) > 0 then
    { role: "user", content: .message.content }
  elif .type == "assistant" and (.message.content | type) == "array" then
    (.message.content[] | select(.type == "text" and (.text | test("\\S")))) as $t |
    { role: "assistant", content: $t.text }
  else
    empty
  end
' "$TRANSCRIPT_PATH" 2>/dev/null)

TURN_COUNT=$(echo "$TURNS" | grep -c '^{' || true)

if [ "$TURN_COUNT" -lt 1 ]; then
  log "No turns found — skipping"
  exit 0
fi

# Build JSON payload: { sessionId, turns: [...] }
PAYLOAD=$(echo "$TURNS" | jq -s '{ sessionId: "'"$SESSION_ID"'", turns: . }')

# POST to bridge — wait for it to complete (don't background, ensure it finishes)
RESPONSE=$(curl -sf -X POST "$BRIDGE_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time 120 2>&1) || true

log "Session $SESSION_ID saved ($TURN_COUNT turns). Bridge response: $RESPONSE"
