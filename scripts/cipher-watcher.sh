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
    log "CI build passed, verifying artifact before deploy..."

    # Verify artifact exists and is valid before deploying
    rm -rf /tmp/ozzu-apk-verify
    cd "$WORKDIR" && gh run download "$RUN_ID" --name ozzu-android --dir /tmp/ozzu-apk-verify -R ozzuworld/ozzu >> "$LOGFILE" 2>&1
    if [ ! -f /tmp/ozzu-apk-verify/app-debug.apk ]; then
      log "APK artifact not found after download — aborting deploy"
      curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
        -d '{"message":"CI build passed but APK artifact not found. Deploy aborted."}' > /dev/null
      rm -rf /tmp/ozzu-apk-verify
      return
    fi
    APK_SIZE=$(stat -c%s /tmp/ozzu-apk-verify/app-debug.apk 2>/dev/null || echo 0)
    if [ "$APK_SIZE" -lt 1000000 ]; then
      log "APK too small ($APK_SIZE bytes), likely corrupt — aborting deploy"
      curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
        -d "{\"message\":\"CI build passed but APK is only ${APK_SIZE} bytes (expected ~84MB). Deploy aborted — artifact may be corrupt.\"}" > /dev/null
      rm -rf /tmp/ozzu-apk-verify
      return
    fi
    rm -rf /tmp/ozzu-apk-verify
    log "Artifact verified (${APK_SIZE} bytes), deploying to all devices..."

    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d '{"message":"CI build passed and artifact verified. Installing new APK on all devices now..."}' > /dev/null
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

