// finding-revision.test.js — dir_1782260457892
//
// Unit tests for the contradiction-detection / finding-revision TRIGGER layer
// (finding-revision.js). The trigger re-invokes the EXISTING claim-verifier when
// a later step's aggregator summary contradicts an already-recorded finding.
//
// Mirrors the DI/capture harness in scorecard-instrumentation.test.js:
//   • makeVerifierCapturingDb / findUpdate — capture the SQL the REAL
//     claimVerifier.verifyFinding issues, so test 9 pins the REUSED floor.
//   • makeTelemetryCapturingDb            — capture telemetry INSERTs.
//   • check / checkAsync                  — same green/red runner.
//
// Every test below is MUTATION-PROVABLE: it goes RED when the named production
// line is reverted. finding-revision.js is require-able on the host because its
// /app/db import is lazy and every consumer takes an injected db (the DI seam).
// Run with: node tests/finding-revision.test.js
"use strict";

const assert = require("assert");
const path   = require("path");
const fs     = require("fs");

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

// The REAL production modules — loadable on the host post-DI-seam.
const findingRevision = require(path.join(__dirname, "../finding-revision"));
const claimVerifier   = require(path.join(__dirname, "../claim-verifier"));
const { detectContradictions, reverifyContradicted } = findingRevision;

// ── Capturing db for the REAL verifyFinding (test 9): records every (sql,params)
//    the production code issues, returns whatever the verdict path needs. Mirrors
//    scorecard-instrumentation.test.js:makeVerifierCapturingDb. ───────────────────
function makeVerifierCapturingDb(findingRow) {
  const captures = [];
  return {
    capturedSql: captures,
    async query(sql, params) {
      captures.push({ sql, params });
      const flat = sql.replace(/\s+/g, " ");
      if (/SELECT[\s\S]*FROM pentest_findings/.test(flat)) return { rows: [findingRow] };
      if (/SELECT[\s\S]*FROM pentest_engagements/.test(flat)) {
        return { rows: [{ id: findingRow.engagement_id, executor_host: "tablet-relay", executor_adb_target: "10.0.0.1:5555" }] };
      }
      if (/FROM soc_queue_items/.test(flat)) {
        // A done step whose command carries a curl -u cred → lets the REAL
        // verifyCredTestFinding extract a cred and reach the probe seam.
        return { rows: [{ id: 99, command: "curl -u admin:admin http://x/" }] };
      }
      return { rows: [] };
    },
  };
}
const findUpdate = (db) => db.capturedSql
  .map(c => c.sql.replace(/\s+/g, " "))
  .find(s => /UPDATE pentest_findings/.test(s));

// ── Capturing db for telemetry INSERTs (tests 7, 8). ──────────────────────────
function makeTelemetryCapturingDb() {
  const telemetry = [];
  return {
    telemetry,
    async query(sql, params) {
      if (/INSERT INTO offense_telemetry/.test(sql)) {
        telemetry.push({ sql: sql.replace(/\s+/g, " "), params });
      }
      return { rows: [] };
    },
  };
}

