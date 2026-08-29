#!/usr/bin/env bash
# edit-size-check.sh — PostToolUse hook (matcher: Edit|Write).
# Anti-shortcut guardrail: flags cosmetic edits that change < 5 characters —
# a satisficing signal (tweak a char instead of making the real change).
# Advisory only: feeds the flag back to Claude, never undoes the edit.
# Write (new content) is never flagged. Fail-open: any error -> exit 0.
INPUT=$(cat)
echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data.get('tool_name') != 'Edit':
        sys.exit(0)
    ti = data.get('tool_input') or {}
    old = ti.get('old_string') or ''
    new = ti.get('new_string') or ''
    if not old and not new:
        sys.exit(0)
    # Strip common prefix + suffix -> the region that actually changed.
    i, n = 0, min(len(old), len(new))
    while i < n and old[i] == new[i]:
        i += 1
    j_old, j_new = len(old), len(new)
    while j_old > i and j_new > i and old[j_old-1] == new[j_new-1]:
        j_old -= 1
        j_new -= 1
    changed = max(j_old - i, j_new - i)
    if changed >= 5:
        sys.exit(0)
    fp = ti.get('file_path', '?')
    sys.stderr.write(
        'EDIT-SIZE CHECK: that edit to ' + fp + ' changed only ' + str(changed) +
        ' character(s). Cosmetic-only edits are a satisficing signal — confirm you '
        'just made the substantive change the task actually requires (and if this '
        'was a genuine one-char fix, carry on).\n')
    sys.exit(2)
except Exception:
    sys.exit(0)
"
exit $?
