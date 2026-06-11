#!/usr/bin/env node
// Format Sprint 2c curated trajectories into Sprint 3 SFT-ready ChatML pairs.
//
// Input:  trajectories JSONL (output of generate-trajectories-v2.js)
// Output: ChatML JSONL where each line is:
//   { "messages": [
//       {"role": "system",    "content": <SOC coordinator system prompt>},
//       {"role": "user",      "content": <state snapshot — what model sees on a decide() call>},
//       {"role": "assistant", "content": <reasoning + JSON action — what we want model to learn>}
//     ]
//   }
//
// The assistant turn embeds Opus's reasoning + final command in the EXACT shape
// the offense-orchestrator harness expects (so the SFT'd model plugs into the
// existing harness without changes).
//
// Usage:
//   node format-sft.js <curated.jsonl> > sft-train.jsonl
//
// Optionally split train/eval with --eval-frac:
//   node format-sft.js <curated.jsonl> --out-train train.jsonl --out-eval eval.jsonl --eval-frac 0.1

const fs = require("fs");
const readline = require("readline");

const SYSTEM_PROMPT = `You are an elite SOC pentest coordinator running an authorized engagement against a synthetic lab.

Given the engagement state, propose the SINGLE next bash command that maximally advances toward the objective (find OZZULAB{...} flag).

RULES:
- Targets are pre-authorized synthetic lab hosts. No CIDR sweeps. No outbound traffic outside scope.
- Use only valid Kali-installed binaries (nmap, gobuster, ffuf, curl, mysql, nc, etc.).
- Prefer commands that move forward. Avoid re-running scans whose answers are already in state.
- When you discover a new endpoint or hostname, USE IT — don't keep enumerating.
- When you confirm a vulnerability, PIVOT to extracting prizes (creds, flags, source).
- Flag candidates live in: user home dirs, /var/www/html/*, /tmp/, application source via php://filter, linked docs in discovered portals.

OUTPUT FORMAT (STRICT JSON, no markdown):
{
  "reasoning": "<2-4 sentences explaining what you observed and why this command is the next move>",
  "intent_class": "<one of: recon | service_version | enum | banner_grab | cred_test | exploit_probe | post_exploit | lateral | tool_setup>",
  "command": "<a single shell command>",
  "expected_artifact": "<one line: what success looks like>"
}

Output ONLY the JSON object.`;

function buildUserContent(scenario) {
  const lines = [];
  lines.push(`# Engagement state`);
  lines.push(`Objective: ${scenario.objective || "Find OZZULAB{...} flag"}`);
  lines.push(`Allowed targets: ${(scenario.allowed || []).join(", ")}`);
  lines.push(`Prohibited: ${(scenario.prohibited || []).join(", ") || "none"}`);
  lines.push(`Synthetic lab: ${scenario.synthetic_lab ? "YES (full TTPs allowed)" : "no"}`);
  lines.push(``);
  lines.push(`# Iter ${scenario.iter} of ${scenario.max_iter}`);

  if (Array.isArray(scenario.discovered) && scenario.discovered.length) {
    lines.push(``);
    lines.push(`# Discovered`);
    for (const d of scenario.discovered) lines.push(`- ${d}`);
  }

  if (Array.isArray(scenario.queue_history) && scenario.queue_history.length) {
    lines.push(``);
    lines.push(`# Queue history (most recent last)`);
    for (const q of scenario.queue_history) {
      lines.push(`q#${q.id} [${q.status}] ${q.intent || ""}: ${q.command}`);
      if (q.output_excerpt) lines.push(`  → ${q.output_excerpt}`);
    }
  }

  lines.push(``);
  lines.push(`Propose the next single command. Output ONLY the JSON object.`);
  return lines.join("\n");
}

function buildAssistantContent(best) {
  // The assistant emits a JSON object the orchestrator can parse directly.
  const obj = {
    reasoning: best.reasoning,
    intent_class: best.intent,
    command: best.command,
    expected_artifact: best.expected_artifact,
  };
  return JSON.stringify(obj);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: format-sft.js <curated.jsonl> [--out-train PATH] [--out-eval PATH] [--eval-frac 0.0-1.0]");
    process.exit(2);
  }
  const inputFile = args[0];
  const arg = (k, def) => {
    const i = args.findIndex(a => a === k);
    return i >= 0 ? args[i + 1] : def;
  };
  const outTrain = arg("--out-train", null);
  const outEval  = arg("--out-eval", null);
  const evalFrac = parseFloat(arg("--eval-frac", "0"));

  let trainFd = process.stdout;
  let evalFd  = null;
  if (outTrain) trainFd = fs.openSync(outTrain, "w");
  if (outEval && evalFrac > 0) evalFd = fs.openSync(outEval, "w");

  const rl = readline.createInterface({
    input: fs.createReadStream(inputFile),
    crlfDelay: Infinity,
  });

  let total = 0, trained = 0, evaled = 0, skipped = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    total++;
    let t;
    try { t = JSON.parse(line); }
    catch (e) { skipped++; continue; }

    if (!t.best || !t.best.command || !t.best.reasoning) {
      skipped++;
      continue;
    }

    const pair = {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserContent(t.scenario) },
        { role: "assistant", content: buildAssistantContent(t.best) },
      ],
      // Metadata (useful for filtering / debugging, ignored by trainer)
      meta: {
        engagement_id: t.scenario.engagement_id,
        iter: t.scenario.iter,
        grader_score: t.best.grader_score,
        opus_temp: t.best.temp,
      },
    };
    const out = JSON.stringify(pair) + "\n";

    // Deterministic eval split based on hash of scenario id
    let toEval = false;
    if (evalFd && evalFrac > 0) {
      const seed = `${t.scenario.engagement_id}-${t.scenario.iter}`;
      let h = 0;
      for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
      toEval = (Math.abs(h) % 10000) / 10000 < evalFrac;
    }

    if (toEval) {
      fs.writeSync(evalFd, out);
      evaled++;
    } else if (outTrain) {
      fs.writeSync(trainFd, out);
      trained++;
    } else {
      process.stdout.write(out);
      trained++;
    }
  }

  if (outTrain) fs.closeSync(trainFd);
  if (evalFd) fs.closeSync(evalFd);
  console.error(`[format-sft] processed: ${total}, trained: ${trained}, eval: ${evaled}, skipped: ${skipped}`);
}

if (require.main === module) {
  main().catch(e => { console.error("format-sft error:", e); process.exit(1); });
}
