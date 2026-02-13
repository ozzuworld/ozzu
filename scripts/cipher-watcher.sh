#!/bin/bash
# cipher-watcher.sh — Daemon that polls for directives and invokes Claude Code
# Full lifecycle: directive created → Cipher plans → approval → Cipher builds → CI → auto-deploy

BRIDGE="http://localhost:3333"
WORKDIR="/home/gcp/ozzu"
POLL_INTERVAL=30
LOGFILE="/tmp/cipher-watcher.log"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOGFILE"; }

# Don't run multiple instances — use flock for reliable single-instance
LOCKFILE="/tmp/cipher-watcher.lock"
exec 200>"$LOCKFILE"
if ! flock -n 200; then
  echo "Already running"
  exit 1
fi
PIDFILE="/tmp/cipher-watcher.pid"
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

# Check if the latest commit has native changes (requires APK rebuild) or JS-only (OTA)
has_native_changes() {
  cd "$WORKDIR"
  # Check files changed in the last commit against native patterns
  local NATIVE_PATTERNS="frontend/modules/.*/android/ frontend/modules/.*/ios/ frontend/app.json frontend/plugins/ frontend/android/ frontend/ios/"
  local CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null)
  [ -z "$CHANGED" ] && return 1  # no changes = not native

  for pattern in $NATIVE_PATTERNS; do
    if echo "$CHANGED" | grep -q "$pattern"; then
      return 0  # has native changes
    fi
  done

  # Also check if package.json added a native dependency (heuristic: any new expo-* or react-native-* package)
  if echo "$CHANGED" | grep -q "frontend/package.json"; then
    local PKG_DIFF=$(git diff HEAD~1 HEAD -- frontend/package.json 2>/dev/null)
    if echo "$PKG_DIFF" | grep -qE '^\+.*"(expo-|react-native-|@react-native)'; then
      return 0  # new native dependency
    fi
  fi

  return 1  # JS-only
}

# Deploy via OTA (JS-only changes — seconds, not minutes)
deploy_ota() {
  log "JS-only changes detected — deploying via OTA..."
  curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
    -d '{"message":"JS-only changes — deploying instantly via OTA update..."}' > /dev/null

  cd "$WORKDIR" && ./scripts/ota-deploy.sh --restart >> "$LOGFILE" 2>&1
  local EXIT=$?

  if [ $EXIT -eq 0 ]; then
    log "OTA deploy complete"
    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d '{"message":"OTA update deployed! All devices are restarting with the new version now."}' > /dev/null
  else
    log "OTA deploy failed (exit=$EXIT)"
    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d '{"message":"OTA deploy failed. May need a full APK rebuild."}' > /dev/null
  fi
}

# Deploy via full APK build (native changes — ~10 min CI build)
deploy_apk() {
  log "Native changes detected — waiting for CI build..."
  curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
    -d '{"message":"Native changes detected — a full APK rebuild is needed. CI build started, this will take about 10 minutes."}' > /dev/null

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
    log "CI build passed, deploying APK to all devices..."
    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d '{"message":"CI build passed. Installing new APK on all devices now..."}' > /dev/null
    cd "$WORKDIR" && ./scripts/deploy.sh >> "$LOGFILE" 2>&1
    log "APK deploy complete"
    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d '{"message":"APK deployed! The new update has been installed on all devices."}' > /dev/null
  else
    log "CI build failed (exit=$EXIT), skipping deploy"
    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d "{\"message\":\"CI build failed (exit code $EXIT). The update was NOT deployed. King Kazuma may want to check what went wrong.\"}" > /dev/null
  fi
}

# Smart deploy: OTA for JS-only, APK for native changes
smart_deploy() {
  if has_native_changes; then
    deploy_apk
  else
    deploy_ota
  fi
}

# Ensure we can spawn Claude Code (may have been started from inside a CC session)
unset CLAUDECODE

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
        claude --allowedTools "Bash Read Write Edit Glob Grep WebFetch WebSearch" -p "You are Cipher, the autonomous dev agent for the ozzu project.

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

You have full autonomy to read any files, search code, and run non-destructive commands to understand the codebase. Just do it — no need to ask permission for research." >> "$LOGFILE" 2>&1

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
        claude --allowedTools "Bash Read Write Edit Glob Grep WebFetch WebSearch" -p "You are Cipher, the autonomous dev agent for the ozzu project.

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

AUTONOMY RULES — You have FULL autonomy for all normal development work:
- Reading, writing, editing, creating, deleting code files — just do it
- Running git commands (add, commit, push, branch, merge) — just do it
- Installing npm/pip packages — just do it
- Running builds, tests, linters — just do it
- Creating/modifying configs, scripts, components — just do it
- File operations (cp, mv, mkdir, rm of project files) — just do it
- Curl calls to the bridge API — just do it
- Do NOT ask for approval for any of the above. Just execute.

ONLY escalate to King Kazuma (via POST $BRIDGE/notify) for:
- Infrastructure changes: shutting down hosts, modifying DNS, domain changes, firewall rules
- Architectural decisions NOT covered by the approved plan
- Deleting entire services/databases or irreversible destructive operations outside the codebase
- Anything that affects production systems beyond this codebase (cloud config, network, etc.)

For escalations, post to $BRIDGE/notify with a clear description of what you need. Do NOT create approvals for routine dev work." >> "$LOGFILE" 2>&1

        log "Done implementing: $IMPL_TITLE"

        # Wait for CI and auto-deploy
        smart_deploy
      fi
    fi
  fi

  sleep "$POLL_INTERVAL"
done
