#!/usr/bin/env bash
# volts.sh — Launch Claude Code as Volts with structured memory context
# Replaces cipher.sh with 4-layer memory architecture:
#   Layer 0: Pulse (VOLTS.local.md) — always in context, 8K char budget
#   Layer 1: Ledger (.volts/ledger.json) — loaded at startup
#   Layer 2: Archive (postgres + JSONL) — searched on demand
#   Layer 3: Canon (memory/*.md) — curated reference, loaded by pointer
#
# Usage: volts [any claude args...]

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LEDGER_PATH="$PROJECT_DIR/.volts/ledger.json"

# ── Anti-shortcut fixes (Apr 2026) ──
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export CLAUDE_CODE_EFFORT_LEVEL=max

LOCAL_MD="${PROJECT_DIR}/CLAUDE.local.md"
MAX_PULSE_CHARS=8000
MAX_HISTORY_CHARS=30000

# ── Enforce git hooks ──
CURRENT_HOOKS=$(cd "$PROJECT_DIR" && git config core.hooksPath 2>/dev/null || echo "")
if [[ "$CURRENT_HOOKS" != ".githooks" ]]; then
  (cd "$PROJECT_DIR" && git config core.hooksPath .githooks)
  echo "Pipeline enforcement: git hooks installed (.githooks)"
else
  echo "Pipeline enforcement: git hooks active"
fi

# ── Layer 1: Read the Ledger (local, no network) ──
LEDGER_DIRECTIVE=""
LEDGER_INSTRUCTIONS=""
LEDGER_DECISIONS=""
LEDGER_FAILURES=""
LEDGER_SESSIONS=""
LEDGER_TS=0

