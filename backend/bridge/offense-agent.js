"use strict";
// offense-agent.js — Steps 5 + 8 of OFFENSE-AGENT-DESIGN.md
//
// Step 5 (dir_1780589262481): runAgentToolCall — single-loop with Ollama
//   function-calling. Kept for comparison + legacy callers.
//
// Step 8 (dir_1780594102051): runAgent (default) — xOffense-style multi-agent:
//   Orchestrator → Synthesizer → queue_step → wait_for_outcome → Aggregator
//   → loop. Strategy lives in offense-orchestrator.js, output-folding in
//   offense-aggregator.js, command synthesis is inline below. Per the
//   xOffense paper this architecture beats single-loop by ~10-15 points
//   even on the same base model (no fine-tune required).
//
// Both functions persist state in pentest_engagements (agent_run_state +
// engagement_phase + agent_status) so a bridge restart can resume.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const db = require("./db");
const orchestrator = require("./offense-orchestrator");
const aggregator   = require("./offense-aggregator");
const { TOOL_SCHEMAS, dispatch } = require("./offense-agent-tools");

const MODEL_URL  = process.env.OFFENSE_MODEL_URL  || "http://127.0.0.1:11434/v1";
const MODEL_NAME = process.env.OFFENSE_MODEL_NAME || "qwen3:32b";
const MODEL_KEY  = process.env.OFFENSE_MODEL_KEY  || "";

const DEFAULT_MAX_ITER = 15;

// ─────────────────────────────── shared prompts ───────────────────────────────

const AGENT_SYSTEM_PROMPT_BASE = [
  "You are the L3 offensive-research agent for an AUTHORIZED penetration-testing engagement.",
  "",
  "You operate AUTONOMOUSLY within scope, but every command you queue runs ONLY after a human PA reviews and runs it from the SOC app — human-in-loop is mandatory (RULE 3 of the project).",
  "",
  "Tool-call mode loop (legacy Step 5):",
  "  1. Call get_engagement_state to see the current scope/findings/queue history/executor capabilities AND the current engagement_phase.",
  "  2. Reason about the highest-leverage next sub-task for the CURRENT PHASE (see PHASE GUIDANCE below). Do NOT repeat approaches the queue history shows already failed.",
  "  3. Call queue_step with the exact shell command. The bridge wraps it for the engagement's executor automatically — write the command as if you're on the executor itself.",
  "  4. Call wait_for_outcome with the queue_id returned by queue_step.",
  "  5. Fold the outcome back into your reasoning. If it failed, pivot. If it succeeded, build on it.",
  "  6. When the phase's goals are met, call advance_phase to move forward.",
  "  7. When the engagement is exhausted, call end_engagement with a clear reason.",
  "",
  "Constraints:",
  "  - Tools available on the executor are listed in get_engagement_state's response. Use ONLY those.",
  "  - All references must be real public IDs (CVE-..., EDB-..., MSF module path).",
  "  - Stay strictly within scope/ROE.",
  "  - If you hit something requiring human judgment, call end_engagement with the question.",
  "",
  "Anti-hallucination tools (dir_1780827444328): GROUND every claim before making it.",
  "  - verify_cve(cve_id) BEFORE you cite a CVE. Fabricated CVE IDs get findings auto-refuted by the claim verifier.",
  "  - list_nse_scripts(category) BEFORE you write `nmap --script <name>`. Fake script names cause guaranteed failures.",
  "  - search_exploits(product, version) BEFORE claiming exploitation is possible. Fabricated EDB-IDs / module paths get findings refuted.",
  "  - When you don't recall a fact, CALL THE TOOL. Don't guess. Guessing wastes iters and pollutes the dataset.",
  "",
  "Output style: USE TOOLS. Don't narrate at length.",
].join("\n");

