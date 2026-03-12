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

# Pull Cipher context from bridge
CONTEXT=$(curl -sf "${BRIDGE_URL}/cipher/context" 2>/dev/null)

if [[ -n "$CONTEXT" ]]; then
  echo "$CONTEXT" > "$LOCAL_MD"
  echo "Cipher context loaded ($(echo "$CONTEXT" | wc -l) lines)"

  # ── Append full conversation history from last session ──
  # This is separate from /cipher/context so even if that endpoint gets rewritten,
  # full history still loads. DO NOT REMOVE THIS BLOCK.
  # Wait for session-save hook to finish writing the previous session to postgres.
  # Without this delay, the history call can race the session save and miss the latest session.
  sleep 3
  HISTORY=$(curl -sf "${BRIDGE_URL}/cipher/history?conversations=2&format=text" 2>/dev/null)
  if [[ -n "$HISTORY" ]]; then
    echo "" >> "$LOCAL_MD"
    echo "## Last Conversation (full transcript — READ THIS FIRST when asked 'where we left off')" >> "$LOCAL_MD"
    echo "$HISTORY" >> "$LOCAL_MD"
    echo "Full conversation history appended ($(echo "$HISTORY" | wc -l) lines)"
  fi
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

# Launch Claude Code — permissions managed via .claude/settings.local.json allow patterns
# NOTE: --dangerously-skip-permissions was removed because it's blocked when running as root.
# The settings.local.json broad allow patterns (Bash(*), Edit(*), etc.) provide equivalent autonomy.
exec claude "$@"
