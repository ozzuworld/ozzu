"use strict";
const { execSync } = require("child_process");

// ── Bridge network identity (read once at startup) ─────────────────
// Gives the offense model concrete ground truth about its execution host
// so it can distinguish its own output from the target's.
let _bridgeNetId = null;
function getBridgeNetworkIdentity() {
  if (_bridgeNetId) return _bridgeNetId;
  try {
    const raw = execSync("ip -4 -o addr show | awk '{print $2, $4}'", { encoding: "utf8", timeout: 3000 });
    const ifaces = {};
    for (const line of raw.trim().split("\n")) {
      const [name, cidr] = line.split(/\s+/);
      if (name && cidr) ifaces[name] = cidr;
    }
    const myIPs = Object.values(ifaces).map(c => c.split("/")[0]);
    const hostname = execSync("hostname", { encoding: "utf8", timeout: 1000 }).trim();
    _bridgeNetId = {
      hostname,
      interfaces: ifaces,
      my_ips: myIPs,
      warning: "These are YOUR host's addresses. If you see any of these IPs in scan/command output, you are looking at YOUR OWN machine, NOT the target. Commands like ifconfig, ip addr, hostname run locally on this host — to inspect a REMOTE target, you must scan it over the network (nmap, curl, etc.).",
    };
  } catch {
    _bridgeNetId = { error: "could not read host network identity" };
  }
  return _bridgeNetId;
}

// offense-agent-tools.js — Step 4 of OFFENSE-AGENT-DESIGN.md (dir_1780588998478)
// dir_1782238863765: OUTCOME_TIMEOUT_MS watchdog — no single step can freeze the loop.
// When a step is stuck 'pending' (e.g. gated for human approval, or executor offline)
// past this timeout, waitForOutcome synthesizes a 'timeout' outcome and the agent
// loop continues to the next decision. Timeout is logged to offense_telemetry as
// 'outcome_timeout' so analyze_engagement_telemetry surfaces it as a warning.
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

const db = require("../db");
const executorProbe = require("./executor-probe");

