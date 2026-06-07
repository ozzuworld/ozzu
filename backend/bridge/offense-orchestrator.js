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

// dir_1780842521084: Findings section builder with Summarizer + content-hash cache.
// Threshold 6000 chars. When tripped, keep last 3 findings (or graph tail) verbatim
// and summarize the rest. Cache the summary in agent_run_state.context_summaries.findings
// keyed by hash so unchanged content doesn't re-summarize each iter.
const FINDINGS_BUDGET = 6000;
async function renderFindingsSection(eng, engagementCtx) {
  if (engagementCtx.finding_graph_rendered) {
    const text = engagementCtx.finding_graph_rendered;
    if (text.length <= FINDINGS_BUDGET) return `Findings (attack graph):\n${text}`;
    return await maybeSummarize(eng, text, "findings_graph", "Findings (attack graph)");
  }
  const flat = JSON.stringify(engagementCtx.findings || []);
  if (flat.length <= FINDINGS_BUDGET) return `Findings so far: ${flat.slice(0, 4000)}`;
  return await maybeSummarize(eng, flat, "findings_flat", "Findings so far");
}

async function maybeSummarize(eng, fullText, cacheKey, headerLabel) {
  try {
    const { performSummarizer, hashContent } = require("/app/execution-monitor");
    const head = fullText.slice(0, fullText.length - 2000);   // older portion to summarize
    const tail = fullText.slice(fullText.length - 2000);       // last 2KB verbatim
    const hash = hashContent(head);
    const cache = (eng.agent_run_state && eng.agent_run_state.context_summaries) || {};
    let summary;
    if (cache[cacheKey] && cache[cacheKey].hash === hash && typeof cache[cacheKey].summary === "string") {
      summary = cache[cacheKey].summary;
    } else {
      summary = await performSummarizer({
        content: head,
        contentType: cacheKey,
        instructions:
          "This is the older portion of a pentest engagement's " + cacheKey + " log. " +
          "Compress to under 2000 characters while preserving EVERY CVE ID, IP, port, " +
          "product+version string, file path, finding ID, severity, and refutation note. " +
          "If 5 findings cite CVE-2021-36260 with the same status, ONE bullet summarizes them. " +
          "If 3 findings are refuted, one bullet per refutation reason. Bullet form preferred. " +
          "Use lines starting with '- Host:', '- CVE:', '- Port:', '- Finding:', '- Refuted:', '- Confirmed:', '- Cred:', '- PoC:' so downstream post-processing can prioritize.",
      });
      // dir_1780845071255: claw-style deterministic post-process — dedup duplicate
      // bullets, truncate over-long lines, drop low-priority noise within a strict
      // budget. Zero LLM cost. Reproducible.
      const beforeCompressLen = (summary || "").length;
      try {
        const { compressSummary } = require("/app/summary-compress");
        const r = compressSummary(summary || "", { max_chars: 2400, max_lines: 40, max_line_chars: 200 });
        summary = r.summary;
        try {
          await db.query(
            `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
             VALUES ($1, NULL, 'compress', 'orchestrator', 0, 0, false, true, 0, 0, 'compress_applied', $2)`,
            [eng.id, `key=${cacheKey}; before=${beforeCompressLen}B; after=${r.compressed_chars}B; deduped=${r.removed_duplicate_lines}; omitted=${r.omitted_lines}`]);
        } catch (_) {}
      } catch (e) {
        // Compress is best-effort. Fall back to the original LLM output capped.
        summary = (summary || "").trim().slice(0, 3000);
        console.error(`[orchestrator] summary-compress failed for ${cacheKey}:`, e.message);
      }
      try {
        await db.query(
          `UPDATE pentest_engagements
              SET agent_run_state = COALESCE(agent_run_state, '{}'::jsonb)
                                  || jsonb_build_object('context_summaries',
                                       COALESCE(agent_run_state->'context_summaries', '{}'::jsonb)
                                       || $2::jsonb)
            WHERE id = $1`,
          [eng.id, JSON.stringify({ [cacheKey]: { hash, summary, ts: new Date().toISOString() } })]);
        await db.query(
          `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'summarizer', 'orchestrator', 0, 0, false, true, 0, 0, 'summarizer_invoked', $2)`,
          [eng.id, `key=${cacheKey}; in=${head.length}B; out=${summary.length}B`]);
      } catch (_) {}
    }
    return `${headerLabel} (older portion summarized — newest verbatim):\n[SUMMARY of earlier ${head.length} chars]\n${summary}\n[end summary]\n\n[Latest ${tail.length} chars verbatim]\n${tail}`;
  } catch (e) {
    // Fall back to a hard slice on summarizer failure.
    console.error(`[orchestrator] summarizer failed for ${cacheKey}:`, e.message);
    return `${headerLabel}: ${fullText.slice(0, 4000)}`;
  }
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
    // dir_1780844590951: surface permission_mode so the orchestrator only
    // proposes intent_class values the mode allows. recon_only blocks all
    // exploit_test/exploit_rce/post_exploit proposals; enumeration blocks
    // exploit_*. Mode escalation requires an explicit MCP call from operator.
    `Permission mode: ${eng.permission_mode || "enumeration"} (allowed intent_class up to: ${({recon_only:"recon", enumeration:"enumeration", exploitation_auto:"exploit_test", exploitation_prompt:"exploit_test", full_engagement:"post_exploit"})[eng.permission_mode || "enumeration"]})`,
    `Scope/ROE: ${JSON.stringify({ scope: eng.scope, roe: eng.roe })}`,
    `Executor: ${eng.executor_host || "dev-01"}`,
    `Tools available on executor: ${execTools.length ? execTools.join(", ") : "(unknown — POSIX-portable only)"}`,
    `Structured recon (hosts/ports/services): ${JSON.stringify(engagementCtx.hosts || []).slice(0, 4000)}`,
    // Findings: graph rendering when engagement opted in to graph_mode (dir_1780781999942),
    // otherwise legacy flat-list JSON. The graph encodes informed_by → enables relationships
    // so the reasoning loop sees how findings build on each other — King Kazuma's
    // SOC-app UI insight ported to the model's prompt.
    // dir_1780842521084: Summarizer — when the findings/graph section exceeds 6KB,
    // compress older portion via PentAGI Summarizer instead of slicing.
    await renderFindingsSection(eng, engagementCtx),
    "",
    "Current Task Coordination Graph:",
    graphText,
    // dir_1780838519357: Mentor + Planner injection. When the Mentor fires
    // (loop detected) or Planner runs (start of run), the guidance lands here.
    // The orchestrator reads it as authoritative redirection from the adviser.
    engagementCtx.planner_plan ? `\n\n=== Execution plan (from Planner at run start) ===\n${engagementCtx.planner_plan}\n=== end plan ===\n` : "",
    engagementCtx.mentor_guidance ? `\n\n⚠️ === Mentor guidance (loop detected — pivot strategy) ===\n${engagementCtx.mentor_guidance}\n=== end mentor ===\n` : "",
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
  catch (e) {
    // dir_1780841672508: Reflector recovery — model returned prose instead
    // of JSON. Send the raw text back with a schema hint, retry once.
    try {
      const { performReflector } = require("/app/execution-monitor");
      const corrected = await performReflector({
        rawText: raw,
        expectedFormat: "JSON",
        schemaHint: '{"select": <task_id_or_null>, "add": [{"directive": "...", "parent_ids": [], "phase": "recon|enumeration|foothold|exploitation|post_exploit|reporting", "prerequisites": "..."}], "advance_phase": "<phase>" | null, "end": "<reason>" | null}',
      });
      parsed = parseJSON(corrected);
      try {
        const db = require("/app/db");
        await db.query(
          `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'reflector', 'orchestrator', 0, 0, false, true, 0, 0, 'reflector_invoked', $2)`,
          [eng.id, `parse_err=${(e.message || "").slice(0, 80)}; recovered=true`]);
      } catch (_) {}
    } catch (re) {
      throw new Error(`orchestrator JSON parse failed: ${e.message} (reflector also failed: ${re.message})`);
    }
  }

  // Sanity defaults so callers don't crash on missing keys.
  const out = {
    select:         (typeof parsed.select === "number" || parsed.select === null) ? parsed.select : null,
    add:            Array.isArray(parsed.add) ? parsed.add : [],
    advance_phase:  (typeof parsed.advance_phase === "string") ? parsed.advance_phase : null,
    end:            (typeof parsed.end === "string") ? parsed.end : null,
    _graph:         graph, // for caller convenience
  };

  // dir_1780842283437: Refiner — break the `added_tasks_no_select` stall.
  // Trigger when:
  //   (a) model added tasks but selected none, OR
  //   (b) the pending pile is overgrown (>5 unblocked)
  // Refiner picks ONE task to focus on (existing pending OR one of the proposed)
  // and prunes redundant pending IDs. Soft-cancel via prune_pending_ids.
  const proposedNonEmpty = out.add.length > 0;
  const stallShape = proposedNonEmpty && out.select == null && !out.end;
  const overgrown = graph.unblocked.length > 5;
  if (stallShape || overgrown) {
    try {
      const { performRefiner } = require("/app/execution-monitor");
      const allTasks = graph.tasks || [];
      const byIdLocal = Object.create(null);
      for (const t of allTasks) byIdLocal[t.id] = t;
      const completedTasks = allTasks
        .filter(t => t && (t.status === "completed" || t.status === "done"))
        .slice(-5)
        .map(t => ({ id: t.id, title: (t.directive || "").slice(0, 200), result: (t.last_result || t.summary || "").slice(0, 300) }));
      const pendingTasks = (graph.unblocked || []).map(id => {
        const t = byIdLocal[id];
        return t ? { id: t.id, title: (t.directive || "").slice(0, 200), phase: t.phase || null } : null;
      }).filter(Boolean);
      const proposedTasks = out.add.map(t => ({ directive: t.directive || "", phase: t.phase || null }));
      const refOut = await performRefiner({
        objective: (eng.objective || eng.engagement_objective || `Engagement ${eng.id} — ${eng.engagement_type || "pentest"}`).slice(0, 500),
        completed: completedTasks,
        pending:   pendingTasks,
        proposed:  proposedTasks,
      });

      // Apply refiner decisions
      const pendingIdSet = new Set(pendingTasks.map(t => t.id));
      if (Array.isArray(refOut.prune_pending_ids) && refOut.prune_pending_ids.length) {
        const pruneTargets = refOut.prune_pending_ids.filter(id => pendingIdSet.has(id));
        if (pruneTargets.length) {
          try {
            await db.query(
              `UPDATE engagement_tasks
                  SET status='cancelled'
                WHERE id = ANY($1::int[]) AND engagement_id=$2 AND status='pending'`,
              [pruneTargets, eng.id]);
          } catch (_) {}
          out._refiner_pruned = pruneTargets;
        }
      }
      if (Array.isArray(refOut.filtered_add) && refOut.filtered_add.length > 0 && refOut.filtered_add.length < out.add.length) {
        out.add = refOut.filtered_add
          .filter(i => Number.isInteger(i) && i >= 0 && i < out.add.length)
          .map(i => out.add[i]);
      }
      if (Number.isInteger(refOut.selected_task_id) && pendingIdSet.has(refOut.selected_task_id)) {
        out.select = refOut.selected_task_id;
        out._refiner_selected = "pending";
      } else if (Number.isInteger(refOut.select_proposed_index) && refOut.select_proposed_index >= 0 && refOut.select_proposed_index < out.add.length) {
        // Trim add to just the chosen one; agent loop will detect _refiner_select_proposed
        // and select the inserted task immediately after addTasks().
        out.add = [out.add[refOut.select_proposed_index]];
        out._refiner_select_proposed = true;
        out._refiner_selected = "proposed";
      }
      out._refiner_rationale = refOut.rationale;

      try {
        await db.query(
          `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'refiner', 'orchestrator', 0, 0, false, true, 0, 0, 'refiner_invoked', $2)`,
          [eng.id, `trigger=${stallShape ? "stall" : "overgrown"}; selected=${out._refiner_selected || "none"}; pruned=${(out._refiner_pruned || []).length}; ${(refOut.rationale || "").slice(0, 200)}`]);
      } catch (_) {}
    } catch (e) {
      console.error(`[orchestrator] refiner failed:`, e.message);
    }
  }

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
