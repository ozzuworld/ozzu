#!/usr/bin/env bash
# volts-checkpoint.sh — Periodic state snapshot
# Runs as: PostToolUse hook (Bash matcher) + cron every 60s
# Reads tail of active JSONL transcript, extracts state, updates ledger.
# Fire-and-forget — errors are logged but never block Claude.

set -euo pipefail

LOG_FILE="/tmp/ozzu-bridge/volts-checkpoint.log"
LEDGER_PATH="/home/gcp/ozzu/.volts/ledger.json"
BRIDGE_URL="http://localhost:3333"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$LEDGER_PATH")"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"; }

# ── Debounce: skip if last checkpoint was < 30s ago ──
STAMP_FILE="/tmp/ozzu-bridge/volts-checkpoint-stamp"
if [ -f "$STAMP_FILE" ]; then
  LAST_STAMP=$(cat "$STAMP_FILE" 2>/dev/null || echo "0")
  NOW=$(date +%s)
  ELAPSED=$((NOW - LAST_STAMP))
  if [ "$ELAPSED" -lt 30 ]; then
    exit 0
  fi
fi
date +%s > "$STAMP_FILE"

# ── Find active JSONL transcript ──
JSONL_DIRS=(
  "$HOME/.claude/projects/-home-gcp-ozzu-scripts/"
  "$HOME/.claude/projects/-home-gcp-ozzu/"
)

LATEST_JSONL=""
LATEST_MTIME=0
for dir in "${JSONL_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  for f in "$dir"*.jsonl; do
    [ -f "$f" ] || continue
    SIZE=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo "0")
    [ "$SIZE" -lt 1024 ] && continue
    MTIME=$(stat -c%Y "$f" 2>/dev/null || stat -f%m "$f" 2>/dev/null || echo "0")
    if [ "$MTIME" -gt "$LATEST_MTIME" ]; then
      LATEST_MTIME=$MTIME
      LATEST_JSONL="$f"
    fi
  done
done

if [ -z "$LATEST_JSONL" ]; then
  log "No active JSONL found"
  exit 0
fi

# Only checkpoint if the JSONL was modified in the last 5 minutes (active session)
NOW=$(date +%s)
AGE=$((NOW - LATEST_MTIME))
if [ "$AGE" -gt 300 ]; then
  exit 0
fi

# ── Extract last few user+assistant turns from JSONL tail ──
# Read last 200 lines to avoid parsing huge files
TAIL_TURNS=$(tail -200 "$LATEST_JSONL" | jq -c '
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
' 2>/dev/null || echo "")

if [ -z "$TAIL_TURNS" ]; then
  exit 0
fi

# ── Score and filter ──
SCORED=$(echo "$TAIL_TURNS" | python3 "$SCRIPT_DIR/volts-importance.py" --filter 6 10 2>/dev/null || echo "[]")
USER_INSTRUCTIONS=$(echo "$SCORED" | jq -c '[.[] | select(.role == "user")] | .[-5:]' 2>/dev/null || echo "[]")

ALL_SCORED=$(echo "$TAIL_TURNS" | python3 "$SCRIPT_DIR/volts-importance.py" 2>/dev/null || echo "[]")
DECISIONS=$(echo "$ALL_SCORED" | jq -c '[.[] | select(.role == "user" and .importance == 8)] | .[-5:] | [.[] | {content: .content, importance: .importance}]' 2>/dev/null || echo "[]")

# ── Get directive state ──
BRANCH=$(git -C /home/gcp/ozzu rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
DIR_ID=$(echo "$BRANCH" | grep -oE 'dir_[0-9]{10,}' || true)

DIRECTIVE_JSON='null'
if [ -n "$DIR_ID" ]; then
  DIR_DATA=$(curl -sf "$BRIDGE_URL/directives/$DIR_ID" --max-time 3 2>/dev/null || echo "")
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

# ── Read existing ledger to preserve history + failures ──
EXISTING_HISTORY="[]"
EXISTING_FAILURES="[]"
EXISTING_PENDING="[]"
if [ -f "$LEDGER_PATH" ]; then
  EXISTING_HISTORY=$(jq -c '.sessionHistory // []' "$LEDGER_PATH" 2>/dev/null || echo "[]")
  EXISTING_FAILURES=$(jq -c '.failedApproaches // []' "$LEDGER_PATH" 2>/dev/null || echo "[]")
  EXISTING_PENDING=$(jq -c '.pendingActions // []' "$LEDGER_PATH" 2>/dev/null || echo "[]")
fi

# ── Write ledger ──
jq -n \
  --argjson version 1 \
  --argjson updatedAt "$NOW" \
  --argjson directive "$DIRECTIVE_JSON" \
  --argjson instructions "$USER_INSTRUCTIONS" \
  --argjson decisions "$DECISIONS" \
  --argjson failures "$EXISTING_FAILURES" \
  --argjson pending "$EXISTING_PENDING" \
  --argjson history "$EXISTING_HISTORY" \
  '{
    version: $version,
    updatedAt: $updatedAt,
    directive: $directive,
    recentInstructions: $instructions,
    recentDecisions: $decisions,
    failedApproaches: $failures,
    pendingActions: $pending,
    sessionHistory: $history
  }' > "$LEDGER_PATH.tmp" && mv "$LEDGER_PATH.tmp" "$LEDGER_PATH"

log "Checkpoint: $(echo "$USER_INSTRUCTIONS" | jq length) instructions, $(echo "$DECISIONS" | jq length) decisions"

# ── Fire-and-forget: update directive working_state ──
if [ -n "$DIR_ID" ]; then
  LAST_USER=$(echo "$TAIL_TURNS" | grep '"role":"user"' | tail -1 | jq -r '.content // ""' 2>/dev/null | head -c 300)
  if [ -n "$LAST_USER" ]; then
    curl -sf -X POST "$BRIDGE_URL/directives/$DIR_ID/work-update" \
      -H "Content-Type: application/json" \
      -d "{\"message\": \"checkpoint: $(echo "$LAST_USER" | tr '"' "'" | head -c 200)\"}" \
      --max-time 3 > /dev/null 2>&1 || true
  fi
fi
