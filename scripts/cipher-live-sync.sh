#!/usr/bin/env bash
# cipher-live-sync.sh — UserPromptSubmit hook for real-time CLI ↔ Voice sync
# 1. Pushes the user's CLI prompt to the bridge (so voice-Cipher knows what's happening)
# 2. Fetches recent voice turns and injects them as context Claude sees
#
# Installed as a UserPromptSubmit hook in .claude/settings.local.json

set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"
SYNC_STATE="/tmp/ozzu-bridge/live-sync-state"
LOG="/tmp/ozzu-bridge/cipher-live-sync.log"

mkdir -p /tmp/ozzu-bridge

log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

# Read stdin JSON from Claude Code hook
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)

if [ -z "$PROMPT" ]; then
  exit 0
fi

# Read last sync timestamp (so we only fetch new turns)
LAST_SYNC=0
if [ -f "$SYNC_STATE" ]; then
  LAST_SYNC=$(cat "$SYNC_STATE" 2>/dev/null || echo 0)
fi

# Push user prompt to bridge (CLI → Voice direction) — fire and forget
if [ ${#PROMPT} -gt 5 ]; then
  # Truncate very long prompts for the push
  SHORT_PROMPT="${PROMPT:0:500}"
  curl -sf -X POST "${BRIDGE_URL}/cipher/live-push" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg c "$SHORT_PROMPT" '{ source: "cli", role: "user", content: $c }')" \
    --max-time 2 > /dev/null 2>&1 &
fi

# Fetch recent voice turns (Voice → CLI direction)
VOICE_CONTEXT=$(curl -sf "${BRIDGE_URL}/cipher/live-feed?since=${LAST_SYNC}&source=voice&format=text" --max-time 3 2>/dev/null || true)

# Update sync timestamp
echo "$(date +%s%3N)" > "$SYNC_STATE"

# If there's voice context, inject it as additionalContext for Claude
if [ -n "$VOICE_CONTEXT" ] && [ "$VOICE_CONTEXT" != "null" ]; then
  TURN_COUNT=$(echo "$VOICE_CONTEXT" | wc -l)
  log "Injecting ${TURN_COUNT} voice turns as context"

  # Output as JSON additionalContext (discreet injection)
  jq -n --arg ctx "$VOICE_CONTEXT" '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: ("[Live voice context — recent Cipher voice session activity]\n" + $ctx + "\n[End voice context]")
    }
  }'
  exit 0
fi

# No voice context to inject — exit cleanly
exit 0
