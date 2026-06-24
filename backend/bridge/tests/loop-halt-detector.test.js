// loop-halt-detector.test.js — dir_1782242371780 (CORRECTION)
//
// REWRITE of the prior green-suite-theater version. The old file (a) asserted the BUG
// as correct (terminal-phase halt → 'completed') and (b) tested INLINE COPIES of the
// logic, never importing the real modules — so reverting the real code left the suite
// green. This version imports the REAL production functions and every test is
// mutation-provable: reverting its named production line turns THAT test red.
//
//   computeFinalStatus      ← offense-agent.js
//   detectLoopHalt          ← telemetry-analyze.js
//   ACTIVE_AGENT_STATUSES   ← telemetry-analyze.js
//   getBehavioralScorecard  ← behavioral-scorecard.js
//   checkHaltedEngagements  ← watchdog.js
//
// No bridge process required: computeFinalStatus / detectLoopHalt / ACTIVE_AGENT_STATUSES
// are pure; getBehavioralScorecard + checkHaltedEngagements take a mock db / ctx.
//
// Run with: node tests/loop-halt-detector.test.js
"use strict";

const assert = require("assert");
const path   = require("path");

// REAL production modules — NOT inline copies.
// computeFinalStatus lives in the dependency-free offense-final-status.js (offense-agent.js
// requires + re-exports it). We import the real function from there because requiring
// offense-agent.js directly pulls its Docker-absolute (/app/*) tree that doesn't resolve
// outside the bridge container; a source-text check below pins that offense-agent.js
// actually USES this function (so the wiring can't silently regress).
const { computeFinalStatus }              = require(path.join(__dirname, "../offense-final-status"));
const { detectLoopHalt, ACTIVE_AGENT_STATUSES } = require(path.join(__dirname, "../telemetry-analyze"));
const { getBehavioralScorecard }          = require(path.join(__dirname, "../behavioral-scorecard"));
const watchdog                            = require(path.join(__dirname, "../watchdog"));
const fs                                  = require("fs");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// Mock db mirroring tests/scorecard-instrumentation.test.js's pattern: dispatch by the
// table named in the SQL. Lets us drive the real getBehavioralScorecard / watchdog
// queries without a live database.
function makeScorecardDb(overrides = {}) {
  const data = {
    engagement: { status: "in_progress", agent_status: "halted", engagement_phase: "reporting", agent_run_state: {} },
    telemetry: [], findings: [], tasks: [], queue: [],
    ...overrides,
  };
  return {
    async query(sql) {
      if (/FROM pentest_engagements/.test(sql)) return { rows: [data.engagement] };
      if (/FROM offense_telemetry/.test(sql))   return { rows: data.telemetry };
      if (/FROM pentest_findings/.test(sql))    return { rows: data.findings };
      if (/FROM engagement_tasks/.test(sql))    return { rows: data.tasks };
      if (/FROM soc_queue_items/.test(sql))     return { rows: data.queue };
      return { rows: [] };
    },
  };
}

