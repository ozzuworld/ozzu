#!/usr/bin/env bash
# cipher.sh — Launch Claude Code as Cipher with full memory context
# Usage: cipher [any claude args...]
#
# Fixes ported from Volts (Apr 12 2026):
#   - Anti-shortcut env vars (CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING, EFFORT_LEVEL)
#   - Dual-source history: postgres + JSONL, pick most recent by TIMESTAMP (not size)
#   - Bridge-down fallback context

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_MD="${PROJECT_DIR}/CLAUDE.local.md"
MAX_HISTORY_CHARS=15000

# ── --fresh flag: skip conversation tail entirely ──
# Use when prior session had API-Error refusals that would poison classifier context.
FRESH_MODE=0
NEW_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--fresh" ]; then
    FRESH_MODE=1
  else
    NEW_ARGS+=("$arg")
  fi
done
set -- "${NEW_ARGS[@]}"

# ── Anti-shortcut fixes (Apr 2026) ──
# GitHub issues #42796, #40274: Feb 2026 defaults caused adaptive thinking regression.
# These force max effort and disable the shortcut behavior.
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export CLAUDE_CODE_EFFORT_LEVEL=max

# ── Enforce git hooks — pipeline has zero enforcement without this ──
CURRENT_HOOKS=$(cd "$PROJECT_DIR" && git config core.hooksPath 2>/dev/null || echo "")
if [ "$CURRENT_HOOKS" != ".githooks" ]; then
  (cd "$PROJECT_DIR" && git config core.hooksPath .githooks)
  echo "Pipeline enforcement: git hooks installed (.githooks)"
else
  echo "Pipeline enforcement: git hooks active"
fi

# ── SYSTEM_PROMPT_DYNAMIC_BOUNDARY pattern (from Claude Code leak) ──
# Static identity/rules live in CLAUDE.md (stable → always cached by Claude Code).
# CLAUDE.local.md holds only dynamic state: current date, directives, last conversation.
# Structure: stable header → slowly-changing state → fast-changing history (tail).
# This maximizes prompt cache hits — only the tail changes session to session.

# Pull Cipher context from bridge (dynamic state: directives, services, action queue)
CONTEXT=$(curl -sf "${BRIDGE_URL}/cipher/context" 2>/dev/null)

