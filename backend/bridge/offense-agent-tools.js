"use strict";
// offense-agent-tools.js — Step 4 of OFFENSE-AGENT-DESIGN.md (dir_1780588998478)
//
// The seven tools the L3 agent (Step 5) calls during its SUMMARY→THOUGHT→ACTION
// loop. Each tool is server-side and membrane-safe: returns structured data or
// status to the model, never raises offensive content to L4. Step 5 wires these
// into an Ollama function-call loop.
//
// Tool implementations:
//   get_engagement_state  — FULL (extends offense-engine.gatherContext)
//   queue_step            — FULL (wraps for executor, inserts, telemetry)
//   wait_for_outcome      — FULL (poll loop with timeout)
//   probe_executor        — FULL (delegates to executor-probe)
//   advance_phase         — STUB (engagement_phase column lands in a later step)
//   request_human         — STUB (operator UX lands in Step 6)
//   end_engagement        — STUB (agent-loop columns land in Step 5)
//
// TOOL_SCHEMAS is the JSON array suitable for the `tools` param of an Ollama
// /v1/chat/completions request when calling qwen3:32b / deepseek-r1:32b.

const db = require("./db");
const executorProbe = require("./executor-probe");

// Mirror of offense-engine.wrapForExecutor — copied here so this module is
// self-contained and the agent loop doesn't pull all of offense-engine in.
// Keep in sync with offense-engine.js (Kali chroot routing via `nh -s` when
// the executor's tool list contains the `nh` sentinel — dir_1780759239313).
function wrapForExecutor(command, engagement) {
  const host = engagement && engagement.executor_host;
  if (!host || host === "dev-01" || !engagement.executor_adb_target) return command;
  const tools = Array.isArray(engagement.executor_tools) ? engagement.executor_tools : [];
  const hasChroot = tools.includes("nh");
  const b64 = Buffer.from(String(command), "utf8").toString("base64");
  const pipe = hasChroot
    ? `echo ${b64} | base64 -d | su -c "/data/local/nhsystem/nh -s"`
    : `echo ${b64} | base64 -d | sh`;
  return `adb -s ${engagement.executor_adb_target} shell '${pipe}' </dev/null`;
}

// ────────────────────────────── tool implementations ──────────────────────────────

async function getEngagementState(args) {
  const id = args && args.engagement_id;
  if (!id) return { error: "engagement_id required" };
  const eng = await db.query(
    `SELECT id, engagement_type, status, scope, roe,
            executor_host, executor_adb_target, executor_tools, executor_tools_probed_at
       FROM pentest_engagements WHERE id = $1`, [id]);
  if (eng.rows.length === 0) return { error: `engagement ${id} not found` };
  const [hosts, findings, queue] = await Promise.all([
    db.query(`SELECT ip, hostname, status, ports FROM recon_hosts WHERE engagement_id = $1 ORDER BY ip`, [id]),
    db.query(`SELECT title, severity, status, affected_asset, affected_assets, refs
                FROM pentest_findings WHERE engagement_id = $1 ORDER BY discovered_at`, [id]),
    db.query(
      `SELECT seq, title, status,
              LEFT(COALESCE(command, ''), 240) AS command_preview,
              LEFT(COALESCE(output, ''),  600) AS output_preview,
              completed_at
         FROM soc_queue_items
        WHERE engagement_id = $1
          AND status IN ('done', 'failed', 'cancelled')
        ORDER BY seq DESC LIMIT 10`, [id]),
  ]);
  // Surface known executor capability limits so the agent doesn't burn iterations
  // rediscovering them (dir_1780759239313). When commands run inside the Kali
  // chroot via `nh -s`, raw-socket syscalls (netlink RTM_GETROUTE, AF_PACKET) are
  // blocked by Samsung's kernel + SELinux even with CAP_NET_RAW in CapEff —
  // magiskpolicy live-patches don't help. TCP-connect works natively.
  const engRow = eng.rows[0];
  const tools = Array.isArray(engRow.executor_tools) ? engRow.executor_tools : [];
  if (tools.includes("nh")) {
    engRow.executor_caps_note =
      "Executor: Kali ARM64 chroot on rooted Android tablet, reached via `nh -s` " +
      "(stdin pipe into chroot bash). TCP-connect scans work natively. Raw sockets " +
      "do NOT work (Samsung kernel/SELinux blocks netlink RTM_GETROUTE and AF_PACKET " +
      "even with CAP_NET_RAW); use `nmap -sT -Pn` for port scans, `nmap -sn -PS<port>` " +
      "with a TCP-connect target list for host discovery, and `nc -z`/`curl` over `nmap " +
      "-sP`/`-sS`. Avoid ICMP-only host discovery — prefer TCP probes to known ports.";
  }
  return {
    engagement: engRow,
    hosts: hosts.rows,
    findings: findings.rows,
    queue_history: queue.rows,
  };
}

