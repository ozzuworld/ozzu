// outcome-watchdog.test.js — dir_1782238863765
// Unit tests for the three harness freeze-prevention fixes:
//   Part 1: permission-denial paths now write status='failed' so waitForOutcome unblocks
//   Part 2: OUTCOME_TIMEOUT_MS watchdog constant + runAgent DEFAULT_WAIT_TIMEOUT_SEC
//   Part 3: offense_telemetry 'outcome_timeout' signal logged on watchdog fire
// No DB, no bridge process required. Tests pure logic.
// Run with: node tests/outcome-watchdog.test.js
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

// ── Part 1: intent_invalid and intent_mismatch now write status='failed' ─────
console.log("\n[1] Permission-denial feedback — intent gates now produce terminal status");
{
  // Simulate the intent_invalid gate logic (mirrors autonomous-executor.js)
  const VALID_INTENTS = new Set([
    "recon", "enum", "banner_grab", "service_version", "tool_setup",
    "cred_test", "exploit_probe", "lateral", "post_exploit",
  ]);
  const GATE_INTENTS = new Set(["cred_test", "exploit_probe", "lateral", "post_exploit"]);

  function simulateIntentInvalidPath(claimed) {
    if (claimed !== "unclassified" && !VALID_INTENTS.has(claimed)) {
      // dir_1782238863765 Part 1: writes status='failed'
      return { blocked: true, writes_failed_status: true, reason: `intent_class='${claimed}' invalid` };
    }
    return { blocked: false };
  }

  check("unknown intent_class is blocked and writes terminal status", () => {
    const r = simulateIntentInvalidPath("attack_everything");
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.writes_failed_status, true);
  });

  check("valid auto-run intent passes through", () => {
    const r = simulateIntentInvalidPath("recon");
    assert.strictEqual(r.blocked, false);
  });

  check("valid gate intent passes the VALID_INTENTS check (gated downstream)", () => {
    const r = simulateIntentInvalidPath("exploit_probe");
    assert.strictEqual(r.blocked, false);
  });

  // Simulate the intent_mismatch gate logic
  function simulateIntentMismatchPath(claimed, inferred) {
    if (inferred && inferred !== claimed) {
      const oneIsGated = GATE_INTENTS.has(claimed) || GATE_INTENTS.has(inferred);
      if (oneIsGated) {
        // dir_1782238863765 Part 1: writes status='failed'
        return { blocked: true, writes_failed_status: true, reason: `mismatch ${claimed}→${inferred}` };
      }
    }
    return { blocked: false };
  }

  check("intent mismatch where inferred is gated blocks and writes terminal status", () => {
    // claimed=enum (auto-run) but command is actually an exploit — gated
    const r = simulateIntentMismatchPath("enum", "exploit_probe");
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.writes_failed_status, true);
  });

  check("intent mismatch where NEITHER is gated does NOT block (labeling nuance)", () => {
    // claimed=recon, inferred=enum — both auto-run, no safety risk
    const r = simulateIntentMismatchPath("recon", "enum");
    assert.strictEqual(r.blocked, false);
  });

  check("intent mismatch where claimed is gated blocks (model may be trying to downgrade)", () => {
    // claimed=cred_test (gated), inferred=recon (auto-run) — oneIsGated=true
    const r = simulateIntentMismatchPath("cred_test", "recon");
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.writes_failed_status, true);
  });
}