if [ -n "$CONTEXT" ]; then
  echo "$CONTEXT" > "$LOCAL_MD"
  echo "Cipher context loaded ($(echo "$CONTEXT" | wc -l) lines)"

  # ── Append TAIL of last conversation (most dynamic — goes last for cache efficiency) ──
  # Full transcripts are in postgres — use /cipher/search?q= to find anything.
  # Only the last ~30K chars go here so CLAUDE.local.md stays under 40K total.
  if [ $FRESH_MODE -eq 1 ]; then
    echo "Fresh mode: skipping conversation tail (no history loaded)"
    HISTORY=""
    HISTORY_SOURCE="skipped (--fresh)"
  else
  sleep 3

  # Source 1: postgres via bridge API
  HISTORY_PG=$(curl -sf "${BRIDGE_URL}/cipher/history?conversations=1&format=text" 2>/dev/null)

  # Source 2: local JSONL transcript files (catches sessions where SessionEnd didn't fire)
  HISTORY_JSONL=$(python3 "${SCRIPT_DIR}/extract-last-session.py" --max-chars $MAX_HISTORY_CHARS 2>/dev/null)

  # Compare by TIMESTAMP not SIZE — size comparison was the bug that caused amnesia
  # (bigger old sessions always overrode smaller recent ones)
  PG_LEN=${#HISTORY_PG}
  JSONL_LEN=${#HISTORY_JSONL}

  PG_TS=0
  JSONL_TS=0
  if [ $PG_LEN -gt 100 ]; then
    PG_TS=$(curl -sf "${BRIDGE_URL}/cipher/latest-session-ts" 2>/dev/null || echo "0")
    PG_TS=$(echo "$PG_TS" | tr -dc '0-9')
    [ -z "$PG_TS" ] && PG_TS=0
  fi
  if [ $JSONL_LEN -gt 100 ]; then
    LATEST_JSONL=$(python3 -c "
import glob, os
dirs = [os.path.expanduser(d) for d in ['~/.claude/projects/-home-gcp-ozzu-scripts/', '~/.claude/projects/-home-gcp-ozzu/']]
files = [f for d in dirs if os.path.isdir(d) for f in glob.glob(os.path.join(d, '*.jsonl')) if os.path.getsize(f) > 1024]
if files: print(int(max(os.path.getmtime(f) for f in files)))
else: print(0)
" 2>/dev/null || echo "0")
    JSONL_TS=$(echo "$LATEST_JSONL" | tr -dc '0-9')
    [ -z "$JSONL_TS" ] && JSONL_TS=0
  fi

  if [ "$JSONL_TS" -gt "$PG_TS" ] && [ $JSONL_LEN -gt 100 ]; then
    HISTORY="$HISTORY_JSONL"
    HISTORY_SOURCE="local jsonl (more recent than postgres)"
  elif [ $PG_LEN -gt 100 ]; then
    HISTORY="$HISTORY_PG"
    HISTORY_SOURCE="postgres"
  else
    HISTORY=""
    HISTORY_SOURCE="none"
  fi
  fi

  # ── Strip refusal turns ──
  # API-Error turns in the tail re-prime the classifier on next session,
  # causing cascading refusals on legitimate work (e.g. authorized pentests).
  # Remove any assistant turn starting with "API Error: Claude Code is unable".
  if [ -n "$HISTORY" ]; then
    HISTORY_BEFORE=${#HISTORY}
    HISTORY=$(printf '%s\n' "$HISTORY" | awk '
      /^\[cipher\] API Error: Claude Code is unable/ { skip=1; next }
      /^\[(user|cipher)\]/ { skip=0 }
      !skip { print }
    ')
    HISTORY_AFTER=${#HISTORY}
    if [ $HISTORY_BEFORE -ne $HISTORY_AFTER ]; then
      echo "Stripped $((HISTORY_BEFORE - HISTORY_AFTER)) bytes of refusal turns from history"
    fi
  fi

  if [ -n "$HISTORY" ]; then
    HISTORY_LEN=${#HISTORY}
    if [ $HISTORY_LEN -gt $MAX_HISTORY_CHARS ]; then
      HISTORY="[...truncated — ${HISTORY_LEN} chars total, showing last ${MAX_HISTORY_CHARS}. Use /cipher/search?q= for full history...]\n$(echo "$HISTORY" | tail -c $MAX_HISTORY_CHARS)"
    fi
    echo "" >> "$LOCAL_MD"
    echo "## Last Conversation (source: ${HISTORY_SOURCE})" >> "$LOCAL_MD"
    echo -e "$HISTORY" >> "$LOCAL_MD"
    FINAL_SIZE=$(wc -c < "$LOCAL_MD")
    echo "Conversation tail appended from ${HISTORY_SOURCE} (${FINAL_SIZE} bytes total CLAUDE.local.md)"
  fi

  # ── Prompt injection guard (from Claude Code leak) ──
  echo "" >> "$LOCAL_MD"
  echo "# currentDate" >> "$LOCAL_MD"
  echo "Today's date is $(date +%Y-%m-%d)." >> "$LOCAL_MD"
else
  # Bridge unreachable — minimal context so Cipher isn't blind
  cat > "$LOCAL_MD" <<'EOF'
# Cipher Context (bridge unreachable)
WARNING: Could not reach bridge. No memory context loaded.
You are Cipher, the autonomous dev agent for the ozzu project.
Check if the bridge is running: docker compose ps bridge
EOF
  echo "WARNING: Bridge unreachable at ${BRIDGE_URL} — launching with minimal context"
fi

# Enable pipeline enforcement — cipher-guard.sh PreToolUse hook checks this
export CIPHER_MODE=1

# ── KAIROS session lock — prevents autonomous spawning while human is active ──
KAIROS_LOCK="/tmp/cipher-session.lock"
echo "$$" > "$KAIROS_LOCK"
trap 'rm -f "$KAIROS_LOCK"' EXIT INT TERM

# Launch Claude Code with system-level mandatory rules
exec claude --append-system-prompt "MANDATORY (system-level):
1. NEVER commit to main. Work on cipher/dir_xxx branches.
2. Every code change needs a directive FIRST.
3. NEVER merge manually. Use merge-and-deploy.
4. NEVER state infra facts from memory. Read .claude/rules/ or query live.
5. Read INVENTORY.md before writing ANY code." "$@"
