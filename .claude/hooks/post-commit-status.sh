#!/bin/bash
# PostToolUse hook: after successful git commit, notify bridge with directive status
# This ensures directive activity_log stays current

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
STDOUT=$(echo "$INPUT" | jq -r '.tool_output.stdout // empty' 2>/dev/null)

# Only process successful git commits
if ! echo "$COMMAND" | grep -qE '^\s*git\s+commit'; then
  exit 0
fi

# Extract directive ID from commit message
DIR_ID=$(echo "$COMMAND" | grep -oE 'dir_[0-9]{10,}' | head -1)
if [ -z "$DIR_ID" ]; then
  exit 0
fi

# Post status update to bridge (fire-and-forget)
COMMIT_HASH=$(git -C /home/gcp/ozzu rev-parse --short HEAD 2>/dev/null || echo "unknown")
BRANCH=$(git -C /home/gcp/ozzu rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

curl -s -X POST "http://localhost:3333/status" \
  -H 'Content-Type: application/json' \
  -d "{\"directiveId\":\"$DIR_ID\",\"message\":\"Committed $COMMIT_HASH on $BRANCH\",\"event\":\"commit\",\"persona\":\"cipher\"}" \
  --max-time 3 > /dev/null 2>&1 &

exit 0
