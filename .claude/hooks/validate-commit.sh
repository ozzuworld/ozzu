#!/bin/bash
# PreToolUse hook: validate git commits follow the pipeline
# Blocks commits to main without directive ID, blocks commits without a branch

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Only check git commit commands
if ! echo "$COMMAND" | grep -qE '^\s*git\s+commit'; then
  exit 0
fi

# Check if we're on main — block direct commits
BRANCH=$(git -C /home/gcp/ozzu rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$BRANCH" = "main" ]; then
  # Allow exception tags
  if echo "$COMMAND" | grep -qE '\[(pipeline-fix|config|docs|security)\]'; then
    exit 0
  fi
  echo "BLOCKED: Cannot commit directly to main. Create a directive and branch first (cipher/dir_xxx)." >&2
  exit 2
fi

# Check if commit message contains directive ID on cipher/ branches
if echo "$BRANCH" | grep -qE '^cipher/'; then
  if ! echo "$COMMAND" | grep -qE 'dir_[0-9]{10,}'; then
    echo "BLOCKED: Commit on cipher/ branch must reference a directive ID (e.g. Directive: dir_XXXXX) in the commit message." >&2
    exit 2
  fi
fi

exit 0
