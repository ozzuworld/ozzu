#!/usr/bin/env node
// dir_1781203380739 — Reshape end-to-end PLAY trajectories (play-engagement.js output)
// into the {scenario, best} records that format-sft.js already consumes. This keeps the
// pilot SFT data byte-identical in format to the prior SFT and to eval-offense.js inference.
//
// Only WINNING trajectories (flag_captured) are emitted, one record per decision iter.
// queue_history is reconstructed cumulatively so each pair shows the model exactly the
// state it had when it chose that command.
//
// Usage: node play-to-scenarios.js <play.jsonl> > scenarios.jsonl

const fs = require("fs");
const readline = require("readline");

// MUST mirror play-engagement.js VARIANT_SCOPES (allowed/prohibited per variant) so the
// reconstructed user prompt matches what Opus actually saw.
const VARIANT_SCOPES = {
  v1: { allowed: ["10.10.20.10", "10.10.20.20", "10.10.20.30"], prohibited: ["10.10.20.1"] },
  v2: { allowed: ["10.10.21.10", "10.10.21.20", "10.10.21.30"], prohibited: ["10.10.21.1"] },
};

function histItem(it) {
  return {
    id: it.iter,
    status: it.exit_code === 0 ? "done" : "failed",
    intent: it.oracle_intent,
    command: it.command,
    output_excerpt: it.output_excerpt,   // 500-char excerpt; eval-offense.js uses the same
  };
}

async function main() {
  const input = process.argv[2];
  if (!input) { console.error("usage: play-to-scenarios.js <play.jsonl>"); process.exit(2); }

  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  let wins = 0, pairs = 0, skippedEng = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let t; try { t = JSON.parse(line); } catch { continue; }
    if (!t.flag_captured || !Array.isArray(t.iters)) { skippedEng++; continue; }
    wins++;

    const scope = VARIANT_SCOPES[t.variant] || { allowed: [], prohibited: [] };
    const maxIter = t.total_iters || t.iters.length;
    const history = [];

    for (const it of t.iters) {
      // Need a real command + reasoning to make a training target.
      if (it.command && it.oracle_reasoning) {
        const scenario = {
          engagement_id: t.engagement_id,
          objective: t.objective,
          allowed: scope.allowed,
          prohibited: scope.prohibited,
          synthetic_lab: true,
          iter: it.iter,
          max_iter: maxIter,
          queue_history: history.slice(),
        };
        const best = {
          command: it.command,
          reasoning: it.oracle_reasoning,
          intent: it.oracle_intent,
          expected_artifact: it.oracle_expected,
        };
        process.stdout.write(JSON.stringify({ scenario, best }) + "\n");
        pairs++;
      }
      history.push(histItem(it));   // grow context for the next iter regardless
    }
  }
  console.error(`[play-to-scenarios] winning_engagements=${wins} pairs=${pairs} skipped_non_win=${skippedEng}`);
}

main();
