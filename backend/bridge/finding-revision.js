// finding-revision.js — dir_1782260457892
//
// Contradiction-detection / finding-revision loop.
//
// The existing claim-verifier (claim-verifier.js) re-checks a finding exactly
// ONCE — at INSERT time (offense-aggregator.js:262), when the finding is first
// written. It catches a finding that contradicts ITSELF (a "Sensitive File
// Exposure" whose own evidence is a 403). It does NOT react when a LATER step
// returns output that contradicts an ALREADY-recorded finding.
//
// This module is the thin, additive TRIGGER for that case: after each step's
// aggregator fold, scan the just-folded `summary` for a signal that contradicts
// a confirmed, non-floored finding, and — if found — RE-INVOKE the existing
// verifyFinding(findingId, db). The downgrade itself (kind='refuted',
// severity='info', telemetry row) is owned by claim-verifier.js and is REUSED,
// not reimplemented here.
//
// Membrane-safe: the only thing this module writes is an audit telemetry row
// carrying a class token (cred / exposure) and the finding id — never a command,
// payload, or IP.

"use strict";

const claimVerifier = require("./claim-verifier");
const { REVISION_TRIGGERED } = require("./verify-gate-constants");

// dir_1782255739233 pattern: load the real db lazily so this module is
// `require`-able outside the Docker container (tests run on the host, where
// /app/db does not exist). In-container the absolute path resolves; on the host
// the require throws and we leave the binding null — every consumer accepts an
// injected db (the DI seam), so production keeps the real module and tests inject.
let _realDb = null;
try { _realDb = require("/app/db"); } catch (_) { /* host: no /app/db — injected by caller */ }
function resolveDb(injected) {
  return injected || _realDb;
}

// IP-extraction idiom — same shape as claim-verifier.js:121.
const IP_RE = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

// HIDDEN/negative-status shape — same family as claim-verifier.js HIDDEN_STATUS_RE
// (claim-verifier.js:173). Matches a 401/403/404 carried in a key_signal.
const HIDDEN_STATUS_RE = /(?:Status:\s*|HTTP[/ ]\d\.?\d?\s*|http_code[=:]?\s*)?\b(40[134])\b/i;
// Cred/auth findings are contradicted specifically by an unauthorized signal:
// 401, 403, or the word "unauthorized".
const AUTH_NEG_RE = /\b(401|403)\b|unauthorized/i;

// Collect every IP a finding claims (single affected_asset + structured
// affected_assets[]). Returns a Set of dotted-quad strings.
function findingIps(finding) {
  const ips = new Set();
  const single = String(finding.affected_asset || "");
  const m = single.match(IP_RE);
  if (m) ips.add(m[1]);
  const list = finding.affected_assets;
  if (Array.isArray(list)) {
    for (const a of list) {
      if (!a) continue;
      const ip = String(a.ip || a.host || a || "");
      const mm = ip.match(IP_RE);
      if (mm) ips.add(mm[1]);
    }
  }
  return ips;
}

// PURE: no DB, no I/O. Given the aggregator `summary` for the step that just ran
// and the engagement's already-recorded `findings`, return the findings this
// step contradicts: [{ finding_id, reason }]. `reason` is a class token
// ('cred' | 'exposure'), never a payload.
function detectContradictions(summary, findings) {
  // FAILED-STEP GUARD (explicit, required): never trigger off a step that merely
  // failed or timed out — a failed step proves nothing about a prior finding.
  if (!summary) return [];
  if (summary.success === false) return [];
  if (["timeout", "tool_missing", "unknown"].includes(summary.error_category)) return [];

  const signals = Array.isArray(summary.key_signals) ? summary.key_signals.map(String) : [];
  if (signals.length === 0) return [];
  if (!Array.isArray(findings) || findings.length === 0) return [];

  const out = [];
  for (const finding of findings) {
    if (!finding) continue;
    // Idempotency: only consider a still-confirmed, non-floored finding. A finding
    // already at severity='info' (floored) or already refuted/unverified must
    // never be re-touched.
    if (finding.kind !== "confirmed") continue;
    if (finding.severity === "info") continue;

    const isCred     = claimVerifier.isCredTestClaim(finding);
    const isExposure = claimVerifier.isExposureClaim(finding);
    if (!isCred && !isExposure) continue; // only the two classes the verifier can re-check

    const ips = findingIps(finding);
    if (ips.size === 0) continue;

    for (const sig of signals) {
      const sigIpMatch = sig.match(IP_RE);
      if (!sigIpMatch) continue;
      // Host match: the finding's IP must appear in THIS key_signal.
      if (!ips.has(sigIpMatch[1])) continue;

      // Contradiction = the matched signal carries a hidden/negative status of the
      // OPPOSITE polarity for the claim's class.
      if (isCred && AUTH_NEG_RE.test(sig)) {
        out.push({ finding_id: finding.id, reason: "cred" });
        break; // one trigger per finding
      }
      if (isExposure && HIDDEN_STATUS_RE.test(sig)) {
        out.push({ finding_id: finding.id, reason: "exposure" });
        break;
      }
    }
  }
  return out;
}

// For each contradiction: emit ONE audit telemetry row (non-silent requirement),
// then RE-INVOKE the existing verifier, which re-probes and — on a held
// contradiction — performs the REUSED downgrade. verifyFn is the DI seam (same
// pattern as claim-verifier.js): defaults to the real verifyFinding.
async function reverifyContradicted(engagementId, contradictions, { db, verifyFn } = {}) {
  const dbh = resolveDb(db);
  verifyFn = verifyFn || require("/app/claim-verifier").verifyFinding;

  for (const c of contradictions) {
    if (!c || c.finding_id == null) continue;
    // 1. Audit telemetry BEFORE re-verify. Membrane-safe: class token + id only,
    //    no command bytes, no payload, no IP. Best-effort — never throws into the loop.
    if (dbh) {
      try {
        await dbh.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'claim-verifier', 'finding_revision',
                   0, 0, false, true, 0, 0, $2, $3)`,
          [engagementId || null, REVISION_TRIGGERED,
           `finding ${c.finding_id}; reason=${c.reason || "?"}`]);
      } catch (_) { /* audit telemetry never blocks the re-verify */ }
    }

    // 2. Re-invoke the EXISTING verifier. It re-probes the auth-required path and,
    //    on a held contradiction, issues the reused refute UPDATE (floor severity,
    //    kind='refuted') + its own verify_fail telemetry row.
    try {
      await verifyFn(c.finding_id, dbh);
    } catch (e) {
      console.error(`[finding-revision] reverify finding ${c.finding_id} failed:`, e.message);
    }
  }
}

module.exports = { detectContradictions, reverifyContradicted };
