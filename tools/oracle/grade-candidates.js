#!/usr/bin/env node
// Stage 2 — Self-grader: Opus ranks the candidate commands from multi-sample.js
// by reasoning quality and predicted impact on the engagement objective.
//
// Returns a ranked list with scores 0-10 per candidate plus a verdict
// ("kept" | "rejected") for downstream curation.
//
// Programmatic:
//   const { gradeCandidates } = require("./grade-candidates");
//   const r = await gradeCandidates(state, candidates);
//   // r.ranked: [{...candidate, score, rationale}, ...]

const { query } = require("@anthropic-ai/claude-agent-sdk");

const GRADER_MODEL = process.env.GRADER_MODEL || "opus";

const SYSTEM_PROMPT = `You are evaluating candidate next-commands for a SOC pentest engagement.

Given the engagement state and N candidate commands, score each from 0-10 on:
- Strategic fit (will it move toward the objective?)
- Use of discovered information (does it leverage what's already known?)
- Tactical correctness (valid syntax, plausible expected output, no fabricated names)
- Avoidance of redundancy (not re-running what's already been done)
- Reasonable scope (no CIDR sweeps, no out-of-scope targets)

Output STRICT JSON only:
{
  "scores": [
    {"candidate_index": 0, "score": <0-10>, "rationale": "<one sentence>"},
    ...
  ],
  "best_index": <int>,
  "best_reason": "<one sentence — why this one wins>"
}

Score 0 = totally wrong / hallucinated. 5 = okay. 10 = optimal next step.
Be honest — if multiple candidates are equivalently good, score them equally.
Do not preface or wrap. Output ONLY the JSON object.`;

function buildGraderPrompt(state, candidates) {
  const lines = [];
  lines.push(`# Engagement state`);
  lines.push(`Objective: ${state.objective || "Find OZZULAB{...} flag"}`);
  lines.push(`Allowed targets: ${(state.allowed || []).join(", ")}`);
  lines.push(`Synthetic lab: ${state.synthetic_lab ? "YES" : "no"}`);
  lines.push(`Iter ${state.iter} of ${state.max_iter}`);

  if (state.discovered && state.discovered.length) {
    lines.push(``);
    lines.push(`# Discovered`);
    for (const d of state.discovered) lines.push(`- ${d}`);
  }

  if (state.queue_history && state.queue_history.length) {
    lines.push(``);
    lines.push(`# Recent queue history`);
    for (const q of state.queue_history) {
      lines.push(`q#${q.id} [${q.status}] ${q.intent || ""}: ${q.command}`);
      if (q.output_excerpt) lines.push(`  → ${q.output_excerpt.slice(0, 200)}`);
    }
  }

  lines.push(``);
  lines.push(`# Candidate next-commands (rank these)`);
  candidates.forEach((c, i) => {
    if (!c.ok || !c.command) {
      lines.push(`## Candidate ${i} (PARSE FAILED)`);
      lines.push(`error: ${c.error || "unknown"}`);
      return;
    }
    lines.push(`## Candidate ${i} (intent=${c.intent || "?"}, temp=${c.temp})`);
    lines.push(`reasoning: ${c.reasoning}`);
    lines.push(`command: ${c.command}`);
    if (c.expected_artifact) lines.push(`expected: ${c.expected_artifact}`);
  });

  lines.push(``);
  lines.push(`Score each candidate and pick the best. Output ONLY JSON.`);
  return lines.join("\n");
}

async function gradeCandidates(state, candidates, opts = {}) {
  if (!candidates || candidates.length === 0) {
    return { ok: false, error: "no candidates" };
  }
  const model = opts.model || GRADER_MODEL;
  const userPrompt = buildGraderPrompt(state, candidates);
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  const t0 = Date.now();
  let finalText = "";
  let usage = null;
  let resultModel = null;
  const stream = query({
    prompt: fullPrompt,
    options: { model, allowedTools: [] },
  });
  for await (const msg of stream) {
    if (msg.type === "assistant" && msg.message?.content) {
      for (const b of msg.message.content) if (b.type === "text") finalText += b.text;
      if (msg.message?.model) resultModel = msg.message.model;
      if (msg.message?.usage) usage = msg.message.usage;
    } else if (msg.type === "result") {
      if (msg.result && !finalText) finalText = msg.result;
      if (msg.usage && !usage) usage = msg.usage;
    }
  }
  const latency_ms = Date.now() - t0;
  const text = finalText.trim();

  let parsed;
  try {
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    parsed = JSON.parse(stripped);
  } catch (e) {
    return {
      ok: false, error: `JSON parse: ${e.message}`,
      raw: text, latency_ms, usage,
    };
  }

  const ranked = candidates.map((c, i) => {
    const scoreEntry = (parsed.scores || []).find(s => s.candidate_index === i);
    return {
      ...c,
      grader_score: scoreEntry ? scoreEntry.score : null,
      grader_rationale: scoreEntry ? scoreEntry.rationale : null,
    };
  }).sort((a, b) => (b.grader_score ?? -1) - (a.grader_score ?? -1));

  return {
    ok: true,
    state,
    ranked,
    best_index: parsed.best_index,
    best_reason: parsed.best_reason,
    raw: text,
    latency_ms,
    usage,
    model: resultModel || model,
  };
}

module.exports = { gradeCandidates };

if (require.main === module) {
  const fs = require("fs");
  const stateP = process.argv[2];
  const candP  = process.argv[3];
  if (!stateP || !candP) {
    console.error("Usage: grade-candidates.js <state.json> <candidates.json>");
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(stateP, "utf8"));
  const candidates = JSON.parse(fs.readFileSync(candP, "utf8")).candidates ||
                     JSON.parse(fs.readFileSync(candP, "utf8"));
  gradeCandidates(state, candidates).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 2);
  }).catch(e => {
    console.error("grader fatal:", e.message);
    process.exit(1);
  });
}
