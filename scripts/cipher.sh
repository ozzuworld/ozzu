#!/usr/bin/env bash
# cipher.sh — Launch Cipher's interactive CLI (Claude Code) — opencode panel optional
# Usage:
#   cipher [--fresh] [--no-launch] [--tui] [extra args...]
#
# One mind, one CLI: refreshes CLAUDE.local.md from the bridge (live state +
# memory index) and appends the most recent conversation tail from a UNIFIED
# timeline (Claude Code + Reasonix transcripts, newest session wins), then opens
# Claude Code — the interactive agent CLI. Model + endpoint come from
# ~/.claude/settings.json (whatever provider it points at — currently Qwen via
# Alibaba Model Studio). --tui swaps in opencode's paneled UI.
# Extra args become a one-shot prompt via `claude -p`.
#
# Fixes ported from Volts (Apr 12 2026):
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
# ── --no-launch: refresh context + print what would launch, then exit (dry run) ──
NO_LAUNCH=0
# ── --tui: the full paneled opencode interface (default is Claude Code) ──
TUI_MODE=0
NEW_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh) FRESH_MODE=1 ;;
    --no-launch) NO_LAUNCH=1 ;;
    --tui) TUI_MODE=1 ;;
    *) NEW_ARGS+=("$1") ;;
  esac
  shift
done
set -- "${NEW_ARGS[@]}"

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
BRIDGE_UP=0
[ -n "$CONTEXT" ] && BRIDGE_UP=1

# ── Always extract JSONL transcript tail ──
# This was previously gated inside the bridge-up branch, which meant the
# fallback never ran when the bridge was the thing that needed falling-back-from.
# JSONL is the SOURCE OF TRUTH for conversation history — postgres is just a copy.
if [ $FRESH_MODE -eq 1 ]; then
  HISTORY_JSONL=""
  JSONL_TS=0
else
  HISTORY_JSONL=$(python3 "${SCRIPT_DIR}/extract-last-session.py" --max-chars $MAX_HISTORY_CHARS 2>/dev/null)
  JSONL_TS=$(python3 "${SCRIPT_DIR}/extract-last-session.py" --print-mtime 2>/dev/null | tr -dc '0-9')
  [ -z "$JSONL_TS" ] && JSONL_TS=0
fi

