#!/usr/bin/env bash
# cipher-resume.sh — Retrieve recent Cipher conversation history from the bridge
# Usage:
#   ./scripts/cipher-resume.sh                        # Last 3 conversations
#   ./scripts/cipher-resume.sh --conversations 5      # Last 5 conversations
#   ./scripts/cipher-resume.sh --since '2026-02-15T10:00:00Z'
#   ./scripts/cipher-resume.sh --limit 50             # Max 50 turns
#   ./scripts/cipher-resume.sh --json                 # JSON output
#   ./scripts/cipher-resume.sh | xclip -selection clipboard

set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"
CONVERSATIONS=3
LIMIT=200
SINCE=""
FORMAT="text"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --conversations|-c) CONVERSATIONS="$2"; shift 2 ;;
    --limit|-l)         LIMIT="$2"; shift 2 ;;
    --since|-s)         SINCE="$2"; shift 2 ;;
    --json|-j)          FORMAT="json"; shift ;;
    --help|-h)
      echo "Usage: cipher-resume.sh [--conversations N] [--limit N] [--since TIMESTAMP] [--json]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

QUERY="format=${FORMAT}&conversations=${CONVERSATIONS}&limit=${LIMIT}"
if [[ -n "$SINCE" ]]; then
  QUERY="${QUERY}&since=${SINCE}"
fi

curl -s "${BRIDGE_URL}/cipher/history?${QUERY}"
