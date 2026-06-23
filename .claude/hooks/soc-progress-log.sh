#!/bin/bash
# PostToolUse hook: after a SOC-related merge_and_deploy, append a timestamped line
# to the canonical SOC doc's "## Progress log" so it stays auto-current.
#
# Fires on the merge_and_deploy MCP tool (mcp__ozzu-bridge__merge_and_deploy) and on
# the legacy curl form. SOC-relevance is decided from the merged branch name OR the
# latest main commit subject matching: soc|offense|engagement|membrane|pentest|exploit.
# Never blocks or fails the tool (always exit 0).
#
# Wired in .claude/settings.json under PostToolUse. Self-tested with both a SOC and a
# non-SOC simulated payload (dir_1782250182891).

INPUT=$(cat)

DOC="/home/gcp/ozzu/backend/bridge/SOC-PIPELINE-ARCHITECTURE.md"
REPO="/home/gcp/ozzu"

# --- only act on merge_and_deploy (MCP tool name or legacy curl command) ---
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if ! echo "$TOOL_NAME $COMMAND" | grep -qiE 'merge[_-]and[_-]deploy'; then
  exit 0
fi

# --- gather a haystack from the tool result + input to detect branch/dir + SOC-ness ---
# tool_response is the MCP result; fall back to tool_output (Bash-style) + the raw input.
RESP=$(echo "$INPUT" | jq -r '
  (.tool_response // .tool_output // empty) |
  if type=="object" then tojson else (. // empty) end' 2>/dev/null)
HAYSTACK="$RESP $COMMAND $INPUT"

# If the merge clearly failed, do not log a progress entry.
if echo "$HAYSTACK" | grep -qiE '"?success"?\s*[:=]\s*false|deploy_failed|merge failed'; then
  exit 0
fi

# Merged branch / directive id (best-effort, for SOC detection + a fallback title).
BRANCH=$(echo "$HAYSTACK" | grep -oE 'cipher/dir_[0-9]+' | head -1)
DIR_ID=$(echo "$HAYSTACK" | grep -oE 'dir_[0-9]+' | head -1)

# Latest commit subject on main (human-readable title for the log line).
SUBJECT=$(git -C "$REPO" log -1 --format=%s 2>/dev/null)

# --- SOC relevance: branch OR latest main commit subject matches the topic regex ---
SOC_RE='soc|offense|engagement|membrane|pentest|exploit'
if ! echo "$BRANCH $SUBJECT" | grep -qiE "$SOC_RE"; then
  exit 0   # not a SOC-related merge — nothing to log
fi

# --- compose the line ---
STAMP=$(date +%Y-%m-%d)
TITLE="$SUBJECT"
[ -z "$TITLE" ] && TITLE="SOC merge ${DIR_ID:-(unknown directive)}"
LINE="- ${STAMP} — ${TITLE}"

[ -f "$DOC" ] || exit 0   # canonical doc missing (e.g. running pre-merge) — skip quietly

# Idempotency: if this exact line already exists, do not duplicate.
# NB: pass the pattern after `--` — $LINE starts with "- " which grep/ugrep would
# otherwise parse as an option flag.
if grep -qF -- "$LINE" "$DOC" 2>/dev/null; then
  exit 0
fi

# Insert newest-first. Anchor: the line is placed right after the closing "-->" of the
# comment block under "## Progress log"; if there is no comment block, right after the
# "## Progress log" heading. awk tracks state so only the FIRST valid anchor fires.
TMP=$(mktemp)
awk -v line="$LINE" '
  BEGIN { seen_hdr=0; injected=0 }
  {
    print $0
    if (injected) next
    if ($0 ~ /^## Progress log[[:space:]]*$/) { seen_hdr=1; next }
    if (seen_hdr && $0 ~ /-->/) { print ""; print line; injected=1; next }
  }
  END {
    # Fallback: heading existed but no comment-close was found — append at EOF anchor.
    if (seen_hdr && !injected) { print ""; print line }
  }
' "$DOC" > "$TMP"

if grep -qF -- "$LINE" "$TMP" 2>/dev/null; then
  mv "$TMP" "$DOC"
  echo "📝 SOC progress log updated: ${LINE}"
else
  rm -f "$TMP"
fi

exit 0
