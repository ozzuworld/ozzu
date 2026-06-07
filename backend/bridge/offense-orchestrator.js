"use strict";
// offense-orchestrator.js — Step 8 of OFFENSE-AGENT-DESIGN.md (dir_1780594102051)
//
// The xOffense pattern's Task Orchestrator. Given the engagement's full state
// and the current Task Coordination Graph (DAG of engagement_tasks), the model
// selects the NEXT unblocked task to execute — or proposes new tasks/edges to
// extend the DAG when the existing graph is exhausted.
//
// Orchestrator NEVER produces commands. It produces task *directives*
// (high-level "what to do" descriptions) that the Command Synthesizer
// (offense-engine.js Step 3 GENERATION prompt) translates into shell commands.
//
// Membrane: Orchestrator's prompt holds full engagement context but its
// output is structured JSON (task directives, not commands). The structured
// output is what the rest of the loop consumes.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const db = require("./db");

const MODEL_URL  = process.env.OFFENSE_MODEL_URL  || "http://127.0.0.1:11434/v1";
const MODEL_NAME = process.env.OFFENSE_MODEL_NAME || "qwen3:32b";
const MODEL_KEY  = process.env.OFFENSE_MODEL_KEY  || "";

const ORCHESTRATOR_SYSTEM_PROMPT = [
  "You are the TASK ORCHESTRATOR of an offensive-research multi-agent system for an AUTHORIZED penetration test.",
  "",
  "You receive: (a) engagement scope/ROE + structured state (hosts, findings), (b) the current Task Coordination Graph (DAG of tasks with their status + outcome summaries), (c) the current engagement phase.",
  "",
  "Your job: pick the SINGLE next task to execute, OR add new tasks to the graph.",
  "  - An unblocked pending task (all parents done/skipped) is eligible for execution.",
  "  - If a useful pending task exists, return {select: <task_id>}.",
  "  - If the current pending set is EXHAUSTED for the phase OR a new finding suggests new attack paths, return {add: [<new tasks>]} to extend the DAG. Each new task has {directive, parent_ids, phase, prerequisites}.",
  "  - You CAN do both: select an existing AND add new ones in the same response.",
  "  - If the engagement is at a natural pause (phase complete, scope exhausted, or stuck), return {advance_phase: \"<next_phase>\"} OR {end: \"<reason>\"}.",
  "",
  "Constraints:",
  "  - Stay strictly within scope/ROE.",
  "  - Do NOT propose commands — that's the Command Synthesizer's job. Task directives are HIGH-LEVEL (e.g. 'enumerate RTSP service on 192.168.1.19 to identify firmware version', not 'nc 192.168.1.19 554').",
  "  - Pivot away from approaches the graph shows failed.",
  "  - Build on what succeeded — failed task outcome_summaries surface error patterns; successful ones surface attack vectors.",
  "  - The executor's available tools are in the engagement state; don't propose tasks impossible for that executor.",
  "",
  "Respond STRICT JSON, no prose, no code fences. Schema:",
  '{"select": <existing_task_id_to_execute_next> | null, "add": [{"directive": "...", "parent_ids": [], "phase": "recon|enumeration|foothold|exploitation|post_exploit|reporting", "prerequisites": "..."}] | [], "advance_phase": "<phase>" | null, "end": "<reason>" | null}',
  'If nothing to do, return {"select": null, "add": [], "end": "<reason>"}.',
].join("\n");

function chatCompletion(messages, modelOverride) {
  return new Promise((resolve, reject) => {
    const base = MODEL_URL.replace(/\/+$/, "");
    const url = new URL(base + "/chat/completions");
    const lib = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify({ model: modelOverride || MODEL_NAME, messages, temperature: 0.2, stream: false });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (MODEL_KEY) headers.Authorization = `Bearer ${MODEL_KEY}`;
    // dir_1780786724856: 60s timeout + fresh socket per request. Tunnel death
    // through bridge restart no longer hangs the agent forever — fails fast,
    // bridge startup auto-reopens, next iter proceeds.
    const reqAgent = new lib.Agent({ keepAlive: false });
    const req = lib.request(url, { method: "POST", headers, timeout: 180000, agent: reqAgent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`orchestrator HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(body);
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!content) return reject(new Error("orchestrator returned no content"));
          resolve(content);
        } catch (e) { reject(new Error(`orchestrator parse error: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("orchestrator timeout")));
    req.write(payload);
    req.end();
  });
}