if [ $BRIDGE_UP -eq 1 ]; then
  echo "$CONTEXT" > "$LOCAL_MD"
  echo "Cipher context loaded ($(echo "$CONTEXT" | wc -l) lines)"

  # ── Pick conversation tail: postgres vs JSONL, whichever is newer ──
  if [ $FRESH_MODE -eq 1 ]; then
    echo "Fresh mode: skipping conversation tail (no history loaded)"
    HISTORY=""
    HISTORY_SOURCE="skipped (--fresh)"
  else
    sleep 3
    HISTORY_PG=$(curl -sf "${BRIDGE_URL}/cipher/history?conversations=1&format=text" 2>/dev/null)
    PG_LEN=${#HISTORY_PG}
    JSONL_LEN=${#HISTORY_JSONL}

    PG_TS=0
    if [ $PG_LEN -gt 100 ]; then
      PG_TS=$(curl -sf "${BRIDGE_URL}/cipher/latest-session-ts" 2>/dev/null || echo "0")
      PG_TS=$(echo "$PG_TS" | tr -dc '0-9')
      [ -z "$PG_TS" ] && PG_TS=0
    fi

    # Compare by TIMESTAMP not SIZE — size comparison was the bug that caused amnesia
    # (bigger old sessions always overrode smaller recent ones)
    if [ "$JSONL_TS" -gt "$PG_TS" ] && [ $JSONL_LEN -gt 100 ]; then
      HISTORY="$HISTORY_JSONL"
      HISTORY_SOURCE="session transcripts — claude+reasonix (more recent than postgres)"
    elif [ $PG_LEN -gt 100 ]; then
      HISTORY="$HISTORY_PG"
      HISTORY_SOURCE="postgres"
    elif [ $JSONL_LEN -gt 100 ]; then
      HISTORY="$HISTORY_JSONL"
      HISTORY_SOURCE="session transcripts — claude+reasonix (postgres empty)"
    else
      HISTORY=""
      HISTORY_SOURCE="none"
    fi
  fi
else
  # ── Bridge unreachable: fallback mode ──
  # Live state (directives, services) unavailable, but conversation tail is still loadable
  # from the on-disk JSONL — that's the whole point of the fallback.
  cat > "$LOCAL_MD" <<EOF
# Cipher Context (bridge unreachable — fallback mode)
WARNING: Could not reach bridge at ${BRIDGE_URL}.
Live state queries (directives, services, action queue, memory) are UNAVAILABLE this session.
Conversation tail below is loaded from on-disk JSONL transcript.

You are Cipher, the autonomous dev agent for the ozzu project.
Recover bridge: cd ${PROJECT_DIR}/backend && docker compose ps bridge && docker compose up -d bridge
After recovery, /cipher/search?q= becomes available again for older history.
EOF
  echo "WARNING: Bridge unreachable at ${BRIDGE_URL} — using JSONL fallback"
  if [ ${#HISTORY_JSONL} -gt 100 ]; then
    HISTORY="$HISTORY_JSONL"
    HISTORY_SOURCE="session transcripts (bridge-down fallback)"
  else
    HISTORY=""
    HISTORY_SOURCE="none (no JSONL found either)"
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

# Enable pipeline enforcement — cipher-guard.sh PreToolUse hook checks this
export CIPHER_MODE=1

# ── KAIROS session lock — prevents autonomous spawning while human is active ──
KAIROS_LOCK="/tmp/cipher-session.lock"
echo "$$" > "$KAIROS_LOCK"
trap 'rm -f "$KAIROS_LOCK"' EXIT INT TERM

# Launch the hands — Cipher is the mind. The CLI loads the same workspace
# files (AGENTS.md, CLAUDE.md, CLAUDE.local.md), so it wakes up with the
# same memory and the same timeline every time.
cd "$PROJECT_DIR" || exit 1

if [ $NO_LAUNCH -eq 1 ]; then
  echo "[dry-run] context ready (${FINAL_SIZE:-0} bytes CLAUDE.local.md). Would launch: claude (Claude Code interactive) — --tui for the opencode panel"
  exit 0
fi

# Providers come from opencode's built-in catalog (models.dev): DeepSeek,
# Qwen/DashScope, Anthropic, Google — keys read from standard env vars.
# Extract the known key names from gitignored backend/.env (no full source —
# keeps unrelated secrets out of the launch environment).
if [ -f "${PROJECT_DIR}/backend/.env" ]; then
  for ENV_LINE in DEEPSEEK_API_KEY DASHSCOPE_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY; do
    VAL=$(grep -E "^${ENV_LINE}=" "${PROJECT_DIR}/backend/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
    [ -n "$VAL" ] && export "${ENV_LINE}=${VAL}"
  done
fi

# ── Launch ──
# claude lives in ~/.local/bin — make sure it resolves even from a bare shell.
export PATH="$HOME/.local/bin:$PATH"

# One-shot headless: extra args become the prompt (claude -p).
if [ $# -gt 0 ]; then
  exec claude -p "$*"
fi

# Full paneled opencode UI (opt-in).
if [ $TUI_MODE -eq 1 ]; then
  exec opencode "$@"
fi

# Default: Claude Code (this is the hands). Model + endpoint come from
# ~/.claude/settings.json (currently qwen3.8-max via Alibaba Model Studio);
# it loads the same workspace files (AGENTS.md, CLAUDE.md, CLAUDE.local.md),
# so it wakes up with the same memory and the same timeline.
exec claude
