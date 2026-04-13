#!/usr/bin/env bash
# start-gmail-mcp.sh — Launch Google Workspace MCP servers for both Gmail accounts
# Usage: ./start-gmail-mcp.sh
#
# Requires: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in environment
# First run: opens browser for OAuth consent (one-time per account)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load credentials from .env.gmail if it exists
ENV_FILE="${PROJECT_DIR}/backend/.env.gmail"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if [ -z "${GOOGLE_OAUTH_CLIENT_ID:-}" ] || [ -z "${GOOGLE_OAUTH_CLIENT_SECRET:-}" ]; then
  echo "ERROR: Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET"
  echo "Either export them or create ${ENV_FILE} with:"
  echo "  GOOGLE_OAUTH_CLIENT_ID=your-id.apps.googleusercontent.com"
  echo "  GOOGLE_OAUTH_CLIENT_SECRET=your-secret"
  exit 1
fi

export OAUTHLIB_INSECURE_TRANSPORT=1
export GOOGLE_OAUTH_CLIENT_ID
export GOOGLE_OAUTH_CLIENT_SECRET

source "$HOME/.local/bin/env" 2>/dev/null || true

echo "Starting Gmail MCP — personal account (port 8000)..."
USER_GOOGLE_EMAIL="eng.hsuarezp@gmail.com" \
WORKSPACE_MCP_PORT=8000 \
  uvx workspace-mcp --transport streamable-http --tool-tier core &
PID_PERSONAL=$!

echo "Starting Gmail MCP — ozzu account (port 8001)..."
USER_GOOGLE_EMAIL="eng.ozzu@gmail.com" \
WORKSPACE_MCP_PORT=8001 \
  uvx workspace-mcp --transport streamable-http --tool-tier core &
PID_OZZU=$!

echo ""
echo "Gmail MCP servers running:"
echo "  Personal (eng.hsuarezp): http://localhost:8000/mcp  (PID: $PID_PERSONAL)"
echo "  Ozzu (eng.ozzu):         http://localhost:8001/mcp  (PID: $PID_OZZU)"
echo ""
echo "Register in Claude Code:"
echo "  claude mcp add --transport http gmail-personal http://localhost:8000/mcp"
echo "  claude mcp add --transport http gmail-ozzu http://localhost:8001/mcp"
echo ""
echo "First run will open browser for OAuth consent per account."
echo "Press Ctrl+C to stop both."

trap "kill $PID_PERSONAL $PID_OZZU 2>/dev/null; exit 0" INT TERM
wait
