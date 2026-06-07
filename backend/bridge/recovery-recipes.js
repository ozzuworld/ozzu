// recovery-recipes.js — dir_1780845298918
//
// Typed failure scenarios + recovery recipes for the SOC pentest agent loop.
// Ported pattern from claw-code rust/crates/runtime/src/recovery_recipes.rs:
//   - typed enum of recognizable failure shapes
//   - each shape has a recipe: ordered steps + max attempts + escalation policy
//   - per-engagement attempt counter in agent_run_state.recovery_state
//   - escalation = pause + push notification + telemetry alert
//
// Scenarios are SOC-pentest specific (claw's were MCP/worker-boot specific) but
// the structure is faithful.

"use strict";

const FAILURE_SCENARIOS = {
  EXECUTOR_OFFLINE:        "executor_offline",
  CVE_FABRICATION_STREAK:  "cve_fabrication_streak",
  NSE_FABRICATION_STREAK:  "nse_fabrication_streak",
  TARGET_UNREACHABLE:      "target_unreachable",
  PARSE_FAILURE_REPEAT:    "parse_failure_repeat",
  PERMISSION_STREAK:       "permission_streak",
  MODEL_LOOP:              "model_loop",
};

const ESCALATION = {
  ALERT_OPERATOR:  "alert_operator",
  LOG_AND_CONTINUE:"log_and_continue",
  ABORT:           "abort",
};

const RECIPES = {
  [FAILURE_SCENARIOS.EXECUTOR_OFFLINE]: {
    steps: ["pause_engagement", "escalate_to_operator"],
    max_attempts: 1,                      // no auto-recovery — needs physical action
    escalation_policy: ESCALATION.ALERT_OPERATOR,
    reason_template: "Executor (tablet/dev-01) unreachable. Need operator to restore.",
  },
  [FAILURE_SCENARIOS.CVE_FABRICATION_STREAK]: {
    steps: ["inject_mentor_guidance", "require_verify_cve"],
    max_attempts: 3,
    escalation_policy: ESCALATION.ALERT_OPERATOR,
    reason_template: "Model fabricated CVE IDs in 3+ consecutive proposals. Capability gap or wrong target product.",
  },
  [FAILURE_SCENARIOS.NSE_FABRICATION_STREAK]: {
    steps: ["inject_mentor_guidance"],
    max_attempts: 3,
    escalation_policy: ESCALATION.LOG_AND_CONTINUE,
    reason_template: "Model proposed non-existent NSE script names in 3+ rows. NSE catalog hint should land.",
  },
  [FAILURE_SCENARIOS.TARGET_UNREACHABLE]: {
    steps: ["skip_target", "inject_mentor_guidance"],
    max_attempts: 3,
    escalation_policy: ESCALATION.LOG_AND_CONTINUE,
    reason_template: "Target host reachable from neither dev-01 nor tablet. Likely topology issue or firewall.",
  },
  [FAILURE_SCENARIOS.PARSE_FAILURE_REPEAT]: {
    steps: ["inject_mentor_guidance"],
    max_attempts: 5,
    escalation_policy: ESCALATION.ALERT_OPERATOR,
    reason_template: "Reflector tripped 5+ times — model can't produce structured output even with correction. Suggests model degradation or prompt damage.",
  },
  [FAILURE_SCENARIOS.PERMISSION_STREAK]: {
    steps: ["inject_mentor_guidance"],
    max_attempts: 3,
    escalation_policy: ESCALATION.LOG_AND_CONTINUE,
    reason_template: "Model keeps proposing intent_class above current permission_mode ceiling. Either operator should escalate mode or model needs context refresh.",
  },
  [FAILURE_SCENARIOS.MODEL_LOOP]: {
    steps: ["inject_mentor_guidance", "force_intent_class"],
    max_attempts: 5,
    escalation_policy: ESCALATION.ALERT_OPERATOR,
    reason_template: "Mentor fired 5+ times with no measurable progress. Likely gravity-locked on a dead lead.",
  },
};

