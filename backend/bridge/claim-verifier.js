// claim-verifier.js — dir_1780789196002
//
// Async re-check of high-stakes findings the offense aggregator emits.
// Catches false positives like the engagement 628 / finding #34 case:
// model treated unauthenticated 200 OK on the root URL as "Default Credentials
// Accepted" — but the same cred against /ISAPI/System/deviceInfo returned 401.
//
// v1 scope: cred_test claims only, Hikvision auth-required endpoint only.
// Pattern-match the finding title, locate the source queue item, extract
// the cred + target, re-run against an auth-required path, decide pass/fail.
//
// Fires fire-and-forget from offense-aggregator.js after the finding INSERT.
// Result lands as kind='refuted' + evidence_summary appended (no rejection —
// keep the finding visible so the dataset captures both verdicts).

"use strict";

const { spawn } = require("child_process");
const { VERIFY_GATE_FAIL } = require("./verify-gate-constants");

// dir_1782255739233: load the real db lazily so this module can be `require`d
// outside the Docker container (tests run on the host, where /app/db does not
// exist). In-container the absolute path resolves; on the host the require throws
// and we leave the binding null — every consumer accepts an injected db (the DI
// seam below), so production keeps the real module and tests inject a mock.
let _realDb = null;
try { _realDb = require("/app/db"); } catch (_) { /* host: no /app/db — injected by caller */ }
function resolveDb(injected) {
  return injected || _realDb;
}

// Title patterns that should trigger cred-test verification. Conservative for v1.
const CRED_TEST_TITLE_PATTERNS = [
  /default\s+credentials?\s+accepted/i,
  /credentials?\s+accepted/i,
  /(potential|valid)\s+(\w+\s+){0,3}credentials?/i,   // "Potential valid default credentials" — dir_1780836984634
  /credentials?\s+(work|valid|accepted|successful)/i,
  /authentication\s+bypass/i,
  /auth(entication)?\s+(success|successful|bypass)/i,
  /successful\s+(login|auth)/i,
  /admin\s+access(ed)?/i,
  /logged?\s+in(\s+as)?/i,
];

function isCredTestClaim(finding) {
  if (!finding || !finding.title) return false;
  const t = String(finding.title);
  return CRED_TEST_TITLE_PATTERNS.some(re => re.test(t));
}

// Probe paths per fingerprint. v1 covers Hikvision; everything else falls back
// to the affected_asset URL unchanged (verifier skips if it can't form a probe).
const PROBE_PATHS = {
  hikvision: "/ISAPI/System/deviceInfo",
};

function detectVendor(finding) {
  const haystack = `${finding.title || ""} ${finding.evidence_summary || ""} ${finding.affected_asset || ""}`.toLowerCase();
  if (/hikvision|isapi/.test(haystack)) return "hikvision";
  return null;
}

// Find the queue item that most likely produced this finding: most recent done
// step on the same engagement with a curl -u pattern in its command.
async function findSourceQueueItem(engagementId, db) {
  const r = await db.query(
    `SELECT id, command FROM soc_queue_items
       WHERE engagement_id = $1 AND status = 'done'
         AND command IS NOT NULL
       ORDER BY completed_at DESC LIMIT 10`,
    [engagementId]);
  for (const row of r.rows) {
    // Decode the wrap-for-executor base64 chunk so we can inspect the real curl.
    const wrapped = row.command;
    const m = wrapped.match(/echo\s+([A-Za-z0-9+/=]+)\s*\|\s*base64\s+-d/);
    const inner = m ? Buffer.from(m[1], "base64").toString("utf8") : wrapped;
    if (/curl[^\n]*-u\s+\S+:\S+/.test(inner)) return { id: row.id, inner };
  }
  return null;
}

// Run the verification command locally on the bridge (lab reached via wg0 → tablet relay).
// dev-01 is removed from the offense pipeline (2026-06-23).
async function runViaExecutor(engagement, innerCmd) {
  return new Promise((resolve) => {
    let cmd = innerCmd;
    const proc = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => out += d.toString());
    proc.on("close", () => resolve(out));
    proc.on("error", () => resolve(""));
    proc.stdin.write(cmd);
    proc.stdin.end();
  });
}

