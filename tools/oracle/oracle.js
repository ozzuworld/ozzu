#!/usr/bin/env node
// Oracle — Claude-as-teacher for SOC pentest trajectory generation.
//
// Uses @anthropic-ai/claude-agent-sdk's query() — authenticates via Max plan
// (OAuth session at /root/.local/share/claude), so no API key needed.
//
// Input:  engagement state snapshot (scope, queue history, last outcome)
// Output: {command, reasoning} — the optimal next SOC step the teacher
//         would issue from this state.
//
// Used by generate-trajectories.js to build the Sprint 2 SFT dataset.

const { query } = require("@anthropic-ai/claude-agent-sdk");

const TEACHER_MODEL = process.env.ORACLE_TEACHER_MODEL || "opus";

const SYSTEM_PROMPT = `You are an elite SOC pentest coordinator running an authorized engagement against a synthetic lab.

Your job: given the engagement state, propose the SINGLE next bash command that maximally advances toward the objective (find OZZULAB{...} flag).

RULES OF ENGAGEMENT:
- Targets are pre-authorized synthetic lab hosts. No CIDR sweeps. No outbound traffic outside scope.
- Use only valid Kali-installed binaries (nmap, gobuster, ffuf, curl, mysql, nc, etc.).
- Prefer commands that move forward. Avoid re-running scans whose answers are already in state.
- When you discover a new endpoint or hostname, USE IT — don't keep enumerating.
- When you confirm a vulnerability (e.g. LFI works), PIVOT to extracting prizes (creds, flags, source).
- Flag candidates live in: user home dirs, /var/www/html/*, /tmp/, application source via php://filter, linked docs in discovered portals.

OUTPUT FORMAT (STRICT JSON, no markdown):
{
  "reasoning": "<2-4 sentences explaining what you observed, why this command is the next move, and what you expect it to return>",
  "intent_class": "<one of: recon | service_version | enum | banner_grab | cred_test | exploit_probe | post_exploit | lateral | tool_setup>",
  "command": "<a single shell command>",
  "expected_artifact": "<one line: what success looks like (a string to grep for, a file path, a status code)>"
}

Do not preface or wrap. Output ONLY the JSON object.`;

function buildUserPrompt(state) {
  const lines = [];
  lines.push(`# Engagement state`);
  lines.push(`Objective: ${state.objective || "Find OZZULAB{...} flag on target hosts."}`);
  lines.push(`Allowed targets: ${(state.allowed || []).join(", ")}`);
  lines.push(`Prohibited: ${(state.prohibited || []).join(", ") || "none"}`);
  lines.push(`Synthetic lab: ${state.synthetic_lab ? "YES (full TTPs allowed)" : "no"}`);
  lines.push(``);
  lines.push(`# Iter ${state.iter} of ${state.max_iter}`);

  if (Array.isArray(state.discovered) && state.discovered.length) {
    lines.push(``);
    lines.push(`# Discovered`);
    for (const d of state.discovered) lines.push(`- ${d}`);
  }

  if (Array.isArray(state.queue_history) && state.queue_history.length) {
    lines.push(``);
    lines.push(`# Queue history (most recent last)`);
    for (const q of state.queue_history) {
      lines.push(`q#${q.id} [${q.status}] ${q.intent || ""}: ${q.command}`);
      if (q.output_excerpt) lines.push(`  → ${q.output_excerpt}`);
    }
  }

  if (state.last_failure) {
    lines.push(``);
    lines.push(`# Last failure`);
    lines.push(state.last_failure);
  }

  lines.push(``);
  lines.push(`Propose the next single command. Output ONLY the JSON object.`);
  return lines.join("\n");
}

async function askOracle(state, opts = {}) {
  const model = opts.model || TEACHER_MODEL;
  const userPrompt = buildUserPrompt(state);

  // Compose the full prompt: system instructions + user payload.
  // The agent SDK doesn't expose a separate `system` field via the simple
  // query() entry point, so we inline the system block at the top.
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  const t0 = Date.now();
  let finalText = "";
  let usage = null;
  let resultModel = null;

  // query() returns an AsyncGenerator of SDK messages.
  const stream = query({
    prompt: fullPrompt,
    options: {
      model,
      // Disable tools — we just want a single completion, no agentic loop.
      allowedTools: [],
    },
  });

  for await (const msg of stream) {
    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text") finalText += block.text;
      }
      if (msg.message?.model) resultModel = msg.message.model;
      if (msg.message?.usage) usage = msg.message.usage;
    } else if (msg.type === "result") {
      // result event has the final text + usage rollup
      if (msg.result && !finalText) finalText = msg.result;
      if (msg.usage && !usage) usage = msg.usage;
    }
  }

  const latency_ms = Date.now() - t0;
  const text = finalText.trim();

  let parsed;
  try {
    const stripped = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/, "")
      .trim();
    parsed = JSON.parse(stripped);
  } catch (e) {
    return {
      ok: false,
      raw: text,
      error: `JSON parse failed: ${e.message}`,
      latency_ms,
      usage,
      model: resultModel,
    };
  }

  return {
    ok: true,
    state,
    oracle_reasoning: parsed.reasoning,
    oracle_intent: parsed.intent_class,
    oracle_command: parsed.command,
    oracle_expected: parsed.expected_artifact,
    raw: text,
    latency_ms,
    usage,
    model: resultModel || model,
  };
}

module.exports = { askOracle, buildUserPrompt, SYSTEM_PROMPT };

if (require.main === module) {
  const fs = require("fs");
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: oracle.js <state.json>");
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  askOracle(state).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 2);
  }).catch(e => {
    console.error("oracle error:", e.message);
    process.exit(1);
  });
}
