#!/usr/bin/env node
// Sprint 2c — Multi-sample + self-grade trajectory pipeline.
//
// For each scenario: ask Opus N times (multi-sample) → grade with Opus → keep
// only the highest-scored candidate (rejection sampling, DeepSeek-R1 style).
//
// Replaces generate-trajectories.js (single-pass) for production training data.
//
// Usage:
//   node generate-trajectories-v2.js <scenarios.jsonl>
//     [--limit N] [--out path] [--temps a,b,c,d,e] [--min-score N]
//
// Default: 5 candidates per scenario, min-score 6 to keep.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { sampleCandidates, DEFAULT_TEMPS } = require("./multi-sample");
const { gradeCandidates } = require("./grade-candidates");

const DEFAULT_OUT = "/home/gcp/ozzu/private/oracle-trajectories/trajectories-v2.jsonl";
const REJECTED_OUT = "/home/gcp/ozzu/private/oracle-trajectories/rejected-v2.jsonl";

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: generate-trajectories-v2.js <scenarios.jsonl> [--limit N] [--out path] [--temps a,b,c,d,e] [--min-score N]");
    process.exit(2);
  }
  const scenariosFile = args[0];

  const arg = (k, def) => {
    const i = args.findIndex(a => a === k);
    return i >= 0 ? args[i + 1] : def;
  };

  const limit     = parseInt(arg("--limit", "0"), 10) || Infinity;
  const outFile   = arg("--out", DEFAULT_OUT);
  const rejFile   = arg("--rej", REJECTED_OUT);
  const temps     = (arg("--temps", null) || DEFAULT_TEMPS.join(",")).split(",").map(parseFloat);
  const minScore  = parseFloat(arg("--min-score", "6"));

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const outFd = fs.openSync(outFile, "a");
  const rejFd = fs.openSync(rejFile, "a");

  console.error(`[gen-v2] writing accepted → ${outFile}`);
  console.error(`[gen-v2] writing rejected → ${rejFile}`);
  console.error(`[gen-v2] temps=${temps.join(",")} min-score=${minScore}`);

  const rl = readline.createInterface({
    input: fs.createReadStream(scenariosFile),
    crlfDelay: Infinity,
  });

  let processed = 0;
  let accepted = 0;
  let rejected = 0;
  let totalInput = 0, totalOutput = 0;
  const t0 = Date.now();

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (processed >= limit) break;
    processed++;

    let scenario;
    try { scenario = JSON.parse(line); }
    catch (e) { console.error(`[gen-v2] skip malformed: ${e.message}`); continue; }

    const oracleInput = {
      iter: scenario.iter,
      max_iter: scenario.max_iter,
      objective: scenario.objective,
      allowed: scenario.allowed,
      prohibited: scenario.prohibited,
      synthetic_lab: scenario.synthetic_lab,
      discovered: scenario.discovered,
      queue_history: scenario.queue_history,
    };

    // ---- Stage 1: multi-sample ----
    let samp;
    try { samp = await sampleCandidates(oracleInput, { temps }); }
    catch (e) {
      console.error(`[gen-v2] sample error on ${scenario.engagement_id} iter ${scenario.iter}: ${e.message}`);
      continue;
    }
    if (samp.n_ok === 0) {
      console.error(`[gen-v2] all ${temps.length} candidates parse-failed on ${scenario.engagement_id} iter ${scenario.iter}`);
      continue;
    }

    // ---- Stage 2: grade ----
    let graded;
    try { graded = await gradeCandidates(oracleInput, samp.candidates); }
    catch (e) {
      console.error(`[gen-v2] grade error on ${scenario.engagement_id} iter ${scenario.iter}: ${e.message}`);
      continue;
    }
    if (!graded.ok) {
      console.error(`[gen-v2] grade parse-fail on ${scenario.engagement_id} iter ${scenario.iter}: ${graded.error}`);
      continue;
    }

    const best = graded.ranked[0]; // sorted desc by score
    const acceptedThis = (best.grader_score !== null && best.grader_score >= minScore);

    const trajectory = {
      scenario,
      candidates_n: samp.n_ok,
      best: {
        command: best.command,
        reasoning: best.reasoning,
        intent: best.intent,
        expected_artifact: best.expected_artifact,
        grader_score: best.grader_score,
        grader_rationale: best.grader_rationale,
        temp: best.temp,
      },
      best_reason: graded.best_reason,
      all_candidates: samp.candidates.map(c => ({
        temp: c.temp, ok: c.ok, command: c.command,
        intent: c.intent, score: graded.ranked.find(r => r.candidate_index === c.candidate_index)?.grader_score,
      })),
      ground_truth: scenario.ground_truth,
      usage: {
        sample_total: samp.candidates.reduce((s, c) => s + (c.usage?.output_tokens || 0), 0),
        grade: graded.usage?.output_tokens || 0,
      },
      ts: new Date().toISOString(),
    };

    const targetFd = acceptedThis ? outFd : rejFd;
    fs.writeSync(targetFd, JSON.stringify(trajectory) + "\n");
    if (acceptedThis) accepted++; else rejected++;

    totalInput  += (samp.candidates.reduce((s, c) => s + (c.usage?.input_tokens || 0), 0)) + (graded.usage?.input_tokens || 0);
    totalOutput += (samp.candidates.reduce((s, c) => s + (c.usage?.output_tokens || 0), 0)) + (graded.usage?.output_tokens || 0);

    if (processed % 3 === 0) {
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[gen-v2] ${processed} processed, ${accepted} accepted, ${rejected} rejected, tok in=${totalInput} out=${totalOutput}, ${el}s`);
    }
  }

  fs.closeSync(outFd);
  fs.closeSync(rejFd);
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`[gen-v2] DONE: ${accepted}/${processed} accepted, ${rejected} rejected (acceptance ${(accepted / (processed || 1) * 100).toFixed(1)}%)`);
  console.error(`[gen-v2] tokens: input=${totalInput} output=${totalOutput}, ${el}s elapsed`);
}

if (require.main === module) {
  main().catch(e => { console.error("gen-v2 fatal:", e); process.exit(1); });
}
