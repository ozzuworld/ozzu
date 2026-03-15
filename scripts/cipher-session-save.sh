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

# Build JSON payload and write to temp file (avoids curl argument-too-long for big sessions)
PAYLOAD_FILE="$LOG_DIR/session-payload-$SESSION_ID.json"
echo "$TURNS" | jq -s '{ sessionId: "'"$SESSION_ID"'", turns: . }' > "$PAYLOAD_FILE"

# POST to bridge using file — wait for it to complete, ensure it finishes
RESPONSE=$(curl -sf -X POST "$BRIDGE_URL" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE" \
  --max-time 120 2>&1) || true

# Clean up temp file
rm -f "$PAYLOAD_FILE"

log "Session $SESSION_ID saved ($TURN_COUNT turns). Bridge response: $RESPONSE"

# ── Auto-save handoff to active directive ──
# If on a cipher/dir_XXX branch, save session handoff so the next session can pick up
BRANCH=$(git -C /home/gcp/ozzu rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
DIR_ID=$(echo "$BRANCH" | grep -oE 'dir_[0-9]{10,}' || true)

if [ -n "$DIR_ID" ]; then
  log "Saving handoff to directive $DIR_ID"

  # Extract last 5 assistant turns for handoff context
  LAST_ASSISTANT=$(echo "$TURNS" | grep '"role":"assistant"' | tail -5 | jq -sr '[.[].content] | join("\n---\n")' 2>/dev/null | head -c 2000 | tr '"' "'")
  # Extract last 3 user turns for context
  LAST_USER=$(echo "$TURNS" | grep '"role":"user"' | tail -3 | jq -sr '[.[].content] | join("\n---\n")' 2>/dev/null | head -c 1000 | tr '"' "'")

  HANDOFF="Last user messages: $LAST_USER\n\nLast assistant work: $LAST_ASSISTANT"

  # Build JSON payload for handoff
  HANDOFF_FILE="$LOG_DIR/handoff-$DIR_ID.json"
  jq -n \
    --arg handoff "$HANDOFF" \
    --arg summary "Session ended with $TURN_COUNT turns on branch $BRANCH" \
    '{handoff_context: $handoff, work_summary: $summary}' > "$HANDOFF_FILE"

  curl -sf -X POST "http://localhost:3333/directives/$DIR_ID/session-handoff" \
    -H "Content-Type: application/json" \
    -d @"$HANDOFF_FILE" \
    --max-time 10 > /dev/null 2>&1 || log "Handoff POST failed for $DIR_ID"

  rm -f "$HANDOFF_FILE"
  log "Handoff saved for $DIR_ID"
fi
