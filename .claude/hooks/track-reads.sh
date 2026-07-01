#!/usr/bin/env bash
# track-reads.sh — PostToolUse:Read hook.
# Logs each file Cipher Reads to a session-scoped file so read-first-gate.sh can
# require that a sibling was read before a new file is created in a pattern-heavy
# dir. Fail-open: any error is swallowed and we always exit 0 (never disrupts).
INPUT=$(cat)
echo "$INPUT" | python3 -c "
import sys, json, os
try:
    data = json.load(sys.stdin)
    if data.get('tool_name') != 'Read':
        sys.exit(0)
    fp = (data.get('tool_input') or {}).get('file_path', '')
    if not fp:
        sys.exit(0)
    sid = data.get('session_id') or 'default'
    log = '/tmp/claude-reads-' + str(sid) + '.log'
    with open(log, 'a') as f:
        f.write(os.path.abspath(fp) + '\n')
except Exception:
    pass
" 2>/dev/null
exit 0
