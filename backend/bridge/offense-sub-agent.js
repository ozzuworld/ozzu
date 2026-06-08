// offense-sub-agent.js — dir_1780848098817
//
// Per-target sub-agent runner. Modeled on offense-agent.js's runAgent loop
// but scoped to ONE target_host. Independent mentor counter, recovery state,
// permission_mode override, and workspace scope.
//
// Coordinator (the engagement-level runAgent loop) spawns these via
// spawnSubAgent() and reads their status/findings to decide whether to
// terminate, re-prompt, or spawn additional sub-agents.

"use strict";

const db = require("./db");
const orchestrator = require("./offense-orchestrator");
const aggregator = require("./offense-aggregator");

// ── Lifecycle helpers ────────────────────────────────────────────────────

async function spawnSubAgent({
  engagement_id,
  target_host,
  target_role,
  objective,
  permission_mode_override,
  scope_targets_override,
  spawned_by,
  spawned_reason,
  max_iter,
}) {
  if (!engagement_id) return { error: "engagement_id required" };
  if (!target_host || typeof target_host !== "string") return { error: "target_host required" };
  // Default scope: just this target_host
  const scopeOverride = Array.isArray(scope_targets_override) && scope_targets_override.length > 0
    ? scope_targets_override
    : [target_host];
  const r = await db.query(
    `INSERT INTO engagement_sub_agents
       (engagement_id, target_host, target_role, status, max_iter,
        objective, permission_mode_override, scope_targets_override,
        spawned_by, spawned_reason)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9)
     RETURNING id, engagement_id, target_host, target_role, status, max_iter,
               objective, permission_mode_override, scope_targets_override,
               spawned_by, spawned_reason, created_at`,
    [engagement_id, target_host, target_role || null,
     max_iter || 20, objective || null,
     permission_mode_override || null, scopeOverride,
     spawned_by || "operator", spawned_reason || null]);
  const sub = r.rows[0];
  // Fire-and-forget the runner; coordinator can poll status
  setImmediate(() => {
    runSubAgent(sub.id).catch(e => console.error(`[sub-agent ${sub.id}] runner crashed:`, e.message));
  });
  return sub;
}

async function terminateSubAgent(subAgentId, reason) {
  const r = await db.query(
    `UPDATE engagement_sub_agents
        SET status = 'terminated',
            completed_at = NOW(),
            agent_run_state = COALESCE(agent_run_state, '{}'::jsonb)
                            || jsonb_build_object('terminated_reason', $2::text)
      WHERE id = $1 AND status IN ('pending','running','paused')
      RETURNING id, target_host, status`,
    [subAgentId, reason || "manual termination"]);
  return r.rows[0] || null;
}

async function listSubAgents(engagementId) {
  const r = await db.query(
    `SELECT id, engagement_id, target_host, target_role, status, iter, max_iter,
            objective, permission_mode_override,
            spawned_by, spawned_reason, created_at, started_at, completed_at,
            last_action, total_findings, total_queue_items,
            agent_run_state
       FROM engagement_sub_agents
      WHERE engagement_id = $1
      ORDER BY id ASC`,
    [engagementId]);
  return r.rows;
}

async function getSubAgent(subAgentId) {
  const r = await db.query(
    `SELECT * FROM engagement_sub_agents WHERE id = $1`, [subAgentId]);
  return r.rows[0] || null;
}

async function setSubStatus(subId, status, extras) {
  const payload = JSON.stringify({ ...(extras || {}) });
  const setClauses = [
    "status = $1",
    "agent_run_state = COALESCE(agent_run_state, '{}'::jsonb) || $2::jsonb",
    "iter = COALESCE($3::int, iter)",
    "last_action = COALESCE($4::text, last_action)",
  ];
  if (status === "running") setClauses.push("started_at = COALESCE(started_at, NOW())");
  if (["completed", "failed", "terminated"].includes(status)) setClauses.push("completed_at = NOW()");
  await db.query(
    `UPDATE engagement_sub_agents SET ${setClauses.join(", ")} WHERE id = $5`,
    [status, payload, (extras && extras.iter) || null, (extras && extras.last_action) || null, subId]);
}

// ── Context loader (sub-agent-scoped) ─────────────────────────────────────
//
// Loads engagement context BUT narrows scope to this sub-agent's target_host
// and filters recon/findings to this sub-agent's view.

