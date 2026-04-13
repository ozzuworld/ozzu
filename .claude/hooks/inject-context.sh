#!/usr/bin/env bash
# inject-context.sh — PreToolUse hook that injects path-scoped architecture rules
# Fires on Read|Edit|Write|Glob|Grep. Reads tool_input from stdin JSON,
# matches file path against known areas, outputs additionalContext.

RULES_DIR="/home/gcp/ozzu/.claude/rules"

# Read hook input from stdin
INPUT=$(cat)

# Extract file path from tool_input (handles file_path, path, and pattern fields)
FILE_PATH=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ti = data.get('tool_input', {})
    print(ti.get('file_path', '') or ti.get('path', '') or ti.get('pattern', ''))
except:
    print('')
" 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0

# Match path to rules file
RULES_FILE=""
case "$FILE_PATH" in
  *backend/*|*/bridge/*) RULES_FILE="$RULES_DIR/backend.md" ;;
  *frontend/*) RULES_FILE="$RULES_DIR/frontend.md" ;;
  *hardware/*) RULES_FILE="$RULES_DIR/hardware.md" ;;
esac

[ -z "$RULES_FILE" ] || [ ! -f "$RULES_FILE" ] && exit 0

# Read rules content (skip frontmatter)
CONTENT=$(awk 'BEGIN{skip=0} /^---$/{skip++; next} skip>=2{print}' "$RULES_FILE")

[ -z "$CONTENT" ] && exit 0

# Output additionalContext JSON
python3 -c "
import json, sys
content = sys.stdin.read()
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'additionalContext': content
    }
}))
" <<< "$CONTENT"
