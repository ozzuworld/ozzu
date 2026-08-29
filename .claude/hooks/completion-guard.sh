#!/usr/bin/env bash
# completion-guard.sh — Stop hook.
# Anti-shortcut guardrail: blocks premature stopping when the final assistant
# message ends with a dodge question ("want me to continue?", "shall I?", ...)
# instead of finishing the work. Exit 2 + stderr feeds the reason back to the
# model, which must keep working. Fail-open: any error -> allow the stop.
# Loop guard: if stop_hook_active is set, always allow (never re-block).
INPUT=$(cat)
echo "$INPUT" | python3 -c "
import sys, json, re
try:
    data = json.load(sys.stdin)
    # Already inside a stop-hook loop -> let it end, no matter what.
    if data.get('stop_hook_active'):
        sys.exit(0)
    tp = data.get('transcript_path') or ''
    if not tp:
        sys.exit(0)
    last_text = ''
    with open(tp) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get('type') != 'assistant':
                continue
            msg = rec.get('message') or {}
            content = msg.get('content')
            texts = []
            if isinstance(content, str):
                texts = [content]
            elif isinstance(content, list):
                texts = [c.get('text', '') for c in content
                         if isinstance(c, dict) and c.get('type') == 'text']
            if texts:
                last_text = ' '.join(texts)
    if not last_text:
        sys.exit(0)
    tail = last_text[-300:].lower()
    dodges = [
        r'want me to\b', r'do you want me\b', r'shall i\b', r'should i\b',
        r'would you like me\b', r'let me know if you\b', r'happy to continue',
        r'i can (?:continue|proceed|do that) (?:if you|next)',
        r'say the word\b', r'just ask\b',
    ]
    if not any(re.search(p, tail) for p in dodges):
        sys.exit(0)
    sys.stderr.write(
        'COMPLETION GUARD: you ended with a dodge question instead of finishing. '
        'Never ask permission to continue - do the remaining work NOW, verify it, '
        'then end with the result. No off-ramps, no want-me-to questions.\n')
    sys.exit(2)
except Exception:
    sys.exit(0)
"
exit $?