async function loadSubAgentContext(subAgentId) {
  const sub = await getSubAgent(subAgentId);
  if (!sub) return { sub_agent: null };
  const engRes = await db.query(
    `SELECT id, engagement_type, scope, roe, status,
            executor_host, executor_adb_target, executor_tools,
            engagement_phase, agent_run_state, agent_status,
            graph_mode_enabled, permission_mode
       FROM pentest_engagements WHERE id = $1`,
    [sub.engagement_id]);
  if (engRes.rows.length === 0) return { sub_agent: sub, engagement: null };
  const engRow = engRes.rows[0];
  // Apply sub-agent overrides on top of engagement scope/mode
  let scope = engRow.scope;
  try { if (typeof scope === "string") scope = JSON.parse(scope || "{}"); } catch (_) { scope = {}; }
  if (Array.isArray(sub.scope_targets_override) && sub.scope_targets_override.length > 0) {
    scope = { ...scope, targets: sub.scope_targets_override };
  }
  const effectivePermissionMode = sub.permission_mode_override || engRow.permission_mode || "enumeration";
  // Load only this sub-agent's owned data, fall back to coordinator-level when null
  const [hosts, findings, queue] = await Promise.all([
    db.query(
      `SELECT ip, hostname, status, ports FROM recon_hosts
        WHERE engagement_id = $1
          AND (sub_agent_id = $2 OR sub_agent_id IS NULL)
          AND (ip = $3 OR hostname = $3 OR sub_agent_id = $2)
        ORDER BY ip`,
      [sub.engagement_id, sub.id, sub.target_host]),
    db.query(
      `SELECT id, title, severity, status, affected_asset, affected_assets, refs, kind, informed_by, enables
         FROM pentest_findings
        WHERE engagement_id = $1
          AND (sub_agent_id = $2 OR (sub_agent_id IS NULL AND affected_asset = $3))
        ORDER BY discovered_at`,
      [sub.engagement_id, sub.id, sub.target_host]),
    db.query(
      `SELECT seq, title, status, LEFT(COALESCE(command,''),240) AS command_preview, LEFT(COALESCE(output,''),200) AS output_preview
         FROM soc_queue_items
        WHERE engagement_id = $1
          AND sub_agent_id = $2
          AND status IN ('done','failed','cancelled')
        ORDER BY seq DESC LIMIT 10`,
      [sub.engagement_id, sub.id]),
  ]);
  // Build a pseudo-engagement object reflecting overrides
  const subScopedEng = {
    ...engRow,
    scope,
    permission_mode: effectivePermissionMode,
    id: engRow.id,
  };
  return {
    sub_agent: sub,
    engagement: subScopedEng,
    hosts: hosts.rows,
    findings: findings.rows,
    queue: queue.rows,
    // Sub-agent specific context the orchestrator surfaces in its user message
    sub_agent_objective: sub.objective || `Investigate ${sub.target_host}`,
    sub_agent_target_host: sub.target_host,
    sub_agent_target_role: sub.target_role,
  };
}

// ── Main loop ────────────────────────────────────────────────────────────

const SUB_DEFAULT_MAX_ITER = 20;

