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
const db = require("/app/db");

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
async function findSourceQueueItem(engagementId) {
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

// Run the verification request through the engagement's executor. Mirrors the
// shape of offense-engine.wrapForExecutor — for the tablet executor case we
// adb-wrap; for dev-01 we ssh directly.
async function runViaExecutor(engagement, innerCmd) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(innerCmd).toString("base64");
    let cmd;
    if (engagement.executor_host && engagement.executor_host !== "dev-01") {
      const adbTarget = engagement.executor_adb_target || "10.9.0.10:5555";
      cmd = `adb -s ${adbTarget} shell 'echo ${b64} | base64 -d | su -c "/data/local/nhsystem/nh -s"' </dev/null`;
    } else {
      cmd = `echo ${b64} | base64 -d | ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 dev-01 'bash -s'`;
    }
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
async function verifyCredTestFinding(finding) {
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

  const src = await findSourceQueueItem(finding.engagement_id);
  if (!src) return { verdict: "skip", reason: "no curl -u source queue item in last 10 done steps" };

  // Extract cred token from source command. Stays in-memory; never logged.
  const credMatch = src.inner.match(/-u\s+(\S+)/);
  if (!credMatch) return { verdict: "skip", reason: "no -u in source command" };
  const cred = credMatch[1];

  // Build probe: curl GET (not HEAD — some endpoints don't implement HEAD) to the
  // auth-required path with same cred, short timeout.
  const probePath = PROBE_PATHS[vendor];
  const probeCmd = `curl -sS -o /tmp/cv -w 'HTTP=%{http_code}\\n' --connect-timeout 8 --max-time 15 -u ${cred} http://${targetIp}${probePath}; head -c 600 /tmp/cv 2>/dev/null`;
  const out = await runViaExecutor(engagement, probeCmd);

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

// Main entry. Dispatches by claim type.
async function verifyFinding(findingId) {
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

    const result = await verifyCredTestFinding(finding);
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
  verifyFinding, verifyFindingDataSync,
  isCredTestClaim, detectVendor,
  isExposureClaim, refuteExposureBy403,
};
