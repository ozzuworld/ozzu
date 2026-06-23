"use strict";
// verify-gate-constants.js — dir_1782255739233
//
// Single source of truth for the telemetry token written by the pre-insert
// gate writer (offense-aggregator.js) and read by the scorecard reader
// (behavioral-scorecard.js). A string-literal in both files would silently
// zero the gated-finding count if they ever drifted apart.

const VERIFY_GATE_FAIL = "verify_gate_fail";

module.exports = { VERIFY_GATE_FAIL };
