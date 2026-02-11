#!/usr/bin/env bash
# PermissionRequest hook — sync/blocking
# Posts approval request to bridge, polls until resolved or timeout (5 min).
# Outputs JSON {"decision": "allow"} or {"decision": "deny"} to stdout.

set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"
POLL_INTERVAL=2
MAX_WAIT=300  # 5 minutes

# Read hook event from stdin
INPUT=$(cat)

# Extract details
TOOL=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name', d.get('tool', 'unknown')))" 2>/dev/null || echo "unknown")
DESCRIPTION=$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
inp = d.get('tool_input', d.get('input', {}))
if isinstance(inp, dict):
    desc = inp.get('command', inp.get('file_path', json.dumps(inp)[:200]))
elif isinstance(inp, str):
    desc = inp[:200]
else:
    desc = str(inp)[:200]
print(desc)
" 2>/dev/null || echo "unknown action")

# Generate a unique ID
APPROVAL_ID="apr_$(date +%s)_$$"

# Determine risk level based on tool/command content
RISK="medium"
if echo "$DESCRIPTION" | grep -qiE '(force|--force|-f|delete|drop|reset --hard|rm -rf|push.*main|push.*master)'; then
  RISK="high"
fi

# Post the approval request
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BRIDGE_URL}/approvals" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"${APPROVAL_ID}\",\"tool\":\"${TOOL}\",\"description\":$(echo "$DESCRIPTION" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))'),\"risk\":\"${RISK}\"}" \
  --connect-timeout 2 --max-time 5 2>/dev/null || echo "000")

# If bridge is unreachable, allow by default (don't block dev work)
if [ "$HTTP_CODE" != "200" ]; then
  echo '{"decision":"allow"}'
  exit 0
fi

# Also post a status update so the AI knows there's a pending approval
curl -s -X POST "${BRIDGE_URL}/status" \
  -H "Content-Type: application/json" \
  -d "{\"event\":\"permission_request\",\"tool\":\"${TOOL}\",\"message\":\"Awaiting approval: ${DESCRIPTION}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
  --connect-timeout 2 --max-time 5 >/dev/null 2>&1 || true

# Poll for resolution
ELAPSED=0
while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  RESPONSE=$(curl -s "${BRIDGE_URL}/approvals/${APPROVAL_ID}/poll" \
    --connect-timeout 2 --max-time 5 2>/dev/null || echo '{"resolved":false}')

  RESOLVED=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('resolved', False))" 2>/dev/null || echo "False")

  if [ "$RESOLVED" = "True" ]; then
    APPROVED=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('approved', False))" 2>/dev/null || echo "False")
    if [ "$APPROVED" = "True" ]; then
      echo '{"decision":"allow"}'
    else
      echo '{"decision":"deny"}'
    fi
    exit 0
  fi

  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

# Timeout — deny by default
echo '{"decision":"deny"}'
exit 0