async function queueStep(args) {
  const { engagement_id, title, command, references, expected_artifact, model_override, intent_class } = args || {};
  if (!engagement_id) return { error: "engagement_id required" };
  if (!command)       return { error: "command required" };
  // intent_class is required by the schema but tolerated as NULL on legacy calls
  // — autonomous-executor treats NULL as gated (safe default).
  const er = await db.query(
    `SELECT id, executor_host, executor_adb_target, executor_tools FROM pentest_engagements WHERE id = $1`,
    [engagement_id]);
  if (er.rows.length === 0) return { error: `engagement ${engagement_id} not found` };
  const eng = er.rows[0];

  const seqRow = await db.query(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM soc_queue_items WHERE engagement_id = $1`,
    [engagement_id]);
  const seq = seqRow.rows[0].next;

  const titleBase = title || `Offensive step ${seq}`;
  const finalTitle = model_override ? `[${model_override}] ${titleBase}` : titleBase;
  const wrappedCommand = wrapForExecutor(command, eng);

  // Membrane-handled origin: agent tool used by the L3 model to queue its
  // own step. Bypass the cipher-exploit-write trigger. See feedback_soc_observer_role.md.
  const ins = await db.withBypass('offense_agent_tool', (client) => client.query(
    `INSERT INTO soc_queue_items
       (engagement_id, seq, title, description, command, expected_artifact, status, intent_class)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING id, seq`,
    [engagement_id, seq, finalTitle, null, wrappedCommand, expected_artifact || null,
     typeof intent_class === "string" ? intent_class : null]));

  // Lightweight telemetry — Step 5 will write a richer per-iteration row that
  // ties reasoning/generation outputs together. For now record the queueing.
  try {
    await db.query(
      `INSERT INTO offense_telemetry
         (engagement_id, queue_item_id, model_used, intent_category,
          n_hosts, n_findings, step_queued, in_scope, n_references,
          latency_ms, error_message)
       VALUES ($1, $2, $3, 'agent', 0, 0, true, true, $4, 0, NULL)`,
      [engagement_id, ins.rows[0].id, "agent-tool", Array.isArray(references) ? references.length : 0]);
  } catch (_) { /* telemetry NEVER breaks tool dispatch */ }

  // Phase-gated autonomous execution (dir_1780784224487). If the engagement has
  // autonomous_execution_enabled=true AND phase is in AUTO_RUN_PHASES, this kicks
  // off the SSH execution path internally. wait_for_outcome will then return as
  // soon as the run completes — no human approval step. ROE block-list lint
  // runs inside maybeAutoExecute; on a hit the row is marked failed with a
  // diagnostic the agent sees on its next poll.
  let auto = null;
  try {
    const { maybeAutoExecute } = require("/app/autonomous-executor");
    auto = await maybeAutoExecute(ins.rows[0].id);
    console.log(`[queue_step] q=${ins.rows[0].id} autoExec=${JSON.stringify(auto)}`);
  } catch (e) {
    console.error(`[queue_step] auto-execute hook failed:`, e.message);
  }

  return {
    queue_id: ins.rows[0].id,
    seq:      ins.rows[0].seq,
    title:    finalTitle,
    auto_executed: !!(auto && auto.autoExecuted),
    auto_reason:   auto ? auto.reason : null,
    note: (auto && auto.autoExecuted)
      ? "Step queued AND auto-executed (recon/enumeration phase). Use wait_for_outcome to block until SSH completes."
      : "Step queued for PA. Use wait_for_outcome(queue_id) to block until it runs.",
  };
}

async function waitForOutcome(args) {
  const { queue_item_id, timeout_sec } = args || {};
  if (!queue_item_id) return { error: "queue_item_id required" };
  const timeoutMs = (Number(timeout_sec) > 0 ? Number(timeout_sec) : 1800) * 1000;
  const pollMs   = 5000;
  const start = Date.now();

  while ((Date.now() - start) < timeoutMs) {
    const r = await db.query(
      `SELECT id, status, LEFT(COALESCE(output, ''), 2000) AS output_preview,
              started_at, completed_at
         FROM soc_queue_items WHERE id = $1`, [queue_item_id]);
    if (r.rows.length === 0) return { error: `queue_item ${queue_item_id} not found` };
    const row = r.rows[0];
    if (row.status === "done" || row.status === "failed" || row.status === "cancelled") {
      return {
        queue_item_id,
        status:           row.status,
        output_preview:   row.output_preview,
        elapsed_sec:      Math.round((Date.now() - start) / 1000),
        started_at:       row.started_at,
        completed_at:     row.completed_at,
      };
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return {
    queue_item_id,
    status:       "timeout",
    elapsed_sec:  Math.round(timeoutMs / 1000),
    note:         "PA did not run the step within the timeout — agent should escalate or skip.",
  };
}

async function probeExecutorTool(args) {
  const { engagement_id, force } = args || {};
  if (!engagement_id) return { error: "engagement_id required" };
  return await executorProbe.probeExecutor(engagement_id, !!force);
}

// ─────────────────────────────── activated (Step 5) ───────────────────────────────

const VALID_PHASES = ["recon", "enumeration", "foothold", "exploitation", "post_exploit", "reporting"];

async function advancePhase(args) {
  const { engagement_id, new_phase } = args || {};
  if (!engagement_id) return { error: "engagement_id required" };
  if (!new_phase || !VALID_PHASES.includes(new_phase)) {
    return { error: `new_phase must be one of: ${VALID_PHASES.join(", ")}` };
  }
  // Capture old phase BEFORE the update so the push-notification hook can
  // tell whether we're crossing the auto-run → gated boundary.
  const prev = await db.query(
    `SELECT engagement_phase FROM pentest_engagements WHERE id = $1`,
    [engagement_id]);
  const oldPhase = prev.rows[0] && prev.rows[0].engagement_phase;
  const r = await db.query(
    `UPDATE pentest_engagements
        SET engagement_phase = $1
      WHERE id = $2
      RETURNING engagement_phase`,
    [new_phase, engagement_id]);
  if (r.rows.length === 0) return { error: `engagement ${engagement_id} not found` };
  // Push-notification hook (dir_1780784224487). Fires iff old phase is auto-run
  // AND new phase is gated AND throttle not active. Failures swallowed.
  let pushResult = null;
  try {
    const { onPhaseAdvance } = require("/app/autonomous-executor");
    pushResult = await onPhaseAdvance(engagement_id, oldPhase, new_phase);
  } catch (e) {
    console.error(`[advance_phase] push hook failed:`, e.message);
  }
  return { engagement_id, phase: r.rows[0].engagement_phase, ok: true, push: pushResult };
}

async function endEngagement(args) {
  const { engagement_id, reason } = args || {};
  if (!engagement_id) return { error: "engagement_id required" };
  const r = await db.query(
    `UPDATE pentest_engagements
        SET agent_status = 'completed'
      WHERE id = $1
      RETURNING id, agent_status`,
    [engagement_id]);
  if (r.rows.length === 0) return { error: `engagement ${engagement_id} not found` };
  return { engagement_id, agent_status: r.rows[0].agent_status, reason: reason || "(no reason given)", ok: true };
}

// ─────────────────────────────── still-stubbed (Step 6) ───────────────────────────────

async function requestHuman(args) {
  return {
    deferred: true,
    reason: "request_human lands when the operator-side modal lands (Step 6 of OFFENSE-AGENT-DESIGN.md). For now, write the question into your reasoning before calling end_engagement — the operator will see it in the agent_run_state transcript.",
  };
}

// ────────────────────────────────── dispatcher ─────────────────────────────────

// Model knowledge tools (dir_1780827444328) — anti-hallucination grounding
const mkTools = require("/app/model-knowledge-tools");

const TOOL_IMPLS = {
  get_engagement_state: getEngagementState,
  queue_step:           queueStep,
  wait_for_outcome:     waitForOutcome,
  probe_executor:       probeExecutorTool,
  advance_phase:        advancePhase,
  request_human:        requestHuman,
  end_engagement:       endEngagement,
  verify_cve:           mkTools.verifyCve,
  list_nse_scripts:     mkTools.listNseScripts,
  search_exploits:      mkTools.searchExploits,
};

// Central router. Returns the tool's result as a JSON-serializable object the
// agent loop wraps in a `role:"tool"` message back to the model.
async function dispatch(toolName, args) {
  const fn = TOOL_IMPLS[toolName];
  if (!fn) return { error: `unknown tool: ${toolName}` };
  try {
    let parsed = args;
    if (typeof args === "string") {
      try { parsed = JSON.parse(args); } catch (_) { parsed = {}; }
    }
    return await fn(parsed || {});
  } catch (e) {
    return { error: `${toolName} failed: ${e.message || String(e)}` };
  }
}

// ───────────────────────────── Ollama tool schemas ─────────────────────────────
// Format: OpenAI-compatible `tools` array. Ollama 0.3+ passes these through to
// qwen3 / deepseek-r1's native function-calling.

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "get_engagement_state",
      description: "Return the full state of a pentest engagement: scope, ROE, status, executor (host + adb target + actually-installed tools), structured recon hosts, current findings, and the last 10 finalized queue items with their outcomes. Call this at the start of each iteration to see what's happened and what's known.",
      parameters: {
        type: "object",
        properties: { engagement_id: { type: "string", description: "Engagement ID, e.g. SKYLINE-SOC-2026-628" } },
        required: ["engagement_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_step",
      description: "Insert a new step into the engagement's PA queue. You MUST tag intent_class so the harness knows whether to auto-run the step or gate it for human review. Auto-run intents (the harness ships them to the executor immediately): recon, enum, banner_grab, service_version, tool_setup. Gated intents (human approves in the SOC app): cred_test, exploit_probe, lateral, post_exploit. THE HARNESS VERIFIES YOUR INTENT against the command content — claiming intent_class=enum on a `curl -u admin:pass` will be flagged as intent_mismatch, gated regardless, AND logged as a model-behavior signal for v1.4 training. Be honest.",
      parameters: {
        type: "object",
        properties: {
          engagement_id:      { type: "string",  description: "Engagement ID" },
          title:              { type: "string",  description: "Short label shown in the SOC app" },
          command:            { type: "string",  description: "Exact shell command (logical — wrapping for the executor is automatic)" },
          intent_class:       {
            type: "string",
            enum: ["recon", "enum", "banner_grab", "service_version", "tool_setup", "cred_test", "exploit_probe", "lateral", "post_exploit"],
            description: "What KIND of action this step performs. Auto-run set = recon|enum|banner_grab|service_version|tool_setup. Gated set = cred_test|exploit_probe|lateral|post_exploit. Required.",
          },
          references:         { type: "array",   items: { type: "string" }, description: "Public PoC IDs (CVE-..., EDB-..., metasploit module paths). Optional." },
          expected_artifact:  { type: "string",  description: "What a successful run looks like (file, output substring, etc.)" },
        },
        required: ["engagement_id", "title", "command", "intent_class"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for_outcome",
      description: "Block until a queued step has been executed by the PA (status flips to done/failed/cancelled) or the timeout elapses. Returns the status + a preview of the output. Use this immediately after queue_step.",
      parameters: {
        type: "object",
        properties: {
          queue_item_id: { type: "number", description: "queue_id returned by queue_step" },
          timeout_sec:   { type: "number", description: "Max seconds to wait (default 1800 = 30 minutes)" },
        },
        required: ["queue_item_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "probe_executor",
      description: "Probe the engagement's executor for actually-installed tools (replaces seeded executor_tools with ground truth). Call this once at engagement start, or after installing new tools on the executor. Idempotent: skips if last probe was < 24h unless force=true.",
      parameters: {
        type: "object",
        properties: {
          engagement_id: { type: "string",  description: "Engagement ID" },
          force:         { type: "boolean", description: "Re-probe even if last probe is recent (default false)" },
        },
        required: ["engagement_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "advance_phase",
      description: "Move the engagement to a new phase (recon → enumeration → foothold → exploitation → post_exploit → reporting). STUBBED — engagement_phase column is provisioned in a later step. Calling this today returns a deferred response so the agent doesn't loop on it.",
      parameters: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          new_phase:     { type: "string", description: "Target phase" },
        },
        required: ["engagement_id", "new_phase"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_human",
      description: "Pause the agent loop and surface a question to the operator. STUBBED — the operator-side UI lands in a later step. For now this returns deferred; the agent should end the engagement with a note describing the question.",
      parameters: {
        type: "object",
        properties: {
          engagement_id: { type: "string",  description: "Engagement ID" },
          question:      { type: "string",  description: "Question for the operator" },
        },
        required: ["engagement_id", "question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_engagement",
      description: "Mark the engagement complete with a reason. STUBBED — the agent-loop completion columns land in a later step. For now this returns deferred.",
      parameters: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          reason:        { type: "string", description: "Why the engagement is ending (scope exhausted, blocked, etc.)" },
        },
        required: ["engagement_id", "reason"],
      },
    },
  },
  // ─── Model knowledge tools (dir_1780827444328) — call BEFORE claiming ───
  {
    type: "function",
    function: {
      name: "verify_cve",
      description: "Ground-truth lookup of a CVE ID via NVD. Returns {exists, summary, cvss_v3_score, cvss_v3_vector, published_date, affected_products[], references[]}. Use BEFORE claiming a CVE in a finding or queue_step — citing fake CVE IDs gets findings auto-refuted by the claim verifier. Cached for 7 days. Membrane-safe (metadata only).",
      parameters: {
        type: "object",
        properties: {
          cve_id: { type: "string", description: "CVE identifier in CVE-YYYY-NNNN format (e.g. 'CVE-2021-36260')" },
        },
        required: ["cve_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_nse_scripts",
      description: "List REAL Nmap NSE scripts available on the SOC executor. Returns {scripts:[{name, categories[], description}]}. Use BEFORE writing `nmap --script <name>` — fake script names cause guaranteed failures. Filter by category (auth, broadcast, brute, default, discovery, dos, exploit, external, fuzzer, intrusive, malware, safe, version, vuln). Optional refresh:true to re-pull catalog from dev-01.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Filter by Nmap script category (optional). One of: auth, broadcast, brute, default, discovery, dos, exploit, external, fuzzer, intrusive, malware, safe, version, vuln" },
          refresh:  { type: "boolean", description: "Force a refresh of the catalog from dev-01 nmap --script-help all (optional, costly — only when investigating new scripts)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_exploits",
      description: "Search ExploitDB via `searchsploit` for real public PoCs matching a product / version. Returns {exploits:[{edb_id, title, type, platform, port, date_published, author, codes (CVE refs), source_path}]}. Use BEFORE claiming exploitation is possible — fabricated exploit references get findings refuted. Membrane-safe: returns metadata + reference path, NOT the PoC body itself.",
      parameters: {
        type: "object",
        properties: {
          product: { type: "string", description: "Product / vendor name (e.g. 'Hikvision', 'Dropbear', 'OpenSSH')" },
          version: { type: "string", description: "Version string (optional, narrows the search)" },
          port:    { type: "string", description: "Service port to filter by (optional)" },
        },
        required: ["product"],
      },
    },
  },
];

module.exports = { dispatch, TOOL_SCHEMAS, TOOL_IMPLS, wrapForExecutor };