# Deploy iOS IPA (triggered separately from Android since it's a manual workflow)
deploy_ios() {
  log "Triggering iOS CI build..."
  curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
    -d '{"message":"iOS build triggered. This takes ~15 minutes (macOS runner). Will install on iPhone when done."}' > /dev/null

  # Trigger the iOS workflow (it's workflow_dispatch, not triggered by push)
  cd "$WORKDIR"
  if ! gh workflow run build-ios.yml -R ozzuworld/ozzu >> "$LOGFILE" 2>&1; then
    log "Failed to trigger iOS build"
    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d '{"message":"Failed to trigger iOS build workflow. Check GitHub Actions permissions."}' > /dev/null
    return
  fi

  # Wait for the workflow run to appear
  sleep 15

  # Get the run ID for the iOS build we just triggered
  local IOS_RUN_ID
  IOS_RUN_ID=$(gh run list --workflow=build-ios.yml -R ozzuworld/ozzu --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
  if [ -z "$IOS_RUN_ID" ]; then
    log "Could not find iOS CI run"
    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d '{"message":"iOS build was triggered but could not find the run ID. Check GitHub Actions manually."}' > /dev/null
    return
  fi

  log "Watching iOS CI run $IOS_RUN_ID..."
  gh run watch "$IOS_RUN_ID" --exit-status >> "$LOGFILE" 2>&1
  local EXIT=$?

  if [ $EXIT -eq 0 ]; then
    log "iOS CI build passed, deploying IPA to iPhone..."

    # Verify IPA artifact exists
    rm -rf /tmp/ozzu-ipa-verify
    gh run download "$IOS_RUN_ID" --name ozzu-ios --dir /tmp/ozzu-ipa-verify -R ozzuworld/ozzu >> "$LOGFILE" 2>&1
    if [ ! -f /tmp/ozzu-ipa-verify/ozzu.ipa ]; then
      log "IPA artifact not found after download — aborting iOS deploy"
      curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
        -d '{"message":"iOS build passed but IPA artifact not found. Deploy aborted."}' > /dev/null
      rm -rf /tmp/ozzu-ipa-verify
      return
    fi
    IPA_SIZE=$(stat -c%s /tmp/ozzu-ipa-verify/ozzu.ipa 2>/dev/null || echo 0)
    if [ "$IPA_SIZE" -lt 1000000 ]; then
      log "IPA too small ($IPA_SIZE bytes), likely corrupt — aborting iOS deploy"
      curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
        -d "{\"message\":\"iOS build passed but IPA is only ${IPA_SIZE} bytes. Deploy aborted — artifact may be corrupt.\"}" > /dev/null
      rm -rf /tmp/ozzu-ipa-verify
      return
    fi
    rm -rf /tmp/ozzu-ipa-verify
    log "IPA verified (${IPA_SIZE} bytes), installing on iPhone..."

    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d '{"message":"iOS build passed and IPA verified. Installing on iPhone via AltServer..."}' > /dev/null

    cd "$WORKDIR" && ./scripts/deploy-ios.sh >> "$LOGFILE" 2>&1
    local DEPLOY_EXIT=$?

    if [ $DEPLOY_EXIT -eq 0 ]; then
      log "iOS deploy complete"
      curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
        -d '{"message":"iOS app deployed! The new version has been installed on iPhone."}' > /dev/null
    else
      log "iOS deploy failed (exit=$DEPLOY_EXIT) — iPhone may not be connected to dev-01"
      curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
        -d '{"message":"iOS build succeeded but deploy failed. Is the iPhone connected via USB to dev-01? Run ./scripts/deploy-ios.sh manually when ready."}' > /dev/null
    fi
  else
    log "iOS CI build failed (exit=$EXIT)"
    curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
      -d "{\"message\":\"iOS CI build failed (exit code $EXIT). Check the workflow run on GitHub.\"}" > /dev/null
  fi
}

# Smart deploy: OTA for JS-only, APK+IPA for native changes
smart_deploy() {
  if has_native_changes; then
    deploy_apk
    # Also trigger iOS build in background (runs on separate macOS runner)
    deploy_ios &
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
        DIR_CONTEXT=$(echo "$DIR_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('context',''))" 2>/dev/null)

        log "Planning directive: $DIR_TITLE ($DIR_ID)"

        # Mark as planning + notify
        curl -sf -X PATCH "$BRIDGE/directives/$DIR_ID" \
          -H 'Content-Type: application/json' \
          -d '{"status":"planning"}' > /dev/null
        curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
          -d "{\"message\":\"Cipher is now planning directive: $DIR_TITLE. I'll let you know when the plan is ready for review.\"}" > /dev/null

        # Build context section if available
        CONTEXT_SECTION=""
        if [ -n "$DIR_CONTEXT" ] && [ "$DIR_CONTEXT" != "None" ]; then
          CONTEXT_SECTION="- User Context (King Kazuma's original words and intent): $DIR_CONTEXT"
        fi

        # Invoke Claude Code to plan
        cd "$WORKDIR"
        claude --allowedTools "Bash Read Write Edit Glob Grep WebFetch WebSearch" -p "You are Cipher, the autonomous dev agent for the ozzu project.

A new $DIR_TYPE directive needs planning:
- Title: $DIR_TITLE
- Description: $DIR_DESC
$CONTEXT_SECTION
- Directive ID: $DIR_ID

Your task:
1. Research the codebase to understand what's needed
2. Create a detailed implementation plan
3. Submit the plan by running: curl -X PATCH $BRIDGE/directives/$DIR_ID -H 'Content-Type: application/json' -d with a JSON body containing \"status\": \"planned\" and \"plan\": \"<your plan text>\"

For 'quick' type directives: skip planning, set status directly to 'approved' and implement immediately.
For 'feature' type directives: create a thorough plan and submit it. It will need PIN approval before you can implement.
For 'explore' type directives: research and report findings, then set status to 'completed' with findings in the plan field.

You have full autonomy to read any files, search code, and run non-destructive commands to understand the codebase. Just do it — no need to ask permission for research.

IMPORTANT: When done planning, notify King Kazuma by running:
curl -X POST $BRIDGE/notify -H 'Content-Type: application/json' -d '{\"message\":\"Plan ready for: $DIR_TITLE. A PIN approval will be needed to proceed.\"}'" >> "$LOGFILE" 2>&1

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
        IMPL_CONTEXT=$(echo "$IMPL_JSON" | python3 -c "import sys,json; c=json.load(sys.stdin).get('context',''); print(c if c else '')" 2>/dev/null)

        log "Implementing directive: $IMPL_TITLE ($IMPL_ID)"

        # Build context section if available
        IMPL_CONTEXT_SECTION=""
        if [ -n "$IMPL_CONTEXT" ] && [ "$IMPL_CONTEXT" != "None" ]; then
          IMPL_CONTEXT_SECTION="- User Context (King Kazuma's original words and intent): $IMPL_CONTEXT"
        fi

        # Mark as in_progress + notify
        curl -sf -X PATCH "$BRIDGE/directives/$IMPL_ID" \
          -H 'Content-Type: application/json' \
          -d '{"status":"in_progress"}' > /dev/null
        curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
          -d "{\"message\":\"Cipher is now implementing: $IMPL_TITLE. I'll notify you when it's done and deployed.\"}" > /dev/null

        # Invoke Claude Code to implement
        cd "$WORKDIR"
        claude --allowedTools "Bash Read Write Edit Glob Grep WebFetch WebSearch" -p "You are Cipher, the autonomous dev agent for the ozzu project.

Implement this approved directive:
- Title: $IMPL_TITLE
- Directive ID: $IMPL_ID
$IMPL_CONTEXT_SECTION
- Approved Plan:
$IMPL_PLAN

IMPLEMENTATION LIFECYCLE — FOLLOW THIS EXACTLY:

Phase 1: IMPLEMENT
- Implement the changes described in the plan
- Commit with a clear message and push to main
- If an APK rebuild is needed, the CI will handle it automatically on push

Phase 2: VERIFY
- You MUST verify your work actually functions before marking complete
- For HA integrations: check that entities exist in HA (curl the HA API), verify state isn't 'unavailable'
- For bridge changes: restart the bridge and confirm it starts without errors
- For frontend changes: confirm TypeScript compiles (npx tsc --noEmit)
- For device integrations: confirm the device responds to commands
- If verification fails, fix the issue and re-verify. Do NOT skip this.

Phase 3: REPORT
- Mark the directive complete ONLY if verification passed:
  curl -X PATCH $BRIDGE/directives/$IMPL_ID -H 'Content-Type: application/json' -d '{\"status\":\"completed\"}'
- Notify King Kazuma with a summary:
  curl -X POST $BRIDGE/notify -H 'Content-Type: application/json' -d '{\"message\":\"DONE: $IMPL_TITLE. <what was built + verification results + any remaining manual steps>\"}'
- This notification is MANDATORY. King Kazuma must know when work is finished.

COMPLETION RULES — CRITICAL:
- NEVER mark a directive as 'completed' unless the core functionality ACTUALLY WORKS
- If you wrote code but can't verify it works (device not on network, service down, etc.), that's a BLOCKER — not a completion
- 'I added the code plumbing but nothing is connected yet' is NOT completed. That's blocked.
- Status options: 'completed' (working + verified), 'blocked' (needs external action), 'in_progress' (still working)
- If blocked, set status to 'blocked' and IMMEDIATELY notify:
  curl -X PATCH $BRIDGE/directives/$IMPL_ID -H 'Content-Type: application/json' -d '{\"status\":\"blocked\"}'
  curl -X POST $BRIDGE/notify -H 'Content-Type: application/json' -d '{\"message\":\"BLOCKED: $IMPL_TITLE — <what is needed from King Kazuma to unblock>\"}'

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
- Blockers that need physical/manual action (connecting devices, entering passwords, etc.)
- Infrastructure changes: shutting down hosts, modifying DNS, domain changes, firewall rules
- Architectural decisions NOT covered by the approved plan
- Anything that affects production systems beyond this codebase

For escalations, post to $BRIDGE/notify with a clear description of what you need." >> "$LOGFILE" 2>&1

        IMPL_EXIT=$?
        log "Done implementing: $IMPL_TITLE (exit=$IMPL_EXIT)"

        # Notify completion (in case the agent didn't)
        if [ $IMPL_EXIT -eq 0 ]; then
          curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
            -d "{\"message\":\"Implementation finished for: $IMPL_TITLE. Deploying now...\"}" > /dev/null
        else
          curl -sf -X POST "$BRIDGE/notify" -H 'Content-Type: application/json' \
            -d "{\"message\":\"Implementation of $IMPL_TITLE may have failed (exit code $IMPL_EXIT). Check the logs.\"}" > /dev/null
        fi

        # Wait for CI and auto-deploy
        smart_deploy
      fi
    fi
  fi

  sleep "$POLL_INTERVAL"
done