async function runSubAgent(subAgentId, opts = {}) {
  const modelOverride = (opts && opts.model_override) || null;
  const startMs = Date.now();

  // Initial status flip + record start
  const initialSub = await getSubAgent(subAgentId);
  if (!initialSub) return { sub_agent_id: subAgentId, ok: false, reason: "sub-agent not found" };
  const maxIter = initialSub.max_iter || SUB_DEFAULT_MAX_ITER;
  let iter = initialSub.iter || 0;

  await setSubStatus(subAgentId, "running", {
    iter,
    last_action: "sub_agent_started",
    started_at: new Date().toISOString(),
  });

  let endReason = null;
  let tasksAdded = 0;
  let stepsQueued = 0;

  while (iter < maxIter) {
    iter++;
    // Re-fetch sub-agent status — coordinator may have terminated us
    const liveSub = await getSubAgent(subAgentId);
    if (!liveSub) { endReason = "sub-agent disappeared"; break; }
    if (liveSub.status === "terminated") { endReason = "terminated by coordinator"; break; }
    if (liveSub.status === "paused") { endReason = "paused by coordinator"; break; }

    const ctx = await loadSubAgentContext(subAgentId);
    if (!ctx.engagement) {
      await setSubStatus(subAgentId, "failed", { iter, error: "engagement disappeared" });
      return { sub_agent_id: subAgentId, ok: false, iter, reason: "engagement disappeared" };
    }

    // Mark current iter context with sub_agent_id so downstream inserts get tagged
    ctx._sub_agent_id = subAgentId;
    ctx._sub_agent_objective = ctx.sub_agent_objective;
    ctx._sub_agent_target = ctx.sub_agent_target_host;

    // dir_1780848456715: pick up coordinator reprompt if present
    const subState = (ctx.sub_agent && ctx.sub_agent.agent_run_state) || {};
    if (subState.coordinator_reprompt && subState.coordinator_reprompt_iter && subState.coordinator_reprompt_iter > (subState.last_reprompt_acked || 0)) {
      ctx.mentor_guidance = [
        `=== Coordinator reprompt (from engagement-level orchestrator at coordinator iter ${subState.coordinator_reprompt_iter}) ===`,
        subState.coordinator_reprompt,
        "=== end coordinator reprompt ===",
        "Apply this new objective immediately. Override your prior plan if needed.",
      ].join("\n");
      // Mark as acked so we don't re-inject every iter
      try {
        await db.query(
          `UPDATE engagement_sub_agents
              SET agent_run_state = COALESCE(agent_run_state, '{}'::jsonb)
                                  || jsonb_build_object('last_reprompt_acked', $2::int)
            WHERE id = $1`,
          [subAgentId, subState.coordinator_reprompt_iter]);
      } catch (_) {}
    }

    // (1) Orchestrator decides
    let decision;
    try {
      decision = await orchestrator.decide(ctx, modelOverride);
    } catch (e) {
      await setSubStatus(subAgentId, "failed", { iter, error: e.message });
      return { sub_agent_id: subAgentId, ok: false, iter, reason: `orchestrator failed: ${e.message}` };
    }

    // (2) Add tasks (sub-agent-scoped)
    if (Array.isArray(decision.add) && decision.add.length) {
      for (const t of decision.add) {
        try {
          const r = await db.query(
            `INSERT INTO engagement_tasks
               (engagement_id, parent_ids, directive, phase, prerequisites, status)
             VALUES ($1, $2::int[], $3, $4, $5, 'pending')
             RETURNING id`,
            [ctx.engagement.id,
             Array.isArray(t.parent_ids) ? t.parent_ids.filter(Number.isInteger) : [],
             (t.directive || "").slice(0, 1000),
             (typeof t.phase === "string" && t.phase) ? t.phase.trim() : null,
             (typeof t.prerequisites === "string") ? t.prerequisites.trim() : null]);
          if (r.rows[0]) tasksAdded++;
        } catch (_) {}
      }
    }

    // (3) Phase advance is allowed only at the coordinator level — sub-agents
    // observe but don't change engagement phase.
    if (decision.advance_phase) {
      console.log(`[sub-agent ${subAgentId}] orchestrator proposed phase advance — sub-agents may not change engagement phase; ignoring`);
    }

    // (4) End condition
    if (decision.end) {
      endReason = decision.end;
      break;
    }

    // (5) No selection → continue (might add tasks next iter)
    if (decision.select == null) {
      await setSubStatus(subAgentId, "running", { iter, tasks_added: tasksAdded, last_action: "no_select" });
      continue;
    }

    // (6) Load selected task
    const taskRow = await db.query(
      `SELECT id, directive, phase, prerequisites, parent_ids, status
         FROM engagement_tasks WHERE id = $1 AND engagement_id = $2`,
      [decision.select, ctx.engagement.id]);
    if (taskRow.rows.length === 0) {
      console.error(`[sub-agent ${subAgentId}] orchestrator selected nonexistent task ${decision.select}`);
      continue;
    }
    const task = taskRow.rows[0];
    if (task.status !== "pending") continue;
    await orchestrator.markInFlight(task.id, iter);

    // (7) Synthesizer — reuse the main agent's synthesizer via a thin re-export
    let step;
    try {
      const agentMod = require("/app/offense-agent");
      step = await agentMod.__synthesizeCommandForSubAgent
        ? await agentMod.__synthesizeCommandForSubAgent(task, ctx, modelOverride)
        : await defaultSynthesize(task, ctx, modelOverride);
    } catch (e) {
      await orchestrator.completeTask(task.id, "failed", `synthesizer error: ${e.message}`);
      continue;
    }
    if (!step || !step.command) {
      await orchestrator.completeTask(task.id, "failed", "synthesizer produced no command");
      continue;
    }

    // (8) Insert queue item with sub_agent_id tag — dir_1780946011445: match the
    // main agent's pattern (offense-agent-tools.js:100-116). Sub-agent's prior
    // minimal insert was missing seq (NOT NULL) → ran 20 iters/sub w/ 0 commands
    // queued, coordinator had no signal → re-spawned redundant batches.
    let queueId;
    try {
      const { wrapForExecutor } = require("/app/offense-agent-tools");
      const seqRow = await db.query(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM soc_queue_items WHERE engagement_id = $1`,
        [ctx.engagement.id]);
      const seq = seqRow.rows[0].next;
      const wrappedCommand = wrapForExecutor(step.command, ctx.engagement);
      const title = `[sub${subAgentId}/${ctx.sub_agent_target_host}] ${(task.directive || "").slice(0, 80)}`;
      const ins = await db.withBypass("offense_agent_tool", (client) => client.query(
        `INSERT INTO soc_queue_items
           (engagement_id, sub_agent_id, seq, title, description, command, expected_artifact,
            status, intent_class, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, 'pending', $7, NOW())
         RETURNING id`,
        [ctx.engagement.id, subAgentId, seq, title, wrappedCommand,
         step.expected_artifact || null,
         step.intent_class || "recon"]));
      queueId = ins.rows[0].id;
      stepsQueued++;
    } catch (e) {
      await orchestrator.completeTask(task.id, "failed", `queue insert failed: ${e.message}`);
      continue;
    }

    // (9) Dispatch to autonomous-executor (same as parent agent — sub-agent
    // doesn't bypass any gates)
    try {
      const ae = require("/app/autonomous-executor");
      await ae.maybeAutoExecute(queueId);
    } catch (e) {
      console.error(`[sub-agent ${subAgentId}] maybeAutoExecute error:`, e.message);
    }

    // (10) Wait for queue item to terminate (poll)
    const outcome = await waitForQueueItem(queueId, 600 * 1000);

    // (11) Aggregate the result back into findings/hosts (aggregator tags with sub_agent_id via ctx)
    try {
      await aggregator.fold(ctx.engagement.id, task.directive, step.expected_artifact, outcome.output || "", modelOverride);
    } catch (e) {
      console.error(`[sub-agent ${subAgentId}] aggregator error:`, e.message);
    }
    await orchestrator.completeTask(task.id, outcome.status === "done" ? "done" : "failed",
      `q#${queueId} ${outcome.status}`);

    // (12) Update sub-agent stats
    try {
      const findingCount = await db.query(
        `SELECT COUNT(*)::int AS c FROM pentest_findings WHERE sub_agent_id = $1`, [subAgentId]);
      await db.query(
        `UPDATE engagement_sub_agents
            SET iter = $2,
                last_action = $3,
                total_findings = $4,
                total_queue_items = COALESCE(total_queue_items, 0) + 1
          WHERE id = $1`,
        [subAgentId, iter,
         `q#${queueId} ${outcome.status} on ${ctx.sub_agent_target_host}`,
         findingCount.rows[0].c]);
    } catch (_) {}
  }

  // Termination
  const finalStatus = endReason ? (endReason.startsWith("terminated") ? "terminated" : "completed") : "completed";
  await setSubStatus(subAgentId, finalStatus, {
    iter,
    end_reason: endReason || "max_iter_reached",
    last_action: "sub_agent_finished",
    elapsed_sec: Math.round((Date.now()-startMs)/1000),
  });
  return {
    sub_agent_id: subAgentId,
    ok: finalStatus === "completed",
    iter,
    end_reason: endReason || "max_iter_reached",
    tasks_added: tasksAdded,
    steps_queued: stepsQueued,
    elapsed_sec: Math.round((Date.now()-startMs)/1000),
  };
}

async function waitForQueueItem(queueId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await db.query(
      `SELECT status, LEFT(COALESCE(output,''),16000) AS output FROM soc_queue_items WHERE id = $1`, [queueId]);
    const row = r.rows[0];
    if (!row) return { status: "missing", output: "" };
    if (row.status === "done" || row.status === "failed" || row.status === "cancelled") return row;
    await new Promise(rs => setTimeout(rs, 2000));
  }
  return { status: "timeout", output: "[timed out waiting for queue item]" };
}

// Fallback synthesizer when offense-agent doesn't export __synthesizeCommandForSubAgent.
async function defaultSynthesize(task, ctx, modelOverride) {
  const agentMod = require("/app/offense-agent");
  if (typeof agentMod.synthesizeCommand === "function") {
    return await agentMod.synthesizeCommand(task, ctx, modelOverride);
  }
  return { command: null, intent_class: "recon" };
}

module.exports = {
  spawnSubAgent,
  terminateSubAgent,
  listSubAgents,
  getSubAgent,
  runSubAgent,
  loadSubAgentContext,
};
