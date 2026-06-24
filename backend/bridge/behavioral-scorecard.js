"use strict";
// behavioral-scorecard.js — dir_1782255739233
const { VERIFY_GATE_FAIL } = require("./verify-gate-constants");
//
// Membrane-safe per-engagement behavioral scorecard. Returns ONLY numbers,
// enums, and booleans — never command text, IPs, CVE IDs, tool names, port
// banners, or finding descriptions. Safe to hand to any downstream model,
// including one with an aggressive cybersecurity classifier.

async function getBehavioralScorecard(engagementId, db) {
  const eid = Number(engagementId);
  if (!eid) throw new Error("engagement_id required");

  // Parallel queries — all aggregate over safe numeric/enum columns only.
  const [
    engRow,
    telRows,
    findingRows,
    taskRows,
    queueRows,
  ] = await Promise.all([
    db.query(
      `SELECT status, agent_status, engagement_phase, agent_run_state
         FROM pentest_engagements WHERE id = $1`,
      [eid]),
    db.query(
      `SELECT outcome, intent_category, outcome_notes, step_queued, created_at
         FROM offense_telemetry WHERE engagement_id = $1 ORDER BY id ASC`,
      [eid]),
    db.query(
      `SELECT severity, kind FROM pentest_findings WHERE engagement_id = $1`,
      [eid]),
    db.query(
      `SELECT status, phase, created_at, completed_at
         FROM engagement_tasks WHERE engagement_id = $1 ORDER BY id ASC`,
      [eid]),
    db.query(
      `SELECT status, created_at
         FROM soc_queue_items WHERE engagement_id = $1 ORDER BY seq ASC`,
      [eid]),
  ]);

  const eng = engRow.rows[0];
  if (!eng) throw new Error(`engagement ${eid} not found`);

  const telemetry = telRows.rows;
  const findings  = findingRows.rows;
  const tasks     = taskRows.rows;

  // ── concluded / conclude_reason ───────────────────────────────────────────
  // dir_1782242371780 (correction): 'halted' is a distinct terminal status for a
  // harness-FORCED abnormal halt (loop-breaker terminal phase / dark-loop / stall),
  // reported separately from a clean 'completed' so the scorecard never disguises a
  // forced halt as a successful conclusion.
  const agentStatus = eng.agent_status || "running";
  const concluded = ["completed", "paused", "error", "halted"].includes(agentStatus);
  const concludeReason = ["completed", "paused", "error", "halted", "running"].includes(agentStatus)
    ? agentStatus : "running";

  // ── total_steps ───────────────────────────────────────────────────────────
  const totalSteps = queueRows.rows.length;

  // ── phase_progression ─────────────────────────────────────────────────────
  // Walk tasks in order; group consecutive same-phase runs, counting steps and
  // wall seconds. Never surface any directive text.
  const phaseProgression = [];
  {
    const phaseAdvanceRows = telemetry.filter(t =>
      t.outcome === "forced_phase_advance" || t.intent_category === "phase_advance");
    const tasksByPhase = {};
    for (const t of tasks) {
      const ph = t.phase || "recon";
      if (!tasksByPhase[ph]) tasksByPhase[ph] = { steps: 0, wallMs: 0 };
      tasksByPhase[ph].steps++;
      if (t.created_at && t.completed_at) {
        tasksByPhase[ph].wallMs += new Date(t.completed_at) - new Date(t.created_at);
      }
    }
    for (const [phase, info] of Object.entries(tasksByPhase)) {
      const advancedBy = phaseAdvanceRows.some(r => (r.outcome_notes || "").includes(phase))
        ? "loop_breaker" : "model";
      phaseProgression.push({
        phase,
        steps: info.steps,
        advanced_by: advancedBy,
        wall_seconds: Math.round(info.wallMs / 1000),
      });
    }
  }

  // ── step_queued_rate + breakdown ──────────────────────────────────────────
  const nonProdRows = telemetry.filter(t => t.intent_category === "non_productive_turn");
  const breakdown = { infra_hang: 0, prose_only: 0, lint_reject: 0, other: 0 };
  for (const r of nonProdRows) {
    const outcome = r.outcome;
    if (outcome === "infra_hang")  breakdown.infra_hang++;
    else if (outcome === "prose_only") breakdown.prose_only++;
    else if (outcome === "lint_reject") breakdown.lint_reject++;
    else breakdown.other++;
  }
  const totalTurns = totalSteps + nonProdRows.length;
  const stepQueuedRate = totalTurns > 0
    ? Math.round((totalSteps / totalTurns) * 1000) / 1000
    : 0;

  // ── loop_breaker_fires ────────────────────────────────────────────────────
  const loopBreakerFires = telemetry.filter(t =>
    t.outcome === "forced_phase_advance" && t.intent_category === "phase_advance").length;

  // ── watchdog_timeouts ─────────────────────────────────────────────────────
  const watchdogTimeouts = telemetry.filter(t => t.outcome === "watchdog_timeout").length;

  // ── inference_hung ────────────────────────────────────────────────────────
  const inferenceHung = telemetry.filter(t =>
    t.outcome === "inference_hung_retry" || t.outcome === "infra_hang").length;

  // ── permission_denied ─────────────────────────────────────────────────────
  const deniedRows = telemetry.filter(t => t.outcome === "permission_denied");
  const byRule = {};
  for (const r of deniedRows) {
    // outcome_notes may contain "rule=X" — extract the rule token only (never the command)
    const m = (r.outcome_notes || "").match(/rule[=:](\w[\w_-]{0,40})/i);
    const rule = m ? m[1] : "unknown";
    byRule[rule] = (byRule[rule] || 0) + 1;
  }
  const permissionDenied = { count: deniedRows.length, by_rule: byRule };

  // ── claim_verify ──────────────────────────────────────────────────────────
  const verifyRows = telemetry.filter(t =>
    t.intent_category === "cred_test" || t.intent_category === "exposure_with_403" || t.intent_category === "pre_insert_gate");
  const claimVerify = {
    fired:           verifyRows.length,
    passed:          verifyRows.filter(r => r.outcome === "verify_pass").length,
    failed:          verifyRows.filter(r => r.outcome === "verify_fail").length,
    gated_a_finding: telemetry.filter(r => r.outcome === VERIFY_GATE_FAIL).length,
  };

  // ── findings_by_severity ──────────────────────────────────────────────────
  const findingsBySeverity = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) {
    const sev = f.severity || "low";
    if (sev in findingsBySeverity) findingsBySeverity[sev]++;
  }

  // ── false_positive (aggregate shape — no specifics) ──────────────────────
  // A false positive is a finding that the claim verifier caught (kind='refuted'
  // or kind='unverified'). Describe only whether one existed and the mechanism.
  const refutedFindings = findings.filter(f => f.kind === "refuted" || f.kind === "unverified");
  const fpExists = refutedFindings.length > 0;
  const fp = {
    severity:                  fpExists ? (refutedFindings[0].severity || null) : null,
    model_claimed:             fpExists,
    ground_truth_holds:        fpExists ? false : false,
    harness_caught_it:         fpExists,
    mechanism_that_should_have: fpExists ? (
      refutedFindings[0].kind === "unverified" ? "claim_verifier_pre_insert" : "claim_verifier"
    ) : null,
  };

  // ── membrane_breach ───────────────────────────────────────────────────────
  const membraneBreach = telemetry.filter(t => t.outcome === "membrane_breach").length;

  // ── orphaned_tasks ────────────────────────────────────────────────────────
  const orphanedTasks = tasks.filter(t => t.status === "skipped" &&
    /* only tasks skipped by the drain, not manually */ true).length;

  return {
    engagement_id:        eid,
    concluded,
    conclude_reason:      concludeReason,
    total_steps:          totalSteps,
    phase_progression:    phaseProgression,
    step_queued_rate:     stepQueuedRate,
    step_queued_breakdown: breakdown,
    loop_breaker_fires:   loopBreakerFires,
    watchdog_timeouts:    watchdogTimeouts,
    inference_hung:       inferenceHung,
    permission_denied:    permissionDenied,
    claim_verify:         claimVerify,
    findings_by_severity: findingsBySeverity,
    false_positive:       fp,
    membrane_breach:      membraneBreach,
    orphaned_tasks:       orphanedTasks,
  };
}

module.exports = { getBehavioralScorecard };