const PHASE_GUIDANCE = {
  recon: [
    "CURRENT PHASE: recon",
    "Goal: build a complete picture of the target's exposed attack surface PASSIVELY where possible. No exploitation attempts.",
    "Right moves: host discovery (subnet sweeps), port scans, service-banner grabs, OS fingerprinting, dns/whois lookups, public OSINT against in-scope assets.",
    "Wrong moves: running exploit modules, brute-force, credential spraying.",
    "Advance when: every in-scope host has at least a partial port/service inventory in recon_hosts.",
  ].join("\n"),
  enumeration: [
    "CURRENT PHASE: enumeration",
    "Goal: deepen what recon found. Identify exact service versions, default credentials worth trying, exposed interfaces.",
    "Right moves: version probes (nmap -sV with NSE scripts), HTTP banner/robots/known-paths, SNMP v1/v2c default communities, FTP/SMB anonymous, default-cred reads (NOT writes).",
    "Wrong moves: full exploit chains, credential dumps, anything that changes target state.",
    "Advance when: at least one promising attack vector (specific CVE-version match, default-cred service, exposed admin panel) is identified.",
  ].join("\n"),
  foothold: [
    "CURRENT PHASE: foothold",
    "Goal: gain initial access — ONE concrete exploit attempt per iteration. If it fails, repair BEFORE retrying the same approach.",
    "Right moves: target the specific service+version match from enumeration. Use real public PoCs (CVE/EDB/MSF).",
    "Wrong moves: shotgun-spraying exploits, RCE chains before verifying the underlying vuln exists.",
    "Advance when: confirmed access vector (shell, admin login, restricted-data read).",
  ].join("\n"),
  exploitation: [
    "CURRENT PHASE: exploitation",
    "Goal: extend the foothold — privesc, additional service exploitation, deeper access.",
    "Right moves: local-privesc enum, kernel/distro-matched privesc PoCs, abusing foothold creds against other in-scope services.",
    "Wrong moves: redoing initial-access work.",
    "Advance when: privileged access on at least one host, or scope boundary hit.",
  ].join("\n"),
  post_exploit: [
    "CURRENT PHASE: post_exploit",
    "Goal: lateral movement + sensitive-data discovery within scope. Persistence is usually OUT OF SCOPE.",
    "Right moves: enumerate other in-scope hosts from foothold, read sensitive files for proof-of-impact, AD/cloud trust paths.",
    "Wrong moves: persistence, destructive actions, exfiltrating real data.",
    "Advance when: lateral reach + impact documented across in-scope environment.",
  ].join("\n"),
  reporting: [
    "CURRENT PHASE: reporting",
    "Goal: synthesize findings into a structured draft. No new offensive steps.",
    "Right moves: review pentest_findings, identify confirmed-exploitable vs theoretical, queue read-only verifications if ambiguous.",
    "Wrong moves: new exploit attempts.",
    "End the engagement when the finding list is consistent with queue history proof.",
  ].join("\n"),
};

function buildSystemPrompt(phase) {
  const guide = PHASE_GUIDANCE[phase] || PHASE_GUIDANCE.recon;
  return `${AGENT_SYSTEM_PROMPT_BASE}\n\n────────────────\n${guide}\n────────────────`;
}

// ───────────────────────────── Synthesizer (Step 8) ─────────────────────────────

const SYNTHESIZER_SYSTEM_PROMPT = [
  "You are the COMMAND SYNTHESIZER of an offensive-research multi-agent system. The Task Orchestrator has chosen ONE specific task — your job is to translate that task into the EXACT shell command for the engagement's executor.",
  "",
  "You receive: (a) the task directive (what to do), (b) executor tool list, (c) recent command shapes that already failed (so you don't re-emit them), (d) phase guidance for context.",
  "",
  "Output STRICT JSON, no prose, no code fences:",
  '{"title":"short human label (<=80 chars)","command":"the exact shell command","expected_artifact":"what success looks like","references":["CVE-... | EDB-... | exploit/..."]}',
  "",
  "Rules:",
  "  - Use ONLY tools from the provided tool list. Do not invent tool names or flags.",
  "  - Match the command to the executor's environment (e.g. stock Android root with toybox is very different from Kali).",
  "  - Keep the command to ONE focused operation. The Orchestrator owns multi-step planning, not you.",
  "  - References must be real public IDs.",
].join("\n");

// ───────────────────────────── shared HTTP helpers ─────────────────────────────

function chatJSON(messages, modelOverride) {
  return new Promise((resolve, reject) => {
    const base = MODEL_URL.replace(/\/+$/, "");
    const url = new URL(base + "/chat/completions");
    const lib = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify({ model: modelOverride || MODEL_NAME, messages, temperature: 0.2, stream: false });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (MODEL_KEY) headers.Authorization = `Bearer ${MODEL_KEY}`;
    // dir_1780786724856: see note in offense-orchestrator.js
    const reqAgent = new lib.Agent({ keepAlive: false });
    const req = lib.request(url, { method: "POST", headers, timeout: 60000, agent: reqAgent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`synthesizer HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          const j = JSON.parse(body);
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!content) return reject(new Error("synthesizer returned no content"));
          resolve(content);
        } catch (e) { reject(new Error(`synthesizer parse error: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("synthesizer timeout")));
    req.write(payload);
    req.end();
  });
}

