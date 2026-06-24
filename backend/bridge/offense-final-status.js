"use strict";
// offense-final-status.js — dir_1782242371780 (correction)
//
// The pure final-status mapping for offense-agent.js's runAgent loop. Extracted into
// its own dependency-free module so it is the SINGLE source of truth AND importable by
// the test suite without loading offense-agent.js's Docker-absolute (/app/*) require
// tree. offense-agent.js requires this and re-exports computeFinalStatus.
//
// The prior tests asserted an INLINE COPY of this mapping and so hid the bug where a
// harness-forced abnormal halt was mislabeled 'completed'. With the logic here, the
// test exercises the REAL function — reverting any single arm turns its test red.
//
// Mapping (precedence matters — 'halted' is checked FIRST):
//   haltedAbnormally    → 'halted'    — loop-breaker on a terminal phase / dark-loop
//                                        halt-timeout / stall exhaustion. NOT a model end.
//   endedByOrchestrator → 'completed' — the model called end_engagement. Legitimate even
//                                        with 0 findings (a clean "nothing exploitable").
//   iter >= maxIter     → 'paused'    — iteration-budget cap; resumable via start_engagement_run.
//   otherwise           → 'error'     — unexpected early exit.
//
// 'halted' must be checked before 'paused' so a forced halt that also happens to be at
// the iter cap can never read as the resumable 'paused', and before 'completed' so it
// can never masquerade as a clean conclusion (the exact incident this corrects).
function computeFinalStatus({ haltedAbnormally, endedByOrchestrator, iter, maxIter }) {
  if (haltedAbnormally) return "halted";
  if (endedByOrchestrator) return "completed";
  if (iter >= maxIter) return "paused";
  return "error";
}

module.exports = { computeFinalStatus };
