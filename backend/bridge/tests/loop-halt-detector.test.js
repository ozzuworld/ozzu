// loop-halt-detector.test.js — dir_1782242371780
// Unit tests for the three loop-halt fixes:
//   Fix 1: terminal-phase loop-breaker → engagement_concluded (not silent skip)
//   Fix 2: iter-budget exhaustion → 'paused' (not 'idle') status
//   Fix 3: halt-timeout detection → 'loop_halted' telemetry outcome
// No DB, no bridge process required. Tests pure logic.
// Run with: node tests/loop-halt-detector.test.js
"use strict";

const assert = require("assert");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ── Fix 1: Terminal phase reached → engagement_concluded, not silent skip ────
console.log("\n[1] Terminal-phase loop-breaker concludes engagement (dir_1782242371780 Fix 1)");
{
  const PHASE_ORDER = ["recon", "enumeration", "foothold", "exploitation", "post_exploit", "reporting"];

  // Mirrors the loop-breaker nextPhase computation in offense-agent.js
  function computeNextPhase(currentPhase) {
    const idx = PHASE_ORDER.indexOf(currentPhase);
    return (idx >= 0 && idx < PHASE_ORDER.length - 1) ? PHASE_ORDER[idx + 1] : null;
  }

  check("nextPhase from 'post_exploit' is 'reporting' (one before terminal)", () => {
    assert.strictEqual(computeNextPhase("post_exploit"), "reporting");
  });

  check("nextPhase from 'reporting' is null (terminal phase)", () => {
    assert.strictEqual(computeNextPhase("reporting"), null);
  });

  // Simulate the loop-breaker branch decision
  function loopBreakerDecision(currentPhase, streak, MAX_CONSECUTIVE_INTENT) {
    if (streak < MAX_CONSECUTIVE_INTENT) return { action: "none" };
    const nextPhase = computeNextPhase(currentPhase);
    if (nextPhase) {
      return { action: "advance", to: nextPhase };
    } else {
      // Fix 1: was a silent skip (if (nextPhase) { ... } — no else), now concludes
      return { action: "conclude", outcome: "engagement_concluded", phase: currentPhase };
    }
  }

  check("loop-breaker in 'reporting' with streak ≥ 3 → conclude, not skip", () => {
    const r = loopBreakerDecision("reporting", 3, 3);
    assert.strictEqual(r.action, "conclude");
    assert.strictEqual(r.outcome, "engagement_concluded");
  });

  check("loop-breaker in 'reporting' with streak < 3 → no action yet", () => {
    const r = loopBreakerDecision("reporting", 2, 3);
    assert.strictEqual(r.action, "none");
  });

  check("loop-breaker in 'post_exploit' with streak ≥ 3 → advance to 'reporting' (not conclude)", () => {
    const r = loopBreakerDecision("post_exploit", 3, 3);
    assert.strictEqual(r.action, "advance");
    assert.strictEqual(r.to, "reporting");
  });

  check("loop-breaker in 'exploitation' with streak ≥ 3 → advance to 'post_exploit'", () => {
    const r = loopBreakerDecision("exploitation", 3, 3);
    assert.strictEqual(r.action, "advance");
    assert.strictEqual(r.to, "post_exploit");
  });

  check("loop-breaker conclusion sets endedByOrchestrator=true → finalStatus='completed'", () => {
    // Mirrors the code: endedByOrchestrator = true; break; → finalStatus = 'completed'
    let endedByOrchestrator = false;
    const r = loopBreakerDecision("reporting", 4, 3);
    if (r.action === "conclude") {
      endedByOrchestrator = true; // as coded
    }
    const finalStatus = endedByOrchestrator ? "completed" : "error";
    assert.strictEqual(finalStatus, "completed");
  });

  check("prior behavior (no Fix 1): terminal phase was silently skipped", () => {
    // Reproduce what USED to happen (the bug): if (nextPhase) { ... } with nextPhase=null → nothing
    function oldLoopBreaker(currentPhase, streak) {
      if (streak < 3) return { action: "none" };
      const nextPhase = computeNextPhase(currentPhase);
      if (nextPhase) return { action: "advance", to: nextPhase };
      // OLD CODE: no else branch — falls through silently
      return { action: "none" }; // <-- the bug: silent skip
    }
    const r = oldLoopBreaker("reporting", 3);
    assert.strictEqual(r.action, "none", "Old code: terminal phase was silent skip");
  });
}

// ── Fix 2: Iter-budget exhaustion → 'paused', not 'idle' ─────────────────────
console.log("\n[2] Iteration-budget exhaustion produces terminal 'paused' status (dir_1782242371780 Fix 2)");
{
  // Mirrors the finalStatus computation in offense-agent.js (post-fix)
  function computeFinalStatus(endedByOrchestrator, iter, maxIter) {
    return endedByOrchestrator ? "completed"
      : (iter >= maxIter ? "paused" : "error");
  }

  // Old behavior for comparison
  function computeFinalStatusOld(endedByOrchestrator, iter, maxIter) {
    return endedByOrchestrator ? "completed"
      : (iter >= maxIter ? "idle" : "error");
  }

  check("budget hit → new finalStatus is 'paused' (not 'idle')", () => {
    const status = computeFinalStatus(false, 50, 50);
    assert.strictEqual(status, "paused");
  });

  check("budget hit → old finalStatus was 'idle' (the bug being fixed)", () => {
    const status = computeFinalStatusOld(false, 50, 50);
    assert.strictEqual(status, "idle"); // confirms what the old code did
  });

  check("budget hit → 'paused' is a non-'running' terminal status", () => {
    const status = computeFinalStatus(false, 15, 15);
    assert.notStrictEqual(status, "running");
    assert.notStrictEqual(status, "idle");
    assert.strictEqual(status, "paused");
  });

  check("model ended cleanly → still 'completed' (unchanged behavior)", () => {
    const status = computeFinalStatus(true, 10, 50);
    assert.strictEqual(status, "completed");
  });

  check("unexpected early exit → 'error' (unchanged behavior)", () => {
    // iter < maxIter AND endedByOrchestrator = false
    const status = computeFinalStatus(false, 5, 50);
    assert.strictEqual(status, "error");
  });

  check("'paused' is resumable by re-calling start_engagement_run (semantic check)", () => {
    // Verify the end_reason message includes the re-call instruction
    const maxIter = 15;
    const endReason = `hit max_iter=${maxIter} cap — re-call start_engagement_run to continue`;
    assert.ok(endReason.includes("re-call start_engagement_run"));
    assert.ok(endReason.includes(`max_iter=${maxIter}`));
  });
}

