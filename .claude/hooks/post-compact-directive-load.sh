#!/usr/bin/env bash
# post-compact-directive-load.sh — SessionStart hook (compact matcher)
# After context compaction, restores state from the Ledger (local file)
# then falls back to bridge API if ledger is empty.
# Also auto-loads up to 2 relevant Canon memory files.

LEDGER_PATH="/home/gcp/ozzu/.volts/ledger.json"
MEMORY_DIR="/root/.claude/projects/-home-gcp-ozzu/memory"

# ── Try Ledger first (local, no network) ──
if [ -f "$LEDGER_PATH" ]; then
  LEDGER_TS=$(jq -r '.updatedAt // 0' "$LEDGER_PATH" 2>/dev/null || echo "0")

  if [ "$LEDGER_TS" != "0" ] && [ "$LEDGER_TS" != "null" ]; then
    DIRECTIVE=$(jq -r '.directive // empty' "$LEDGER_PATH" 2>/dev/null)
    DIR_ID=$(echo "$DIRECTIVE" | jq -r '.id // empty' 2>/dev/null)
    DIR_TITLE=$(echo "$DIRECTIVE" | jq -r '.title // "unknown"' 2>/dev/null)
    DIR_STATUS=$(echo "$DIRECTIVE" | jq -r '.status // "unknown"' 2>/dev/null)
    DIR_BRANCH=$(echo "$DIRECTIVE" | jq -r '.branch // "unknown"' 2>/dev/null)
    WORK_SUMMARY=$(echo "$DIRECTIVE" | jq -r '.workSummary // "No work summary"' 2>/dev/null | head -c 2000)
    WORKING_STATE=$(echo "$DIRECTIVE" | jq -r '.workingState // "No working state"' 2>/dev/null | head -c 1000)
    HANDOFF=$(echo "$DIRECTIVE" | jq -r '.handoffContext // "No handoff context"' 2>/dev/null | head -c 2000)

    # Recent instructions (importance >= 6)
    INSTRUCTIONS=$(jq -r '
      if .recentInstructions and (.recentInstructions | length) > 0 then
        [.recentInstructions[] | "- [score \(.importance // "?")] \(.content // "" | .[0:200])"] | join("\n")
      else "None recorded" end
    ' "$LEDGER_PATH" 2>/dev/null || echo "None recorded")

    # Recent decisions
    DECISIONS=$(jq -r '
      if .recentDecisions and (.recentDecisions | length) > 0 then
        [.recentDecisions[] | "- \(.content // "" | .[0:200])"] | join("\n")
      else "None recorded" end
    ' "$LEDGER_PATH" 2>/dev/null || echo "None recorded")

    # Failed approaches
    FAILURES=$(jq -r '
      if .failedApproaches and (.failedApproaches | length) > 0 then
        [.failedApproaches[] | "- \(.approach // "" | .[0:200]): \(.reason // "" | .[0:100])"] | join("\n")
      else "None recorded" end
    ' "$LEDGER_PATH" 2>/dev/null || echo "None recorded")

    cat <<EOF
## Context Compacted — State Restored from Ledger

**Directive:** ${DIR_ID:-none} — $DIR_TITLE [$DIR_STATUS]
**Branch:** $DIR_BRANCH

### Work Summary
$WORK_SUMMARY

### Working State
$WORKING_STATE

### Handoff Context
$HANDOFF

### Recent User Instructions (importance >= 6)
$INSTRUCTIONS

### Recent Decisions
$DECISIONS

### Failed Approaches (do NOT retry these)
$FAILURES

**Resume work from this state. Do NOT restart or rebuild what's already done.**
EOF

    # ── Auto-load relevant Canon memory files ──
    if [ -d "$MEMORY_DIR" ] && [ -n "$DIR_TITLE" ] && [ "$DIR_TITLE" != "unknown" ] && [ "$DIR_TITLE" != "null" ]; then
      # Extract keywords from directive title
      KEYWORDS=$(echo "$DIR_TITLE" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' '\n' | grep -v '^$' | sort -u)

      LOADED=0
      for memfile in "$MEMORY_DIR"/*.md; do
        [ "$LOADED" -ge 2 ] && break
        [ ! -f "$memfile" ] && continue
        basename=$(basename "$memfile")
        [ "$basename" = "MEMORY.md" ] && continue

        # Check if any keyword matches the filename or description
        for kw in $KEYWORDS; do
          if echo "$basename" | grep -qi "$kw"; then
            CONTENT=$(head -c 5000 "$memfile")
            echo ""
            echo "### Auto-loaded Canon: $basename"
            echo "$CONTENT"
            LOADED=$((LOADED + 1))
            break
          fi
        done
      done
    fi

    exit 0
  fi
fi

# ── Fallback: fetch from bridge (original behavior) ──
BRANCH=$(git -C /home/gcp/ozzu rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
DIR_ID=$(echo "$BRANCH" | grep -oE 'dir_[0-9]{10,}' || true)

if [ -z "$DIR_ID" ]; then
  echo "Context was compacted. No active directive branch detected (on '$BRANCH')."
  echo "Ask the user what to work on."
  exit 0
fi

DIRECTIVE=$(curl -sf "http://localhost:3333/directives/$DIR_ID" --max-time 5 2>/dev/null)

if [ -z "$DIRECTIVE" ]; then
  echo "Context was compacted. Active directive $DIR_ID but could not fetch from bridge."
  echo "Ask the user what to work on."
  exit 0
fi

TITLE=$(echo "$DIRECTIVE" | jq -r '.title // "unknown"')
STATUS=$(echo "$DIRECTIVE" | jq -r '.status // "unknown"')
WORK_SUMMARY=$(echo "$DIRECTIVE" | jq -r '.work_summary // "No work summary recorded"' | head -c 2000)
WORKING_STATE=$(echo "$DIRECTIVE" | jq -r 'if .working_state then (.working_state | tostring) else "No working state recorded" end' | head -c 1000)
HANDOFF=$(echo "$DIRECTIVE" | jq -r '.handoff_context // "No handoff context recorded"' | head -c 2000)

ACTIVITY=$(echo "$DIRECTIVE" | jq -r '
  if .activity_log then
    [.activity_log | sort_by(.timestamp) | reverse | .[0:5] | .[] |
      "\(.type): \(.message[0:200])"] | join("\n")
  else "No activity log" end' 2>/dev/null | head -c 1500)

cat <<EOF
## Context Compacted — Directive State Restored (bridge fallback)

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