// ── Detection ─────────────────────────────────────────────────────────────
//
// detectFailureScenario({telemetry, queueItems, mentorFires}) returns the
// FIRST matching scenario (by detection priority) or null. Each scenario has
// its own signature in recent state.

function detectFailureScenario({ telemetry = [], queueItems = [], mentorFires = 0 } = {}) {
  // 1. Executor offline: last 2 queue items both failed with "device offline" / "no such device"
  const lastTwo = queueItems.slice(-2);
  const offlineRe = /(device offline|no such device|connection refused|operation timed out)/i;
  if (lastTwo.length >= 2 && lastTwo.every(q => offlineRe.test(String(q.output || "")))) {
    return {
      scenario: FAILURE_SCENARIOS.EXECUTOR_OFFLINE,
      evidence: lastTwo.map(q => `q#${q.id}: ${String(q.output || "").slice(0, 100)}`).join(" | "),
    };
  }

  // 2-3. Fabrication streaks: 3+ telemetry rows with outcome auto_cve_not_found / auto_nse_not_found in a row
  const lastTel = telemetry.slice(-3);
  if (lastTel.length >= 3 && lastTel.every(t => t.outcome === "auto_cve_not_found" || t.outcome === "auto_cve_affected_mismatch")) {
    return {
      scenario: FAILURE_SCENARIOS.CVE_FABRICATION_STREAK,
      evidence: lastTel.map(t => t.outcome_notes || t.outcome).join(" | "),
    };
  }
  if (lastTel.length >= 3 && lastTel.every(t => t.outcome === "auto_nse_not_found")) {
    return {
      scenario: FAILURE_SCENARIOS.NSE_FABRICATION_STREAK,
      evidence: lastTel.map(t => t.outcome_notes || t.outcome).join(" | "),
    };
  }

  // 4. Target unreachable: 3+ queue items targeting same host all failed with timeout/no-route
  const unreachRe = /(no route to host|Network is unreachable|host is down|connect timed out|timeout)/i;
  const hostMap = {};
  for (const q of queueItems.slice(-10)) {
    if (q.status !== "failed") continue;
    if (!unreachRe.test(String(q.output || ""))) continue;
    const ipMatch = String(q.command || "").match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    if (!ipMatch) continue;
    hostMap[ipMatch[0]] = (hostMap[ipMatch[0]] || 0) + 1;
  }
  for (const [host, count] of Object.entries(hostMap)) {
    if (count >= 3) {
      return {
        scenario: FAILURE_SCENARIOS.TARGET_UNREACHABLE,
        evidence: `host ${host} unreachable in ${count} attempts`,
        host,
      };
    }
  }

  // 5. Parse failure repeat: 3+ reflector_invoked rows recently (NOT consecutive — just recent count)
  const recentReflector = telemetry.slice(-10).filter(t => t.outcome === "reflector_invoked").length;
  if (recentReflector >= 3) {
    return {
      scenario: FAILURE_SCENARIOS.PARSE_FAILURE_REPEAT,
      evidence: `${recentReflector} reflector invocations in last 10 telemetry rows`,
    };
  }

  // 6. Permission streak: 3+ permission_denied in a row
  if (lastTel.length >= 3 && lastTel.every(t => t.outcome === "permission_denied")) {
    return {
      scenario: FAILURE_SCENARIOS.PERMISSION_STREAK,
      evidence: lastTel.map(t => t.outcome_notes).join(" | "),
    };
  }

  // 7. Model loop: Mentor fires from caller signal
  if (mentorFires >= 5) {
    return {
      scenario: FAILURE_SCENARIOS.MODEL_LOOP,
      evidence: `mentor fired ${mentorFires} times this run`,
    };
  }

  return null;
}

// ── Application ───────────────────────────────────────────────────────────
//
// applyRecovery(db, engagement, hit) returns:
//   {applied_steps: [], attempts: N, escalated: bool, recovery_meta: {...}}
// Mutates engagement.agent_run_state.recovery_state in the DB.

