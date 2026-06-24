"use strict";
// verify-gate-constants.js — dir_1782255739233
//
// Single source of truth for the telemetry token written by the pre-insert
// gate writer (offense-aggregator.js) and read by the scorecard reader
// (behavioral-scorecard.js). A string-literal in both files would silently
// zero the gated-finding count if they ever drifted apart.

const VERIFY_GATE_FAIL = "verify_gate_fail";

// dir_1782260457892: audit token written by the contradiction-detection /
// finding-revision trigger (finding-revision.js) BEFORE it re-invokes the
// verifier. Audit-only — the scorecard counts the integrity event via the
// reused verifyFinding row, so this token is intentionally not read there.
// offense_telemetry.outcome is VARCHAR(24) — keep it ≤24 chars.
const REVISION_TRIGGERED = "revision_triggered";

module.exports = { VERIFY_GATE_FAIL, REVISION_TRIGGERED };
