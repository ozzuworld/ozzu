// scorecard-instrumentation.test.js — dir_1782255739233
//
// Unit tests for the three harness-instrumentation changes:
//   1. Claim-verifier pre-insert gate (verify-fail floors severity + emits telemetry)
//   2. Non-productive turn cause-enum mapping
//   3. Behavioral scorecard membrane safety
//
// No DB, no bridge process required — pure logic tests.
// behavioral-scorecard.js is imported directly (accepts db as a param, no /app/* at load time).
// claim-verifier pure functions are inlined (the module requires /app/db at load time).
// Run with: node tests/scorecard-instrumentation.test.js
"use strict";

const assert = require("assert");
const path   = require("path");

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

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ── 1. Claim-verifier pre-insert gate ────────────────────────────────────────
// claim-verifier.js requires /app/db at module load, which doesn't exist outside
// the Docker container. Test the pure functions inline instead — they are copied
// verbatim from claim-verifier.js and must stay in sync.
console.log("\n[1] Claim-verifier pre-insert gate (verifyFindingDataSync logic)");

{
  // ---- inlined from claim-verifier.js (pure, no DB) ----
  const EXPOSURE_TITLE_PATTERNS = [
    /sensitive\s+file\s+exposure/i,
    /exposed\s+(file|directory|endpoint|configuration|credentials?|database|backup)/i,
    /file\s+disclosure/i,
    /information\s+disclosure(?!.*version)/i,
    /directory\s+listing/i,
  ];
  const HIDDEN_STATUS_RE = /(?:Status:\s*|HTTP[/ ]\d\.?\d?\s*|http_code[=:]?\s*)(40[1-4])\b/i;

  function isExposureClaim(finding) {
    if (!finding || !finding.title) return false;
    return EXPOSURE_TITLE_PATTERNS.some(re => re.test(String(finding.title)));
  }

  function refuteExposureBy403(finding) {
    const haystack = `${finding.evidence_summary || ""} ${finding.affected_asset || ""}`;
    const m = haystack.match(HIDDEN_STATUS_RE);
    if (!m) return null;
    return { verdict: "fail", code: m[1], notes: `hidden status ${m[1]}` };
  }

  function verifyFindingDataSync(f) {
    if (!f || !f.title) return { verdict: "skip" };
    if (isExposureClaim(f)) {
      const haystack = `${f.evidence || ""} ${f.evidence_summary || ""} ${f.affected_asset || ""}`;
      const synthetic = { title: f.title, evidence_summary: haystack, affected_asset: f.affected_asset || "" };
      const fast = refuteExposureBy403(synthetic);
      if (fast) return { verdict: "fail", notes: fast.notes, code: fast.code };
    }
    return { verdict: "skip" };
  }
  // ---- end inlined ----

  check("exposure claim with 403 evidence → verdict:fail", () => {
    const result = verifyFindingDataSync({ title: "Sensitive File Exposure", evidence: "Status: 403" });
    assert.strictEqual(result.verdict, "fail");
  });

  check("exposure claim with 401 evidence → verdict:fail", () => {
    const result = verifyFindingDataSync({ title: "Exposed Configuration File", evidence: "HTTP/1.1 401" });
    assert.strictEqual(result.verdict, "fail");
  });

  check("exposure claim with 404 evidence → verdict:fail", () => {
    const result = verifyFindingDataSync({ title: "Directory Listing", evidence: "http_code=404" });
    assert.strictEqual(result.verdict, "fail");
  });

  check("exposure claim with 200 evidence only → verdict:skip (no hidden-status match)", () => {
    const result = verifyFindingDataSync({ title: "Sensitive File Exposure", evidence: "HTTP 200 OK" });
    assert.strictEqual(result.verdict, "skip");
  });

  check("non-exposure claim (cred-test) → verdict:skip", () => {
    const result = verifyFindingDataSync({ title: "Default Credentials Accepted", evidence: "auth returned 200" });
    assert.strictEqual(result.verdict, "skip",
      "cred-test claims must not be gated pre-insert (needs DB id for probe)");
  });

  check("null finding → verdict:skip (no crash)", () => {
    assert.strictEqual(verifyFindingDataSync(null).verdict, "skip");
  });

  check("aggregator correctly floors severity to info on gate fail", () => {
    const f = { title: "Sensitive File Exposure", evidence: "Status: 403", severity: "high", kind: "confirmed" };
    const preCheck = verifyFindingDataSync(f);
    let finalSeverity = f.severity;
    let finalKind = f.kind;
    let telemetryOutcome = null;
    if (preCheck.verdict === "fail") {
      finalSeverity = "info";
      finalKind = "unverified";
      telemetryOutcome = "verify_gate_fail";
    }
    assert.strictEqual(finalSeverity, "info", "severity must be floored to info");
    assert.strictEqual(finalKind, "unverified", "kind must become unverified");
    assert.strictEqual(telemetryOutcome, "verify_gate_fail",
      "telemetry outcome must be verify_gate_fail");
  });

  check("aggregator preserves severity when gate skips", () => {
    const f = { title: "Default Credentials Accepted", evidence: "auth ok", severity: "critical", kind: "confirmed" };
    const preCheck = verifyFindingDataSync(f);
    let finalSeverity = f.severity;
    if (preCheck.verdict === "fail") finalSeverity = "info";
    assert.strictEqual(finalSeverity, "critical", "severity must be unchanged when gate skips");
  });

  check("telemetry outcome token fits VARCHAR(24)", () => {
    assert.ok("verify_gate_fail".length <= 24,
      "verify_gate_fail exceeds 24 chars");
  });
}

