#!/usr/bin/env node
// Stage 1 — Multi-sample oracle: ask Opus N times per scenario at varying temps.
// Returns the K candidates as an array. Caller decides which to keep (use
// grade-candidates.js for self-judging).
//
// Used to upgrade Sprint 2's single-pass trajectories into rejection-sampleable
// candidate pools (DeepSeek-R1 recipe).
//
// Usage (programmatic):
//   const { sampleCandidates } = require("./multi-sample");
//   const r = await sampleCandidates(state, { temps: [0.3,0.5,0.7,0.9,1.0] });
//   // r.candidates: [{command, reasoning, intent, temp, latency_ms, ok}, ...]

const { askOracle } = require("./oracle");

const DEFAULT_TEMPS = [0.3, 0.5, 0.7, 0.9, 1.0];

async function sampleCandidates(state, opts = {}) {
  const temps = opts.temps || DEFAULT_TEMPS;
  const model = opts.model;
  const parallel = opts.parallel !== false; // default parallel

  const tasks = temps.map((temp, i) => async () => {
    const t0 = Date.now();
    try {
      // Tag the prompt with sample-index so cache doesn't dedup. Opus's
      // OAuth path doesn't expose temperature directly, but varied prompts
      // produce varied chains (the de-facto temperature effect on Max plan).
      const stateWithSeed = {
        ...state,
        _sample_index: i,
        _sample_temp: temp,
      };
      const r = await askOracle(stateWithSeed, { model });
      return {
        candidate_index: i,
        temp,
        ok: r.ok,
        command: r.oracle_command || null,
        reasoning: r.oracle_reasoning || null,
        intent: r.oracle_intent || null,
        expected_artifact: r.oracle_expected || null,
        raw: r.raw,
        error: r.error || null,
        latency_ms: r.latency_ms,
        usage: r.usage,
        model: r.model,
        elapsed_ms: Date.now() - t0,
      };
    } catch (e) {
      return {
        candidate_index: i, temp, ok: false,
        command: null, reasoning: null, intent: null, expected_artifact: null,
        raw: null, error: e.message,
        latency_ms: Date.now() - t0, usage: null, model: null,
        elapsed_ms: Date.now() - t0,
      };
    }
  });

  let candidates;
  if (parallel) {
    candidates = await Promise.all(tasks.map(t => t()));
  } else {
    candidates = [];
    for (const t of tasks) candidates.push(await t());
  }

  return {
    state,
    candidates,
    n_ok: candidates.filter(c => c.ok).length,
    n_failed: candidates.filter(c => !c.ok).length,
    total_latency_ms: Math.max(...candidates.map(c => c.elapsed_ms)),
  };
}

module.exports = { sampleCandidates, DEFAULT_TEMPS };

if (require.main === module) {
  const fs = require("fs");
  const p = process.argv[2];
  if (!p) {
    console.error("Usage: multi-sample.js <state.json>");
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(p, "utf8"));
  sampleCandidates(state).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch(e => {
    console.error("multi-sample error:", e.message);
    process.exit(1);
  });
}