if [ -f "$LEDGER_PATH" ]; then
  LEDGER_TS=$(jq -r '.updatedAt // 0' "$LEDGER_PATH" 2>/dev/null || echo "0")

  if [ "$LEDGER_TS" != "0" ] && [ "$LEDGER_TS" != "null" ]; then
    echo "Ledger loaded (updated $(date -d @$LEDGER_TS +%Y-%m-%dT%H:%M 2>/dev/null || date -r $LEDGER_TS +%Y-%m-%dT%H:%M 2>/dev/null || echo '?'))"

    LEDGER_DIRECTIVE=$(jq -r '
      if .directive and .directive.id then
        "Directive: \(.directive.id) — \(.directive.title // "?") [\(.directive.status // "?")]\nBranch: \(.directive.branch // "?")"
      else "" end
    ' "$LEDGER_PATH" 2>/dev/null || echo "")

    LEDGER_INSTRUCTIONS=$(jq -r '
      if .recentInstructions and (.recentInstructions | length) > 0 then
        [.recentInstructions[] | select(.role == "user") | "- \(.content // "" | .[0:300])"] | join("\n")
      else "" end
    ' "$LEDGER_PATH" 2>/dev/null || echo "")

    LEDGER_DECISIONS=$(jq -r '
      if .recentDecisions and (.recentDecisions | length) > 0 then
        [.recentDecisions[] | "- \(.content // "" | .[0:200])"] | join("\n")
      else "" end
    ' "$LEDGER_PATH" 2>/dev/null || echo "")

    LEDGER_FAILURES=$(jq -r '
      if .failedApproaches and (.failedApproaches | length) > 0 then
        [.failedApproaches[] | "- \(.approach // ""): \(.reason // "")"] | join("\n")
      else "" end
    ' "$LEDGER_PATH" 2>/dev/null || echo "")

    LEDGER_SESSIONS=$(jq -r '
      if .sessionHistory and (.sessionHistory | length) > 0 then
        [.sessionHistory[-3:][] | "- \(.summary // "" | .[0:150])"] | join("\n")
      else "" end
    ' "$LEDGER_PATH" 2>/dev/null || echo "")
  fi
else
  echo "No ledger found — first run"
fi

# ── Layer 0: Build the Pulse (VOLTS.local.md) ──
# Pull dynamic state from bridge (directives, services, action queue)
CONTEXT=$(curl -sf "${BRIDGE_URL}/cipher/context" 2>/dev/null)

if [[ -n "$CONTEXT" ]]; then
  # Start with bridge context (identity, directives, services)
  echo "$CONTEXT" > "$LOCAL_MD"
  echo "Bridge context loaded ($(echo "$CONTEXT" | wc -l) lines)"

  # ── Inject Ledger state into Pulse ──
  if [ -n "$LEDGER_INSTRUCTIONS" ] || [ -n "$LEDGER_DECISIONS" ] || [ -n "$LEDGER_FAILURES" ]; then
    {
      echo ""
      echo "## Ledger (from last session — local state)"

      if [ -n "$LEDGER_DIRECTIVE" ]; then
        echo "$LEDGER_DIRECTIVE"
      fi

      if [ -n "$LEDGER_INSTRUCTIONS" ]; then
        echo ""
        echo "### Last User Instructions (importance >= 6)"
        echo "$LEDGER_INSTRUCTIONS"
      fi

      if [ -n "$LEDGER_DECISIONS" ]; then
        echo ""
        echo "### Recent Decisions"
        echo "$LEDGER_DECISIONS"
      fi

      if [ -n "$LEDGER_FAILURES" ]; then
        echo ""
        echo "### Failed Approaches (do NOT retry)"
        echo "$LEDGER_FAILURES"
      fi

      if [ -n "$LEDGER_SESSIONS" ]; then
        echo ""
        echo "### Recent Sessions"
        echo "$LEDGER_SESSIONS"
      fi
    } >> "$LOCAL_MD"
  fi

  # ── Append conversation tail (most dynamic — goes last for cache efficiency) ──
  sleep 3

  # Source 1: postgres via bridge API
  HISTORY_PG=$(curl -sf "${BRIDGE_URL}/cipher/history?conversations=1&format=text" 2>/dev/null)

  # Source 2: local jsonl transcript files
  HISTORY_JSONL=$(python3 "${SCRIPT_DIR}/extract-last-session.py" --max-chars $MAX_HISTORY_CHARS 2>/dev/null)

  # Compare by TIMESTAMP (not size — the bug that caused amnesia)
  PG_LEN=${#HISTORY_PG}
  JSONL_LEN=${#HISTORY_JSONL}

  PG_TS=0
  JSONL_TS=0
  if [[ $PG_LEN -gt 100 ]]; then
    PG_TS=$(curl -sf "${BRIDGE_URL}/cipher/latest-session-ts" 2>/dev/null || echo "0")
    PG_TS=${PG_TS//[^0-9]/}
    [[ -z "$PG_TS" ]] && PG_TS=0
  fi
  if [[ $JSONL_LEN -gt 100 ]]; then
    LATEST_JSONL=$(python3 -c "
import glob, os
dirs = [os.path.expanduser(d) for d in ['~/.claude/projects/-home-gcp-ozzu-scripts/', '~/.claude/projects/-home-gcp-ozzu/']]
files = [f for d in dirs if os.path.isdir(d) for f in glob.glob(os.path.join(d, '*.jsonl')) if os.path.getsize(f) > 1024]
if files: print(int(max(os.path.getmtime(f) for f in files)))
else: print(0)
" 2>/dev/null || echo "0")
    JSONL_TS=${LATEST_JSONL//[^0-9]/}
    [[ -z "$JSONL_TS" ]] && JSONL_TS=0
  fi

  if [[ $JSONL_TS -gt $PG_TS && $JSONL_LEN -gt 100 ]]; then
    HISTORY="$HISTORY_JSONL"
    HISTORY_SOURCE="local jsonl (more recent than postgres)"
  elif [[ $PG_LEN -gt 100 ]]; then
    HISTORY="$HISTORY_PG"
    HISTORY_SOURCE="postgres"
  else
    HISTORY=""
    HISTORY_SOURCE="none"
  fi

  if [[ -n "$HISTORY" ]]; then
    HISTORY_LEN=${#HISTORY}
    if [[ $HISTORY_LEN -gt $MAX_HISTORY_CHARS ]]; then
      HISTORY="[...truncated — ${HISTORY_LEN} chars total, showing last ${MAX_HISTORY_CHARS}. Use /cipher/search?q= for full history...]\n$(echo "$HISTORY" | tail -c $MAX_HISTORY_CHARS)"
    fi
    echo "" >> "$LOCAL_MD"
    echo "## Last Conversation (source: ${HISTORY_SOURCE})" >> "$LOCAL_MD"
    echo -e "$HISTORY" >> "$LOCAL_MD"
    FINAL_SIZE=$(wc -c < "$LOCAL_MD")
    echo "Conversation tail appended from ${HISTORY_SOURCE} (${FINAL_SIZE} bytes total CLAUDE.local.md)"
  fi

  # ── Prompt injection guard ──
  echo "" >> "$LOCAL_MD"
  echo "# currentDate" >> "$LOCAL_MD"
  echo "Today's date is $(date +%Y-%m-%d)." >> "$LOCAL_MD"
else
  # Bridge unreachable — use Ledger as sole context source
  {
    echo "# Volts Context (bridge unreachable — restored from Ledger)"
    echo "WARNING: Could not reach bridge. Context loaded from local ledger only."
    echo "You are Volts, the autonomous dev agent for the ozzu project."
    echo ""
    if [ -n "$LEDGER_DIRECTIVE" ]; then
      echo "## Active Directive"
      echo "$LEDGER_DIRECTIVE"
    fi
    if [ -n "$LEDGER_INSTRUCTIONS" ]; then
      echo ""
      echo "## Last User Instructions"
      echo "$LEDGER_INSTRUCTIONS"
    fi
    if [ -n "$LEDGER_DECISIONS" ]; then
      echo ""
      echo "## Recent Decisions"
      echo "$LEDGER_DECISIONS"
    fi
    if [ -n "$LEDGER_FAILURES" ]; then
      echo ""
      echo "## Failed Approaches (do NOT retry)"
      echo "$LEDGER_FAILURES"
    fi
    echo ""
    echo "Check if the bridge is running: docker compose ps bridge"
  } > "$LOCAL_MD"
  echo "WARNING: Bridge unreachable — launching with ledger-only context"
fi

# Enable pipeline enforcement
export CIPHER_MODE=1

# ── KAIROS session lock ──
KAIROS_LOCK="/tmp/cipher-session.lock"
echo "$$" > "$KAIROS_LOCK"
trap 'rm -f "$KAIROS_LOCK"' EXIT INT TERM

# Launch Claude Code
exec claude "$@"
