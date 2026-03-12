#!/bin/bash
# UserPromptSubmit hook: injects the last conversation's final messages
# directly into Claude's context on every message.
# This is NOT pre-loaded context — it's injected at message time.

# Pull the last 2 conversations via bridge API (first one might be current session)
RESULT=$(curl -s "http://localhost:3333/cipher/history?limit=2" 2>/dev/null)

if [ -z "$RESULT" ]; then
  exit 0
fi

# Extract the last 5 turns from the most recent conversation using node
OUTPUT=$(node -e "
const data = JSON.parse(process.argv[1]);
if (!data.conversations || !data.conversations.length) process.exit(0);
// Use index 0 — the current active session is NOT in the DB yet (saved on SessionEnd), so index 0 is the last completed session
const conv = data.conversations[0];
const turns = (conv.turns || []).filter(t => {
  const c = (t.content || '');
  // Filter out /exit commands and system noise
  if (c.includes('<command-name>/exit</command-name>')) return false;
  if (c.includes('<local-command-stdout>')) return false;
  if (c.includes('<local-command-caveat>')) return false;
  if (c.trim() === '') return false;
  return true;
});
const last5 = turns.slice(-10);
if (!last5.length) process.exit(0);
console.log('=== LAST SESSION — FINAL MESSAGES (answer from these when asked) ===');
console.log('');
last5.forEach(t => {
  const who = t.role === 'user' ? 'King Kazuma' : 'Cipher';
  const content = (t.content || '').substring(0, 800);
  console.log('[' + who + ']: ' + content);
  console.log('');
});
console.log('=== END ===');
" "$RESULT" 2>/dev/null)

if [ -n "$OUTPUT" ]; then
  echo "$OUTPUT"
fi

exit 0
