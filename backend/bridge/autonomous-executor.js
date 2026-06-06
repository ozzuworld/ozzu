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

const db = require("/app/db");
const { sendPush } = require("/app/push-notifications");

const AUTO_RUN_PHASES = new Set(["recon", "enumeration"]);
const GATE_PHASES     = new Set(["foothold", "exploitation", "post_exploit", "lateral", "reporting"]);

// Throttle: max 1 phase-advance push per engagement per N seconds.
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

// --- main: called from queueStep after the row is inserted ---
async function maybeAutoExecute(queueItemId) {
  try {
    const r = await db.query(
      `SELECT q.id, q.command, q.engagement_id,
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

    const phase = item.engagement_phase || "recon";
    if (!AUTO_RUN_PHASES.has(phase)) return { autoExecuted: false, reason: `phase=${phase} is gated` };

    // ROE lint runs in BOTH modes but it's most consequential here — we're
    // about to SSH this command to a real target with no human review.
    const hit = roeLint(item.command, item.roe);
    if (hit) {
      // Mark failed with diagnostic so the agent's wait_for_outcome surfaces it.
      // db.withBypass because the diagnostic itself shouldn't trip the membrane
      // write-guard if it quotes the offending pattern.
      await db.withBypass("autonomous_roe_block", (client) => client.query(
        `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
        [`[ROE-BLOCKED — prohibited pattern matched: ${hit}]\n[See engagement.roe.prohibited.]`, item.id]));
      return { autoExecuted: false, reason: "ROE block-list hit", pattern: hit };
    }

    // Mark auto_executed and fire the existing run endpoint internally.
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
      };
    } catch (e) {
      console.error(`[autonomous-executor] run-endpoint call failed for item ${item.id}:`, e.message);
      return { autoExecuted: false, reason: `run endpoint error: ${e.message}` };
    }
  } catch (e) {
    console.error(`[autonomous-executor] maybeAutoExecute crashed:`, e.message);
    return { autoExecuted: false, reason: `internal: ${e.message}` };
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

module.exports = { maybeAutoExecute, onPhaseAdvance, roeLint, AUTO_RUN_PHASES, GATE_PHASES };
