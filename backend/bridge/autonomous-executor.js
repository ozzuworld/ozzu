// autonomous-executor.js — dir_1780784224487
//
// Phase-gated autonomous execution. Model self-runs recon/enumeration steps;
// only foothold / post_exploit / lateral / exploitation queue as pending for
// human approval. Phase-advance into a gated phase fires a push notification
// to King Kazuma's iPhone (throttled).
//
// See feedback_soc_observer_role.md for the role boundary: Cipher does NOT
// trigger autonomous execution — it's the L3 model's queueStep call that
// triggers it. Cipher only observes the result via telemetry.

"use strict";

const fs = require("fs");
const path = require("path");
const db = require("/app/db");
const { sendPush } = require("/app/push-notifications");

const AUTO_RUN_PHASES = new Set(["recon", "enumeration"]);
const GATE_PHASES     = new Set(["foothold", "exploitation", "post_exploit", "lateral", "reporting"]);

// Step-level intent classifier (dir_1780784990563). Replaces phase-only gating
// with per-step intent + content-lint verification.
const AUTO_RUN_INTENTS = new Set(["recon", "enum", "banner_grab", "service_version", "tool_setup"]);
const GATE_INTENTS     = new Set(["cred_test", "exploit_probe", "lateral", "post_exploit"]);
const VALID_INTENTS    = new Set([...AUTO_RUN_INTENTS, ...GATE_INTENTS]);

// Hot-reloadable intent rules. Loaded once, refreshed on file mtime change.
let _rulesCache = { mtime: 0, rules: [] };
function loadIntentRules() {
  const p = "/app/lint/intent-rules.json";
  try {
    const st = fs.statSync(p);
    if (st.mtimeMs !== _rulesCache.mtime) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      _rulesCache = {
        mtime: st.mtimeMs,
        rules: (Array.isArray(j.rules) ? j.rules : []).map(r => ({
          intent: r.intent,
          patterns: (Array.isArray(r.patterns) ? r.patterns : []).map(s => {
            try { return new RegExp(s); } catch (_) { return null; }
          }).filter(Boolean),
        })),
      };
    }
  } catch (e) {
    // Don't crash if the rules file is missing — fall back to empty (no inference).
    if (_rulesCache.rules.length === 0) _rulesCache = { mtime: 0, rules: [] };
  }
  return _rulesCache.rules;
}

// inferIntentFromCommand: scan the command string against the rules dictionary.
// Returns the FIRST matching intent. The rules file ORDERS most-specific →
// least-specific so e.g. `cred_test` regex wins over `enum` regex on a
// `hydra` command. Returns null when nothing matches.
function inferIntentFromCommand(command) {
  if (!command || typeof command !== "string") return null;
  const rules = loadIntentRules();
  for (const r of rules) {
    for (const re of r.patterns) {
      if (re.test(command)) return r.intent;
    }
  }
  return null;
}

// Throttle: max 1 push per engagement per N seconds (any cause).
const PHASE_PUSH_THROTTLE_SEC = 300;

// --- ROE block-list lint ---
// Cheap regex pass on the command string. Patterns come from the engagement's
// roe.prohibited[] array. Each entry is treated as a case-insensitive substring
// match by default; entries prefixed `re:` are treated as regex.
function roeLint(command, roe) {
  if (!roe || !command) return null;
  const prohibited = Array.isArray(roe.prohibited) ? roe.prohibited :
                    (roe.prohibited ? [roe.prohibited] : []);
  if (prohibited.length === 0) return null;
  const cmd = String(command).toLowerCase();
  for (const p of prohibited) {
    if (typeof p !== "string") continue;
    if (p.startsWith("re:")) {
      try {
        const re = new RegExp(p.slice(3), "i");
        if (re.test(command)) return p;
      } catch (_) { /* invalid regex — skip */ }
    } else {
      // Substring match on hint phrases. Match against keywords from the
      // prohibited line — too literal a match misses "Factory data reset"
      // when the prohibited line is "factory reset, firmware wipe, ...".
      const keywords = p.toLowerCase().split(/[,/(){}\[\]]+/).map(s => s.trim()).filter(Boolean);
      for (const kw of keywords) {
        if (kw.length < 4) continue; // skip noise words
        if (cmd.includes(kw)) return `${p} (matched: "${kw}")`;
      }
    }
  }
  return null;
}

// Log mismatch + write diagnostic to queue row. Membrane bypass since the
// diagnostic may quote the offending command.
async function recordIntentMismatch(engagementId, itemId, claimed, inferred, command) {
  try {
    await db.query(
      `INSERT INTO offense_telemetry
         (engagement_id, queue_item_id, model_used, intent_category,
          n_hosts, n_findings, step_queued, in_scope, n_references,
          latency_ms, outcome, outcome_notes, error_message)
       VALUES ($1, $2, 'lint', $3, 0, 0, true, true, 0, 0,
               'intent_mismatch', $4, NULL)`,
      [engagementId, itemId, claimed || "(none)",
       `claimed=${claimed || "(none)"}, inferred=${inferred}`]);
  } catch (_) { /* telemetry never breaks gating */ }
  try {
    await db.withBypass("intent_mismatch_diag", (client) => client.query(
      `UPDATE soc_queue_items
          SET output = COALESCE(output, '') ||
                       '[INTENT_MISMATCH dir_1780784990563] declared=' || $1 ||
                       ' but command content suggests=' || $2 ||
                       '. Gated — human review required.'
        WHERE id = $3`,
      [claimed || "(none)", inferred, itemId]));
  } catch (e) {
    console.error(`[autonomous-executor] mismatch diag write failed:`, e.message);
  }
}

