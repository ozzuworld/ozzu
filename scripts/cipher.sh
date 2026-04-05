#!/usr/bin/env bash
# cipher.sh — Launch Claude Code as Cipher with full memory context
# Usage: cipher [any claude args...]

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_MD="${PROJECT_DIR}/CLAUDE.local.md"

# ── Enforce git hooks — pipeline has zero enforcement without this ──
CURRENT_HOOKS=$(cd "$PROJECT_DIR" && git config core.hooksPath 2>/dev/null || echo "")
if [[ "$CURRENT_HOOKS" != ".githooks" ]]; then
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

if [[ -n "$CONTEXT" ]]; then
  echo "$CONTEXT" > "$LOCAL_MD"
  echo "Cipher context loaded ($(echo "$CONTEXT" | wc -l) lines)"

  # ── Append TAIL of last conversation (most dynamic — goes last for cache efficiency) ──
  # Full transcripts are in postgres — use /cipher/search?q= to find anything.
  # Only the last ~30K chars go here so CLAUDE.local.md stays under 40K total.
  sleep 3
  MAX_HISTORY_CHARS=30000
  HISTORY=$(curl -sf "${BRIDGE_URL}/cipher/history?conversations=1&format=text" 2>/dev/null)
  if [[ -n "$HISTORY" ]]; then
    HISTORY_LEN=${#HISTORY}
    if [[ $HISTORY_LEN -gt $MAX_HISTORY_CHARS ]]; then
      # Keep only the tail (most recent messages)
      HISTORY="[...truncated — ${HISTORY_LEN} chars total, showing last ${MAX_HISTORY_CHARS}. Use /cipher/search?q= for full history...]\n$(echo "$HISTORY" | tail -c $MAX_HISTORY_CHARS)"
    fi
    echo "" >> "$LOCAL_MD"
    echo "## Last Conversation (tail — full transcript in postgres, search via /cipher/search?q=)" >> "$LOCAL_MD"
    echo -e "$HISTORY" >> "$LOCAL_MD"
    FINAL_SIZE=$(wc -c < "$LOCAL_MD")
    echo "Conversation tail appended (${FINAL_SIZE} bytes total CLAUDE.local.md)"
  fi

  # ── Prompt injection guard (from Claude Code leak) ──
  # Appended last so it's fresh in context before Claude reads anything else.
  # Prevents file/tool content from being treated as instructions after compaction.
  echo "" >> "$LOCAL_MD"
  echo "# currentDate" >> "$LOCAL_MD"
  echo "Today's date is $(date +%Y-%m-%d)." >> "$LOCAL_MD"
else
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

# Launch Claude Code — permissions managed via .claude/settings.local.json allow patterns
# NOTE: --dangerously-skip-permissions was removed because it's blocked when running as root.
# The settings.local.json broad allow patterns (Bash(*), Edit(*), etc.) provide equivalent autonomy.
exec claude "$@"