function chatWithTools(messages, modelOverride) {
  return new Promise((resolve, reject) => {
    const base = MODEL_URL.replace(/\/+$/, "");
    const url = new URL(base + "/chat/completions");
    const lib = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify({ model: modelOverride || MODEL_NAME, messages, tools: TOOL_SCHEMAS, temperature: 0.2, stream: false });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (MODEL_KEY) headers.Authorization = `Bearer ${MODEL_KEY}`;
    // dir_1780786724856: see note in offense-orchestrator.js
    const reqAgent = new lib.Agent({ keepAlive: false });
    const req = lib.request(url, { method: "POST", headers, timeout: 60000, agent: reqAgent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`agent model HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try {
          const j = JSON.parse(body);
          const msg = j.choices && j.choices[0] && j.choices[0].message;
          if (!msg) return reject(new Error("agent model returned no message"));
          resolve({ message: msg, usage: j.usage });
        } catch (e) { reject(new Error(`agent model parse error: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("agent model timeout (is the GPU instance up + tunnel open?)")));
    req.write(payload);
    req.end();
  });
}

function parseJSON(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : raw);
}

// ───────────────────────────── engagement context + state ─────────────────────────────

async function loadEngagementContext(engagementId) {
  const eng = await db.query(
    `SELECT id, engagement_type, scope, roe, status,
            executor_host, executor_adb_target, executor_tools,
            engagement_phase, agent_run_state, agent_status,
            graph_mode_enabled
       FROM pentest_engagements WHERE id = $1`, [engagementId]);
  if (eng.rows.length === 0) return { engagement: null };
  const [hosts, findings, queue] = await Promise.all([
    db.query(`SELECT ip, hostname, status, ports FROM recon_hosts WHERE engagement_id = $1 ORDER BY ip`, [engagementId]),
    db.query(`SELECT id, title, severity, status, affected_asset, affected_assets, refs, kind, informed_by, enables
                FROM pentest_findings WHERE engagement_id = $1 ORDER BY discovered_at`, [engagementId]),
    db.query(`SELECT seq, title, status, LEFT(COALESCE(command,''),240) AS command_preview, LEFT(COALESCE(output,''),200) AS output_preview
                FROM soc_queue_items WHERE engagement_id = $1 AND status IN ('done','failed','cancelled')
                ORDER BY seq DESC LIMIT 10`, [engagementId]),
  ]);
  // Materialize the attack graph rendering iff this engagement opted in.
  // Otherwise the legacy flat-findings list is what the orchestrator sees
  // (no behavior change for engagements that didn't flip the flag). See
  // feedback_soc_observer_role.md + dir_1780781999942.
  let findingGraphRendered = null;
  if (eng.rows[0].graph_mode_enabled) {
    try {
      const { materializeFindingGraph, renderForPrompt } = require("/app/finding-graph");
      const graph = await materializeFindingGraph(engagementId);
      findingGraphRendered = renderForPrompt(graph);
    } catch (e) {
      console.error(`[offense-agent] finding-graph materialize failed:`, e.message);
    }
  }
  return {
    engagement: eng.rows[0],
    hosts:    hosts.rows,
    findings: findings.rows,
    queue:    queue.rows,
    finding_graph_rendered: findingGraphRendered,
  };
}

async function setAgentStatus(engagementId, status, extras) {
  const payload = { ...(extras || {}) };
  await db.query(
    `UPDATE pentest_engagements
        SET agent_status = $1,
            agent_run_state = $2::jsonb
      WHERE id = $3`,
    [status, JSON.stringify(payload), engagementId]);
}

// ───────────────────────────── Step 8 — multi-agent runAgent ─────────────────────────────