// --- main: called from queueStep after the row is inserted ---
async function maybeAutoExecute(queueItemId, opts = {}) {
  try {
    const r = await db.query(
      `SELECT q.id, q.command, q.engagement_id, q.intent_class,
              e.autonomous_execution_enabled, e.autonomous_paused,
              e.engagement_phase, e.roe
         FROM soc_queue_items q
         JOIN pentest_engagements e ON q.engagement_id = e.id
        WHERE q.id = $1`,
      [queueItemId]);
    if (r.rows.length === 0) return { autoExecuted: false, reason: "queue item not found" };
    const item = r.rows[0];

    if (!item.autonomous_execution_enabled) return { autoExecuted: false, reason: "engagement opt-out" };
    if (item.autonomous_paused)              return { autoExecuted: false, reason: "engagement paused" };

    // ROE block-list lint always runs first. ROE-prohibited wins everything.
    const roeHit = roeLint(item.command, item.roe);
    if (roeHit) {
      await db.withBypass("autonomous_roe_block", (client) => client.query(
        `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
        [`[ROE-BLOCKED — prohibited pattern matched: ${roeHit}]\n[See engagement.roe.prohibited.]`, item.id]));
      return { autoExecuted: false, reason: "ROE block-list hit", pattern: roeHit };
    }

    // Step-level intent classifier (dir_1780784990563).
    // 1) Model must declare intent_class. NULL = gated (safe default).
    // 2) Harness infers an intent from the command content.
    // 3) MISMATCH gates regardless. Mismatch is itself a training signal logged
    //    to offense_telemetry as outcome='intent_mismatch'.
    // 4) If declared+inferred agree AND intent is in AUTO_RUN_INTENTS → auto-run.
    // 5) Otherwise gate. If gated intent → fire push (throttled).
    const claimed = item.intent_class;
    const inferred = inferIntentFromCommand(item.command);

    if (!claimed) {
      return { autoExecuted: false, reason: "intent_class not declared by model — gated as safe default" };
    }
    if (!VALID_INTENTS.has(claimed)) {
      await recordIntentMismatch(item.engagement_id, item.id, claimed, inferred || "(none)", item.command);
      return { autoExecuted: false, reason: `intent_class=${claimed} not in enum — gated`, inferred };
    }
    // Mismatch check: if we COULD infer an intent and it disagrees with the
    // claimed one AND one of them is gated, that's a mismatch. (If both are in
    // AUTO_RUN_INTENTS we treat it as harmless — e.g. claimed=enum, inferred=
    // banner_grab is a labeling nuance, not a safety risk.)
    if (inferred && inferred !== claimed) {
      const oneIsGated = GATE_INTENTS.has(claimed) || GATE_INTENTS.has(inferred);
      if (oneIsGated) {
        await recordIntentMismatch(item.engagement_id, item.id, claimed, inferred, item.command);
        // Push iff inferred is gated — the model TRIED to slip something past.
        if (GATE_INTENTS.has(inferred)) {
          await pushOnGatedIntent(item.engagement_id, item.id, `mismatch(${claimed}→${inferred})`, item.command);
        }
        return { autoExecuted: false, reason: `intent_mismatch claimed=${claimed} inferred=${inferred}` };
      }
    }
    if (!AUTO_RUN_INTENTS.has(claimed)) {
      // Honestly-declared gated intent — pending row + push.
      await pushOnGatedIntent(item.engagement_id, item.id, claimed, item.command);
      return { autoExecuted: false, reason: `intent=${claimed} is gated — pending human approval`, inferred };
    }

    // All checks passed — auto-execute.
    await db.query(`UPDATE soc_queue_items SET auto_executed=true WHERE id=$1`, [item.id]);

    const apiKey = process.env.BRIDGE_API_KEY || "";
    try {
      const resp = await fetch(`http://localhost:3333/soc/queue/${item.id}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const okBody = resp.ok ? await resp.json().catch(() => null) : null;
      return {
        autoExecuted: resp.ok,
        reason: resp.ok ? "ssh-spawned" : `run endpoint returned ${resp.status}`,
        session_id: okBody && okBody.session_id,
        inferred,
      };
    } catch (e) {
      console.error(`[autonomous-executor] run-endpoint call failed for item ${item.id}:`, e.message);
      return { autoExecuted: false, reason: `run endpoint error: ${e.message}`, inferred };
    }
  } catch (e) {
    console.error(`[autonomous-executor] maybeAutoExecute crashed:`, e.message);
    return { autoExecuted: false, reason: `internal: ${e.message}` };
  }
}

// Push when a GATED intent is queued (replaces dir_1780784224487's phase-advance
// push). Throttled per engagement.
async function pushOnGatedIntent(engagementId, itemId, intentLabel, command) {
  try {
    const eg = await db.query(
      `SELECT autonomous_execution_enabled, last_phase_advance_push_at FROM pentest_engagements WHERE id=$1`,
      [engagementId]);
    if (eg.rows.length === 0) return { pushed: false, reason: "engagement not found" };
    if (!eg.rows[0].autonomous_execution_enabled) return { pushed: false, reason: "engagement opt-out" };
    const lastPush = eg.rows[0].last_phase_advance_push_at;
    if (lastPush) {
      const ageSec = (Date.now() - new Date(lastPush).getTime()) / 1000;
      if (ageSec < PHASE_PUSH_THROTTLE_SEC) return { pushed: false, reason: `throttled — ${Math.round(ageSec)}s` };
    }
    const tk = await db.query(`SELECT token FROM device_push_tokens WHERE token IS NOT NULL`);
    const tokens = tk.rows.map(r => r.token).filter(Boolean);
    if (tokens.length === 0) return { pushed: false, reason: "no push tokens" };
    const result = await sendPush(tokens, {
      title: `${engagementId} — ${intentLabel} queued`,
      body:  `Model proposed a ${intentLabel} step. Review + approve in app.`,
      data:  { engagement_id: engagementId, queue_item_id: itemId, kind: "gated_intent", intent: intentLabel },
      priority: "high",
    });
    await db.query(`UPDATE pentest_engagements SET last_phase_advance_push_at = NOW() WHERE id=$1`, [engagementId]);
    return { pushed: true, sent: result.sent, errors: result.errors, tokens: tokens.length };
  } catch (e) {
    console.error(`[autonomous-executor] pushOnGatedIntent crashed:`, e.message);
    return { pushed: false, reason: `internal: ${e.message}` };
  }
}

// --- phase-advance hook ---
// Called from offense-agent-tools.js advancePhase (after the UPDATE lands).
// Pushes a notification iff the new phase is gated AND the previous phase
// was auto-run (= we're crossing the human-attention boundary), AND we
// haven't already pushed within PHASE_PUSH_THROTTLE_SEC.
async function onPhaseAdvance(engagementId, oldPhase, newPhase) {
  try {
    if (!GATE_PHASES.has(newPhase))    return { pushed: false, reason: "new phase not gated" };
    if (!AUTO_RUN_PHASES.has(oldPhase)) return { pushed: false, reason: "old phase not auto-run — not crossing boundary" };

    // Engagement flag — if autonomous isn't enabled, we never pushed for it
    // before, and we don't owe a notification now (legacy gated-everywhere mode).
    const eg = await db.query(
      `SELECT autonomous_execution_enabled, last_phase_advance_push_at FROM pentest_engagements WHERE id=$1`,
      [engagementId]);
    if (eg.rows.length === 0) return { pushed: false, reason: "engagement not found" };
    if (!eg.rows[0].autonomous_execution_enabled) return { pushed: false, reason: "engagement opt-out" };

    const lastPush = eg.rows[0].last_phase_advance_push_at;
    if (lastPush) {
      const ageSec = (Date.now() - new Date(lastPush).getTime()) / 1000;
      if (ageSec < PHASE_PUSH_THROTTLE_SEC) {
        return { pushed: false, reason: `throttled — last push ${Math.round(ageSec)}s ago` };
      }
    }

    // Pull all push tokens. INVENTORY says device_push_tokens table is the source.
    const tk = await db.query(`SELECT token FROM device_push_tokens WHERE token IS NOT NULL`);
    const tokens = tk.rows.map(r => r.token).filter(Boolean);
    if (tokens.length === 0) return { pushed: false, reason: "no push tokens" };

    const result = await sendPush(tokens, {
      title: `${engagementId} → ${newPhase}`,
      body:  `Model advanced to ${newPhase}. First gated step queued — approve in app.`,
      data:  { engagement_id: engagementId, kind: "phase_advance", from: oldPhase, to: newPhase },
      priority: "high",
    });

    await db.query(
      `UPDATE pentest_engagements SET last_phase_advance_push_at = NOW() WHERE id=$1`,
      [engagementId]);

    return { pushed: true, sent: result.sent, errors: result.errors, tokens: tokens.length };
  } catch (e) {
    console.error(`[autonomous-executor] onPhaseAdvance crashed:`, e.message);
    return { pushed: false, reason: `internal: ${e.message}` };
  }
}

module.exports = {
  maybeAutoExecute,
  onPhaseAdvance,
  pushOnGatedIntent,
  roeLint,
  inferIntentFromCommand,
  AUTO_RUN_PHASES,
  GATE_PHASES,
  AUTO_RUN_INTENTS,
  GATE_INTENTS,
  VALID_INTENTS,
};