function parseJSON(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : raw);
}

// Pull the current DAG of an engagement. Returns {tasks: [...], graph_text: "..."}
// where graph_text is a flat, model-friendly serialization for the Orchestrator prompt.
async function loadGraph(engagementId) {
  const r = await db.query(
    `SELECT id, parent_ids, directive, phase, prerequisites, status, queue_item_id,
            outcome_summary, iteration,
            created_at, completed_at
       FROM engagement_tasks
      WHERE engagement_id = $1
      ORDER BY id ASC`, [engagementId]);
  const tasks = r.rows;
  // Compute unblocked-set = pending tasks whose parents are all done/skipped.
  const byId = Object.create(null);
  for (const t of tasks) byId[t.id] = t;
  const isResolved = (t) => t.status === "done" || t.status === "skipped";
  const unblocked = [];
  for (const t of tasks) {
    if (t.status !== "pending") continue;
    const parents = t.parent_ids || [];
    if (parents.every((pid) => byId[pid] && isResolved(byId[pid]))) unblocked.push(t.id);
  }
  return { tasks, unblocked };
}

function serializeGraphForPrompt(graph) {
  if (graph.tasks.length === 0) return "(empty — no tasks yet; you must propose initial tasks via `add`)";
  const lines = graph.tasks.map((t) => {
    const parents = (t.parent_ids || []).length ? `parents=${(t.parent_ids).join(",")}` : "parents=root";
    const outcome = t.outcome_summary
      ? ` outcome=${JSON.stringify(t.outcome_summary).slice(0, 240)}`
      : "";
    const blocked = graph.unblocked.includes(t.id) ? "[unblocked]" : "";
    return `  task=${t.id} ${parents} phase=${t.phase || "?"} status=${t.status} ${blocked} directive="${(t.directive || "").slice(0, 140)}"${outcome}`;
  });
  lines.push(`  unblocked_pending: ${graph.unblocked.length ? graph.unblocked.join(", ") : "(none)"}`);
  return lines.join("\n");
}

// Run the Orchestrator. Receives engagement context object that the agent loop
// has already assembled (saves an extra DB round-trip). Returns the parsed
// decision: {select, add, advance_phase, end}.
async function decide(engagementCtx, modelOverride) {
  if (!engagementCtx || !engagementCtx.engagement) {
    throw new Error("orchestrator: engagement context required");
  }
  const eng = engagementCtx.engagement;
  const graph = await loadGraph(eng.id);
  const graphText = serializeGraphForPrompt(graph);

  const execTools = Array.isArray(eng.executor_tools) ? eng.executor_tools : [];
  const phase = eng.engagement_phase || "recon";

  const userMsg = [
    `Engagement: id=${eng.id} type=${eng.engagement_type || "?"} status=${eng.status || "?"} phase=${phase}`,
    `Scope/ROE: ${JSON.stringify({ scope: eng.scope, roe: eng.roe })}`,
    `Executor: ${eng.executor_host || "dev-01"}`,
    `Tools available on executor: ${execTools.length ? execTools.join(", ") : "(unknown — POSIX-portable only)"}`,
    `Structured recon (hosts/ports/services): ${JSON.stringify(engagementCtx.hosts || []).slice(0, 4000)}`,
    // Findings: graph rendering when engagement opted in to graph_mode (dir_1780781999942),
    // otherwise legacy flat-list JSON. The graph encodes informed_by → enables relationships
    // so the reasoning loop sees how findings build on each other — King Kazuma's
    // SOC-app UI insight ported to the model's prompt.
    engagementCtx.finding_graph_rendered
      ? `Findings (attack graph):\n${engagementCtx.finding_graph_rendered}`
      : `Findings so far: ${JSON.stringify(engagementCtx.findings || []).slice(0, 4000)}`,
    "",
    "Current Task Coordination Graph:",
    graphText,
    "",
    "DECISION RULE — read carefully:",
    "  1) If unblocked_pending above is NON-EMPTY, you MUST return {\"select\": <one of those IDs>}. The selection executes that task this iteration; you can also add new tasks in the same response.",
    "  2) Only return {\"end\": \"...\"} when the engagement is truly complete — ROE goals met OR every reachable attack surface is exhausted AND no unblocked task remains.",
    "  3) Returning {\"select\": null, \"add\": [], \"end\": null} is INVALID — the agent loop will stall. If you have nothing to do, end with a reason instead.",
    "",
    "Pick the next move as strict JSON per the schema above.",
  ].join("\n");

  const raw = await chatCompletion([
    { role: "system", content: ORCHESTRATOR_SYSTEM_PROMPT },
    { role: "user", content: userMsg },
  ], modelOverride);

  let parsed;
  try { parsed = parseJSON(raw); }
  catch (e) { throw new Error(`orchestrator JSON parse failed: ${e.message}`); }

  // Sanity defaults so callers don't crash on missing keys.
  const out = {
    select:         (typeof parsed.select === "number" || parsed.select === null) ? parsed.select : null,
    add:            Array.isArray(parsed.add) ? parsed.add : [],
    advance_phase:  (typeof parsed.advance_phase === "string") ? parsed.advance_phase : null,
    end:            (typeof parsed.end === "string") ? parsed.end : null,
    _graph:         graph, // for caller convenience
  };

  // Fallback (dir_1780763267882): when the model returns a fully-empty decision
  // but unblocked pending tasks exist, auto-select the oldest. qwen3:32b base
  // reliably hits this failure mode — the system prompt + DECISION RULE above
  // help but don't eliminate it. Tag the choice with _fallback so callers can
  // measure how often we paper over model indecision; log via the
  // note_model_behavior tag="empty_decision" polarity="negative" for v1.4
  // corpus signal.
  if (out.select == null && out.add.length === 0 && !out.end && graph.unblocked.length > 0) {
    out.select = graph.unblocked[0];
    out._fallback = "auto_selected_oldest_unblocked";
  }
  return out;
}

