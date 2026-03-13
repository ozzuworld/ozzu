#!/bin/bash
# UserPromptSubmit hook: injects context into every Claude message.
#
# FIRST MESSAGE of a session: injects a MANDATORY PRE-FLIGHT CHECKLIST
# that Cipher must complete before responding. This is the gate.
#
# SUBSEQUENT MESSAGES: injects lightweight last-session reference only.

BRIDGE_URL="http://localhost:3333"
STATE_FILE="/tmp/ozzu-bridge/cipher-preflight-done"

# Pull the last 2 conversations via bridge API
RESULT=$(curl -s "${BRIDGE_URL}/cipher/history?limit=2" 2>/dev/null)

if [ -z "$RESULT" ]; then
  exit 0
fi

# Check if this is the first message of a new session
# (state file doesn't exist or was created by a different session)
CURRENT_SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
PREVIOUS_SESSION_ID=""
if [ -f "$STATE_FILE" ]; then
  PREVIOUS_SESSION_ID=$(cat "$STATE_FILE" 2>/dev/null)
fi

IS_FIRST_MESSAGE=false
if [ "$CURRENT_SESSION_ID" != "$PREVIOUS_SESSION_ID" ]; then
  IS_FIRST_MESSAGE=true
fi

if [ "$IS_FIRST_MESSAGE" = true ]; then
  # FIRST MESSAGE — inject full pre-flight checklist
  mkdir -p /tmp/ozzu-bridge
  echo "$CURRENT_SESSION_ID" > "$STATE_FILE"

  # Get full last conversation (not just last 5 turns)
  OUTPUT=$(node -e "
const data = JSON.parse(process.argv[1]);
if (!data.conversations || !data.conversations.length) process.exit(0);
const conv = data.conversations[0];
const turns = (conv.turns || []).filter(t => {
  const c = (t.content || '');
  if (c.includes('<command-name>/exit</command-name>')) return false;
  if (c.includes('<local-command-stdout>')) return false;
  if (c.includes('<local-command-caveat>')) return false;
  if (c.trim() === '') return false;
  return true;
});
// Last 20 turns for full context
const lastN = turns.slice(-20);
if (!lastN.length) process.exit(0);

console.log('=== MANDATORY PRE-FLIGHT CHECKLIST ===');
console.log('YOU MUST COMPLETE THIS BEFORE YOUR FIRST RESPONSE.');
console.log('If you skip this, King Kazuma will see it immediately.');
console.log('');
console.log('1. QUOTE King Kazuma last message (copy exact words below):');
const lastUser = [...lastN].reverse().find(t => t.role === 'user');
if (lastUser) console.log('   > ' + (lastUser.content || '').substring(0, 300));
console.log('');
console.log('2. QUOTE your last response (copy exact words below):');
const lastAssistant = [...lastN].reverse().find(t => t.role === 'assistant');
if (lastAssistant) console.log('   > ' + (lastAssistant.content || '').substring(0, 300));
console.log('');
console.log('3. WHAT IS THE PENDING ACTION? State it in one sentence.');
console.log('');
console.log('4. READ /home/gcp/ozzu/INVENTORY.md before writing ANY code.');
console.log('   If what you are about to build ALREADY EXISTS in the inventory, USE IT. Do NOT rebuild.');
console.log('');
console.log('RULES:');
console.log('- If King Kazuma asks \"where we left off\" → answer ONLY from this context');
console.log('- Do NOT make API calls, searches, or tool calls before completing this checklist');
console.log('- Do NOT give status dumps or summaries — answer from the conversation');
console.log('');
console.log('=== LAST SESSION CONVERSATION ===');
console.log('');
lastN.forEach(t => {
  const who = t.role === 'user' ? '[King Kazuma]' : '[Cipher]';
  const content = (t.content || '').substring(0, 800);
  console.log(who + ': ' + content);
  console.log('');
});
console.log('=== END PRE-FLIGHT ===');
" "$RESULT" 2>/dev/null)

  if [ -n "$OUTPUT" ]; then
    echo "$OUTPUT"
  fi
else
  # SUBSEQUENT MESSAGES — lightweight reference only (saves tokens)
  OUTPUT=$(node -e "
const data = JSON.parse(process.argv[1]);
if (!data.conversations || !data.conversations.length) process.exit(0);
const conv = data.conversations[0];
const turns = (conv.turns || []).filter(t => {
  const c = (t.content || '');
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
fi

exit 0
