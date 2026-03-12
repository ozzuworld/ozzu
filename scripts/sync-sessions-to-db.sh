#!/usr/bin/env bash
# sync-sessions-to-db.sh — Cron job that syncs CLI session JSONL files to postgres
# Runs every minute. Tracks file sizes to detect when sessions grow.
# Re-syncs sessions that have grown since last sync.
# Only marks a session "final" after 5 minutes of no changes.

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

BRIDGE_URL="http://localhost:3333"
JSONL_DIR="/root/.claude/projects/-home-gcp-ozzu-scripts"
LOCK_FILE="/tmp/ozzu-bridge/sync-sessions.lock"
LOG_FILE="/tmp/ozzu-bridge/sync-sessions.log"
STATE_FILE="/tmp/ozzu-bridge/synced-sessions-v2.txt"
# Format: sessionId|fileSize|timestamp

mkdir -p /tmp/ozzu-bridge

log() { echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"; }

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

touch "$STATE_FILE"

# Check bridge is up
if ! curl -sf "$BRIDGE_URL/health" --max-time 5 >/dev/null 2>&1; then
  exit 0
fi

SYNCED=0

for f in "$JSONL_DIR"/*.jsonl; do
  [ -f "$f" ] || continue

  SESSION_ID=$(basename "$f" .jsonl)
  FILE_SIZE=$(stat -c %s "$f" 2>/dev/null || echo 0)
  FILE_AGE=$(( $(date +%s) - $(stat -c %Y "$f") ))

  # Skip files modified in last 5 minutes — session likely still active
  if [ "$FILE_AGE" -lt 300 ]; then
    continue
  fi

  # Check if already synced at this exact size
  PREV_SIZE=$(grep "^${SESSION_ID}|" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d'|' -f2)
  if [ "$PREV_SIZE" = "$FILE_SIZE" ]; then
    continue
  fi

  # File is new or has grown since last sync — need to (re-)sync
  if [ -n "$PREV_SIZE" ]; then
    log "Re-syncing $SESSION_ID (grew from $PREV_SIZE to $FILE_SIZE)"
  fi

  # Extract turns — handle both string and array content formats
  TURNS=$(jq -c '
    if .type == "user" then
      if (.message.content | type) == "string" and (.message.content | length) > 0 then
        { role: "user", content: .message.content }
      elif (.message.content | type) == "array" then
        (.message.content[] |
          if (type) == "string" and (length) > 0 then
            { role: "user", content: . }
          elif (type) == "object" and .type == "text" and (.text | length) > 0 then
            { role: "user", content: .text }
          else empty end
        )
      else empty end
    elif .type == "assistant" and (.message.content | type) == "array" then
      (.message.content[] | select(.type == "text" and (.text | test("\\S")))) as $t |
      { role: "assistant", content: $t.text }
    else
      empty
    end
  ' "$f" 2>/dev/null)

  TURN_COUNT=$(echo "$TURNS" | grep -c '^{' || true)

  if [ "$TURN_COUNT" -lt 1 ]; then
    # Mark with current size so we don't retry
    sed -i "/^${SESSION_ID}|/d" "$STATE_FILE"
    echo "${SESSION_ID}|${FILE_SIZE}|$(date +%s)" >> "$STATE_FILE"
    continue
  fi

  # Build payload as temp file to avoid argument-too-long
  PAYLOAD_FILE="/tmp/ozzu-bridge/sync-payload-$SESSION_ID.json"
  echo "$TURNS" | jq -s "{ sessionId: \"$SESSION_ID\", turns: . }" > "$PAYLOAD_FILE" 2>/dev/null

  if [ ! -s "$PAYLOAD_FILE" ]; then
    log "ERROR: Failed to build payload for $SESSION_ID"
    rm -f "$PAYLOAD_FILE"
    continue
  fi

  # POST to bridge — the endpoint handles dedup via sessionId
  RESPONSE=$(curl -sf -X POST "$BRIDGE_URL/cipher/session-save" \
    -H "Content-Type: application/json" \
    -d @"$PAYLOAD_FILE" \
    --max-time 120 2>&1)
  CURL_EXIT=$?

  rm -f "$PAYLOAD_FILE"

  if [ $CURL_EXIT -eq 0 ] && echo "$RESPONSE" | jq -e '.success == true' >/dev/null 2>&1; then
    # Update state with current size
    sed -i "/^${SESSION_ID}|/d" "$STATE_FILE"
    echo "${SESSION_ID}|${FILE_SIZE}|$(date +%s)" >> "$STATE_FILE"
    SYNCED=$((SYNCED + 1))
    log "Synced $SESSION_ID ($TURN_COUNT turns, ${FILE_SIZE}B)"
  else
    log "FAILED to sync $SESSION_ID: exit=$CURL_EXIT response=$RESPONSE"
  fi
done

if [ "$SYNCED" -gt 0 ]; then
  log "Sync complete: $SYNCED new/updated sessions saved"
fi