// Persist new tasks proposed by the Orchestrator. Returns the inserted rows.
async function addTasks(engagementId, newTasks) {
  const inserted = [];
  for (const t of newTasks) {
    if (!t || typeof t.directive !== "string" || !t.directive.trim()) continue;
    const r = await db.query(
      `INSERT INTO engagement_tasks
         (engagement_id, parent_ids, directive, phase, prerequisites, status)
       VALUES ($1, $2::int[], $3, $4, $5, 'pending')
       RETURNING id`,
      [
        engagementId,
        Array.isArray(t.parent_ids) ? t.parent_ids.filter((n) => Number.isInteger(n)) : [],
        t.directive.trim(),
        (typeof t.phase === "string" && t.phase) ? t.phase.trim() : null,
        (typeof t.prerequisites === "string") ? t.prerequisites.trim() : null,
      ]);
    inserted.push(r.rows[0].id);
  }
  return inserted;
}

// Mark a task in_flight when the Synthesizer is producing a command for it.
async function markInFlight(taskId, iteration) {
  await db.query(
    `UPDATE engagement_tasks
        SET status = 'in_flight', iteration = $2, updated_at = NOW()
      WHERE id = $1`,
    [taskId, iteration || null]);
}

// Link a task to the queue_item the Synthesizer queued for it.
async function linkQueueItem(taskId, queueItemId) {
  await db.query(
    `UPDATE engagement_tasks
        SET queue_item_id = $1, updated_at = NOW()
      WHERE id = $2`,
    [queueItemId, taskId]);
}

// Finalize a task — Aggregator has folded the outcome.
async function completeTask(taskId, status, outcomeSummary) {
  await db.query(
    `UPDATE engagement_tasks
        SET status = $1, outcome_summary = $2, completed_at = NOW(), updated_at = NOW()
      WHERE id = $3`,
    [status, outcomeSummary ? JSON.stringify(outcomeSummary) : null, taskId]);
}

// Operator-facing: reset the graph for an engagement (used when scope changes
// materially and the existing plan is no longer relevant).
async function resetGraph(engagementId) {
  await db.query(`DELETE FROM engagement_tasks WHERE engagement_id = $1`, [engagementId]);
  return { engagement_id: engagementId, ok: true };
}

module.exports = {
  decide,
  loadGraph,
  serializeGraphForPrompt,
  addTasks,
  markInFlight,
  linkQueueItem,
  completeTask,
  resetGraph,
};
