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

// dir_1780930740964: tech-stack hints renderer. Surfaces "which attack
// techniques apply to this host" based on the inferred tech_stack tags so
// the model doesn't try LFI/SSTI on an nginx static target etc.
const TECH_HINTS = {
  "nginx-static":  "NO PHP, NO PHP filters, NO SSTI, NO PHP LFI. Try: SSH cred-test on this host, known nginx CVEs (verify_cve first), gobuster for hidden paths.",
  "apache-php":    "PHP LFI viable (php://filter/convert.base64-encode/resource=...), PHP wrappers, SSTI possible. Look for view.php/index.php/include patterns. Check for config files in /var/www/html/.",
  "ssh":           "SSH cred-test viable. Try common defaults (admin, root, sysadmin) with inline -l flag + small password lists. Avoid rockyou (too slow). Check banner for OS hints.",
  "mysql":         "MySQL connect with default creds (root/root, root/'', mysql/mysql). Check for SQL injection on web frontends. Look for config files exposing creds.",
  "mariadb":       "Same as mysql. Common defaults: root/root, mariadb/mariadb.",
  "postgres":      "PostgreSQL connect with postgres/postgres, admin/admin. Check pg_hba.conf for trust auth.",
  "iis-aspnet":    "IIS/ASP.NET: try /aspnet_client/, /web.config disclosure, ViewState abuse, no SSTI.",
  "tomcat":        "Tomcat: try /manager/, /host-manager/, /admin/ with default creds tomcat/tomcat. Possible WAR file upload to RCE.",
  "jetty":         "Jetty: check /shutdown handler, JNDI exposures, web.xml.",
  "wordpress":     "WordPress: wpscan for plugin vulns, /wp-login.php cred-test, /wp-admin/ enumeration.",
  "joomla":        "Joomla: joomscan, /administrator login, components enumeration.",
};
function renderTechStackHints(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) return "";
  const lines = [];
  for (const h of hosts) {
    const tags = new Set();
    if (Array.isArray(h.tech_stack)) for (const t of h.tech_stack) tags.add(t);
    if (Array.isArray(h.ports)) for (const p of h.ports) {
      if (Array.isArray(p.tech_stack)) for (const t of p.tech_stack) tags.add(t);
    }
    if (tags.size === 0) continue;
    const hint = [...tags].map(t => TECH_HINTS[t]).filter(Boolean).join(" | ");
    if (hint) lines.push(`  ${h.ip} [${[...tags].join(",")}] → ${hint}`);
  }
  if (lines.length === 0) return "";
  return `Stack hints (use to avoid wrong-class techniques):\n${lines.join("\n")}`;
}