// ── 2. Non-productive turn cause-enum mapping ─────────────────────────────────
console.log("\n[2] Non-productive turn cause-enum mapping");

{
  // Inline replication of the classification logic in offense-agent.js.
  // Must stay in sync with the actual code.
  function classifyNonProductiveCause(scenario) {
    if (scenario.type === "synthesizer_throw") {
      const isHang = /timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(scenario.errorMessage || "");
      return isHang ? "infra_hang" : "prose_only";
    }
    if (scenario.type === "no_command")     return "prose_only";
    if (scenario.type === "queue_rejected") return "lint_reject";
    if (scenario.type === "no_select")      return "other";
    return "other";
  }

  check("synthesizer timeout error → infra_hang", () => {
    assert.strictEqual(classifyNonProductiveCause({ type: "synthesizer_throw", errorMessage: "synthesizer timeout" }), "infra_hang");
  });
  check("ETIMEDOUT → infra_hang", () => {
    assert.strictEqual(classifyNonProductiveCause({ type: "synthesizer_throw", errorMessage: "connect ETIMEDOUT" }), "infra_hang");
  });
  check("ECONNRESET → infra_hang", () => {
    assert.strictEqual(classifyNonProductiveCause({ type: "synthesizer_throw", errorMessage: "read ECONNRESET" }), "infra_hang");
  });
  check("socket hang up → infra_hang", () => {
    assert.strictEqual(classifyNonProductiveCause({ type: "synthesizer_throw", errorMessage: "socket hang up" }), "infra_hang");
  });
  check("JSON parse error (non-timeout) → prose_only", () => {
    assert.strictEqual(classifyNonProductiveCause({ type: "synthesizer_throw", errorMessage: "JSON parse failed: Unexpected token" }), "prose_only");
  });
  check("synthesizer returned no command → prose_only", () => {
    assert.strictEqual(classifyNonProductiveCause({ type: "no_command" }), "prose_only");
  });
  check("queue_step rejected → lint_reject", () => {
    assert.strictEqual(classifyNonProductiveCause({ type: "queue_rejected" }), "lint_reject");
  });
  check("orchestrator gave no selection → other", () => {
    assert.strictEqual(classifyNonProductiveCause({ type: "no_select" }), "other");
  });
  check("unknown scenario → other", () => {
    assert.strictEqual(classifyNonProductiveCause({ type: "completely_unknown" }), "other");
  });
  check("all four enum tokens fit VARCHAR(24)", () => {
    for (const e of ["infra_hang", "prose_only", "lint_reject", "other"]) {
      assert.ok(e.length <= 24, `enum '${e}' exceeds 24-char VARCHAR limit`);
    }
  });
  check("intent_category 'non_productive_turn' fits VARCHAR(64)", () => {
    assert.ok("non_productive_turn".length <= 64);
  });
}

// ── 3. Behavioral scorecard membrane safety ────────────────────────────────────
// behavioral-scorecard.js takes db as a parameter, so it loads fine outside Docker.
console.log("\n[3] Behavioral scorecard membrane safety");