// Verify a cred_test finding. Builds a probe curl that hits an auth-required
// path with the same cred, then evaluates the response. Returns one of:
//   {verdict:'pass', code, notes}     — finding stands
//   {verdict:'fail', code, notes}     — finding is refuted
//   {verdict:'skip', reason}          — can't verify, leave finding alone
async function verifyCredTestFinding(finding, db, runProbe) {
  // dir_1782255739233: runProbe is the executor seam — defaults to the real
  // local-spawn executor; tests inject a deterministic probe response so the
  // PRODUCTION verdict→UPDATE logic can be exercised without a live target.
  runProbe = runProbe || runViaExecutor;
  const vendor = detectVendor(finding);
  if (!vendor || !PROBE_PATHS[vendor]) return { verdict: "skip", reason: `no probe path for vendor=${vendor || "unknown"}` };

  // Locate target host. affected_asset is "192.168.1.19" or "192.168.1.19:80" — strip port.
  if (!finding.affected_asset) return { verdict: "skip", reason: "no affected_asset" };
  const hostMatch = String(finding.affected_asset).match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  if (!hostMatch) return { verdict: "skip", reason: "no IP in affected_asset" };
  const targetIp = hostMatch[1];

  // Find source queue item with the cred.
  const eng = await db.query(
    `SELECT id, executor_host, executor_adb_target FROM pentest_engagements WHERE id = $1`,
    [finding.engagement_id]);
  if (eng.rows.length === 0) return { verdict: "skip", reason: "engagement not found" };
  const engagement = eng.rows[0];

  const src = await findSourceQueueItem(finding.engagement_id, db);
  if (!src) return { verdict: "skip", reason: "no curl -u source queue item in last 10 done steps" };

  // Extract cred token from source command. Stays in-memory; never logged.
  const credMatch = src.inner.match(/-u\s+(\S+)/);
  if (!credMatch) return { verdict: "skip", reason: "no -u in source command" };
  const cred = credMatch[1];

  // Build probe: curl GET (not HEAD — some endpoints don't implement HEAD) to the
  // auth-required path with same cred, short timeout.
  const probePath = PROBE_PATHS[vendor];
  const probeCmd = `curl -sS -o /tmp/cv -w 'HTTP=%{http_code}\\n' --connect-timeout 8 --max-time 15 -u ${cred} http://${targetIp}${probePath}; head -c 600 /tmp/cv 2>/dev/null`;
  const out = await runProbe(engagement, probeCmd);

  const httpMatch = out.match(/HTTP=(\d{3})/);
  const code = httpMatch ? httpMatch[1] : null;
  const looksUnauth = /Unauthorized|<userCheck/i.test(out);
  const looksAuthSuccess = /<DeviceInfo|deviceName|<serialNumber>/i.test(out);

  if (code === "200" && looksAuthSuccess) {
    return { verdict: "pass", code, notes: `${probePath} → 200 + DeviceInfo XML — cred works.` };
  }
  if (code === "401" || code === "403" || looksUnauth) {
    return { verdict: "fail", code: code || "unauth", notes: `${probePath} → ${code || "unauthorized body"} — cred rejected.` };
  }
  // Inconclusive (404, 5xx, timeout). Don't refute — the original test might
  // have been against a different real endpoint we don't know about.
  return { verdict: "skip", reason: `inconclusive probe response (code=${code || "(none)"})` };
}

// dir_1780854805127: exposure-finding claims requiring HTTP 200 + content.
// A finding titled "Sensitive File Exposure" / "Exposed X" with evidence
// containing a 403/401/404 status is auto-refuted because those statuses
// mean the file is HIDDEN, not exposed.
const EXPOSURE_TITLE_PATTERNS = [
  /sensitive\s+file\s+exposure/i,
  /exposed\s+(file|directory|endpoint|configuration|credentials?|database|backup)/i,
  /file\s+disclosure/i,
  /information\s+disclosure(?!.*version)/i, // info-disclosure but NOT version banner disclosure
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
  return { verdict: "fail", code: m[1], notes:
    `Title claims "${finding.title.slice(0, 80)}" but evidence shows HTTP ${m[1]}. ` +
    `${m[1] === "403" ? "Apache returns 403 for hidden files (.htaccess/.htpasswd/.hta/server-status are standard hardening, not exposure)." :
      m[1] === "401" ? "401 means auth required — file is protected, not exposed." :
      m[1] === "404" ? "404 means not found — file does not exist." :
      "Hidden, not exposed."}` };
}