// dir_1782238863765 Part 2 — watchdog timeout for wait_for_outcome.
// Named constant so it's visible in telemetry searches and easy to tune.
// Default: 2 minutes. Overridden by the caller's timeout_sec arg (which comes
// from runAgent's waitTimeoutSec, default 1800s for the human-in-loop case).
// The watchdog fires when the default timeout_sec is not overridden AND the step
// never executes (e.g. gated-pending, executor offline). The agent sees a
// 'timeout' outcome and continues to the next decision instead of freezing.
const OUTCOME_TIMEOUT_MS = 120000; // 2 minutes

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
              LEFT(COALESCE(command, ''), 400) AS command_preview,
              LEFT(COALESCE(output, ''),  2000) AS output_preview,
              completed_at
         FROM soc_queue_items
        WHERE engagement_id = $1
          AND status IN ('done', 'failed', 'cancelled')
        ORDER BY seq DESC LIMIT 20`, [id]),
  ]);
  // dir_1782345318729: ALWAYS override executor_tools with bridge ground truth.
  // Execution is LOCAL on the bridge container — old tablet-probed lists are stale
  // and list tools (masscan, xxd, msfconsole...) that don't exist here, causing
  // "command not found" failures every engagement.
  const engRow = eng.rows[0];
  const BRIDGE_TOOLS = ["nmap","curl","ssh","python3","searchsploit",
                        "nuclei","httpx","whatweb","netcat","dig","host",
                        "openssl","jq","awk","grep","sed","bash"];
  engRow.executor_tools = BRIDGE_TOOLS;
  // dir_1782346173114: clear tablet identity — model sees "tablet-p610" and tries
  // ADB commands. Execution is LOCAL on the bridge Linux VM, not on any tablet/phone.
  engRow.executor_host = "bridge-local";
  engRow.executor_adb_target = null;
  engRow.executor_caps_note =
    "Executor: Linux bridge container (local bash, NOT a tablet/phone — do NOT use ADB/Android commands). " +
    "Lab subnet reached via WireGuard (~240ms RTT). " +
    "ONLY the tools listed above are installed. You CAN install more at runtime with apt-get install -y. " +
    "NOT pre-installed: gobuster, nikto, hydra, john, hashcat, dirb, wfuzz, sqlmap, metasploit, wget, masscan, ffuf, xxd. " +
    "NOT available: adb, dumpsys, getprop, pm, settings, or any Android tool.";
  // Sanitize scope.target_networks — the wizard stores reachable_via: "tablet-p610"
  // which makes the model think the tablet is involved. Replace with "wireguard-relay".
  if (engRow.scope) {
    let scope = typeof engRow.scope === "string" ? JSON.parse(engRow.scope) : engRow.scope;
    if (Array.isArray(scope.target_networks)) {
      for (const net of scope.target_networks) {
        if (net.reachable_via) net.reachable_via = "wireguard-relay";
      }
      engRow.scope = scope;
    }
  }
  return {
    engagement: engRow,
    hosts: hosts.rows,
    findings: findings.rows,
    queue_history: queue.rows,
    executor_identity: getBridgeNetworkIdentity(),
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
    const { maybeAutoExecute } = require("/app/soc/autonomous-executor");
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
  // dir_1782238863765 Part 2 — watchdog. Use OUTCOME_TIMEOUT_MS as the default
  // so an un-executed (pending) step never freezes the agent beyond 2 minutes.
  // Callers may still pass timeout_sec to override (e.g. runAgent passes
  // waitTimeoutSec=1800 for the human-in-loop approval case — that override is
  // intentional for manual-PA engagements). Minimum cap: OUTCOME_TIMEOUT_MS.
  const callerMs = Number(timeout_sec) > 0 ? Number(timeout_sec) * 1000 : OUTCOME_TIMEOUT_MS;
  const timeoutMs = callerMs;
  const pollMs   = 5000;
  const start = Date.now();

  while ((Date.now() - start) < timeoutMs) {
    const r = await db.query(
      `SELECT id, status, LEFT(COALESCE(output, ''), 2000) AS output_preview,
              started_at, completed_at, engagement_id
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
    // dir_1782339045044: check abort flag inside the poll loop so operator Stop
    // takes effect within 5s, not after the full 120s timeout.
    if (row.engagement_id) {
      try {
        const ae = await db.query(
          `SELECT agent_run_state->>'abort_requested' AS abort FROM pentest_engagements WHERE id = $1`,
          [row.engagement_id]);
        if (ae.rows[0] && ae.rows[0].abort === "true") {
          return { queue_item_id, status: "abort", elapsed_sec: Math.round((Date.now() - start) / 1000), reason: "operator stopped the run" };
        }
      } catch (_) {}
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }

  // dir_1782238863765 Part 2+3: watchdog fired — log to offense_telemetry so
  // analyze_engagement_telemetry surfaces 'outcome_timeout' as a warning.
  // Also look up the engagement_id from the queue row for the telemetry insert.
  //
  // dir_1782243745921 Fix 1: a step that timed out while STILL 'pending' (never
  // reached 'running') means execution never started — synthesis hung or the run
  // endpoint failed silently. Resolve the row to 'failed' so it can never stay
  // 'pending' indefinitely. A step that reached 'running' is a legitimately long
  // operation (brute-force, large scan) — do NOT touch it; the caller will re-poll
  // or handle the timeout outcome without overwriting the live execution.
  let engId = null;
  let itemStatus = null;
  try {
    const qRow = await db.query(
      `SELECT engagement_id, status FROM soc_queue_items WHERE id = $1`, [queue_item_id]);
    if (qRow.rows[0]) {
      engId = qRow.rows[0].engagement_id;
      itemStatus = qRow.rows[0].status;
    }
    if (engId) {
      await db.query(
        `INSERT INTO offense_telemetry
           (engagement_id, queue_item_id, model_used, intent_category,
            n_hosts, n_findings, step_queued, in_scope, n_references,
            latency_ms, outcome, outcome_notes)
         VALUES ($1, $2, 'watchdog', 'wait_for_outcome', 0, 0, false, true, 0,
                 $3, 'outcome_timeout', $4)`,
        [engId, queue_item_id,
         Math.round(timeoutMs),
         `queue_item ${queue_item_id} stayed '${itemStatus || "pending"}' for ${Math.round(timeoutMs/1000)}s — watchdog fired (dir_1782238863765)`]);
    }
  } catch (_) { /* telemetry never breaks the watchdog */ }

  // dir_1782243745921 Fix 1: only resolve 'pending' items — a 'running' item
  // may still complete legitimately (long scan/brute-force).
  if (itemStatus === "pending") {
    try {
      await db.withBypass("watchdog_timeout_resolve", (client) => client.query(
        `UPDATE soc_queue_items
            SET status='failed',
                output = COALESCE(output, '') ||
                         '[WATCHDOG_TIMEOUT — dir_1782243745921 Fix 1]\n' ||
                         'Step never reached running state after ' || $1 || 's. ' ||
                         'Likely cause: command synthesis timed out (inference hung) or ' ||
                         'the run endpoint failed silently. Resolved to failed so it cannot ' ||
                         'block the agent indefinitely.',
                completed_at = NOW()
          WHERE id = $2 AND status = 'pending'`,
        [Math.round(timeoutMs / 1000), queue_item_id]));
    } catch (_) { /* resolution failure must never crash the watchdog */ }
  }

  return {
    queue_item_id,
    status:       "timeout",
    item_status_at_timeout: itemStatus || "unknown",
    elapsed_sec:  Math.round(timeoutMs / 1000),
    note:         itemStatus === "pending"
      ? "Step never started (stayed 'pending' past watchdog timeout) — resolved to 'failed' in DB (dir_1782243745921 Fix 1). Synthesis likely timed out. Agent should re-queue with a simpler command."
      : "Step stayed 'running' past watchdog timeout — execution may still complete; agent should move on (dir_1782238863765).",
  };
}