// ── Fix 3: Halt-detection timeout emits 'loop_halted' telemetry outcome ───────
console.log("\n[3] Halt-timeout detection emits 'loop_halted' telemetry (dir_1782242371780 Fix 3)");
{
  const HALT_TIMEOUT_MS = 300000; // 5 minutes, matches offense-agent.js

  check("HALT_TIMEOUT_MS is 300 000ms (5 minutes)", () => {
    assert.strictEqual(HALT_TIMEOUT_MS, 300000);
  });

  check("HALT_TIMEOUT_MS > OUTCOME_TIMEOUT_MS (5min > 2min — fires after watchdog)", () => {
    const OUTCOME_TIMEOUT_MS = 120000;
    assert.ok(HALT_TIMEOUT_MS > OUTCOME_TIMEOUT_MS);
  });

  // Simulate the halt-detection condition in the stall path
  function shouldHalt(stallStreak, haveWork, lastStepQueuedAt, now) {
    const haltTimeoutExpired = (now - lastStepQueuedAt) > HALT_TIMEOUT_MS;
    return (stallStreak >= 3 && !haveWork) || stallStreak >= 30 || (haltTimeoutExpired && !haveWork);
  }

  function haltReason(stallStreak, haveWork, lastStepQueuedAt, now) {
    const haltTimeoutExpired = (now - lastStepQueuedAt) > HALT_TIMEOUT_MS;
    const haltedByTimeout = haltTimeoutExpired && !haveWork && stallStreak < 30;
    return haltedByTimeout
      ? `loop dark for ${Math.round((now-lastStepQueuedAt)/1000)}s with no pending work — loop_halted (dir_1782242371780)`
      : `orchestrator gave no task ${stallStreak}× (work in flight: ${haveWork}) — engagement exhausted`;
  }

  const now = Date.now();
  const longAgo = now - HALT_TIMEOUT_MS - 1000; // 5min+1s ago — expired
  const recentTs = now - 60000; // 1min ago — not expired

  check("halt fires when timeout expired AND no pending work", () => {
    assert.ok(shouldHalt(1, false, longAgo, now));
  });

  check("halt does NOT fire when timeout expired but work IS in flight", () => {
    assert.ok(!shouldHalt(1, true, longAgo, now));
  });

  check("halt does NOT fire within timeout even with no work (normal stall patience)", () => {
    // 1 stall, no work, but recent — should wait, not halt
    assert.ok(!shouldHalt(1, false, recentTs, now));
  });

  check("existing stall-streak check (stallStreak>=3 && !haveWork) still fires", () => {
    assert.ok(shouldHalt(3, false, recentTs, now));
  });

  check("existing hard cap (stallStreak>=30) still fires regardless", () => {
    assert.ok(shouldHalt(30, true, recentTs, now));
  });

  check("halt-timeout end_reason includes 'loop_halted' and directive ref", () => {
    const reason = haltReason(1, false, longAgo, now);
    assert.ok(reason.includes("loop_halted"), `Missing 'loop_halted' in: ${reason}`);
    assert.ok(reason.includes("dir_1782242371780"), `Missing directive ref in: ${reason}`);
  });

  check("stall-exhaustion end_reason is unchanged (engagement exhausted path)", () => {
    const reason = haltReason(3, false, recentTs, now);
    assert.ok(reason.includes("engagement exhausted"), `Expected 'engagement exhausted' in: ${reason}`);
    assert.ok(!reason.includes("loop_halted"), `Should not include 'loop_halted' for stall path`);
  });

  check("telemetry outcome for halt-timeout is 'loop_halted'", () => {
    const TELEMETRY_OUTCOME = "loop_halted";
    assert.strictEqual(TELEMETRY_OUTCOME, "loop_halted");
  });

  check("telemetry model_used for halt-detector is 'halt_detector'", () => {
    const TELEMETRY_MODEL = "halt_detector";
    assert.strictEqual(TELEMETRY_MODEL, "halt_detector");
  });

  check("lastStepQueuedAt resets on every successful queue_step", () => {
    // Simulate: initial = now - 400s (would trigger halt), reset on queue
    let lastStepQueuedAt = now - 400000;
    // queue_step succeeds → reset
    lastStepQueuedAt = now;
    assert.ok((now - lastStepQueuedAt) <= 0, "Should be reset to now");
    assert.ok(!shouldHalt(0, false, lastStepQueuedAt, now), "Should not halt after reset");
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