// Pre-insert synchronous gate. Called by offense-aggregator BEFORE the finding
// is written to DB. Only applies the stateless exposure-with-403 check (no probe
// needed — the evidence already tells us the status). Returns:
//   {verdict:'fail', notes}  — gate: floor severity + mark unverified before INSERT
//   {verdict:'skip'}         — no gate; proceed with normal INSERT
// Cred-test verification still runs post-insert (needs DB id for the probe).
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

// dir_1782255739233 (FIX 2 + MINOR 1): the single shared pre-insert gate the
// MANUAL write-paths (routes/soc.js submit-results, routes/mcp.js add_finding)
// call before INSERT, so neither path can bypass verification by hand-authoring
// a self-contradicting finding. Returns the severity/kind the caller must INSERT
// with. Field names are the manual-path shape (description, severity, kind).
//
// MINOR 1 — the gate must be COUNTABLE, never silent:
//   - when it FLOORS a finding it emits an offense_telemetry row with the shared
//     VERIFY_GATE_FAIL token (matching the offense aggregator's pre-insert gate),
//     so the false-positive metric sees manual-path floors too;
//   - when it FAILS OPEN (gate throws, or the verifier module won't load) it emits
//     a distinct 'gate_failed_open' row, so a broken gate is countable rather than
//     silently inserting at the claimed severity and corrupting the FP metric.
//
// telemetry is best-effort: a telemetry write failure never blocks the insert.
async function applyPreInsertGate(finding, { db, engagementId, source } = {}) {
  const dbh = resolveDb(db);
  let severity = finding.severity || "info";
  let kind = ["confirmed", "hypothesis", "refuted"].includes(finding.kind) ? finding.kind : "confirmed";
  let gated = false;
  let failedOpen = false;
  let code = null;

  try {
    const preCheck = verifyFindingDataSync({
      title:            finding.title,
      evidence:         finding.description || finding.evidence || "",
      evidence_summary: finding.description || finding.evidence_summary || "",
      affected_asset:   finding.affected_asset || "",
    });
    if (preCheck.verdict === "fail") {
      severity = "info";
      kind     = "unverified";
      gated    = true;
      code     = preCheck.code || null;
    }
  } catch (e) {
    // The gate threw — fail OPEN (insert at claimed severity) but LOUDLY.
    failedOpen = true;
    if (dbh) {
      try {
        await dbh.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'claim-verifier', 'manual_gate',
                   0, 1, false, true, 0, 0, 'gate_failed_open', $2)`,
          [engagementId || null,
           `source=${source || "manual"}; gate threw: ${(e.message || "").slice(0, 80)}; inserted at claimed severity`]);
      } catch (_) { /* telemetry never blocks the insert */ }
    }
    return { severity, kind, gated, failedOpen, code };
  }

  if (gated && dbh) {
    try {
      await dbh.query(
        `INSERT INTO offense_telemetry
           (engagement_id, queue_item_id, model_used, intent_category,
            n_hosts, n_findings, step_queued, in_scope, n_references,
            latency_ms, outcome, outcome_notes)
         VALUES ($1, NULL, 'claim-verifier', 'manual_gate',
                 0, 1, false, true, 0, 0, $2, $3)`,
        [engagementId || null, VERIFY_GATE_FAIL,
         `source=${source || "manual"}; title="${String(finding.title || "").slice(0, 80)}"; code=${code || "?"}; floored_to=info`]);
    } catch (_) { /* telemetry never blocks the insert */ }
  }

  return { severity, kind, gated, failedOpen, code };
}

// Main entry. Dispatches by claim type.
// dir_1782255739233: optional `injectedDb` is the DI seam — production calls
// verifyFinding(id) and gets the real /app/db; tests call verifyFinding(id, mockDb)
// to capture the exact SQL the PRODUCTION function issues.
async function verifyFinding(findingId, injectedDb, opts = {}) {
  const db = resolveDb(injectedDb);
  const runProbe = opts.runProbe; // executor seam; undefined → real local executor
  try {
    const r = await db.query(
      `SELECT id, engagement_id, title, severity, kind, affected_asset, evidence_summary
         FROM pentest_findings WHERE id = $1`,
      [findingId]);
    if (r.rows.length === 0) return;
    const finding = r.rows[0];
    if (finding.kind === "refuted") return; // already refuted, no point re-checking

    // dir_1780854805127: exposure-with-403 auto-refute. No probe needed —
    // the evidence already tells us the file is hidden.
    if (isExposureClaim(finding)) {
      const fast = refuteExposureBy403(finding);
      if (fast) {
        await db.query(
          `UPDATE pentest_findings
              SET kind = 'refuted',
                  severity = 'info',
                  evidence_summary = COALESCE(evidence_summary, '') || $1
            WHERE id = $2`,
          [`\n\n[REFUTED by claim-verifier dir_1780854805127 at ${new Date().toISOString()}: ${fast.notes}]`, finding.id]);
        try {
          await db.query(
            `INSERT INTO offense_telemetry
               (engagement_id, queue_item_id, model_used, intent_category,
                n_hosts, n_findings, step_queued, in_scope, n_references,
                latency_ms, outcome, outcome_notes)
             VALUES ($1, NULL, 'claim-verifier', 'exposure_with_403',
                     0, 0, false, true, 0, 0, 'verify_fail', $2)`,
            [finding.engagement_id, `finding ${finding.id} "${finding.title.slice(0, 80)}": ${fast.notes}`]);
        } catch (_) {}
        return;
      }
    }

    if (!isCredTestClaim(finding)) return;

    const result = await verifyCredTestFinding(finding, db, runProbe);
    // outcome column is VARCHAR(24) — short tokens only.
    const outcome = result.verdict === "pass" ? "verify_pass"
                  : result.verdict === "fail" ? "verify_fail"
                  : "verify_skip";

    if (result.verdict === "fail") {
      await db.query(
        `UPDATE pentest_findings
            SET kind = 'refuted',
                severity = 'info',
                evidence_summary = COALESCE(evidence_summary, '') || $1
          WHERE id = $2`,
        [
          `\n\n[REFUTED by claim-verifier dir_1780789196002 at ${new Date().toISOString()}: ` +
            `${result.notes}]`,
          finding.id,
        ]);
    } else if (result.verdict === "pass") {
      await db.query(
        `UPDATE pentest_findings
            SET evidence_summary = COALESCE(evidence_summary, '') || $1
          WHERE id = $2`,
        [`\n\n[VERIFIED by claim-verifier at ${new Date().toISOString()}: ${result.notes}]`, finding.id]);
    } else if (result.verdict === "skip") {
      // FIX 4: inconclusive probe — mark the finding explicitly unverified so it
      // is distinguishable from a genuinely-verified 'confirmed' finding in the
      // scorecard's claim_verify / false_positive descriptor. Severity is NOT
      // floored — inconclusive means "can't tell", not "wrong".
      await db.query(
        `UPDATE pentest_findings
            SET kind = 'unverified',
                evidence_summary = COALESCE(evidence_summary, '') || $1
          WHERE id = $2 AND kind = 'confirmed'`,
        [`\n\n[INCONCLUSIVE by claim-verifier at ${new Date().toISOString()}: ${result.reason}]`, finding.id]);
    }

    try {
      await db.query(
        `INSERT INTO offense_telemetry
           (engagement_id, queue_item_id, model_used, intent_category,
            n_hosts, n_findings, step_queued, in_scope, n_references,
            latency_ms, outcome, outcome_notes)
         VALUES ($1, NULL, 'claim-verifier', 'cred_test',
                 0, 0, false, true, 0, 0, $2, $3)`,
        [finding.engagement_id, outcome,
         `finding ${finding.id} "${finding.title.slice(0, 80)}": ${result.notes || result.reason || ""}`]);
    } catch (_) { /* telemetry never breaks verifier */ }
  } catch (e) {
    console.error(`[claim-verifier] verifyFinding(${findingId}) crashed:`, e.message);
  }
}

module.exports = {
  verifyFinding, verifyFindingDataSync, applyPreInsertGate,
  isCredTestClaim, detectVendor,
  isExposureClaim, refuteExposureBy403,
};
