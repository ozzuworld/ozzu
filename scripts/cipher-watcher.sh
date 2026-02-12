#!/bin/bash
# cipher-watcher.sh — Daemon that polls for directives and invokes Claude Code
# Full lifecycle: directive created → Cipher plans → approval → Cipher builds → CI → auto-deploy

BRIDGE="http://localhost:3333"
WORKDIR="/home/gcp/ozzu"
POLL_INTERVAL=30
LOGFILE="/tmp/cipher-watcher.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOGFILE"; }

# Don't run multiple instances
PIDFILE="/tmp/cipher-watcher.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Already running (pid $(cat "$PIDFILE"))"
  exit 1
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

# Wait for CI build to finish and deploy
wait_and_deploy() {
  log "Waiting for CI build to complete..."

  # Give GitHub Actions a moment to register the push
  sleep 15

  # Get the latest run ID
  local RUN_ID
  RUN_ID=$(cd "$WORKDIR" && gh run list --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
  if [ -z "$RUN_ID" ]; then
    log "Could not find CI run, skipping deploy"
    return
  fi

  log "Watching CI run $RUN_ID..."
  cd "$WORKDIR" && gh run watch "$RUN_ID" --exit-status >> "$LOGFILE" 2>&1
  local EXIT=$?

  if [ $EXIT -eq 0 ]; then
    log "CI build passed, deploying to all devices..."
    cd "$WORKDIR" && ./scripts/deploy.sh >> "$LOGFILE" 2>&1
    log "Deploy complete"
  else
    log "CI build failed (exit=$EXIT), skipping deploy"
  fi
}

log "Cipher watcher started (polling every ${POLL_INTERVAL}s)"

while true; do
  # ── Check for pending directives (need planning) ──
  PENDING=$(curl -sf "$BRIDGE/directives?status=pending" 2>/dev/null)
  if [ -n "$PENDING" ]; then
    COUNT=$(echo "$PENDING" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)

    if [ "$COUNT" -gt 0 ]; then
      # Process first pending directive
      eval "$(echo "$PENDING" | python3 -c "
import sys, json
d = json.load(sys.stdin)[0]
print(f'DIR_ID={d[\"id\"]}')
print(f'DIR_TYPE={d[\"type\"]}')
" 2>/dev/null)"

      if [ -n "$DIR_ID" ]; then
        DIR_JSON=$(curl -sf "$BRIDGE/directives/$DIR_ID" 2>/dev/null)
        DIR_TITLE=$(echo "$DIR_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['title'])" 2>/dev/null)
        DIR_DESC=$(echo "$DIR_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['description'])" 2>/dev/null)

        log "Planning directive: $DIR_TITLE ($DIR_ID)"

        # Mark as planning
        curl -sf -X PATCH "$BRIDGE/directives/$DIR_ID" \
          -H 'Content-Type: application/json' \
          -d '{"status":"planning"}' > /dev/null

        # Invoke Claude Code to plan
        cd "$WORKDIR"
        claude --dangerously-skip-permissions -p "You are Cipher, the autonomous dev agent for the ozzu project.

A new $DIR_TYPE directive needs planning:
- Title: $DIR_TITLE
- Description: $DIR_DESC
- Directive ID: $DIR_ID

Your task:
1. Research the codebase to understand what's needed
2. Create a detailed implementation plan
3. Submit the plan by running: curl -X PATCH $BRIDGE/directives/$DIR_ID -H 'Content-Type: application/json' -d with a JSON body containing \"status\": \"planned\" and \"plan\": \"<your plan text>\"

For 'quick' type directives: skip planning, set status directly to 'approved' and implement immediately.
For 'feature' type directives: create a thorough plan and submit it. It will need PIN approval before you can implement.
For 'explore' type directives: research and report findings, then set status to 'completed' with findings in the plan field.

Post status updates to $BRIDGE/status as you work." >> "$LOGFILE" 2>&1

        log "Done planning: $DIR_TITLE"
      fi
    fi
  fi

  # ── Check for approved directives (need implementation) ──
  APPROVED=$(curl -sf "$BRIDGE/directives?status=approved" 2>/dev/null)
  if [ -n "$APPROVED" ]; then
    ACOUNT=$(echo "$APPROVED" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)

    if [ "$ACOUNT" -gt 0 ]; then
      eval "$(echo "$APPROVED" | python3 -c "
import sys, json
d = json.load(sys.stdin)[0]
print(f'IMPL_ID={d[\"id\"]}')
" 2>/dev/null)"

      if [ -n "$IMPL_ID" ]; then
        IMPL_JSON=$(curl -sf "$BRIDGE/directives/$IMPL_ID" 2>/dev/null)
        IMPL_TITLE=$(echo "$IMPL_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['title'])" 2>/dev/null)
        IMPL_PLAN=$(echo "$IMPL_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('plan',''))" 2>/dev/null)

        log "Implementing directive: $IMPL_TITLE ($IMPL_ID)"

        # Mark as in_progress
        curl -sf -X PATCH "$BRIDGE/directives/$IMPL_ID" \
          -H 'Content-Type: application/json' \
          -d '{"status":"in_progress"}' > /dev/null

        # Invoke Claude Code to implement
        cd "$WORKDIR"
        claude --dangerously-skip-permissions -p "You are Cipher, the autonomous dev agent for the ozzu project.

Implement this approved directive:
- Title: $IMPL_TITLE
- Directive ID: $IMPL_ID
- Approved Plan:
$IMPL_PLAN

Your task:
1. Implement the changes described in the plan
2. Commit with a clear message and push to main
3. If an APK rebuild is needed, the CI will handle it automatically on push
4. When done, mark the directive complete: curl -X PATCH $BRIDGE/directives/$IMPL_ID -H 'Content-Type: application/json' -d '{\"status\":\"completed\"}'
5. Post a completion status update to $BRIDGE/status

If you encounter a blocker or need King Kazuma's input, post to $BRIDGE/status and create an approval via $BRIDGE/approvals explaining what you need. Do NOT proceed with destructive or risky actions without approval." >> "$LOGFILE" 2>&1

        log "Done implementing: $IMPL_TITLE"

        # Wait for CI and auto-deploy
        wait_and_deploy
      fi
    fi
  fi

  sleep "$POLL_INTERVAL"
done
