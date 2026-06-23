#!/usr/bin/env bash
# soc-isolation-guard.sh — PreToolUse hook
# Blocks the MAIN Claude session from reading/editing offense source files directly.
# Subagents (identified by "/subagents/" in transcript_path) are allowed through — they
# MUST be able to read offense source; that's the whole point of spawning them.
#
# Rule: .claude/rules/soc-isolation.md
# Exit codes: 0 = allow, 2 = block (PreToolUse block convention)

INPUT=$(cat)

# --- Extract fields via jq (robust to missing fields) ---
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')

# File path: try file_path, then path, then pattern (covers Read/Edit/Write and Grep)
FILE_PATH=$(echo "$INPUT" | jq -r '
  .tool_input.file_path //
  .tool_input.path //
  .tool_input.pattern //
  ""
')

# --- Guard 1: only inspect file-touching tools ---
case "$TOOL_NAME" in
  Read|Edit|Write|Grep) ;;
  *) exit 0 ;;
esac

# --- Guard 2: nothing to check if no file path ---
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# --- Guard 3: subagents are ALLOWED through ---
# Subagent transcripts live under a path containing "/subagents/"
if echo "$TRANSCRIPT_PATH" | grep -q '/subagents/'; then
  exit 0
fi

# --- Guard 4: check against the offense-source blocklist ---
# Match basename or full path for the named files, or any path under private/security-advisories/
is_blocked=0

# Named offense source files (match anywhere in the path)
BLOCKED_FILES=(
  "offense-agent.js"
  "offense-agent-tools.js"
  "offense-engine.js"
  "autonomous-executor.js"
  "permission-enforcer.js"
  "soc-command-classifier.js"
)

for blocked in "${BLOCKED_FILES[@]}"; do
  if echo "$FILE_PATH" | grep -q "$blocked"; then
    is_blocked=1
    MATCHED_FILE="$blocked"
    break
  fi
done

# routes/soc.js — match the routes/soc.js path specifically
if [ "$is_blocked" -eq 0 ]; then
  if echo "$FILE_PATH" | grep -qE 'routes/soc\.js$'; then
    is_blocked=1
    MATCHED_FILE="routes/soc.js"
  fi
fi

# private/security-advisories/ subtree
if [ "$is_blocked" -eq 0 ]; then
  if echo "$FILE_PATH" | grep -q 'private/security-advisories/'; then
    is_blocked=1
    MATCHED_FILE="private/security-advisories/ (subtree)"
  fi
fi

if [ "$is_blocked" -eq 0 ]; then
  exit 0
fi

# --- BLOCK: print message and exit 2 ---
cat <<EOF
BLOCKED by soc-isolation-guard.sh

The main Claude session cannot directly $TOOL_NAME offense source:
  $FILE_PATH  (matched: $MATCHED_FILE)

WHY: The Opus cybersecurity classifier scores cumulative context.
Reading offense source in the main session accumulates toward a session-killing trip.

WHAT TO DO INSTEAD — route through an isolated subagent:

  For EDITS:
    Agent({
      isolation: "worktree",
      prompt: "Edit $FILE_PATH: <describe the change at intent level, not exploit mechanics>"
    })

  For READ-ONLY analysis:
    Agent({
      prompt: "Read $FILE_PATH and summarize <specific question>. Stay at architecture/control-flow level."
    })

The subagent can read/edit offense source freely. It trips alone if it does; the main
session is unaffected.

Rule: .claude/rules/soc-isolation.md
EOF

exit 2