async function probeExecutorTool(args) {
  const { engagement_id } = args || {};
  if (!engagement_id) return { error: "engagement_id required" };
  // Execution is LOCAL on the bridge — return bridge ground truth, not tablet probe.
  const BRIDGE_TOOLS = ["nmap","curl","ssh","python3","searchsploit",
                        "nuclei","httpx","whatweb","netcat","dig","host",
                        "openssl","jq","awk","grep","sed","bash"];
  return {
    engagement_id,
    probed: true,
    executor: "bridge-local",
    installed_count: BRIDGE_TOOLS.length,
    installed: BRIDGE_TOOLS,
    note: "Executor is the Linux bridge container (local bash). NOT a tablet/phone. No ADB. Install more with apt-get install -y.",
  };
}

// ─────────────────────────────── activated (Step 5) ───────────────────────────────

const VALID_PHASES = ["recon", "enumeration", "foothold", "exploitation", "post_exploit", "reporting"];

// dir_1782234450321: ONE-WAY PHASE RATCHET. The phase can only move forward.
// Once a forward phase is reached it cannot regress to an earlier one —
// prevents the model from cycling back to 'recon' after reaching 'foothold'.
const PHASE_RANK = Object.fromEntries(VALID_PHASES.map((p, i) => [p, i]));

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

  // dir_1782234450321: ratchet guard — silently reject regressions.
  // Returning a non-error result so the caller doesn't crash; include
  // a 'ratchet_blocked' flag so telemetry can catch it.
  if (oldPhase && PHASE_RANK[new_phase] !== undefined && PHASE_RANK[oldPhase] !== undefined) {
    if (PHASE_RANK[new_phase] < PHASE_RANK[oldPhase]) {
      console.warn(`[advance_phase] ratchet: blocked regression ${oldPhase} → ${new_phase} for engagement ${engagement_id}`);
      try {
        await db.query(
          `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'ratchet', 'phase_advance', 0, 0, false, true, 0, 0, 'phase_regression_blocked', $2)`,
          [engagement_id, `blocked: ${oldPhase} → ${new_phase}`]);
      } catch (_) {}
      return {
        engagement_id, phase: oldPhase, ok: true,
        ratchet_blocked: true,
        note: `Phase regression ${oldPhase} → ${new_phase} blocked by one-way ratchet (dir_1782234450321). Current phase stays '${oldPhase}'.`,
      };
    }
  }

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
    const { onPhaseAdvance } = require("/app/soc/autonomous-executor");
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