async function applyRecovery(db, engagement, hit) {
  if (!hit || !hit.scenario) return null;
  const recipe = RECIPES[hit.scenario];
  if (!recipe) return null;

  const state = (engagement.agent_run_state && engagement.agent_run_state.recovery_state) || {};
  const existing = state[hit.scenario] || { attempts: 0, last_attempt_at: null, last_evidence: null };
  const nowIso = new Date().toISOString();
  const attempts = existing.attempts + 1;
  const escalate = attempts > recipe.max_attempts;

  const appliedSteps = [];
  let mentorHint = null;
  let intentForce = null;
  let skipHostTarget = null;

  if (!escalate) {
    for (const step of recipe.steps) {
      switch (step) {
        case "inject_mentor_guidance":
          mentorHint = recipe.reason_template + ` (recovery attempt ${attempts}/${recipe.max_attempts})`;
          appliedSteps.push({ step: "inject_mentor_guidance", hint: mentorHint });
          break;
        case "require_verify_cve":
          // Surface as a hint; preflight will pick up
          appliedSteps.push({ step: "require_verify_cve" });
          break;
        case "skip_target":
          skipHostTarget = hit.host || null;
          appliedSteps.push({ step: "skip_target", host: skipHostTarget });
          break;
        case "force_intent_class":
          intentForce = "recon";
          appliedSteps.push({ step: "force_intent_class", intent: intentForce });
          break;
        case "pause_engagement":
        case "escalate_to_operator":
          // these steps are for the escalation path; ignore in normal recovery
          break;
        default:
          appliedSteps.push({ step });
      }
    }
  }

  // Persist counter + last evidence
  try {
    const updated = { ...state, [hit.scenario]: { attempts, last_attempt_at: nowIso, last_evidence: hit.evidence, escalated: escalate } };
    await db.query(
      `UPDATE pentest_engagements
          SET agent_run_state = COALESCE(agent_run_state, '{}'::jsonb)
                              || jsonb_build_object('recovery_state', $2::jsonb)
        WHERE id = $1`,
      [engagement.id, JSON.stringify(updated)]);
  } catch (_) {}

  // Escalation: pause + telemetry
  if (escalate) {
    try {
      await db.query(
        `UPDATE pentest_engagements SET autonomous_paused = true WHERE id = $1`,
        [engagement.id]);
    } catch (_) {}
    appliedSteps.push({ step: "pause_engagement" });
    appliedSteps.push({ step: "escalate_to_operator", reason: recipe.reason_template });
  }

  // Telemetry row
  try {
    await db.query(
      `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
       VALUES ($1, NULL, 'recovery', $2, 0, 0, false, true, 0, 0, $3, $4)`,
      [engagement.id, hit.scenario,
       escalate ? "recovery_escalated" : "recovery_applied",
       `attempts=${attempts}/${recipe.max_attempts}; evidence=${(hit.evidence || "").slice(0, 200)}; steps=${appliedSteps.map(s => s.step).join(",")}`]);
  } catch (_) {}

  return {
    scenario: hit.scenario,
    evidence: hit.evidence,
    attempts,
    max_attempts: recipe.max_attempts,
    escalated: escalate,
    applied_steps: appliedSteps,
    mentor_hint: mentorHint,
    force_intent_class: intentForce,
    skip_host: skipHostTarget,
    escalation_policy: recipe.escalation_policy,
  };
}

// Inspector for the MCP tool.
async function getRecoveryState(db, engagementId) {
  try {
    const r = await db.query(
      `SELECT id, autonomous_paused, agent_run_state->'recovery_state' AS recovery_state
         FROM pentest_engagements WHERE id = $1`,
      [engagementId]);
    if (r.rows.length === 0) return null;
    return { id: r.rows[0].id, paused: r.rows[0].autonomous_paused, recovery_state: r.rows[0].recovery_state || {} };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  FAILURE_SCENARIOS,
  ESCALATION,
  RECIPES,
  detectFailureScenario,
  applyRecovery,
  getRecoveryState,
};
