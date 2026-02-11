#!/usr/bin/env bash
# PostToolUse / Stop hook — async, fire-and-forget status update to bridge server
# Reads hook event JSON from stdin, posts summary to bridge.

set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"

# Read the hook event JSON from stdin
INPUT=$(cat)

EVENT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('event','unknown'))" 2>/dev/null || echo "unknown")
TOOL=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name', d.get('tool', '')))" 2>/dev/null || echo "")
# Build a short message from the input
MESSAGE=$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
# For tool use, include the tool input summary
inp = d.get('tool_input', d.get('input', ''))
if isinstance(inp, dict):
    # For file edits, show the path
    msg = inp.get('file_path', inp.get('command', inp.get('pattern', str(inp)[:120])))
elif isinstance(inp, str):
    msg = inp[:120]
else:
    msg = str(inp)[:120]
print(msg)
" 2>/dev/null || echo "")

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Fire and forget — don't block Claude Code
curl -s -X POST "${BRIDGE_URL}/status" \
  -H "Content-Type: application/json" \
  -d "{\"event\":\"${EVENT}\",\"tool\":\"${TOOL}\",\"message\":$(echo "$MESSAGE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))'),\"timestamp\":\"${TIMESTAMP}\"}" \
  --connect-timeout 2 --max-time 5 >/dev/null 2>&1 || true
