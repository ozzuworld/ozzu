#!/usr/bin/env bash
# post-compact-directive-load.sh — SessionStart hook (compact matcher)
# After context compaction, loads the active directive's state so Cipher
# knows what it was working on without reading transcripts.

BRANCH=$(git -C /home/gcp/ozzu rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
DIR_ID=$(echo "$BRANCH" | grep -oE 'dir_[0-9]{10,}' || true)

if [ -z "$DIR_ID" ]; then
  echo "Context was compacted. No active directive branch detected (on '$BRANCH')."
  echo "Ask the user what to work on."
  exit 0
fi

# Fetch directive from bridge
DIRECTIVE=$(curl -sf "http://localhost:3333/directives/$DIR_ID" --max-time 5 2>/dev/null)

if [ -z "$DIRECTIVE" ]; then
  echo "Context was compacted. Active directive $DIR_ID but could not fetch from bridge."
  echo "Ask the user what to work on."
  exit 0
fi

# Extract fields
TITLE=$(echo "$DIRECTIVE" | jq -r '.title // "unknown"')
STATUS=$(echo "$DIRECTIVE" | jq -r '.status // "unknown"')
WORK_SUMMARY=$(echo "$DIRECTIVE" | jq -r '.work_summary // "No work summary recorded"' | head -c 2000)
WORKING_STATE=$(echo "$DIRECTIVE" | jq -r 'if .working_state then (.working_state | tostring) else "No working state recorded" end' | head -c 1000)
HANDOFF=$(echo "$DIRECTIVE" | jq -r '.handoff_context // "No handoff context recorded"' | head -c 2000)

# Last 5 activity log entries
ACTIVITY=$(echo "$DIRECTIVE" | jq -r '
  if .activity_log then
    [.activity_log | sort_by(.timestamp) | reverse | .[0:5] | .[] |
      "\(.type): \(.message[0:200])"] | join("\n")
  else "No activity log" end' 2>/dev/null | head -c 1500)

cat <<EOF
## Context Compacted — Directive State Restored

**Directive:** $DIR_ID — $TITLE [$STATUS]
**Branch:** $BRANCH

### Work Summary
$WORK_SUMMARY

### Working State
$WORKING_STATE

### Handoff Context (from last session)
$HANDOFF

### Recent Activity
$ACTIVITY

**Resume work from this state. Do NOT restart or rebuild what's already done.**
EOF