(async () => {
  // ── Test 1: terminal-phase halt → 'halted' ──────────────────────────────────
  // PROD LINE: offense-agent.js computeFinalStatus `if (haltedAbnormally) return "halted";`
  // Revert (drop the halted arm / its precedence) → this goes red.
  console.log("\n[1] terminal-phase (harness-forced) halt → finalStatus 'halted'");
  check("haltedAbnormally=true → 'halted' (not 'completed', not 'error')", () => {
    const s = computeFinalStatus({ haltedAbnormally: true, endedByOrchestrator: false, iter: 3, maxIter: 50 });
    assert.strictEqual(s, "halted");
  });
  check("halt takes precedence even if iter hit the cap", () => {
    // A forced halt must still read 'halted', never 'paused', when both could apply.
    const s = computeFinalStatus({ haltedAbnormally: true, endedByOrchestrator: false, iter: 50, maxIter: 50 });
    assert.strictEqual(s, "halted");
  });
  check("WIRING: offense-agent.js uses computeFinalStatus + sets haltedAbnormally on the terminal-phase halt (not the old endedByOrchestrator=true)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "offense-agent.js"), "utf8");
    assert.ok(/computeFinalStatus\(\{\s*haltedAbnormally/.test(src),
      "runAgent must call computeFinalStatus({ haltedAbnormally, ... }) — the extracted mapping");
    assert.ok(src.includes('require("./offense-final-status")'),
      "offense-agent.js must require the pure offense-final-status module");
    // The terminal-phase loop-breaker branch must set haltedAbnormally, NOT the old
    // `endedByOrchestrator = true; // treat as clean conclusion` that caused the mislabel.
    assert.ok(!/endedByOrchestrator = true;\s*\/\/ treat as clean conclusion/.test(src),
      "the old 'treat as clean conclusion' mislabel on the terminal-phase halt must be gone");
    assert.ok(/haltedAbnormally = true; \/\/ harness-forced halt/.test(src),
      "the terminal-phase halt must set haltedAbnormally = true");
  });

  // ── Test 2: genuine model end → 'completed' (even with 0 findings) ───────────
  // PROD LINE: offense-agent.js computeFinalStatus `if (endedByOrchestrator) return "completed";`
  // Mutation: mis-order so the 'halted' arm swallows a clean end → this goes red.
  console.log("\n[2] genuine model end → 'completed' (discriminator: a clean end is legitimate)");
  check("endedByOrchestrator=true, haltedAbnormally=false → 'completed'", () => {
    const s = computeFinalStatus({ haltedAbnormally: false, endedByOrchestrator: true, iter: 4, maxIter: 50 });
    assert.strictEqual(s, "completed");
  });
  check("clean model end stays 'completed' even at iter cap (not 'paused')", () => {
    const s = computeFinalStatus({ haltedAbnormally: false, endedByOrchestrator: true, iter: 50, maxIter: 50 });
    assert.strictEqual(s, "completed");
  });

  // ── Test 3: max_iter budget hit → 'paused' (resumable, NOT a halt) ───────────
  // PROD LINE: offense-agent.js computeFinalStatus `if (iter >= maxIter) return "paused";`
  // Revert the paused arm → this goes red.
  console.log("\n[3] iteration-budget exhaustion → 'paused' (resumable, not a halt)");
  check("iter>=maxIter, no end, no halt → 'paused'", () => {
    const s = computeFinalStatus({ haltedAbnormally: false, endedByOrchestrator: false, iter: 50, maxIter: 50 });
    assert.strictEqual(s, "paused");
  });
  check("unexpected early exit (iter<maxIter, no end, no halt) → 'error'", () => {
    const s = computeFinalStatus({ haltedAbnormally: false, endedByOrchestrator: false, iter: 5, maxIter: 50 });
    assert.strictEqual(s, "error");
  });

  // ── Test 4: scorecard reports conclude_reason='halted' distinctly ────────────
  // PROD LINE: behavioral-scorecard.js the 'halted' token in the concluded /
  // conclude_reason enum arrays. Revert (drop 'halted') → this goes red.
  console.log("\n[4] behavioral scorecard surfaces conclude_reason='halted'");
  await checkAsync("agent_status='halted' → concluded=true AND conclude_reason='halted'", async () => {
    const sc = await getBehavioralScorecard(1, makeScorecardDb({
      engagement: { status: "in_progress", agent_status: "halted", engagement_phase: "reporting", agent_run_state: {} },
    }));
    assert.strictEqual(sc.conclude_reason, "halted", `expected 'halted', got '${sc.conclude_reason}'`);
    assert.strictEqual(sc.concluded, true, "halted engagement must count as concluded");
  });
  await checkAsync("a 'running' engagement is still NOT concluded (control)", async () => {
    const sc = await getBehavioralScorecard(1, makeScorecardDb({
      engagement: { status: "in_progress", agent_status: "running", engagement_phase: "recon", agent_run_state: {} },
    }));
    assert.strictEqual(sc.concluded, false);
    assert.strictEqual(sc.conclude_reason, "running");
  });

  // ── Test 5: detectLoopHalt surfaces the dark-loop marker ─────────────────────
  // PROD LINE: telemetry-analyze.js detectLoopHalt body (the marker find + the
  // abnormal-discriminator return of the issue). Revert (return [] / drop the push)
  // → this goes red. Also pins the discriminator (no false-positive on a clean end).
  console.log("\n[5] detectLoopHalt raises a 'loop_halted' issue on an abnormal halt");
  check("loop_halted marker + 0 confirmed findings + 1 failed step → 1 issue (warn)", () => {
    const telemetry = [{ outcome: "loop_halted" }];
    const issues = detectLoopHalt(telemetry, { confirmed_findings: 0, failed_steps: 1 });
    assert.strictEqual(issues.length, 1, `expected 1 issue, got ${issues.length}`);
    assert.strictEqual(issues[0].kind, "loop_halted");
    assert.strictEqual(issues[0].severity, "warn");
  });
  check("engagement_concluded marker is also detected when abnormal", () => {
    const issues = detectLoopHalt([{ outcome: "engagement_concluded" }], { confirmed_findings: 0, failed_steps: 2 });
    assert.strictEqual(issues.length, 1);
  });
  check("DISCRIMINATOR: clean model end (marker, 0 findings, 0 failed steps) → NO issue", () => {
    // The failed-step requirement keeps a legitimate 'nothing exploitable' verdict quiet.
    const issues = detectLoopHalt([{ outcome: "engagement_concluded" }], { confirmed_findings: 0, failed_steps: 0 });
    assert.strictEqual(issues.length, 0);
  });
  check("DISCRIMINATOR: confirmed findings present → NO issue (real result, not a dark halt)", () => {
    const issues = detectLoopHalt([{ outcome: "loop_halted" }], { confirmed_findings: 2, failed_steps: 3 });
    assert.strictEqual(issues.length, 0);
  });
  check("no marker row → NO issue", () => {
    const issues = detectLoopHalt([{ outcome: "step_queued" }], { confirmed_findings: 0, failed_steps: 5 });
    assert.strictEqual(issues.length, 0);
  });

  // ── Test 6: fleet scan includes 'halted' ─────────────────────────────────────
  // PROD VALUE: telemetry-analyze.js ACTIVE_AGENT_STATUSES array. Revert (remove
  // 'halted') → this goes red. analyzeAllActive selects ANY($1) over this exact
  // array, so the constant is the real fleet filter, not a copy.
  console.log("\n[6] fleet diagnostic status set includes 'halted'");
  check("ACTIVE_AGENT_STATUSES contains 'halted'", () => {
    assert.ok(Array.isArray(ACTIVE_AGENT_STATUSES), "ACTIVE_AGENT_STATUSES must be an array");
    assert.ok(ACTIVE_AGENT_STATUSES.includes("halted"), `missing 'halted' in [${ACTIVE_AGENT_STATUSES.join(", ")}]`);
  });
  check("ACTIVE_AGENT_STATUSES still includes the pre-existing running + error", () => {
    assert.ok(ACTIVE_AGENT_STATUSES.includes("running"));
    assert.ok(ACTIVE_AGENT_STATUSES.includes("error"));
  });

  // ── Test 7: watchdog de-dup — no second alert on an already-flagged halt ─────
  // PROD LINE: watchdog.js checkHaltedEngagements transition guard
  // `if (_haltedAlerted.has(id)) continue; _haltedAlerted.add(id);`. Remove the
  // guard (always alert) → the second sweep fires again → this goes red.
  console.log("\n[7] watchdog alerts a halt ONCE (running→halted transition dedup)");
  await checkAsync("two sweeps over the same halted engagement → exactly ONE alert", async () => {
    let alerts = 0;
    const mockCtx = {
      db: { async query(sql) {
        if (/agent_status = 'halted'/.test(sql)) return { rows: [{ id: "SKYLINE-SOC-TEST-1" }] };
        return { rows: [] };
      } },
      broadcastToAll(msg) { if (msg && msg.status === "halted") alerts++; },
    };
    watchdog.__setTestContext(mockCtx);   // inject ctx + clear the dedup set
    await watchdog.checkHaltedEngagements();
    await watchdog.checkHaltedEngagements();
    assert.strictEqual(alerts, 1, `expected exactly 1 alert across 2 sweeps, got ${alerts}`);
    watchdog.__setTestContext(null);      // teardown
  });
  await checkAsync("a halt that LEAVES 'halted' then returns re-alerts (ack cleared)", async () => {
    let alerts = 0;
    let halted = true;
    const mockCtx = {
      db: { async query(sql) {
        if (/agent_status = 'halted'/.test(sql)) return { rows: halted ? [{ id: "SKYLINE-SOC-TEST-2" }] : [] };
        return { rows: [] };
      } },
      broadcastToAll(msg) { if (msg && msg.status === "halted") alerts++; },
    };
    watchdog.__setTestContext(mockCtx);
    await watchdog.checkHaltedEngagements();   // alert (1)
    halted = false;
    await watchdog.checkHaltedEngagements();   // engagement left halted → ack cleared, no alert
    halted = true;
    await watchdog.checkHaltedEngagements();   // halted again → re-alert (2)
    assert.strictEqual(alerts, 2, `expected 2 alerts (re-halt re-fires), got ${alerts}`);
    watchdog.__setTestContext(null);
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((e) => {
  console.error("Async test runner crashed:", e.message);
  process.exit(1);
});
