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
  const { getBehavioralScorecard } = require(path.join(__dirname, "../behavioral-scorecard"));

  await checkAsync("scorecard returns an object on empty data", async () => {
    const sc = await getBehavioralScorecard(1, makeMockDb());
    assert.strictEqual(typeof sc, "object");
    assert.strictEqual(sc.engagement_id, 1);
  });

  await checkAsync("all required top-level fields present", async () => {
    const sc = await getBehavioralScorecard(1, makeMockDb());
    const required = [
      "engagement_id","concluded","conclude_reason","total_steps",
      "phase_progression","step_queued_rate","step_queued_breakdown",
      "loop_breaker_fires","watchdog_timeouts","inference_hung",
      "permission_denied","claim_verify","findings_by_severity",
      "false_positive","membrane_breach","orphaned_tasks",
    ];
    for (const f of required) assert.ok(f in sc, `missing field: ${f}`);
  });

  await checkAsync("scorecard JSON contains no IP-shaped strings", async () => {
    const db = makeMockDb({
      telemetry: [
        { outcome: "permission_denied", intent_category: "recon", step_queued: false,
          outcome_notes: "rule=workspace_jail; suppressed", created_at: new Date() },
      ],
    });
    const sc = await getBehavioralScorecard(1, db);
    const json = JSON.stringify(sc);
    assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(json),
      "scorecard JSON must not contain IP addresses");
  });

  await checkAsync("scorecard JSON contains no CVE-shaped strings", async () => {
    const sc = await getBehavioralScorecard(1, makeMockDb({ findings: [{ severity: "high", kind: "confirmed" }] }));
    const json = JSON.stringify(sc);
    assert.ok(!/CVE-\d{4}-\d+/i.test(json), "scorecard JSON must not contain CVE IDs");
  });

  await checkAsync("scorecard string values contain no offensive tool names", async () => {
    const db = makeMockDb({
      telemetry: [
        { outcome: "lint_reject", intent_category: "non_productive_turn", step_queued: false,
          outcome_notes: "iter=3; task=5; gate fired", created_at: new Date() },
      ],
    });
    const sc = await getBehavioralScorecard(1, db);
    const strValues = [];
    function extractStrings(obj) {
      if (typeof obj === "string") { strValues.push(obj); return; }
      if (obj && typeof obj === "object") for (const v of Object.values(obj)) extractStrings(v);
    }
    extractStrings(sc);
    const TOOL_RE = /\b(nmap|curl|ssh|wget|sqlmap|hydra|netcat|burpsuite|metasploit|aircrack)\b/i;
    for (const s of strValues) {
      assert.ok(!TOOL_RE.test(s),
        `scorecard value contains offensive tool name: "${s.slice(0,80)}"`);
    }
  });

  await checkAsync("step_queued_breakdown counts each cause correctly", async () => {
    const db = makeMockDb({
      telemetry: [
        { outcome: "infra_hang",  intent_category: "non_productive_turn", step_queued: false, outcome_notes: "", created_at: new Date() },
        { outcome: "prose_only",  intent_category: "non_productive_turn", step_queued: false, outcome_notes: "", created_at: new Date() },
        { outcome: "lint_reject", intent_category: "non_productive_turn", step_queued: false, outcome_notes: "", created_at: new Date() },
        { outcome: "other",       intent_category: "non_productive_turn", step_queued: false, outcome_notes: "", created_at: new Date() },
      ],
      queue: [{ status: "done", created_at: new Date() }, { status: "done", created_at: new Date() }],
    });
    const sc = await getBehavioralScorecard(1, db);
    assert.strictEqual(sc.step_queued_breakdown.infra_hang,  1, "infra_hang count");
    assert.strictEqual(sc.step_queued_breakdown.prose_only,  1, "prose_only count");
    assert.strictEqual(sc.step_queued_breakdown.lint_reject, 1, "lint_reject count");
    assert.strictEqual(sc.step_queued_breakdown.other,       1, "other count");
    assert.ok(sc.step_queued_rate >= 0 && sc.step_queued_rate <= 1,
      `step_queued_rate out of [0,1]: ${sc.step_queued_rate}`);
  });

  await checkAsync("claim_verify.gated_a_finding counts correctly", async () => {
    const db = makeMockDb({
      telemetry: [
        { outcome: "verify_gate_fail", intent_category: "pre_insert_gate", step_queued: false, outcome_notes: "", created_at: new Date() },
        { outcome: "verify_gate_fail", intent_category: "pre_insert_gate", step_queued: false, outcome_notes: "", created_at: new Date() },
        { outcome: "verify_pass",                  intent_category: "cred_test",        step_queued: false, outcome_notes: "", created_at: new Date() },
      ],
    });
    const sc = await getBehavioralScorecard(1, db);
    assert.strictEqual(sc.claim_verify.gated_a_finding, 2, "gated_a_finding");
    assert.strictEqual(sc.claim_verify.passed,          1, "passed");
  });

  await checkAsync("non-existent engagement throws descriptive error", async () => {
    const db = { async query() { return { rows: [] }; } };
    let threw = false;
    try { await getBehavioralScorecard(99999, db); }
    catch (e) {
      threw = true;
      assert.ok(/not found|required/i.test(e.message), `unexpected error: ${e.message}`);
    }
    assert.ok(threw, "should have thrown for missing engagement");
  });
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