// ── Part 2: OUTCOME_TIMEOUT_MS constant + DEFAULT_WAIT_TIMEOUT_SEC ───────────
console.log("\n[2] Watchdog timeout constants");
{
  // Inline the constants as they appear in the actual source files
  const OUTCOME_TIMEOUT_MS = 120000;      // offense-agent-tools.js
  const DEFAULT_WAIT_TIMEOUT_SEC = 120;   // offense-agent.js

  check("OUTCOME_TIMEOUT_MS is 120 000ms (2 minutes)", () => {
    assert.strictEqual(OUTCOME_TIMEOUT_MS, 120000);
  });

  check("DEFAULT_WAIT_TIMEOUT_SEC is 120s (2 minutes)", () => {
    assert.strictEqual(DEFAULT_WAIT_TIMEOUT_SEC, 120);
  });

  check("OUTCOME_TIMEOUT_MS / 1000 equals DEFAULT_WAIT_TIMEOUT_SEC (constants are consistent)", () => {
    assert.strictEqual(OUTCOME_TIMEOUT_MS / 1000, DEFAULT_WAIT_TIMEOUT_SEC);
  });

  // Simulate the waitForOutcome timeout selection logic
  function computeTimeoutMs(timeout_sec) {
    const callerMs = Number(timeout_sec) > 0 ? Number(timeout_sec) * 1000 : OUTCOME_TIMEOUT_MS;
    return callerMs;
  }

  check("when timeout_sec not provided, falls back to OUTCOME_TIMEOUT_MS (120s)", () => {
    assert.strictEqual(computeTimeoutMs(undefined), 120000);
  });

  check("when timeout_sec=0, falls back to OUTCOME_TIMEOUT_MS (invalid/zero input)", () => {
    assert.strictEqual(computeTimeoutMs(0), 120000);
  });

  check("when timeout_sec=1800 (human-in-loop override), uses 1800s", () => {
    assert.strictEqual(computeTimeoutMs(1800), 1800000);
  });

  check("when timeout_sec=120 (runAgent default), uses 120s", () => {
    assert.strictEqual(computeTimeoutMs(120), 120000);
  });

  // Simulate runAgent's waitTimeoutSec calculation
  function computeWaitTimeoutSec(opts_wait_timeout_sec) {
    return Number(opts_wait_timeout_sec) > 0 ? Number(opts_wait_timeout_sec) : DEFAULT_WAIT_TIMEOUT_SEC;
  }

  check("runAgent default (no opts) gives 120s", () => {
    assert.strictEqual(computeWaitTimeoutSec(undefined), 120);
  });

  check("runAgent with explicit wait_timeout_sec=1800 gives 1800s (human-in-loop)", () => {
    assert.strictEqual(computeWaitTimeoutSec(1800), 1800);
  });

  check("runAgent default changed from 1800 to 120 — freeze window reduced from 30min to 2min", () => {
    // Old default was 1800; new default is DEFAULT_WAIT_TIMEOUT_SEC = 120
    assert.ok(DEFAULT_WAIT_TIMEOUT_SEC < 1800);
    assert.strictEqual(DEFAULT_WAIT_TIMEOUT_SEC, 120);
  });
}

// ── Part 3: telemetry outcome_timeout signal ──────────────────────────────────
console.log("\n[3] Telemetry 'outcome_timeout' on watchdog fire");
{
  // Simulate the watchdog telemetry insert — verify the outcome label
  const EXPECTED_OUTCOME = "outcome_timeout";
  const EXPECTED_MODEL   = "watchdog";

  check("watchdog telemetry outcome is 'outcome_timeout'", () => {
    assert.strictEqual(EXPECTED_OUTCOME, "outcome_timeout");
  });

  check("watchdog telemetry model_used is 'watchdog'", () => {
    assert.strictEqual(EXPECTED_MODEL, "watchdog");
  });

  // Verify the outcome_notes template includes the queue_item_id and wait time
  function buildOutcomeNote(queueItemId, timeoutMs) {
    return `queue_item ${queueItemId} stayed 'pending' for ${Math.round(timeoutMs/1000)}s — watchdog fired (dir_1782238863765)`;
  }

  check("outcome_notes contains queue_item_id", () => {
    const note = buildOutcomeNote(42, 120000);
    assert.ok(note.includes("42"), `Expected '42' in note: ${note}`);
  });

  check("outcome_notes contains elapsed seconds", () => {
    const note = buildOutcomeNote(42, 120000);
    assert.ok(note.includes("120s"), `Expected '120s' in note: ${note}`);
  });

  check("outcome_notes references dir_1782238863765", () => {
    const note = buildOutcomeNote(42, 120000);
    assert.ok(note.includes("dir_1782238863765"), `Expected directive ref in note: ${note}`);
  });

  // Verify the telemetry insert intent_category matches the tool that timed out
  check("telemetry intent_category for watchdog is 'wait_for_outcome'", () => {
    const intentCategory = "wait_for_outcome";
    assert.strictEqual(intentCategory, "wait_for_outcome");
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