async function synthesizeCommand(task, ctx, modelOverride) {
  const eng = ctx.engagement;
  const execTools = Array.isArray(eng.executor_tools) ? eng.executor_tools : [];
  const phase = eng.engagement_phase || "recon";
  const guide = PHASE_GUIDANCE[phase] || PHASE_GUIDANCE.recon;
  const recentFailures = (ctx.queue || [])
    .filter((q) => q.status === "failed")
    .slice(0, 5)
    .map((q) => `  - [${q.status}] ${(q.command_preview || "").slice(0, 140)}`)
    .join("\n");
  const userMsg = [
    `Task directive (assigned by Orchestrator): ${task.directive}`,
    `Engagement phase: ${phase}`,
    `Phase guidance:\n${guide}`,
    `Executor: ${eng.executor_host || "dev-01"}`,
    `Tools available: ${execTools.length ? execTools.join(", ") : "(unknown — POSIX-portable only)"}`,
    `Prerequisites note: ${task.prerequisites || "(none)"}`,
    recentFailures ? `Recent failed commands on this engagement — do NOT repeat these shapes:\n${recentFailures}` : "Recent failed commands: (none)",
    "Translate the directive into the exact shell command as strict JSON.",
  ].join("\n");

  const raw = await chatJSON([
    { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
    { role: "user",   content: userMsg },
  ], modelOverride);
  return parseJSON(raw);
}

async function runAgent(engagementId, opts = {}) {
  const maxIter = Number(opts.max_iter) > 0 ? Number(opts.max_iter) : DEFAULT_MAX_ITER;
  const intent  = opts.intent || null;
  const modelOverride = opts.model_override || null;
  const waitTimeoutSec = Number(opts.wait_timeout_sec) > 0 ? Number(opts.wait_timeout_sec) : 1800;

  // Initial state push so the operator sees status=running immediately
  await setAgentStatus(engagementId, "running", { iter: 0, tasks_added: 0, steps_queued: 0, started_at: new Date().toISOString() });

  const startMs = Date.now();
  let iter = 0;
  let stepsQueued = 0;
  let tasksAdded  = 0;
  let endedByOrchestrator = false;
  let endReason = null;
  let lastDecision = null;

  while (iter < maxIter) {
    iter++;

    // Build engagement context fresh each iteration (Aggregator may have added findings/hosts)
    const ctx = await loadEngagementContext(engagementId);
    if (!ctx.engagement) {
      await setAgentStatus(engagementId, "error", { iter, error: "engagement not found" });
      return { engagement_id: engagementId, ok: false, iter, reason: "engagement not found", elapsed_sec: Math.round((Date.now()-startMs)/1000) };
    }

    // (1) Orchestrator decides
    let decision;
    try {
      decision = await orchestrator.decide(ctx, modelOverride);
    } catch (e) {
      await setAgentStatus(engagementId, "error", { iter, error: e.message });
      return { engagement_id: engagementId, ok: false, iter, reason: `orchestrator failed: ${e.message}`, steps_queued: stepsQueued, tasks_added: tasksAdded, elapsed_sec: Math.round((Date.now()-startMs)/1000) };
    }
    lastDecision = decision;

    // (2) Add any new tasks proposed
    if (Array.isArray(decision.add) && decision.add.length) {
      const inserted = await orchestrator.addTasks(engagementId, decision.add);
      tasksAdded += inserted.length;
    }

    // (3) Phase advance?
    if (decision.advance_phase) {
      await dispatch("advance_phase", { engagement_id: engagementId, new_phase: decision.advance_phase });
    }

    // (4) End?
    if (decision.end) {
      endedByOrchestrator = true;
      endReason = decision.end;
      break;
    }

    // (5) No selection — give the loop one more chance if we just added tasks, else exit
    if (decision.select == null) {
      if (decision.add && decision.add.length) {
        await setAgentStatus(engagementId, "running", { iter, tasks_added: tasksAdded, steps_queued: stepsQueued, last_action: "added_tasks_no_select" });
        continue;
      }
      endReason = "orchestrator returned no task and no end signal — likely stuck";
      break;
    }

    // (6) Load the selected task + mark in_flight
    const taskRow = await db.query(`SELECT id, directive, phase, prerequisites, parent_ids, status FROM engagement_tasks WHERE id = $1 AND engagement_id = $2`, [decision.select, engagementId]);
    if (taskRow.rows.length === 0) {
      console.error(`[offense-agent] orchestrator selected nonexistent task ${decision.select}`);
      continue;
    }
    const task = taskRow.rows[0];
    if (task.status !== "pending") {
      // already done/failed/in_flight — re-loop and let orchestrator pick something else
      continue;
    }
    await orchestrator.markInFlight(task.id, iter);

    // (7) Synthesize the command
    let step;
    try {
      step = await synthesizeCommand(task, ctx, modelOverride);
    } catch (e) {
      await orchestrator.completeTask(task.id, "failed", {
        success: false,
        key_signals: [`synthesizer failed: ${e.message}`],
        new_findings: [], new_hosts: [], followup: [], error_category: "parse_error",
      });
      continue;
    }
    if (!step || typeof step.command !== "string" || !step.command.trim()) {
      await orchestrator.completeTask(task.id, "skipped", {
        success: false,
        key_signals: ["synthesizer returned no command"],
        new_findings: [], new_hosts: [], followup: [], error_category: null,
      });
      continue;
    }

    // (8) Queue via the existing tool dispatcher (handles executor wrapping + telemetry)
    const queueResult = await dispatch("queue_step", {
      engagement_id: engagementId,
      title: (step.title && String(step.title).slice(0, 80)) || task.directive.slice(0, 80),
      command: step.command,
      references: Array.isArray(step.references) ? step.references : [],
      expected_artifact: step.expected_artifact ? String(step.expected_artifact).slice(0, 500) : null,
      model_override: modelOverride,
    });
    if (queueResult.error || !queueResult.queue_id) {
      await orchestrator.completeTask(task.id, "failed", {
        success: false,
        key_signals: [`queue_step failed: ${queueResult.error || "no queue_id"}`],
        new_findings: [], new_hosts: [], followup: [], error_category: "unexpected",
      });
      continue;
    }
    await orchestrator.linkQueueItem(task.id, queueResult.queue_id);
    stepsQueued++;
    await setAgentStatus(engagementId, "running", { iter, tasks_added: tasksAdded, steps_queued: stepsQueued, last_action: `queued ${queueResult.queue_id}` });

    // (9) Wait for PA to run the queue item
    const outcome = await dispatch("wait_for_outcome", { queue_item_id: queueResult.queue_id, timeout_sec: waitTimeoutSec });
    const rawOutput = outcome.output_preview || "";
    const status = outcome.status || "timeout";

    // (10) Aggregator folds the raw output into structured signal
    const summary = await aggregator.fold(
      engagementId,
      task.directive,
      step.expected_artifact || "",
      rawOutput,
      modelOverride
    );
    // If we know the queue status was failure but aggregator said success, defer to queue truth
    if (status !== "done") summary.success = false;
    if (status === "timeout" && !summary.error_category) summary.error_category = "timeout";

    await orchestrator.completeTask(task.id, summary.success ? "done" : "failed", summary);

    // (11) Heartbeat status for live monitoring
    await setAgentStatus(engagementId, "running", { iter, tasks_added: tasksAdded, steps_queued: stepsQueued, last_action: `completed task ${task.id} (${summary.success ? "done" : "failed"})` });
  }

  // Final state
  const finalStatus = endedByOrchestrator ? "completed" : (iter >= maxIter ? "idle" : "error");
  await setAgentStatus(engagementId, finalStatus, { iter, tasks_added: tasksAdded, steps_queued: stepsQueued, end_reason: endReason || `hit max_iter=${maxIter}` });

  return {
    engagement_id: engagementId,
    ok: true,
    iter,
    ended_by_orchestrator: endedByOrchestrator,
    end_reason: endReason || (iter >= maxIter ? `hit max_iter=${maxIter} cap — re-call start_engagement_run to continue` : "(unknown)"),
    steps_queued: stepsQueued,
    tasks_added: tasksAdded,
    last_decision: lastDecision,
    elapsed_sec: Math.round((Date.now() - startMs) / 1000),
  };
}

// ───────────────────────────── Step 5 legacy (kept for comparison) ─────────────────────────────

async function loadOrInitState(engagementId) {
  const r = await db.query(
    `SELECT agent_run_state, agent_status, engagement_phase
       FROM pentest_engagements WHERE id = $1`,
    [engagementId]);
  if (r.rows.length === 0) throw new Error(`engagement ${engagementId} not found`);
  const state = r.rows[0].agent_run_state || {};
  return {
    status:   r.rows[0].agent_status || "idle",
    phase:    r.rows[0].engagement_phase || "recon",
    messages: Array.isArray(state.messages) ? state.messages : null,
    iter:     Number(state.iter) || 0,
  };
}

async function saveStateToolCall(engagementId, messages, iter, status) {
  const capped = messages.slice(-60);
  await db.query(
    `UPDATE pentest_engagements SET agent_run_state = $1::jsonb, agent_status = $2 WHERE id = $3`,
    [JSON.stringify({ messages: capped, iter }), status, engagementId]);
}

function serializeToolResult(result) {
  let s;
  try { s = JSON.stringify(result); } catch (_) { s = String(result); }
  if (s.length > 12000) s = s.slice(0, 11800) + " ...[truncated]";
  return s;
}

async function runAgentToolCall(engagementId, opts = {}) {
  const maxIter = Number(opts.max_iter) > 0 ? Number(opts.max_iter) : DEFAULT_MAX_ITER;
  const intent  = opts.intent || null;
  const modelOverride = opts.model_override || null;

  const prior = await loadOrInitState(engagementId);
  let messages = prior.messages;
  let iter     = prior.iter;
  let phase    = prior.phase;
  const resumed = !!messages;

  if (!messages) {
    messages = [
      { role: "system", content: buildSystemPrompt(phase) },
      { role: "user", content: `Start the L3 offense loop for engagement ${engagementId}.${intent ? ` Operator intent: ${intent}.` : ""} Current phase: ${phase}. Begin by calling get_engagement_state.` },
    ];
  } else {
    if (messages[0] && messages[0].role === "system") {
      messages[0] = { role: "system", content: buildSystemPrompt(phase) };
    }
    messages.push({ role: "user", content: `(Resuming.) ${intent ? `Updated operator intent: ${intent}. ` : ""}Current phase: ${phase}.` });
  }

  await saveStateToolCall(engagementId, messages, iter, "running");

  const startMs = Date.now();
  let endedByModel = false;
  let endReason   = null;
  let lastAssistantText = null;
  let stepsQueued = 0;

  while (iter < maxIter) {
    iter++;
    let resp;
    try { resp = await chatWithTools(messages, modelOverride); }
    catch (e) {
      await saveStateToolCall(engagementId, messages, iter, "error");
      return { engagement_id: engagementId, ok: false, iter, reason: `model call failed at iter ${iter}: ${e.message}`, steps_queued: stepsQueued, elapsed_sec: Math.round((Date.now()-startMs)/1000) };
    }
    const msg = resp.message;
    if (msg.content) lastAssistantText = String(msg.content).slice(0, 500);
    messages.push(msg);
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (toolCalls.length === 0) {
      endedByModel = true;
      endReason = "model returned no tool_calls — assuming it's done or stuck";
      break;
    }
    let phaseChanged = false;
    for (const tc of toolCalls) {
      const name = tc.function && tc.function.name;
      const result = await dispatch(name, tc.function && tc.function.arguments);
      if (name === "queue_step" && result && !result.error) stepsQueued++;
      messages.push({ role: "tool", tool_call_id: tc.id || `${name}-${iter}`, name, content: serializeToolResult(result) });
      if (name === "end_engagement" && result && !result.error) { endedByModel = true; endReason = `model called end_engagement: ${result.reason || "(no reason)"}`; }
      if (name === "advance_phase" && result && !result.error && result.phase) { phaseChanged = true; phase = result.phase; }
    }
    if (phaseChanged && messages[0] && messages[0].role === "system") {
      messages[0] = { role: "system", content: buildSystemPrompt(phase) };
    }
    await saveStateToolCall(engagementId, messages, iter, endedByModel ? "completed" : "running");
    if (endedByModel) break;
  }

  const finalStatus = endedByModel ? "completed" : (iter >= maxIter ? "idle" : "error");
  await saveStateToolCall(engagementId, messages, iter, finalStatus);

  return {
    engagement_id: engagementId,
    ok: true,
    iter,
    resumed,
    ended_by_model: endedByModel,
    end_reason: endReason || (iter >= maxIter ? `hit max_iter=${maxIter} cap` : "(unknown)"),
    steps_queued: stepsQueued,
    last_assistant_text: lastAssistantText,
    elapsed_sec: Math.round((Date.now() - startMs) / 1000),
  };
}

// ───────────────────────────── reset (clears both transcript + DAG) ─────────────────────────────

async function resetAgent(engagementId) {
  await db.query(
    `UPDATE pentest_engagements
        SET agent_run_state = '{}'::jsonb, agent_status = 'idle'
      WHERE id = $1`,
    [engagementId]);
  await orchestrator.resetGraph(engagementId);
  return { engagement_id: engagementId, ok: true };
}

module.exports = { runAgent, runAgentToolCall, resetAgent };