// dir_1780955810101: scan recent queue outputs for HTTP discovery findings
// (gobuster: `view.php          (Status: 200) [Size: 36]`, curl HEAD: `HTTP/1.1
// 200 OK\n... Server: nginx\n...`). Surface as structured prompt context so the
// coordinator's exploit synthesizer USES the discovered paths instead of
// inventing its own. Run #11: gobuster found view.php, coord still queued
// `/page?$param=$payload` instead.
function renderDiscoveredEndpoints(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return "";
  const findings = new Map();   // path -> {status, host_hint, evidence_seq}
  const hostFromCmd = (cmd) => {
    const m = String(cmd || "").match(/https?:\/\/([^\s/'"]+)/);
    return m ? m[1] : null;
  };
  for (const q of queue) {
    if (!q || !q.output_preview) continue;
    const out = String(q.output_preview);
    const host = hostFromCmd(q.command_preview);
    // gobuster "name (Status: NNN) [Size: NNN]"
    const gob = out.matchAll(/([A-Za-z0-9_./\-]+)\s+\(Status:\s*(\d{3})\)/g);
    for (const m of gob) {
      const path = m[1].replace(/^\/+/, "").trim();
      const status = m[2];
      if (!path || path.length > 80) continue;
      if (!findings.has(path) || findings.get(path).status !== "200")
        findings.set(path, { status, host_hint: host, evidence_seq: q.seq });
    }
  }
  if (findings.size === 0) return "";
  const lines = [...findings.entries()]
    .sort((a, b) => (a[1].status === "200" ? -1 : 1))
    .slice(0, 25)
    .map(([path, info]) =>
      `  - ${info.host_hint ? info.host_hint + "/" : ""}${path}  (HTTP ${info.status}, seq#${info.evidence_seq})`);
  return [
    "Discovered web endpoints (from prior queue outputs — USE THESE EXACT PATHS in exploit commands, do not invent new ones):",
    ...lines,
  ].join("\n");
}

// dir_1780955810101: parse expected flag/token pattern from engagement
// objective. Lab uses OZZULAB{...}; production engagements use whatever the
// objective declares. Surfaced to the synthesizer so exploit commands grep
// for the RIGHT prefix instead of generic `flag{` / `FLAG`.
function extractFlagPattern(engagement) {
  const scope = engagement && engagement.scope;
  const obj = scope && typeof scope === "object" ? scope.objective : null;
  if (!obj || typeof obj !== "string") return null;
  // Look for `Tokens prefix OZZULAB{...}`, `Flag format OZZULAB{}`, etc.
  // Match the prefix word followed by `{` (with optional placeholder after).
  const m = obj.match(/\b([A-Z][A-Z0-9_]{2,})\{/);
  return m ? m[1] : null;
}

// dir_1780848456715: Sub-agent inventory renderer for coordinator's prompt.
function renderSubAgentsForPrompt(subAgents) {
  if (!Array.isArray(subAgents) || subAgents.length === 0) {
    return "Sub-agents: (none — you are running as a single agent, not a coordinator)";
  }
  const lines = subAgents.map((s) => {
    const role = s.target_role ? ` [${s.target_role}]` : "";
    const objective = (s.objective || "—").slice(0, 100);
    const last = (s.last_action || "—").slice(0, 100);
    return `  - sub#${s.id} ${s.target_host}${role} status=${s.status} iter=${s.iter}/${s.max_iter} findings=${s.total_findings} queue=${s.total_queue_items} objective="${objective}" last="${last}"`;
  });
  return ["Active sub-agents (you are the COORDINATOR over these):", ...lines].join("\n");
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
    // dir_1780930740964: tech_stack hints — surface what techniques apply per host
    renderTechStackHints(engagementCtx.hosts),
    // dir_1780955810101: discovered web endpoints (gobuster/curl) — coord
    // must use these EXACT paths, not invent its own (`/page?$param=...`).
    renderDiscoveredEndpoints(engagementCtx.queue),
    // dir_1780955810101: expected flag/token prefix from engagement objective.
    // Tells the exploit synthesizer to grep `OZZULAB{` not generic `flag{`.
    (() => {
      const fp = extractFlagPattern(eng);
      return fp ? `Expected flag/token prefix in payload responses: \`${fp}{\` — grep exploit outputs for this exact prefix (NOT generic \`flag{\` or \`FLAG\`).` : "";
    })(),
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
    // dir_1780848456715: COORDINATOR view — list of sub-agents this coordinator
    // can spawn / terminate / reprompt. Empty when no sub-agents exist (treat
    // the coordinator as if it IS the agent).
    renderSubAgentsForPrompt(engagementCtx.sub_agents),
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
    "COORDINATOR ACTIONS (dir_1780848456715 — OPTIONAL, in addition to select/add):",
    "  You may also include a \"coordinator_actions\" array with any of these action shapes:",
    '    {"kind":"spawn_sub_agent","target_host":"<ip>","target_role":"gateway|nvr|web|unknown","objective":"<what this sub-agent should accomplish>","permission_mode_override":"<optional>"}',
    '    {"kind":"terminate_sub_agent","sub_agent_id":<n>,"reason":"<why>"}',
    '    {"kind":"reprompt_sub_agent","sub_agent_id":<n>,"new_objective":"<text>"}',
    '    {"kind":"await_sub_agents","min_count":<n>,"max_wait_sec":<n>}',
    "  When to use coordinator_actions:",
    "  - SPAWN when a new host appears in recon_hosts or a known host needs deeper focus",
    "  - TERMINATE a sub-agent that's stuck (paused by recovery_recipes, or no findings after many iters)",
    "  - REPROMPT when a sub-agent's objective should pivot based on what other sub-agents discovered",
    "  - AWAIT when you want to pause your own task loop until N sub-agents complete",
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
        schemaHint: '{"select": <task_id_or_null>, "add": [{"directive": "...", "parent_ids": [], "phase": "recon|enumeration|foothold|exploitation|post_exploit|reporting", "prerequisites": "..."}], "advance_phase": "<phase>" | null, "end": "<reason>" | null, "coordinator_actions": [{"kind":"spawn_sub_agent","target_host":"...","target_role":"...","objective":"..."} | {"kind":"terminate_sub_agent","sub_agent_id":<n>,"reason":"..."} | {"kind":"reprompt_sub_agent","sub_agent_id":<n>,"new_objective":"..."} | {"kind":"await_sub_agents","min_count":<n>,"max_wait_sec":<n>}]}',
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
    // dir_1780848456715: coordinator can spawn / terminate / reprompt / await
    // sub-agents in addition to selecting / adding tasks. Filter to known shapes.
    coordinator_actions: Array.isArray(parsed.coordinator_actions)
      ? parsed.coordinator_actions.filter(a => a && typeof a === "object" && typeof a.kind === "string"
          && ["spawn_sub_agent","terminate_sub_agent","reprompt_sub_agent","await_sub_agents"].includes(a.kind))
      : [],
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