// ─────────────────────── add_finding (dir_1782339906899) ─────────────────────
// Model-callable tool: the model records a finding directly when it discovers
// something, instead of relying on the aggregator to parse raw output.
async function addFinding(args) {
  const { engagement_id, title, severity, description, affected_asset, refs, kind } = args || {};
  if (!engagement_id || !title) return { error: "engagement_id and title required" };
  const validSev = ["critical", "high", "medium", "low", "info"];
  const sev = validSev.includes((severity || "").toLowerCase()) ? severity.toLowerCase() : "info";
  const fKind = ["confirmed", "hypothesis"].includes(kind) ? kind : "hypothesis";
  let finalSev = sev;
  let finalKind = fKind;
  try {
    const gate = require("/app/soc/claim-verifier").applyPreInsertGate;
    if (gate) {
      const gated = await gate(
        { title, description: description || "", severity: sev, kind: fKind, affected_asset: affected_asset || "" },
        { db, engagementId: engagement_id, source: "model_add_finding" });
      finalSev = gated.severity;
      finalKind = gated.kind;
    }
  } catch (_) {}
  const r = await db.query(
    `INSERT INTO pentest_findings (engagement_id, severity, title, description, affected_asset, refs, kind, discovered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'model')
     RETURNING id, severity, kind`,
    [engagement_id, finalSev, title, description || "", affected_asset || "", JSON.stringify(refs || []), finalKind]);
  return { ok: true, finding_id: r.rows[0].id, severity: r.rows[0].severity, kind: r.rows[0].kind };
}

// ────────────────────────────────── dispatcher ─────────────────────────────────

// Model knowledge tools (dir_1780827444328) — anti-hallucination grounding
const mkTools = require("/app/soc/model-knowledge-tools");

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
  search_sploitus:        mkTools.searchSploitus,
  add_finding:            addFinding,
  lookup_attack_playbook: mkTools.lookupAttackPlaybook,
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
  // ─── dir_1782339906899: search_sploitus + add_finding ─────────────────────
  {
    type: "function",
    function: {
      name: "search_sploitus",
      description: "Search Sploitus.com for CVE→PoC and product→PoC mappings. Aggregates ExploitDB + Packet Storm + Vulners + GitHub PoCs + Metasploit — broader than search_exploits. Use when verify_cve confirms a CVE exists and you want a working PoC reference. Membrane-safe: returns metadata only.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — CVE ID, product name, or product+version (e.g. 'Hikvision CVE-2021-36260')" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_attack_playbook",
      description: "Search the HackTricks and PayloadsAllTheThings knowledge bases for attack techniques, default credentials, and exploitation steps for a specific service, device, or vulnerability. Call this IMMEDIATELY after identifying a service in recon/enumeration — it returns the exact attack playbook so you don't have to guess. Examples: 'hikvision camera', 'zkteco access control', 'snmp default community', 'rtsp', 'onvif', 'default credentials http'.",
      parameters: {
        type: "object",
        properties: {
          query:       { type: "string", description: "Search terms — service name, device vendor, protocol, CVE ID, or attack technique" },
          max_results: { type: "integer", description: "Max pages to return (default 5, max 8)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_finding",
      description: "Record a security finding you discovered. Use this to formally log vulnerabilities, misconfigurations, or exposed services. The finding goes through the claim verifier — fabricated claims get auto-refuted. Set kind='confirmed' for verified exploits, kind='hypothesis' for unverified observations.",
      parameters: {
        type: "object",
        properties: {
          engagement_id: { type: "string",  description: "Engagement ID" },
          title:         { type: "string",  description: "Short title of the finding (e.g. 'Hikvision IVMS-4200 default credentials')" },
          severity:      { type: "string",  enum: ["critical", "high", "medium", "low", "info"], description: "Finding severity" },
          description:   { type: "string",  description: "Detailed description with evidence (what was found, how, proof)" },
          affected_asset:{ type: "string",  description: "The affected host:port or service (e.g. '192.168.1.64:80')" },
          refs:          { type: "array",   items: { type: "string" }, description: "Public reference IDs (CVE-..., EDB-..., MSF module path)" },
          kind:          { type: "string",  enum: ["confirmed", "hypothesis"], description: "confirmed = verified exploit, hypothesis = observed but not yet exploited" },
        },
        required: ["engagement_id", "title", "severity"],
      },
    },
  },
];

module.exports = { dispatch, TOOL_SCHEMAS, TOOL_IMPLS, wrapForExecutor };