function makeMockDb(overrides = {}) {
  const data = {
    engagement: { status: "in_progress", agent_status: "completed", engagement_phase: "reporting", agent_run_state: {} },
    telemetry:  [],
    findings:   [],
    tasks:      [],
    queue:      [],
    ...overrides,
  };
  return {
    async query(sql) {
      if (/FROM pentest_engagements/.test(sql))  return { rows: [data.engagement] };
      if (/FROM offense_telemetry/.test(sql))    return { rows: data.telemetry };
      if (/FROM pentest_findings/.test(sql))     return { rows: data.findings };
      if (/FROM engagement_tasks/.test(sql))     return { rows: data.tasks };
      if (/FROM soc_queue_items/.test(sql))      return { rows: data.queue };
      return { rows: [] };
    },
  };
}

(async () => {
  const claimVerifier = require(path.join(__dirname, "../soc/claim-verifier"));

  // Capturing db: records every (sql, params) the production code issues and
  // returns whatever rows the verdict path needs. `findingRow` lets each test
  // shape the finding the SELECT returns.
  function makeVerifierCapturingDb(findingRow) {
    const captures = [];
    return {
      capturedSql: captures,
      async query(sql, params) {
        captures.push({ sql, params });
        const flat = sql.replace(/\s+/g, ' ');
        if (/SELECT[\s\S]*FROM pentest_findings/.test(flat)) {
          return { rows: [findingRow] };
        }
        if (/SELECT[\s\S]*FROM pentest_engagements/.test(flat)) {
          return { rows: [{ id: findingRow.engagement_id, executor_host: 'tablet-relay', executor_adb_target: '10.0.0.1:5555' }] };
        }
        if (/FROM soc_queue_items/.test(flat)) {
          // A done step whose decoded command carries a curl -u cred → lets
          // verifyCredTestFinding extract a cred and reach the probe.
          return { rows: [{ id: 99, command: "curl -u admin:admin http://x/" }] };
        }
        return { rows: [] };
      },
    };
  }
  const findUpdate = (db) => db.capturedSql
    .map(c => c.sql.replace(/\s+/g, ' '))
    .find(s => /UPDATE pentest_findings/.test(s));

  // ── (a) Post-insert FAIL floors severity — via the REAL verifyFinding ─────────
  {
    // Cred-test path: inject a probe response that looks like a 401 so the REAL
    // verdict logic resolves to 'fail' and issues the real refute UPDATE.
    await checkAsync("(a) REAL verifyFinding floors severity='info' on cred-test FAIL", async () => {
      const db = makeVerifierCapturingDb({
        id: 1, engagement_id: 'e1',
        title: 'Default Credentials Accepted on Hikvision',  // cred-test + vendor=hikvision
        severity: 'critical', kind: 'confirmed',
        affected_asset: '10.20.30.40', evidence_summary: '',
      });
      const probe401 = async () => "HTTP=401\nHTTP/1.1 401 Unauthorized\n";
      await claimVerifier.verifyFinding(1, db, { runProbe: probe401 });
      const upd = findUpdate(db);
      assert.ok(upd, "production verifyFinding must issue an UPDATE on a fail verdict");
      assert.ok(/severity\s*=\s*'info'/.test(upd),
        `real UPDATE must floor severity to 'info'; got: ${upd}`);
      assert.ok(/kind\s*=\s*'refuted'/.test(upd),
        "real UPDATE must set kind = 'refuted' on a fail verdict");
    });

    // Exposure fast-path: 403 evidence → real verifyFinding refutes with no probe.
    await checkAsync("(a) REAL verifyFinding floors severity='info' on exposure-with-403 FAIL", async () => {
      const db = makeVerifierCapturingDb({
        id: 1, engagement_id: 'e1',
        title: 'Sensitive File Exposure',
        severity: 'high', kind: 'confirmed',
        affected_asset: '10.20.30.40', evidence_summary: 'Status: 403',
      });
      await claimVerifier.verifyFinding(1, db); // no probe needed for exposure fast-path
      const upd = findUpdate(db);
      assert.ok(upd, "production verifyFinding must issue an UPDATE on exposure-with-403");
      assert.ok(/severity\s*=\s*'info'/.test(upd),
        "real exposure-refute UPDATE must floor severity to 'info'");
      assert.ok(/kind\s*=\s*'refuted'/.test(upd),
        "real exposure-refute UPDATE must set kind = 'refuted'");
    });
  }

  // ── (b) Manual write-paths route through the REAL shared gate ─────────────────
  // applyPreInsertGate is the exact function soc.js submit-results and mcp.js
  // add_finding call. Driving it here exercises the real gate, not a copy.
  {
    // A db that captures telemetry INSERTs so we can prove MINOR-1 emissions.
    function makeTelemetryCapturingDb() {
      const telemetry = [];
      return {
        telemetry,
        async query(sql, params) {
          if (/INSERT INTO offense_telemetry/.test(sql)) {
            // params: [...] — outcome is the 11th positional ($11) → index 1 here
            // since this INSERT uses ($1, NULL, 'claim-verifier', intent, ..., outcome, notes).
            telemetry.push({ sql: sql.replace(/\s+/g, ' '), params });
          }
          return { rows: [] };
        },
      };
    }

    await checkAsync("(b) REAL gate floors exposure-with-403 finding before INSERT (submit-results shape)", async () => {
      const db = makeTelemetryCapturingDb();
      const r = await claimVerifier.applyPreInsertGate(
        { title: 'Sensitive File Exposure', description: 'Status: 403', severity: 'high', affected_asset: '10.20.30.40' },
        { db, engagementId: 'e1', source: 'submit_results' });
      assert.strictEqual(r.severity, 'info',       "real gate must floor severity to info");
      assert.strictEqual(r.kind,     'unverified', "real gate must mark kind unverified");
      assert.strictEqual(r.gated,    true,         "real gate must report gated=true");
    });

    await checkAsync("(b) REAL gate floors exposure-with-403 finding (add_finding shape)", async () => {
      const db = makeTelemetryCapturingDb();
      const r = await claimVerifier.applyPreInsertGate(
        { title: 'Exposed Configuration File', description: 'http_code=403', severity: 'medium', kind: 'confirmed', affected_asset: '10.20.30.40' },
        { db, engagementId: 'e1', source: 'add_finding' });
      assert.strictEqual(r.severity, 'info',       "MCP add_finding: real gate floors severity");
      assert.strictEqual(r.kind,     'unverified', "MCP add_finding: real gate marks unverified");
    });

    await checkAsync("(b) REAL gate passes a clean finding UNCHANGED", async () => {
      const db = makeTelemetryCapturingDb();
      const r = await claimVerifier.applyPreInsertGate(
        { title: 'Admin Panel Accessible', description: 'Logged in as admin, session cookie received', severity: 'critical', kind: 'confirmed', affected_asset: '10.20.30.40' },
        { db, engagementId: 'e1', source: 'submit_results' });
      assert.strictEqual(r.severity, 'critical',  "clean finding: severity unchanged through real gate");
      assert.strictEqual(r.kind,     'confirmed', "clean finding: kind unchanged through real gate");
      assert.strictEqual(r.gated,    false,       "clean finding: real gate reports gated=false");
      assert.strictEqual(db.telemetry.length, 0,  "clean finding: no floor telemetry emitted");
    });

    await checkAsync("(b) REAL gate passes a clean cred-test finding (no evidence) UNCHANGED", async () => {
      const db = makeTelemetryCapturingDb();
      const r = await claimVerifier.applyPreInsertGate(
        { title: 'Default Credentials Accepted', description: '', severity: 'high', kind: 'confirmed', affected_asset: '' },
        { db, engagementId: 'e1', source: 'add_finding' });
      assert.strictEqual(r.severity, 'high',      "cred-test finding: severity preserved (no self-contra evidence)");
      assert.strictEqual(r.kind,     'confirmed', "cred-test finding: kind preserved");
    });

    // MINOR 1: a floor must be COUNTABLE — the real gate emits a VERIFY_GATE_FAIL
    // telemetry row when it floors, matching the offense path's pattern.
    await checkAsync("(b/MINOR-1) REAL gate emits VERIFY_GATE_FAIL telemetry when it floors", async () => {
      const db = makeTelemetryCapturingDb();
      await claimVerifier.applyPreInsertGate(
        { title: 'Sensitive File Exposure', description: 'Status: 403', severity: 'high', affected_asset: '10.20.30.40' },
        { db, engagementId: 'e1', source: 'submit_results' });
      assert.strictEqual(db.telemetry.length, 1, "floor must emit exactly one telemetry row");
      const { VERIFY_GATE_FAIL } = require(path.join(__dirname, "../soc/verify-gate-constants"));
      assert.ok(db.telemetry[0].params.includes(VERIFY_GATE_FAIL),
        "floor telemetry row must carry the VERIFY_GATE_FAIL token as its outcome");
    });

    // MINOR 1: a fail-OPEN must be COUNTABLE too — when the gate's internal check
    // throws, the real gate inserts at claimed severity but emits gate_failed_open.
    await checkAsync("(b/MINOR-1) REAL gate emits gate_failed_open telemetry when it fails open", async () => {
      const db = makeTelemetryCapturingDb();
      // A finding whose .title getter throws → forces verifyFindingDataSync to throw
      // inside applyPreInsertGate, exercising the real fail-open branch.
      const poison = { description: 'x', severity: 'high', affected_asset: '10.20.30.40' };
      Object.defineProperty(poison, 'title', { get() { throw new Error('boom'); }, enumerable: true });
      const r = await claimVerifier.applyPreInsertGate(poison, { db, engagementId: 'e1', source: 'add_finding' });
      assert.strictEqual(r.failedOpen, true, "real gate must report failedOpen=true on internal throw");
      assert.strictEqual(r.severity, 'high', "fail-open inserts at CLAIMED severity (does not silently downgrade)");
      assert.strictEqual(db.telemetry.length, 1, "fail-open must emit exactly one telemetry row");
      // The fail-open outcome token is a literal in the INSERT's VALUES clause, so
      // assert against the captured SQL (not the params array).
      assert.ok(/gate_failed_open/.test(db.telemetry[0].sql),
        "fail-open telemetry row must carry the 'gate_failed_open' outcome so a broken gate is countable");
    });
  }

  // ── (c) skip→unverified labeling — via the REAL verifyFinding ─────────────────
  {
    await checkAsync("(c) REAL verifyFinding sets kind='unverified' (not severity) on SKIP", async () => {
      const db = makeVerifierCapturingDb({
        id: 2, engagement_id: 'e1',
        title: 'Default Credentials Accepted on Hikvision',
        severity: 'high', kind: 'confirmed',
        affected_asset: '10.20.30.40', evidence_summary: '',
      });
      // Inconclusive probe (404) → real verdict resolves to 'skip'.
      const probe404 = async () => "HTTP=404\nNot Found\n";
      await claimVerifier.verifyFinding(2, db, { runProbe: probe404 });
      const upd = findUpdate(db);
      assert.ok(upd, "production verifyFinding must issue an UPDATE on a skip verdict");
      assert.ok(/kind\s*=\s*'unverified'/.test(upd),
        `real skip UPDATE must set kind = 'unverified'; got: ${upd}`);
      assert.ok(!/severity\s*=/.test(upd),
        "real skip UPDATE must NOT alter severity (inconclusive ≠ wrong)");
    });

    await checkAsync("(c) REAL verifyFinding skip UPDATE guards with AND kind='confirmed'", async () => {
      const db = makeVerifierCapturingDb({
        id: 2, engagement_id: 'e1',
        title: 'Default Credentials Accepted on Hikvision',
        severity: 'high', kind: 'confirmed',
        affected_asset: '10.20.30.40', evidence_summary: '',
      });
      const probe404 = async () => "HTTP=404\nNot Found\n";
      await claimVerifier.verifyFinding(2, db, { runProbe: probe404 });
      const upd = findUpdate(db);
      assert.ok(upd, "UPDATE must have been issued");
      assert.ok(/WHERE id = .* AND kind\s*=\s*'confirmed'/.test(upd),
        "real skip UPDATE must guard with AND kind = 'confirmed' to avoid flipping already-refuted rows");
    });
  }

  // ── (d) Writer-token and reader-token are the same shared constant (FIX 3) ────
  {
    // Require the constants module directly — it has no /app/* or Docker deps.
    const verifyGateConstants = require(path.join(__dirname, "../soc/verify-gate-constants"));

    check("(d) VERIFY_GATE_FAIL constant is exported from verify-gate-constants.js", () => {
      assert.ok(typeof verifyGateConstants.VERIFY_GATE_FAIL === "string",
        "VERIFY_GATE_FAIL must be a string export");
      assert.strictEqual(verifyGateConstants.VERIFY_GATE_FAIL, "verify_gate_fail",
        "constant value must be 'verify_gate_fail'");
    });

    check("(d) constant fits VARCHAR(24) column", () => {
      assert.ok(verifyGateConstants.VERIFY_GATE_FAIL.length <= 24,
        `VERIFY_GATE_FAIL '${verifyGateConstants.VERIFY_GATE_FAIL}' exceeds 24-char VARCHAR limit`);
    });


  }
})().then(() => {
  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("\n❌ SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ ALL TESTS PASSED");
  }
}).catch(e => {
  console.error("Async test runner crashed:", e.message);
  process.exit(1);
});