(async () => {
  // ── detectContradictions (PURE) ──────────────────────────────────────────────
  console.log("\n[1] detectContradictions — contradiction signals");

  // 1. confirmed cred finding contradicted by a later 401 signal.
  check("1. flags a confirmed cred finding contradicted by a later 401 signal", () => {
    const summary = { success: true, error_category: null,
      key_signals: ["GET 192.168.1.40/ISAPI/System/deviceInfo returned 401 Unauthorized"] };
    const findings = [{ id: 7, title: "Default Credentials Accepted on Hikvision",
      severity: "high", kind: "confirmed", affected_asset: "192.168.1.40", affected_assets: [] }];
    const r = detectContradictions(summary, findings);
    assert.strictEqual(r.length, 1, "must flag the cred finding");
    assert.strictEqual(r[0].finding_id, 7);
    assert.strictEqual(r[0].reason, "cred");
  });

  // 2. confirmed exposure finding contradicted by a later 403 signal.
  check("2. flags a confirmed exposure finding contradicted by a later 403 signal", () => {
    const summary = { success: true, error_category: null,
      key_signals: ["http_code=403 on 192.168.1.50 for /backup.zip"] };
    const findings = [{ id: 8, title: "Sensitive File Exposure",
      severity: "high", kind: "confirmed", affected_asset: "192.168.1.50", affected_assets: [] }];
    const r = detectContradictions(summary, findings);
    assert.strictEqual(r.length, 1, "must flag the exposure finding");
    assert.strictEqual(r[0].finding_id, 8);
    assert.strictEqual(r[0].reason, "exposure");
  });

  // 3. NOT flag a finding already at severity='info' (PIN: `severity === "info"` guard).
  check("3. does NOT flag a finding already at severity='info' (idempotency)", () => {
    const summary = { success: true, error_category: null,
      key_signals: ["192.168.1.40 returned 401 Unauthorized"] };
    const findings = [{ id: 9, title: "Default Credentials Accepted on Hikvision",
      severity: "info", kind: "confirmed", affected_asset: "192.168.1.40", affected_assets: [] }];
    assert.strictEqual(detectContradictions(summary, findings).length, 0,
      "a floored (severity='info') finding must never be re-triggered");
  });

  // 4. NOT flag a finding whose kind is already refuted/unverified (PIN: `kind === "confirmed"` guard).
  check("4. does NOT flag a finding whose kind is 'refuted'/'unverified'", () => {
    const summary = { success: true, error_category: null,
      key_signals: ["192.168.1.40 returned 401 Unauthorized"] };
    const refuted = [{ id: 10, title: "Default Credentials Accepted on Hikvision",
      severity: "high", kind: "refuted", affected_asset: "192.168.1.40", affected_assets: [] }];
    const unverified = [{ id: 11, title: "Default Credentials Accepted on Hikvision",
      severity: "high", kind: "unverified", affected_asset: "192.168.1.40", affected_assets: [] }];
    assert.strictEqual(detectContradictions(summary, refuted).length, 0, "refuted must not re-trigger");
    assert.strictEqual(detectContradictions(summary, unverified).length, 0, "unverified must not re-trigger");
  });

  // 5. NOT flag when the signal references a DIFFERENT host (PIN: host-match line).
  check("5. does NOT flag when the step signal references a DIFFERENT host", () => {
    const summary = { success: true, error_category: null,
      key_signals: ["192.168.1.99 returned 401 Unauthorized"] }; // different host
    const findings = [{ id: 12, title: "Default Credentials Accepted on Hikvision",
      severity: "high", kind: "confirmed", affected_asset: "192.168.1.40", affected_assets: [] }];
    assert.strictEqual(detectContradictions(summary, findings).length, 0,
      "a 401 on a different host must not contradict this finding");
  });

  // 6. returns [] when summary.success===false / error_category is timeout (PIN: failed-step guard).
  //    [pins tightening #1]
  check("6. returns [] when summary.success===false (failed-step guard)", () => {
    const summary = { success: false, error_category: null,
      key_signals: ["192.168.1.40 returned 401 Unauthorized"] };
    const findings = [{ id: 13, title: "Default Credentials Accepted on Hikvision",
      severity: "high", kind: "confirmed", affected_asset: "192.168.1.40", affected_assets: [] }];
    assert.strictEqual(detectContradictions(summary, findings).length, 0,
      "a failed step must never trigger a revision");
  });
  check("6b. returns [] when error_category is 'timeout' (failed-step guard)", () => {
    const summary = { success: true, error_category: "timeout",
      key_signals: ["192.168.1.40 returned 401 Unauthorized"] };
    const findings = [{ id: 14, title: "Default Credentials Accepted on Hikvision",
      severity: "high", kind: "confirmed", affected_asset: "192.168.1.40", affected_assets: [] }];
    assert.strictEqual(detectContradictions(summary, findings).length, 0,
      "a timed-out step must never trigger a revision");
  });

  // ── reverifyContradicted ─────────────────────────────────────────────────────
  console.log("\n[2] reverifyContradicted — re-invocation + audit telemetry");

  // 7. re-invokes the injected verifyFn once per contradiction with (finding_id, db)
  //    (PIN: the `await verifyFn(...)` line).
  await checkAsync("7. re-invokes injected verifyFn once per contradiction with (finding_id, db)", async () => {
    const db = makeTelemetryCapturingDb();
    const calls = [];
    const verifyFn = async (id, passedDb) => { calls.push({ id, passedDb }); };
    const contradictions = [{ finding_id: 21, reason: "cred" }, { finding_id: 22, reason: "exposure" }];
    await reverifyContradicted("e1", contradictions, { db, verifyFn });
    assert.strictEqual(calls.length, 2, "verifyFn must be invoked once per contradiction");
    assert.strictEqual(calls[0].id, 21, "first call must pass the first finding_id");
    assert.strictEqual(calls[1].id, 22, "second call must pass the second finding_id");
    assert.strictEqual(calls[0].passedDb, db, "verifyFn must receive the injected db as its 2nd arg");
  });

  // 8. emits exactly one revision_triggered telemetry row carrying REVISION_TRIGGERED
  //    (PIN: the telemetry INSERT). SECOND assert: source requires the constants
  //    module AND does not hardcode the literal (mirror scorecard test:578-585).
  await checkAsync("8. emits exactly one revision_triggered telemetry row carrying REVISION_TRIGGERED", async () => {
    const db = makeTelemetryCapturingDb();
    const verifyFn = async () => {}; // isolate telemetry emission from re-verify
    await reverifyContradicted("e1", [{ finding_id: 31, reason: "cred" }], { db, verifyFn });
    assert.strictEqual(db.telemetry.length, 1, "must emit exactly one telemetry row per contradiction");
    const { REVISION_TRIGGERED } = require(path.join(__dirname, "../verify-gate-constants"));
    assert.ok(db.telemetry[0].params.includes(REVISION_TRIGGERED),
      "telemetry row must carry the REVISION_TRIGGERED token as its outcome");
    // Membrane: outcome_notes must NOT carry an IP/payload — class token + id only.
    const notes = db.telemetry[0].params.find(p => typeof p === "string" && /finding 31/.test(p));
    assert.ok(notes, "notes must reference the finding id");
    assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(notes), "notes must contain no IP");

    // Source-content assertion (mirror scorecard-instrumentation.test.js:578-585):
    const src = fs.readFileSync(path.join(__dirname, "../finding-revision.js"), "utf8");
    assert.ok(/require\([^)]*verify-gate-constants[^)]*\)/.test(src),
      "finding-revision.js must require('./verify-gate-constants')");
    assert.ok(!/['"]revision_triggered['"]/.test(src),
      "finding-revision.js must not contain the literal 'revision_triggered' — use the constant");
  });

  // 9. END-TO-END via the REAL claimVerifier.verifyFinding: a cred finding whose
  //    re-probe returns 401 → REAL verdict 'fail' → REAL refute UPDATE floors
  //    severity='info'. (PIN: claim-verifier.js:336 `severity='info'` — proving
  //    the trigger REUSES the floor, not reimplements it.)
  await checkAsync("9. END-TO-END: real verifyFinding floors severity='info' on a re-probed 401", async () => {
    const db = makeVerifierCapturingDb({
      id: 41, engagement_id: "e1",
      title: "Default Credentials Accepted on Hikvision", // cred-test + vendor=hikvision
      severity: "critical", kind: "confirmed",
      affected_asset: "10.20.30.40", evidence_summary: "",
    });
    // reverifyContradicted calls verifyFn(id, db) with no opts, so bind the
    // deterministic 401 probe into a closure over the REAL verifyFinding. This
    // exercises the real refute path (claim-verifier.js verdict→UPDATE) on the host.
    const probe401 = async () => "HTTP=401\nHTTP/1.1 401 Unauthorized\n";
    const verifyFn = (id, injectedDb) => claimVerifier.verifyFinding(id, injectedDb, { runProbe: probe401 });
    await reverifyContradicted("e1", [{ finding_id: 41, reason: "cred" }], { db, verifyFn });
    const upd = findUpdate(db);
    assert.ok(upd, "the REAL verifyFinding must issue an UPDATE on a fail verdict");
    assert.ok(/severity\s*=\s*'info'/.test(upd),
      `the REUSED floor must set severity='info'; got: ${upd}`);
    assert.ok(/kind\s*=\s*'refuted'/.test(upd),
      "the REUSED refute must set kind='refuted'");
  });

  // ── constants ────────────────────────────────────────────────────────────────
  console.log("\n[3] REVISION_TRIGGERED constant");

  // 10. exported and ≤24 chars (mirror scorecard-instrumentation.test.js:559).
  check("10. REVISION_TRIGGERED is exported and fits VARCHAR(24)", () => {
    const vgc = require(path.join(__dirname, "../verify-gate-constants"));
    assert.strictEqual(typeof vgc.REVISION_TRIGGERED, "string", "REVISION_TRIGGERED must be a string export");
    assert.ok(vgc.REVISION_TRIGGERED.length <= 24,
      `REVISION_TRIGGERED '${vgc.REVISION_TRIGGERED}' exceeds 24-char VARCHAR limit`);
  });
})().then(() => {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error("\n❌ SOME TESTS FAILED"); process.exit(1); }
  else { console.log("\n✅ ALL TESTS PASSED"); }
}).catch(e => {
  console.error("Async test runner crashed:", e.message);
  process.exit(1);
});
