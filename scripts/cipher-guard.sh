#!/usr/bin/env bash
# cipher-guard.sh — PreToolUse hook for Edit/Write enforcement
# Blocks file edits when Cipher isn't on a valid cipher/dir_* branch with an active directive.
# Wired via .claude/settings.local.json PreToolUse hook.
# Only enforced when CIPHER_MODE=1 (set by cipher.sh).

set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"
PROJECT_DIR="/home/gcp/ozzu"
CACHE_FILE="/tmp/cipher-guard-cache"
CACHE_TTL=30  # seconds

# ── Not a Cipher session? Allow everything ──
if [[ "${CIPHER_MODE:-}" != "1" ]]; then
  exit 0
fi

# ── Get current branch ──
BRANCH=$(cd "$PROJECT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# ── On main? Block — must create directive + branch first ──
if [[ "$BRANCH" == "main" ]]; then
  echo "BLOCKED: You are on main. Create a directive and branch first:"
  echo "  1. POST /directives with title, description, type, emoji"
  echo "  2. git checkout -b cipher/dir_XXXXXXXXXXXXX"
  echo "  3. Then edit files"
  exit 2
fi

# ── Not on a cipher/dir_* branch? Block ──
if [[ ! "$BRANCH" =~ ^cipher/dir_[0-9]{10,}$ ]]; then
  echo "BLOCKED: Branch '$BRANCH' is not a valid cipher/dir_* branch."
  echo "  Create a directive first, then: git checkout -b cipher/dir_XXXXXXXXXXXXX"
  exit 2
fi

# ── Extract directive ID from branch name ──
DIR_ID="${BRANCH#cipher/}"

# ── Check cache (avoid hitting bridge on every keystroke) ──
if [[ -f "$CACHE_FILE" ]]; then
  CACHED_ID=$(head -1 "$CACHE_FILE" 2>/dev/null || echo "")
  CACHED_TIME=$(sed -n '2p' "$CACHE_FILE" 2>/dev/null || echo "0")
  NOW=$(date +%s)
  AGE=$(( NOW - CACHED_TIME ))
  if [[ "$CACHED_ID" == "$DIR_ID" && "$AGE" -lt "$CACHE_TTL" ]]; then
    CACHED_STATUS=$(sed -n '3p' "$CACHE_FILE" 2>/dev/null || echo "")
    if [[ "$CACHED_STATUS" == "ALLOW" ]]; then
      exit 0
    elif [[ "$CACHED_STATUS" == "BLOCK" ]]; then
      CACHED_REASON=$(sed -n '4p' "$CACHE_FILE" 2>/dev/null || echo "Directive not active")
      echo "BLOCKED: $CACHED_REASON"
      exit 2
    fi
  fi
fi

# ── Query bridge for directive status ──
RESPONSE=$(curl -sf "${BRIDGE_URL}/directives/${DIR_ID}" 2>/dev/null || echo "BRIDGE_DOWN")

if [[ "$RESPONSE" == "BRIDGE_DOWN" ]]; then
  # Bridge unreachable — allow (don't block work if bridge is down)
  exit 0
fi

# Parse status from JSON response
STATUS=$(echo "$RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$STATUS" ]]; then
  # Could not parse — directive might not exist
  echo "BLOCKED: Directive $DIR_ID not found. Create a directive first."
  # Cache the block
  printf '%s\n%s\n%s\n%s\n' "$DIR_ID" "$(date +%s)" "BLOCK" "Directive $DIR_ID not found" > "$CACHE_FILE"
  exit 2
fi

# ── Check directive status ──
case "$STATUS" in
  in_progress|approved)
    # Active directive — allow edits
    printf '%s\n%s\n%s\n' "$DIR_ID" "$(date +%s)" "ALLOW" > "$CACHE_FILE"
    exit 0
    ;;
  completed|cancelled|failed)
    REASON="Directive $DIR_ID is '$STATUS'. Create a new directive for further changes."
    echo "BLOCKED: $REASON"
    printf '%s\n%s\n%s\n%s\n' "$DIR_ID" "$(date +%s)" "BLOCK" "$REASON" > "$CACHE_FILE"
    exit 2
    ;;
  planning|planned)
    REASON="Directive $DIR_ID is '$STATUS' — awaiting approval. Get King Kazuma's approval before implementing."
    echo "BLOCKED: $REASON"
    printf '%s\n%s\n%s\n%s\n' "$DIR_ID" "$(date +%s)" "BLOCK" "$REASON" > "$CACHE_FILE"
    exit 2
    ;;
  *)
    REASON="Directive $DIR_ID has unexpected status '$STATUS'."
    echo "BLOCKED: $REASON"
    printf '%s\n%s\n%s\n%s\n' "$DIR_ID" "$(date +%s)" "BLOCK" "$REASON" > "$CACHE_FILE"
    exit 2
    ;;
esac
