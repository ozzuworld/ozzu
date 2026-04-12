#!/usr/bin/env bash
# volts-session-end.sh — SessionEnd hook (replaces cipher-session-save.sh)
# 1. Saves full transcript to postgres via bridge (same as before)
# 2. Dual-writes scored state to .volts/ledger.json (NEW — survives crashes)
# 3. Updates directive handoff via bridge

set -euo pipefail

LOG_DIR="/tmp/ozzu-bridge"
LOG_FILE="$LOG_DIR/volts-session-end.log"
BRIDGE_URL="http://localhost:3333"
LEDGER_PATH="/home/gcp/ozzu/.volts/ledger.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$LOG_DIR" "$(dirname "$LEDGER_PATH")"

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

# ── Extract ALL user/assistant text turns from JSONL transcript ──
TURNS=$(jq -c '
  if .type == "user" and (.message.content | type) == "string" and (.message.content | length) > 0 then
    { role: "user", content: .message.content }
  elif .type == "user" and (.message.content | type) == "array" then
    (.message.content[] | select(.type == "text" and (.text | test("\\S")))) as $t |
    { role: "user", content: $t.text }
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

# ── Step 1: Save to postgres via bridge (same as cipher-session-save.sh) ──
PAYLOAD_FILE="$LOG_DIR/session-payload-$SESSION_ID.json"
echo "$TURNS" | jq -s '{ sessionId: "'"$SESSION_ID"'", turns: . }' > "$PAYLOAD_FILE"

RESPONSE=$(curl -sf -X POST "$BRIDGE_URL/cipher/session-save" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE" \
  --max-time 120 2>&1) || true

rm -f "$PAYLOAD_FILE"
log "Postgres save: $TURN_COUNT turns. Response: $RESPONSE"

# ── Step 2: Dual-write to .volts/ledger.json ──
# Score turns for importance
SCORED_INSTRUCTIONS=$(echo "$TURNS" | python3 "$SCRIPT_DIR/volts-importance.py" --filter 6 10 2>/dev/null || echo "[]")

# Extract last 5 user instructions (importance >= 6)
USER_INSTRUCTIONS=$(echo "$SCORED_INSTRUCTIONS" | jq -c '[.[] | select(.role == "user")] | .[-5:]' 2>/dev/null || echo "[]")

# Extract decisions (importance == 8)
ALL_SCORED=$(echo "$TURNS" | python3 "$SCRIPT_DIR/volts-importance.py" 2>/dev/null || echo "[]")
DECISIONS=$(echo "$ALL_SCORED" | jq -c '[.[] | select(.role == "user" and .importance == 8)] | .[-5:] | [.[] | {content: .content, importance: .importance}]' 2>/dev/null || echo "[]")

# Get directive state from branch
BRANCH=$(git -C /home/gcp/ozzu rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
DIR_ID=$(echo "$BRANCH" | grep -oE 'dir_[0-9]{10,}' || true)

DIRECTIVE_JSON='null'
if [ -n "$DIR_ID" ]; then
  DIR_DATA=$(curl -sf "$BRIDGE_URL/directives/$DIR_ID" --max-time 5 2>/dev/null || echo "")
  if [ -n "$DIR_DATA" ]; then
    DIRECTIVE_JSON=$(echo "$DIR_DATA" | jq -c '{
      id: .id,
      branch: "'"$BRANCH"'",
      title: .title,
      status: .status,
      workSummary: (.work_summary // null),
      workingState: (if .working_state then (.working_state | tostring) else null end),
      handoffContext: (.handoff_context // null)
    }' 2>/dev/null || echo 'null')
  fi
fi

# Build session history entry
FIRST_USER=$(echo "$TURNS" | grep '"role":"user"' | head -1 | jq -r '.content // ""' 2>/dev/null | head -c 150)
LAST_USER=$(echo "$TURNS" | grep '"role":"user"' | tail -1 | jq -r '.content // ""' 2>/dev/null | head -c 150)
SESSION_SUMMARY="$TURN_COUNT turns. Started: $FIRST_USER | Ended: $LAST_USER"

# Read existing ledger to preserve session history
EXISTING_HISTORY="[]"
if [ -f "$LEDGER_PATH" ]; then
  EXISTING_HISTORY=$(jq -c '.sessionHistory // []' "$LEDGER_PATH" 2>/dev/null || echo "[]")
fi

# Build new ledger
NOW=$(date +%s)
jq -n \
  --argjson version 1 \
  --argjson updatedAt "$NOW" \
  --argjson directive "$DIRECTIVE_JSON" \
  --argjson instructions "$USER_INSTRUCTIONS" \
  --argjson decisions "$DECISIONS" \
  --argjson existingHistory "$EXISTING_HISTORY" \
  --arg sessionId "$SESSION_ID" \
  --arg sessionSummary "$SESSION_SUMMARY" \
  --argjson turnCount "$TURN_COUNT" \
  --argjson now "$NOW" \
  '{
    version: $version,
    updatedAt: $updatedAt,
    directive: $directive,
    recentInstructions: $instructions,
    recentDecisions: $decisions,
    failedApproaches: [],
    pendingActions: [],
    sessionHistory: ([$existingHistory[], {
      id: $sessionId,
      summary: $sessionSummary,
      turnCount: $turnCount,
      endedAt: $now
    }] | .[-5:])
  }' > "$LEDGER_PATH.tmp" && mv "$LEDGER_PATH.tmp" "$LEDGER_PATH"

log "Ledger updated: $LEDGER_PATH (instructions: $(echo "$USER_INSTRUCTIONS" | jq length), decisions: $(echo "$DECISIONS" | jq length))"

# ── Step 3: Directive handoff ──
if [ -n "$DIR_ID" ]; then
  log "Saving handoff to directive $DIR_ID"

  LAST_ASSISTANT=$(echo "$TURNS" | grep '"role":"assistant"' | tail -5 | jq -sr '[.[].content] | join("\n---\n")' 2>/dev/null | head -c 2000 | tr '"' "'")
  LAST_USER_CTX=$(echo "$TURNS" | grep '"role":"user"' | tail -3 | jq -sr '[.[].content] | join("\n---\n")' 2>/dev/null | head -c 1000 | tr '"' "'")

  HANDOFF="Last user messages: $LAST_USER_CTX\n\nLast assistant work: $LAST_ASSISTANT"

  HANDOFF_FILE="$LOG_DIR/handoff-$DIR_ID.json"
  jq -n \
    --arg handoff "$HANDOFF" \
    --arg summary "Session ended with $TURN_COUNT turns on branch $BRANCH" \
    '{handoff_context: $handoff, work_summary: $summary}' > "$HANDOFF_FILE"

  curl -sf -X POST "$BRIDGE_URL/directives/$DIR_ID/session-handoff" \
    -H "Content-Type: application/json" \
    -d @"$HANDOFF_FILE" \
    --max-time 10 > /dev/null 2>&1 || log "Handoff POST failed for $DIR_ID"

  rm -f "$HANDOFF_FILE"
  log "Handoff saved for $DIR_ID"
fi
