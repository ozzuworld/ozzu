// Provider-agnostic --model gate for ALL `claude` CLI spawns.
// The claude CLI endpoint is an interchangeable hand (currently Qwen via Alibaba
// Model Studio). Anthropic model IDs/aliases ("opus", "claude-haiku-4-5-20251001")
// 400 with "Model not exist" on non-Anthropic endpoints — that silently killed
// every daemon auto-fix on 2026-09-17 (nginx recovery, action queue).
// Pinning is opt-in by the operator:
//   CIPHER_CLAUDE_MODEL=<name> → pin that exact name (must be valid on the active endpoint)
//   CIPHER_CLAUDE_ANTHROPIC=1  → endpoint IS Anthropic; use the preferred ID/alias
//   (neither set)              → omit --model entirely; ~/.claude/settings.json decides
function modelArgs(preferred) {
  const pinned = process.env.CIPHER_CLAUDE_MODEL;
  if (pinned) return ["--model", pinned];
  if (process.env.CIPHER_CLAUDE_ANTHROPIC === "1" && preferred) return ["--model", preferred];
  return [];
}

module.exports = { modelArgs };
