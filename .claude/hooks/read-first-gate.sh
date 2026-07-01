#!/usr/bin/env bash
# read-first-gate.sh — PreToolUse:Write hook.
# Blocks creating a NEW file under frontend/components|app or backend/bridge/routes
# when siblings already exist in that directory but none were read this session.
# This is the exact VoipGatewayCard failure: a new component built from assumption
# instead of matching the neighbours. Editing an existing file is never blocked
# (the Edit tool already requires a prior Read). Fail-open: any error -> allow.
INPUT=$(cat)
echo "$INPUT" | python3 -c "
import sys, json, os, glob
try:
    data = json.load(sys.stdin)
    if data.get('tool_name') != 'Write':
        sys.exit(0)
    ti = data.get('tool_input') or {}
    fp = ti.get('file_path', '')
    if not fp:
        sys.exit(0)
    fp = os.path.abspath(fp)
    # Only guard the creation of NEW files. Overwriting an existing file: allow.
    if os.path.exists(fp):
        sys.exit(0)
    guarded = ('/frontend/components/', '/frontend/app/', '/backend/bridge/routes/')
    if not any(g in fp for g in guarded):
        sys.exit(0)
    d = os.path.dirname(fp)
    ext = os.path.splitext(fp)[1]
    siblings = [p for p in glob.glob(os.path.join(d, '*' + ext))
                if os.path.abspath(p) != fp and os.path.isfile(p)]
    if not siblings:
        sys.exit(0)  # brand-new dir / nothing to model on -> allow
    sid = data.get('session_id') or 'default'
    log = '/tmp/claude-reads-' + str(sid) + '.log'
    read_paths = set()
    if os.path.exists(log):
        with open(log) as f:
            read_paths = set(l.strip() for l in f if l.strip())
    if any(os.path.abspath(s) in read_paths for s in siblings):
        sys.exit(0)  # read at least one sibling -> allow
    names = sorted(os.path.basename(s) for s in siblings)[:6]
    reason = ('READ-FIRST GATE: creating new file ' + os.path.basename(fp) + ' in ' + d +
              ' but no existing file there was read this session. Read a sibling first and '
              'match its structure, e.g.: ' + ', '.join(names) +
              '. For UI also read frontend/lib/design-tokens.ts. Then retry the Write. '
              'This is the VoipGatewayCard mistake - do not build from assumption.')
    print(json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': reason}}))
except Exception:
    pass
" 2>/dev/null
exit 0
