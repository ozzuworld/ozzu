#!/bin/bash
# PostToolUse hook: after merge-and-deploy calls, check for failures and alert
# Catches silent deploy_failed scenarios

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
STDOUT=$(echo "$INPUT" | jq -r '.tool_output.stdout // empty' 2>/dev/null)

# Check for merge-and-deploy curl calls
if ! echo "$COMMAND" | grep -qE 'merge-and-deploy'; then
  exit 0
fi

# Check if the response indicates failure
if echo "$STDOUT" | grep -qE '"success"\s*:\s*false|deploy_failed|Merge failed'; then
  DIR_ID=$(echo "$STDOUT" | grep -oE 'dir_[0-9]+' | head -1)
  echo "⚠️  MERGE-AND-DEPLOY FAILED for $DIR_ID — check directive status and git state"
fi

exit 0
