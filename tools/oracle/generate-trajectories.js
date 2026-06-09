#!/usr/bin/env node
// Generate SFT trajectories by feeding scenarios to the Oracle.
//
// Input:  JSONL of scenarios (from extract-scenarios.js)
// Output: JSONL of trajectories, one per scenario:
//   {
//     scenario: {...},                         // engagement state at decision time
//     oracle: {command, reasoning, intent},    // Opus answer
//     ground_truth: {chose_command, outcome},  // what the actual model did
//     usage: {input_tokens, output_tokens},
//     ts: <ISO>
//   }
//
// Usage:
//   node generate-trajectories.js <scenarios.jsonl> [--limit N] [--out <path>]

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { askOracle } = require("./oracle");

const DEFAULT_OUT = "/home/gcp/ozzu/private/oracle-trajectories/trajectories.jsonl";

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: generate-trajectories.js <scenarios.jsonl> [--limit N] [--out <path>]");
    process.exit(2);
  }
  const scenariosFile = args[0];
  const limitArg = args.findIndex(a => a === "--limit");
  const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;
  const outArg = args.findIndex(a => a === "--out");
  const outFile = outArg >= 0 ? args[outArg + 1] : DEFAULT_OUT;

  // Ensure output dir exists
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const outFd = fs.openSync(outFile, "a");
  console.error(`[gen] writing to ${outFile}`);

  const rl = readline.createInterface({
    input: fs.createReadStream(scenariosFile),
    crlfDelay: Infinity,
  });

  let processed = 0, succeeded = 0, failed = 0;
  let totalInput = 0, totalOutput = 0;
  const t0 = Date.now();

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (processed >= limit) break;
    processed++;

    let scenario;
    try { scenario = JSON.parse(line); }
    catch (e) {
      console.error(`[gen] skip malformed line: ${e.message}`);
      continue;
    }

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

    let r;
    try {
      r = await askOracle(oracleInput);
    } catch (e) {
      console.error(`[gen] oracle error on ${scenario.engagement_id} iter ${scenario.iter}: ${e.message}`);
      failed++;
      continue;
    }

    if (!r.ok) {
      console.error(`[gen] oracle parse-fail on ${scenario.engagement_id} iter ${scenario.iter}: ${r.error}`);
      failed++;
      continue;
    }

    const trajectory = {
      scenario,
      oracle: {
        command: r.oracle_command,
        reasoning: r.oracle_reasoning,
        intent: r.oracle_intent,
        expected_artifact: r.oracle_expected,
      },
      ground_truth: scenario.ground_truth,
      usage: r.usage,
      model: r.model,
      latency_ms: r.latency_ms,
      ts: new Date().toISOString(),
    };

    fs.writeSync(outFd, JSON.stringify(trajectory) + "\n");
    succeeded++;
    totalInput += r.usage?.input_tokens || 0;
    totalOutput += r.usage?.output_tokens || 0;

    if (processed % 5 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[gen] ${processed} processed, ${succeeded} ok, ${failed} fail, tokens in=${totalInput} out=${totalOutput}, ${elapsed}s`);
    }
  }

  fs.closeSync(outFd);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`[gen] DONE: ${succeeded}/${processed} succeeded, ${failed} failed`);
  console.error(`[gen] tokens: input=${totalInput} output=${totalOutput}`);
  console.error(`[gen] elapsed: ${elapsed}s`);
  console.error(`[gen] output: ${outFile}`);
}

if (require.main === module) {
  main().catch(e => { console.error("gen error:", e); process.exit(1); });
}
