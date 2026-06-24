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
const db = require("../db");
const orchestrator = require("./offense-orchestrator");
const aggregator   = require("./offense-aggregator");
const { TOOL_SCHEMAS, dispatch } = require("./offense-agent-tools");
// dir_1782242371780 (correction): final-status mapping lives in a dependency-free
// module so it is the single source of truth AND unit-testable without this file's
// Docker-absolute require tree. Re-exported below for callers that import from here.
const { computeFinalStatus } = require("./offense-final-status");

// dir_1780969435006: dual-model SOTA. Synthesizer (compact JSON + bash) uses
// SYNTH_MODEL_*; falls back to OFFENSE_MODEL_* when not set so legacy
// single-model deploys keep working.
const MODEL_URL  = process.env.OFFENSE_SYNTH_MODEL_URL  || process.env.OFFENSE_MODEL_URL  || "http://127.0.0.1:11434/v1";
const MODEL_NAME = process.env.OFFENSE_SYNTH_MODEL_NAME || process.env.OFFENSE_MODEL_NAME || "qwen3:32b";
const MODEL_KEY  = process.env.OFFENSE_MODEL_KEY  || "";

const DEFAULT_MAX_ITER = 30;

// dir_1782238863765 Part 2 — watchdog default for wait_for_outcome in the
// autonomous loop. 120 seconds: if a queued step hasn't started executing
// (status still 'pending') after 2 minutes, the watchdog fires and the agent
// continues. Operators who want human-in-loop approval (PA runs each step
// manually) should pass wait_timeout_sec=1800 in start_engagement_run opts.
const DEFAULT_WAIT_TIMEOUT_SEC = 120; // 2 minutes

// ─────────── loop-breaker constants (dir_1782234450321) ───────────────────────
// When the orchestrator picks tasks that map to the same engagement phase
// MAX_CONSECUTIVE_INTENT times in a row, it's stuck in a loop. Force-advance
// the phase instead of asking the model again.
const MAX_CONSECUTIVE_INTENT = 6;

// Phase order for the one-way ratchet (change 2 is enforced at the advance_phase
// call site in offense-agent-tools.js; this order is also used here when the
// loop-breaker forces an advance).
const PHASE_ORDER = ["recon", "enumeration", "foothold", "exploitation", "post_exploit", "reporting"];

// ─────────────────────────────── shared prompts ───────────────────────────────

const AGENT_SYSTEM_PROMPT_BASE = [
  "You are the L3 offensive-research agent for an AUTHORIZED penetration-testing engagement.",
  "",
  "You operate AUTONOMOUSLY within scope: the commands you queue EXECUTE on their own through the harness — drive the engagement end-to-end through every phase; do NOT stop and wait for a human to run each step. (The operator can pause or stop you from the SOC app at any time.)",
  "",
  "EXECUTION ENVIRONMENT (this OVERRIDES any assumption from the executor's name):",
  "  - Your commands run on a LINUX host with a full pentest toolset (nmap, netcat, curl, dig, etc.). You are NOT on the Android tablet — do NOT use Android-only tools (dumpsys, getprop, pm, settings); they don't exist here. Write standard Linux commands.",
  "  - The lab subnet is reached through a WireGuard L3 relay to the tablet (the tablet is the L3 doorway INTO the lab, not where you run). Because WireGuard is an L3 tunnel:",
  "    • ARP does NOT cross WireGuard — nmap's default ARP host-discovery reports 0 hosts. ALWAYS add `--disable-arp-ping` so nmap uses ICMP/TCP discovery instead.",
  "    • Use `-sT` (TCP connect scan) for port scanning — raw SYN (`-sS`) may not work across the relay.",
  "    • Do NOT combine `-sn` (ping sweep, no ports) with any port-scan flag (`-sT`, `-sS`, `-sV`, etc.) — nmap rejects it.",
  "    • ICMP ping DOES cross the relay (~240ms RTT). Host discovery works; just disable ARP.",
  "    • Scans take longer over the relay. A /24 sweep may take 3-5 minutes. This is normal.",
  "",
  "VULNERABILITY RESEARCH → EXPLOITATION (you have a local exploit DB + active CVE scanner + read-only CVE internet access):",
  "  - When you identify a service AND version (e.g. a Hikvision camera web UI, Dropbear SSH 2022.83), do NOT just record it as a finding — RESEARCH its known vulnerabilities, then EXPLOIT them. The version→CVE→exploit chain is the entire point of enumeration; cataloging services without attacking them is a failure.",
  "  - Available on this Linux host: `searchsploit <product> <version>` (offline ExploitDB — already holds 8 Hikvision + 3 Dropbear entries for this lab), `nuclei -u <url> -tags cve` (active CVE-template scan of an IN-SCOPE target), and read-only CVE lookups via `curl` to cve.circl.lu / services.nvd.nist.gov / www.exploit-db.com (these RESEARCH domains are allowed even though they're outside the engagement scope — only ATTACK traffic is scope-restricted to the lab).",
  "  - Then SELECT the best-matching exploit/PoC (by EDB-ID or CVE) and run it against the in-scope target. If an enumerated service has a public exploit, attempt it before declaring the host done.",
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
  "  - search_sploitus(query) for CVE→PoC and product→PoC mappings. Aggregates ExploitDB + Packet Storm + Vulners + GitHub PoCs + Metasploit — broader than search_exploits. Use when verify_cve confirms a CVE exists and you want a working PoC reference.",
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
    const payload = JSON.stringify({ model: modelOverride || MODEL_NAME, messages, temperature: 0.2, stream: false, max_tokens: parseInt(process.env.OFFENSE_MAX_TOKENS, 10) || 8000 });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (MODEL_KEY) headers.Authorization = `Bearer ${MODEL_KEY}`;
    // dir_1780786724856: see note in offense-orchestrator.js
    const reqAgent = new lib.Agent({ keepAlive: false });
    const req = lib.request(url, { method: "POST", headers, timeout: 180000, agent: reqAgent }, (res) => {
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
    const payload = JSON.stringify({ model: modelOverride || MODEL_NAME, messages, tools: TOOL_SCHEMAS, temperature: 0.2, stream: false, max_tokens: parseInt(process.env.OFFENSE_MAX_TOKENS, 10) || 8000 });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (MODEL_KEY) headers.Authorization = `Bearer ${MODEL_KEY}`;
    // dir_1780786724856: see note in offense-orchestrator.js
    const reqAgent = new lib.Agent({ keepAlive: false });
    const req = lib.request(url, { method: "POST", headers, timeout: 180000, agent: reqAgent }, (res) => {
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

// dir_1780965304265: reasoning-model aware JSON extraction. See full comment
// in offense-orchestrator.js — kept in sync.
function stripThinkingBlocks(raw) {
  let s = String(raw || "");
  s = s.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (/<think>/i.test(s) && !/<\/think>/i.test(s)) {
    const i = s.indexOf("\n\n");
    if (i !== -1) s = s.slice(i + 2);
  }
  const thinkingHeaderRe = /^\s*(?:Thinking\s+Process|Reasoning|Analysis|Let me think|Step\s+\d+)\s*:?/im;
  if (thinkingHeaderRe.test(s)) {
    const last = s.lastIndexOf("\n{");
    if (last !== -1) s = s.slice(last + 1);
  }
  return s;
}

function parseJSON(raw) {
  const stripped = stripThinkingBlocks(raw);
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  return JSON.parse(stripped || raw);
}

// ───────────────────────────── engagement context + state ─────────────────────────────

async function loadEngagementContext(engagementId) {
  const eng = await db.query(
    `SELECT id, engagement_type, scope, roe, status,
            executor_host, executor_adb_target, executor_tools,
            engagement_phase, agent_run_state, agent_status,
            graph_mode_enabled, permission_mode
       FROM pentest_engagements WHERE id = $1`, [engagementId]);
  if (eng.rows.length === 0) return { engagement: null };
  const [hosts, findings, queue, subAgents] = await Promise.all([
    db.query(`SELECT ip, hostname, status, ports FROM recon_hosts WHERE engagement_id = $1 ORDER BY ip`, [engagementId]),
    db.query(`SELECT id, title, severity, status, affected_asset, affected_assets, refs, kind, informed_by, enables, sub_agent_id
                FROM pentest_findings WHERE engagement_id = $1 ORDER BY discovered_at`, [engagementId]),
    db.query(`SELECT seq, title, status, LEFT(COALESCE(command,''),400) AS command_preview, LEFT(COALESCE(output,''),2000) AS output_preview
                FROM soc_queue_items WHERE engagement_id = $1 AND status IN ('done','failed','cancelled')
                ORDER BY seq DESC LIMIT 20`, [engagementId]),
    // dir_1780848456715: sub-agent inventory for coordinator's global view
    db.query(`SELECT id, target_host, target_role, status, iter, max_iter, objective,
                     permission_mode_override, last_action,
                     total_findings, total_queue_items,
                     created_at, started_at, completed_at
                FROM engagement_sub_agents WHERE engagement_id = $1 ORDER BY id ASC`, [engagementId]),
  ]);
  // Materialize the attack graph rendering iff this engagement opted in.
  // Otherwise the legacy flat-findings list is what the orchestrator sees
  // (no behavior change for engagements that didn't flip the flag). See
  // feedback_soc_observer_role.md + dir_1780781999942.
  let findingGraphRendered = null;
  if (eng.rows[0].graph_mode_enabled) {
    try {
      const { materializeFindingGraph, renderForPrompt } = require("/app/soc/finding-graph");
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
    sub_agents: subAgents.rows,
    finding_graph_rendered: findingGraphRendered,
  };
}

async function setAgentStatus(engagementId, status, extras) {
  // dir_1780832189054: merge new fields into existing agent_run_state instead
  // of replacing it. Lets `last_intent`/`max_iter`/`started_at` set on the
  // initial run-start call survive per-iter updates that only carry iter/
  // last_action — so the bridge-startup auto-resume IIFE can recover them.
  const payload = JSON.stringify({ ...(extras || {}) });
  await db.query(
    `UPDATE pentest_engagements
        SET agent_status = $1,
            agent_run_state = COALESCE(agent_run_state, '{}'::jsonb) || $2::jsonb
      WHERE id = $3`,
    [status, payload, engagementId]);
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

  // dir_1782251824781 Fix 3 — inference-hang retry.
  // On a 120s synthesis timeout (synthesizer timeout error from chatJSON), do ONE
  // bounded retry with a short backoff before counting the iteration wasted. This
  // converts a transient DeepSeek latency spike from a full iter loss into a ≤4s
  // extra wait. Only ONE retry so the total synthesis budget stays bounded; a
  // second successive timeout escalates to a hard failure as before.
  const SYNTH_RETRY_BACKOFF_MS = 4000;
  let raw;
  try {
    raw = await chatJSON([
      { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
      { role: "user",   content: userMsg },
    ], modelOverride);
  } catch (firstErr) {
    const isHang = firstErr && (
      /timeout/i.test(firstErr.message) ||
      /ETIMEDOUT|ECONNRESET|socket hang up/i.test(firstErr.message)
    );
    if (isHang) {
      console.warn(`[offense-agent] synthesizer hang on first attempt (${firstErr.message.slice(0,80)}) — retrying after ${SYNTH_RETRY_BACKOFF_MS}ms (dir_1782251824781 Fix 3)`);
      try {
        await db.query(
          `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'synthesizer', 'synthesis', 0, 0, false, true, 0, 0, 'inference_hung_retry', $2)`,
          [ctx.engagement && ctx.engagement.id, `first_attempt_timeout; backoff=${SYNTH_RETRY_BACKOFF_MS}ms; err=${firstErr.message.slice(0,80)}`]);
      } catch (_) {}
      await new Promise(r => setTimeout(r, SYNTH_RETRY_BACKOFF_MS));
      raw = await chatJSON([
        { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
        { role: "user",   content: userMsg },
      ], modelOverride);
    } else {
      throw firstErr;
    }
  }
  try { return parseJSON(raw); }
  catch (e) {
    // dir_1780841672508: Reflector recovery for synthesizer prose
    try {
      const { performReflector } = require("/app/soc/execution-monitor");
      const corrected = await performReflector({
        rawText: raw,
        expectedFormat: "JSON",
        schemaHint: '{"command": "<exact shell command>", "expected_artifact": "<optional>", "rationale": "<one-line WHY>"}',
      });
      const parsed = parseJSON(corrected);
      try {
        const dbMod = require("/app/db");
        await dbMod.query(
          `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'reflector', 'synthesizer', 0, 0, false, true, 0, 0, 'reflector_invoked', $2)`,
          [ctx.engagement && ctx.engagement.id, `parse_err=${(e.message||"").slice(0,80)}; recovered=true`]);
      } catch (_) {}
      return parsed;
    } catch (re) {
      throw new Error(`synthesizer JSON parse failed: ${e.message} (reflector also failed: ${re.message})`);
    }
  }
}

async function runAgent(engagementId, opts = {}) {
  const maxIter = Number(opts.max_iter) > 0 ? Number(opts.max_iter) : DEFAULT_MAX_ITER;
  const intent  = opts.intent || null;
  const modelOverride = opts.model_override || null;
  // dir_1782238863765: default changed from 1800→DEFAULT_WAIT_TIMEOUT_SEC (120s).
  // Autonomous mode should not wait 30 minutes for a step that got blocked.
  // Human-in-loop callers pass wait_timeout_sec=1800 explicitly.
  const waitTimeoutSec = Number(opts.wait_timeout_sec) > 0 ? Number(opts.wait_timeout_sec) : DEFAULT_WAIT_TIMEOUT_SEC;

  // dir_1782242371780: halt-detection wall clock — if no new step has been queued
  // for this many milliseconds while agent_status='running', the loop is dark and
  // must conclude rather than idle silently. 5 minutes is generous; watchdog fires
  // at 2min on pending steps, so this catches the "no pending step, no new queues"
  // dark-loop case that the watchdog cannot reach.
  const HALT_TIMEOUT_MS = 300000; // 5 minutes

  // Initial state push so the operator sees status=running immediately
  // dir_1780832189054: persist intent + max_iter so the bridge-startup
  // auto-resume can re-invoke with the same params after a restart.
  await setAgentStatus(engagementId, "running", {
    iter: 0, tasks_added: 0, steps_queued: 0,
    started_at: new Date().toISOString(),
    last_intent: intent || null,
    max_iter: maxIter,
  });

  const startMs = Date.now();
  let iter = 0;
  let stepsQueued = 0;
  let tasksAdded  = 0;
  let endedByOrchestrator = false;
  // dir_1782242371780 (correction): a harness-FORCED abnormal halt (loop-breaker on
  // a terminal phase, dark-loop halt-timeout, or stall exhaustion) is NOT a clean
  // model-driven conclusion. The prior fix stamped these 'completed', which hid them
  // from the boot scanner (resumes 'running' only) and the fleet diagnostic. Track
  // them distinctly so computeFinalStatus() maps them to 'halted'.
  let haltedAbnormally = false;
  let endReason = null;
  let lastDecision = null;

  // dir_1780838519357: PentAGI-style Mentor + Planner.
  let monitor = null;
  let plannerPlan = null;
  let mentorGuidance = null;
  try {
    const { ExecutionMonitor, performPlanner } = require("/app/soc/execution-monitor");
    // Pull engagement flags + thresholds once at start
    const flagsRow = await db.query(
      `SELECT mentor_enabled, planner_enabled, mentor_same_threshold, mentor_total_threshold
         FROM pentest_engagements WHERE id=$1`, [engagementId]);
    const flags = flagsRow.rows[0] || {};
    monitor = new ExecutionMonitor({
      sameThreshold: Number(flags.mentor_same_threshold) || 3,
      totalThreshold: Number(flags.mentor_total_threshold) || 10,
      enabled: flags.mentor_enabled !== false,
    });
    // dir_1780959393553: rebuild shape counters from queue history so a
    // bridge restart mid-engagement doesn't reset loop detection.
    try { await monitor.hydrateFromQueue(engagementId, db); } catch (_) {}
    if (flags.planner_enabled !== false && intent) {
      try {
        // Brief engagement context for the planner (scope + recent findings)
        const ctxPreview = await loadEngagementContext(engagementId);
        const engPreview = ctxPreview && ctxPreview.engagement ? ctxPreview.engagement : null;
        const findingsPreview = (ctxPreview && Array.isArray(ctxPreview.findings))
          ? ctxPreview.findings.slice(0, 12).map(f => `[${f.severity}] ${f.title || ""}`).join("\n")
          : "";
        const hostsPreview = (ctxPreview && Array.isArray(ctxPreview.hosts))
          ? ctxPreview.hosts.slice(0, 8).map(h => `${h.ip}${h.status ? " (" + h.status + ")" : ""}`).join(", ")
          : "";
        const engagementContext = [
          engPreview ? `Engagement ${engPreview.id}, type=${engPreview.engagement_type}, phase=${engPreview.engagement_phase || "recon"}` : "",
          engPreview && engPreview.scope ? `Scope: ${JSON.stringify(engPreview.scope).slice(0, 800)}` : "",
          hostsPreview ? `Live hosts: ${hostsPreview}` : "",
          findingsPreview ? `Recent findings:\n${findingsPreview}` : "",
        ].filter(Boolean).join("\n");
        const planResult = await performPlanner({
          agentType: "offense orchestrator",
          taskQuestion: intent,
          engagementContext,
        });
        plannerPlan = planResult.plan;
        console.log(`[offense-agent] Planner produced ${plannerPlan.length} char plan for engagement ${engagementId}`);
        try {
          await db.query(
            `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
             VALUES ($1, NULL, 'planner', 'planning', 0, 0, false, true, 0, 0, 'planner_invoked', $2)`,
            [engagementId, `plan length=${plannerPlan.length}`]);
        } catch (_) {}
      } catch (e) {
        console.error(`[offense-agent] Planner failed:`, e.message);
      }
    }
  } catch (e) {
    console.error(`[offense-agent] Mentor/Planner module load failed:`, e.message);
  }

  let stallStreak = 0; // consecutive empty orchestrator decisions — don't quit on the first one

  // dir_1782234450321: loop-breaker — track consecutive engagement phases to
  // detect when the orchestrator is cycling the same phase without advancing.
  let consecutivePhaseStreak = 0;
  let lastSeenPhase = null;

  // dir_1782242371780: halt-detection — track the wall-clock time of the last
  // step queued. If no step is queued for HALT_TIMEOUT_MS while we're running,
  // conclude with 'loop_halted' telemetry instead of staying stuck at 'running'.
  let lastStepQueuedAt = Date.now();

  while (iter < maxIter) {
    iter++;

    // Build engagement context fresh each iteration (Aggregator may have added findings/hosts)
    const ctx = await loadEngagementContext(engagementId);
    if (!ctx.engagement) {
      await setAgentStatus(engagementId, "error", { iter, error: "engagement not found" });
      return { engagement_id: engagementId, ok: false, iter, reason: "engagement not found", elapsed_sec: Math.round((Date.now()-startMs)/1000) };
    }

    // Operator Stop: the app's Stop control sets agent_run_state.abort_requested. Honor it at the
    // iteration boundary so a run halts cleanly after the current step finishes (RULE 3: the
    // operator controls execution via the app). dir_1782172690399.
    if (ctx.engagement.agent_run_state && ctx.engagement.agent_run_state.abort_requested) {
      await setAgentStatus(engagementId, "paused", { iter, end_reason: "operator stopped the run" });
      return { engagement_id: engagementId, ok: true, iter, ended_by_model: false, end_reason: "operator_stopped", elapsed_sec: Math.round((Date.now()-startMs)/1000) };
    }

    // dir_1782243745921 Fix 3: reconciliation sweep — resolve any 'pending' items
    // that are older than ORPHAN_TIMEOUT_SEC with no active execution. These are
    // items whose synthesis hung (inference timed out) or whose run endpoint call
    // failed silently without writing a terminal status. Fires at the top of each
    // iteration so the orchestrator never sees ghost-pending items when deciding
    // whether there's pending work in flight.
    try {
      const { reconcilePendingItems } = require("/app/soc/autonomous-executor");
      await reconcilePendingItems(engagementId);
    } catch (e) {
      console.error(`[offense-agent] reconcile sweep failed:`, e.message);
    }

    // dir_1780845298918: recovery_recipes — detect known failure scenarios and
    // apply structured recovery before this iter's model call. Saves a model
    // call when executor is offline + auto-paces fabrication streaks.
    try {
      const recovery = require("/app/infra/recovery-recipes");
      const [tel, qi] = await Promise.all([
        db.query(
          `SELECT outcome, outcome_notes FROM offense_telemetry
            WHERE engagement_id=$1 ORDER BY id DESC LIMIT 10`, [engagementId]),
        db.query(
          `SELECT id, command, output, status FROM soc_queue_items
            WHERE engagement_id=$1 ORDER BY id DESC LIMIT 10`, [engagementId]),
      ]);
      const mentorFires = tel.rows.filter(t => t.outcome === "mentor_invoked").length;
      const hit = recovery.detectFailureScenario({
        telemetry: tel.rows.slice().reverse(),
        queueItems: qi.rows.slice().reverse(),
        mentorFires,
      });
      if (hit) {
        console.log(`[offense-agent] recovery scenario detected: ${hit.scenario} — ${hit.evidence}`);
        const result = await recovery.applyRecovery(db, ctx.engagement, hit);
        if (result && result.escalated) {
          await setAgentStatus(engagementId, "paused", {
            iter,
            recovery_scenario: hit.scenario,
            recovery_attempts: result.attempts,
            last_action: "recovery_escalated",
          });
          return {
            engagement_id: engagementId,
            ok: false,
            iter,
            reason: `recovery_escalated: ${hit.scenario} (${result.attempts}/${result.max_attempts} attempts) — engagement paused, operator must restart`,
            recovery_scenario: hit.scenario,
            tasks_added: tasksAdded,
            steps_queued: stepsQueued,
            elapsed_sec: Math.round((Date.now()-startMs)/1000),
          };
        }
        if (result && result.mentor_hint) {
          // Inject the recovery hint as the mentor guidance for THIS iter.
          // Override any prior mentor guidance — recovery is the freshest signal.
          mentorGuidance = result.mentor_hint;
        }
        if (result && result.skip_host) {
          // Tag the host as deprioritized via engagement scope hint
          try {
            await db.query(
              `UPDATE pentest_engagements
                  SET agent_run_state = COALESCE(agent_run_state, '{}'::jsonb)
                                      || jsonb_build_object('deprioritized_hosts',
                                           COALESCE(agent_run_state->'deprioritized_hosts', '[]'::jsonb)
                                           || $2::jsonb)
                WHERE id = $1`,
              [engagementId, JSON.stringify([result.skip_host])]);
          } catch (_) {}
        }
      }
    } catch (e) {
      console.error(`[offense-agent] recovery check failed:`, e.message);
    }

    // dir_1780838519357: inject Planner plan + Mentor guidance into orchestrator context
    if (plannerPlan) ctx.planner_plan = plannerPlan;
    if (mentorGuidance) ctx.mentor_guidance = mentorGuidance;

    // dir_1782234450321 — LOOP-BREAKER: detect consecutive same-phase iters.
    // The orchestrator's `task.phase` tells us which engagement phase the chosen
    // task belongs to. We approximate this from `ctx.engagement.engagement_phase`
    // (updated by advance_phase calls) which reflects the current phase at loop
    // entry. When MAX_CONSECUTIVE_INTENT iters fire in the same phase without
    // any advance, force the phase forward via the advance_phase tool.
    {
      const currentPhase = (ctx.engagement && ctx.engagement.engagement_phase) || "recon";
      if (currentPhase === lastSeenPhase) {
        consecutivePhaseStreak++;
      } else {
        consecutivePhaseStreak = 1;
        lastSeenPhase = currentPhase;
      }
      if (consecutivePhaseStreak >= MAX_CONSECUTIVE_INTENT) {
        const currentIdx = PHASE_ORDER.indexOf(currentPhase);
        const nextPhase = currentIdx >= 0 && currentIdx < PHASE_ORDER.length - 1
          ? PHASE_ORDER[currentIdx + 1]
          : null;
        if (nextPhase) {
          console.log(`[offense-agent] loop-breaker: phase '${currentPhase}' repeated ${consecutivePhaseStreak}× — forcing advance to '${nextPhase}'`);
          try {
            await dispatch("advance_phase", { engagement_id: engagementId, new_phase: nextPhase });
            try {
              await db.query(
                `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
                 VALUES ($1, NULL, 'loop_breaker', 'phase_advance', 0, 0, false, true, 0, 0, 'forced_phase_advance', $2)`,
                [engagementId, `phase=${currentPhase} → ${nextPhase}; streak=${consecutivePhaseStreak}; iter=${iter}`]);
            } catch (_) {}
          } catch (e) {
            console.error(`[offense-agent] loop-breaker advance_phase failed:`, e.message);
          }
          consecutivePhaseStreak = 0;
          lastSeenPhase = nextPhase;
          // Inject mentor hint so the orchestrator knows why we advanced
          mentorGuidance = `[LOOP-BREAKER dir_1782234450321] Phase '${currentPhase}' repeated ${MAX_CONSECUTIVE_INTENT}+ times with no advance — automatically advanced to '${nextPhase}'. DO NOT return to '${currentPhase}' or earlier phases. Focus exclusively on '${nextPhase}' tasks: ${nextPhase === "foothold" ? "gaining initial access via confirmed attack vectors from enumeration" : nextPhase === "exploitation" ? "extending the foothold — privesc, additional service exploitation" : nextPhase === "enumeration" ? "version probes and attack-vector identification" : "post-access actions per phase guidance"}.`;
          ctx.mentor_guidance = mentorGuidance;
        } else {
          // dir_1782242371780 (correction): terminal phase reached, loop-breaker has
          // nowhere to advance. This is a HARNESS-FORCED abnormal halt — the model never
          // called end_engagement, the loop-breaker hit the end of PHASE_ORDER and forced a
          // stop. The prior fix stamped this 'completed', which hid it from the boot scanner
          // (resumes 'running' only) and the fleet diagnostic. Mark it haltedAbnormally so
          // computeFinalStatus() maps it to the distinct 'halted' status, and keep
          // endedByOrchestrator FALSE (a model end is the only thing that may set it).
          console.log(`[offense-agent] loop-breaker: phase '${currentPhase}' is terminal (no next phase) and repeated ${consecutivePhaseStreak}× — force-halting engagement (dir_1782242371780)`);
          endReason = `loop-breaker: terminal phase '${currentPhase}' repeated ${consecutivePhaseStreak}× with no end_engagement call — auto-halted (dir_1782242371780)`;
          try {
            await db.query(
              `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
               VALUES ($1, NULL, 'loop_breaker', 'terminal_phase', 0, 0, false, true, 0, 0, 'engagement_concluded', $2)`,
              [engagementId, `phase=${currentPhase}; streak=${consecutivePhaseStreak}; iter=${iter}; steps_queued=${stepsQueued}`]);
          } catch (_) {}
          haltedAbnormally = true; // harness-forced halt → finalStatus 'halted' (NOT 'completed')
          break;
        }
      }
    }

    // (1) Orchestrator decides — retry with reflector on parse failure (dir_1782331356896)
    let decision;
    {
      const MAX_ORCH_RETRIES = 3;
      let orchErr;
      for (let attempt = 0; attempt < MAX_ORCH_RETRIES; attempt++) {
        try {
          decision = await orchestrator.decide(ctx, modelOverride);
          orchErr = null;
          break;
        } catch (e) {
          orchErr = e;
          if (attempt < MAX_ORCH_RETRIES - 1) {
            console.log(`[offense-agent] orchestrator.decide() failed (attempt ${attempt+1}/${MAX_ORCH_RETRIES}): ${e.message} — retrying`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
      if (orchErr) {
        await setAgentStatus(engagementId, "error", { iter, error: orchErr.message });
        return { engagement_id: engagementId, ok: false, iter, reason: `orchestrator failed after ${MAX_ORCH_RETRIES} attempts: ${orchErr.message}`, steps_queued: stepsQueued, tasks_added: tasksAdded, elapsed_sec: Math.round((Date.now()-startMs)/1000) };
      }
    }
    lastDecision = decision;

    // (2) Add any new tasks proposed
    let insertedTaskRows = [];
    if (Array.isArray(decision.add) && decision.add.length) {
      insertedTaskRows = await orchestrator.addTasks(engagementId, decision.add);
      tasksAdded += insertedTaskRows.length;
    }
    // dir_1780848456715: process coordinator_actions[] — spawn/terminate/reprompt/await
    if (Array.isArray(decision.coordinator_actions) && decision.coordinator_actions.length) {
      try {
        const sa = require("/app/soc/offense-sub-agent");
        for (const action of decision.coordinator_actions) {
          try {
            if (action.kind === "spawn_sub_agent" && typeof action.target_host === "string") {
              const r = await sa.spawnSubAgent({
                engagement_id: engagementId,
                target_host: action.target_host,
                target_role: action.target_role || null,
                objective: action.objective || `Investigate ${action.target_host}`,
                permission_mode_override: action.permission_mode_override || null,
                spawned_by: "coordinator",
                spawned_reason: `iter ${iter} coordinator decision`,
              });
              console.log(`[offense-agent] coordinator spawned sub-agent #${r && r.id} for ${action.target_host}`);
              await db.query(
                `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
                 VALUES ($1, NULL, 'coordinator', 'spawn_sub_agent', 0, 0, false, true, 0, 0, 'sub_agent_spawned', $2)`,
                [engagementId, `sub#${r && r.id} target=${action.target_host} role=${action.target_role || "none"}`]);
            } else if (action.kind === "terminate_sub_agent" && Number.isInteger(action.sub_agent_id)) {
              const r = await sa.terminateSubAgent(action.sub_agent_id, action.reason || `coordinator iter ${iter}`);
              await db.query(
                `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
                 VALUES ($1, NULL, 'coordinator', 'terminate_sub_agent', 0, 0, false, true, 0, 0, 'sub_agent_terminated', $2)`,
                [engagementId, `sub#${action.sub_agent_id} reason=${(action.reason || "").slice(0, 200)}`]);
            } else if (action.kind === "reprompt_sub_agent" && Number.isInteger(action.sub_agent_id) && typeof action.new_objective === "string") {
              await db.query(
                `UPDATE engagement_sub_agents
                    SET objective = $2,
                        agent_run_state = COALESCE(agent_run_state, '{}'::jsonb)
                                        || jsonb_build_object('coordinator_reprompt', $3::text,
                                                              'coordinator_reprompt_iter', $4::int)
                  WHERE id = $1 AND status IN ('running','paused','pending')`,
                [action.sub_agent_id, action.new_objective.slice(0, 1000), action.new_objective.slice(0, 1000), iter]);
              await db.query(
                `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
                 VALUES ($1, NULL, 'coordinator', 'reprompt_sub_agent', 0, 0, false, true, 0, 0, 'sub_agent_reprompted', $2)`,
                [engagementId, `sub#${action.sub_agent_id} new_objective="${action.new_objective.slice(0, 200)}"`]);
            } else if (action.kind === "await_sub_agents" && Number.isInteger(action.min_count)) {
              const waitSec = Math.min(900, Math.max(5, action.max_wait_sec || 60));
              await setAgentStatus(engagementId, "awaiting_subs", { iter, awaiting_min: action.min_count, max_wait_sec: waitSec });
              const deadline = Date.now() + waitSec * 1000;
              let completed = 0;
              while (Date.now() < deadline) {
                const c = await db.query(
                  `SELECT COUNT(*)::int AS c FROM engagement_sub_agents
                    WHERE engagement_id = $1 AND status IN ('completed','failed','terminated')`,
                  [engagementId]);
                completed = c.rows[0].c;
                if (completed >= action.min_count) break;
                await new Promise(rs => setTimeout(rs, 5000));
              }
              await db.query(
                `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
                 VALUES ($1, NULL, 'coordinator', 'await_sub_agents', 0, 0, false, true, 0, 0, 'await_completed', $2)`,
                [engagementId, `min=${action.min_count} actual=${completed} wait_sec=${waitSec}`]);
              await setAgentStatus(engagementId, "running", { iter, last_action: `await_done(${completed}/${action.min_count})` });
            }
          } catch (e) { console.error(`[offense-agent] coordinator_action ${action.kind} failed:`, e.message); }
        }
      } catch (e) { console.error(`[offense-agent] coordinator_actions processing failed:`, e.message); }
    }
    // dir_1780842283437: Refiner picked one of the proposed adds — select the
    // inserted row immediately so this iter actually executes work instead of
    // looping back to decide() again ("added_tasks_no_select" stall).
    // orchestrator.addTasks returns an array of inserted task IDs (numbers).
    if (decision._refiner_select_proposed && insertedTaskRows.length > 0 && decision.select == null) {
      decision.select = insertedTaskRows[0];
    }

    // (3) Phase advance?
    if (decision.advance_phase) {
      await dispatch("advance_phase", { engagement_id: engagementId, new_phase: decision.advance_phase });
      // dir_1782234450321: a normal model-driven phase advance resets the streak
      consecutivePhaseStreak = 0;
      lastSeenPhase = decision.advance_phase;
    }

    // (4) End?
    if (decision.end) {
      endedByOrchestrator = true;
      endReason = decision.end;
      break;
    }

    // (5) No selection. Be PATIENT — DeepSeek intermittently returns a thin decision, and during the
    // multi-agent fan-out the coordinator legitimately has "nothing to pick" while sub-agents are still
    // scanning. Don't quit on the first one: while there's pending/running work in the queue, wait +
    // re-orchestrate (a pure wait must NOT burn the iteration budget); only stall out after a few
    // empties with nothing in flight, or a hard patience cap. 2026-06-23.
    if (decision.select == null) {
      if (decision.add && decision.add.length) {
        stallStreak = 0;
        await setAgentStatus(engagementId, "running", { iter, tasks_added: tasksAdded, steps_queued: stepsQueued, last_action: "added_tasks_no_select" });
        continue;
      }
      // Non-productive turn attribution: orchestrator gave no selection → other
      try {
        await db.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'harness', 'non_productive_turn',
                   0, 0, false, true, 0, 0, 'other', $2)`,
          [engagementId, `iter=${iter}; orchestrator_no_select; stall_streak=${stallStreak}`]);
      } catch (_) {}
      stallStreak++;
      const workRow = await db.query(
        `SELECT COUNT(*)::int AS n FROM soc_queue_items WHERE engagement_id = $1 AND status IN ('pending','running')`,
        [engagementId]).catch(() => ({ rows: [{ n: 0 }] }));
      const haveWork = !!(workRow.rows[0] && workRow.rows[0].n > 0);
      // dir_1782242371780: Fix 3 (halt detection) — if no step has been queued for
      // HALT_TIMEOUT_MS AND there's no pending work, the loop is dark. Conclude with
      // a distinct 'loop_halted' telemetry outcome so analyze_engagement_telemetry
      // surfaces it as a WARNING. This catches the case where the watchdog cannot
      // fire (no pending step) but the loop is also not making progress.
      const haltTimeoutExpired = (Date.now() - lastStepQueuedAt) > HALT_TIMEOUT_MS;
      if ((stallStreak >= 3 && !haveWork) || stallStreak >= 30 || (haltTimeoutExpired && !haveWork)) {
        const haltedByTimeout = haltTimeoutExpired && !haveWork && stallStreak < 30;
        endReason = haltedByTimeout
          ? `loop dark for ${Math.round((Date.now()-lastStepQueuedAt)/1000)}s with no pending work — loop_halted (dir_1782242371780)`
          : `orchestrator gave no task ${stallStreak}× (work in flight: ${haveWork}) — engagement exhausted`;
        // dir_1782242371780 (correction): EVERY path through this break is a harness-forced
        // dark-loop/stall halt — the model never ended and the iter cap wasn't hit. Mark it
        // haltedAbnormally so the final status is 'halted', not 'error' (and never 'completed').
        haltedAbnormally = true;
        if (haltedByTimeout) {
          try {
            await db.query(
              `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
               VALUES ($1, NULL, 'halt_detector', 'loop_health', 0, 0, false, true, 0, 0, 'loop_halted', $2)`,
              [engagementId, `halt_timeout=${Math.round((Date.now()-lastStepQueuedAt)/1000)}s; stall_streak=${stallStreak}; iter=${iter}; steps_queued=${stepsQueued}`]);
          } catch (_) {}
        }
        break;
      }
      // transient empty, or sub-agents still scanning — wait, then re-orchestrate. A pure wait must
      // not consume the iteration budget, so undo this turn's iter++.
      await setAgentStatus(engagementId, "running", { iter, last_action: `no_select_wait (${stallStreak}, work=${haveWork})` });
      await new Promise((r) => setTimeout(r, 4000));
      if (iter > 0) iter--;
      continue;
    }
    stallStreak = 0;

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
      // Non-productive turn attribution: synthesizer threw — classify cause
      const isHangErr = e && /timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(e.message || "");
      try {
        await db.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'harness', 'non_productive_turn',
                   0, 0, false, true, 0, 0, $2, $3)`,
          [engagementId,
           isHangErr ? "infra_hang" : "prose_only",
           `iter=${iter}; task=${task.id}; synthesizer_err=${(e.message||"").slice(0,120)}`]);
      } catch (_) {}
      continue;
    }
    // dir_1782331356896: retry synthesis once on empty command before giving up
    if (!step || typeof step.command !== "string" || !step.command.trim()) {
      console.log(`[offense-agent] synthesizer returned no command for task ${task.id} — retrying once`);
      try {
        step = await synthesizeCommand(task, ctx, modelOverride);
      } catch (_) { step = null; }
      if (!step || typeof step.command !== "string" || !step.command.trim()) {
        await orchestrator.completeTask(task.id, "skipped", {
          success: false,
          key_signals: ["synthesizer returned no command (after retry)"],
          new_findings: [], new_hosts: [], followup: [], error_category: null,
        });
        try {
          await db.query(
            `INSERT INTO offense_telemetry
               (engagement_id, queue_item_id, model_used, intent_category,
                n_hosts, n_findings, step_queued, in_scope, n_references,
                latency_ms, outcome, outcome_notes)
             VALUES ($1, NULL, 'harness', 'non_productive_turn',
                     0, 0, false, true, 0, 0, 'prose_only', $2)`,
            [engagementId, `iter=${iter}; task=${task.id}; no_command_after_retry`]);
        } catch (_) {}
        continue;
      }
    }

    // dir_1780854966869: register synthesized command's canonical shape so
    // Mentor's shape-based loop detection catches synthesizer-level repetition.
    if (monitor && typeof monitor.recordCommandShape === "function") {
      try { monitor.recordCommandShape(step.command); } catch (_) {}
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
      // Non-productive turn attribution: queue_step rejected the step → lint_reject
      try {
        await db.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'harness', 'non_productive_turn',
                   0, 0, false, true, 0, 0, 'lint_reject', $2)`,
          [engagementId, `iter=${iter}; task=${task.id}; queue_err=${(queueResult.error||"no queue_id").slice(0,120)}`]);
      } catch (_) {}
      continue;
    }
    await orchestrator.linkQueueItem(task.id, queueResult.queue_id);
    stepsQueued++;
    lastStepQueuedAt = Date.now(); // dir_1782242371780: reset halt-detection clock on every successful queue
    await setAgentStatus(engagementId, "running", { iter, tasks_added: tasksAdded, steps_queued: stepsQueued, last_action: `queued ${queueResult.queue_id}` });

    // (9) Wait for PA to run the queue item
    let outcome = await dispatch("wait_for_outcome", { queue_item_id: queueResult.queue_id, timeout_sec: waitTimeoutSec });
    // dir_1782308369939: a step still 'running' at the wait timeout is a long scan
    // PROGRESSING over the high-latency lab relay (~240ms RTT), NOT a frozen step. The
    // 120s leash was abandoning live recon → 0 hosts → loop-breaker force-advance → dead
    // end (e.g. SKYLINE-SOC-2026-431). Keep waiting (bounded) while it stays 'running'.
    // A 'pending'-at-timeout step never started (synthesis hung) and is NOT extended —
    // that stays a real fast-fail, preserving the dir_1782238863765 watchdog intent.
    let _runningReWaits = 0;
    const MAX_RUNNING_REWAITS = 4; // up to ~5×waitTimeout total for a genuinely long scan
    while (
      outcome.status === "timeout" &&
      outcome.item_status_at_timeout === "running" &&
      _runningReWaits < MAX_RUNNING_REWAITS
    ) {
      _runningReWaits++;
      console.log(`[offense-agent] q=${queueResult.queue_id} still running at ${waitTimeoutSec}s — extending wait (${_runningReWaits}/${MAX_RUNNING_REWAITS})`);
      outcome = await dispatch("wait_for_outcome", { queue_item_id: queueResult.queue_id, timeout_sec: waitTimeoutSec });
    }
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
    // dir_1782329692909: the aggregator reads the actual output and decides success.
    // Prior code overrode this with queue status, but queue status was often wrong
    // (exit code 1 from a ping loop that found hosts → "failed" even though recon
    // worked). Trust the aggregator; only override on genuine timeout.
    if (status === "timeout" && !summary.error_category) summary.error_category = "timeout";
    if (status === "timeout") summary.success = false;

    // (10b) dir_1782260457892: contradiction-detection / finding-revision.
    // Placed after the queue-truth correction above so the failed-step guard
    // sees the corrected summary.success. ctx.findings is the set recorded BEFORE
    // this iteration — i.e. findings a LATER step can now contradict.
    try {
      const { detectContradictions, reverifyContradicted } = require("/app/soc/finding-revision");
      const contradictions = detectContradictions(summary, ctx.findings || []);
      if (contradictions.length > 0) {
        await reverifyContradicted(engagementId, contradictions, { db });
      }
    } catch (e) {
      console.error(`[offense-agent] contradiction pass failed:`, e.message);
    }

    // dir_1782331356896: immediate re-synthesis on fixable command errors.
    // Instead of burning a full orchestrator round-trip, retry the same task
    // directive once with the error output as context. Only for syntax/argument
    // errors, not timeouts or infra hangs.
    const RETRIABLE_ERRORS = new Set(["syntax_error", "argument_error", "parse_error"]);
    if (!summary.success && RETRIABLE_ERRORS.has(summary.error_category) && !task._retried) {
      console.log(`[offense-agent] task ${task.id} failed with retriable '${summary.error_category}' — immediate re-synthesis`);
      task._retried = true;
      task.directive = `${task.directive}\n\nPREVIOUS ATTEMPT FAILED:\nCommand: ${(step.command || "").slice(0,300)}\nError: ${(rawOutput || "").slice(0,500)}\nFix the command and try again.`;
      let retryStep;
      try { retryStep = await synthesizeCommand(task, ctx, modelOverride); } catch (_) { retryStep = null; }
      if (retryStep && typeof retryStep.command === "string" && retryStep.command.trim()) {
        const retryQueue = await dispatch("queue_step", {
          engagement_id: engagementId,
          title: `[retry] ${(retryStep.title || task.directive).slice(0, 70)}`,
          command: retryStep.command,
          references: Array.isArray(retryStep.references) ? retryStep.references : [],
          model_override: modelOverride,
        });
        if (retryQueue.queue_id) {
          stepsQueued++;
          let retryOutcome = await dispatch("wait_for_outcome", { queue_item_id: retryQueue.queue_id, timeout_sec: waitTimeoutSec });
          const retryOutput = retryOutcome.output_preview || "";
          const retrySummary = await aggregator.fold(engagementId, task.directive, "", retryOutput, modelOverride);
          if (retryOutcome.status === "timeout") { retrySummary.error_category = "timeout"; retrySummary.success = false; }
          await orchestrator.completeTask(task.id, retrySummary.success ? "done" : "failed", retrySummary);
          await setAgentStatus(engagementId, "running", { iter, last_action: `retry task ${task.id} (${retrySummary.success ? "recovered" : "still_failed"})` });
          continue;
        }
      }
    }

    await orchestrator.completeTask(task.id, summary.success ? "done" : "failed", summary);

    // (11) Heartbeat status for live monitoring
    await setAgentStatus(engagementId, "running", { iter, tasks_added: tasksAdded, steps_queued: stepsQueued, last_action: `completed task ${task.id} (${summary.success ? "done" : "failed"})` });

    // (12) Mentor check — dir_1780838519357. The action signature is the
    // directive shape. If the same shape repeats N times OR total calls hit
    // threshold, fire the Mentor LLM call and inject its guidance into the
    // next iter's orchestrator context.
    if (monitor && monitor.enabled) {
      const actionSig = (task.directive || "").slice(0, 80).toLowerCase();
      if (monitor.shouldInvokeMentor(actionSig)) {
        const snap = monitor.snapshot();
        console.log(`[offense-agent] Mentor threshold hit (same=${snap.sameToolCount}, total=${snap.totalCallCount}) — invoking adviser`);
        try {
          const { performMentor } = require("/app/soc/execution-monitor");
          // Build mentor context from recent queue items (model's actual actions)
          const queueRecent = await db.query(
            `SELECT title, status, LEFT(COALESCE(command,''),300) AS cmd, LEFT(COALESCE(output,''),300) AS out
               FROM soc_queue_items WHERE engagement_id=$1 AND status != 'pending'
               ORDER BY id DESC LIMIT 20`, [engagementId]);
          const executedToolCalls = queueRecent.rows.map(r => ({
            name: "queue_step",
            args: r.title,
            result: `[${r.status}] ${(r.out || "").replace(/\s+/g, " ")}`,
          })).reverse();
          mentorGuidance = await performMentor({
            agentType: "offense orchestrator",
            subtaskDescription: task.directive,
            agentPrompt: "I propose pentest steps for execution on a tablet-mediated Kali chroot executor. I should diversify avenues when one fails repeatedly.",
            recentMessages: [],
            executedToolCalls,
            lastToolName: "queue_step",
            lastToolArgs: task.directive,
            lastToolResult: JSON.stringify(summary).slice(0, 800),
          });
          monitor.reset();
          try {
            await db.query(
              `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
               VALUES ($1, $2, 'mentor', 'monitoring', 0, 0, false, true, 0, 0, 'mentor_invoked', $3)`,
              [engagementId, queueResult.queue_id || null, `same=${snap.sameToolCount}, total=${snap.totalCallCount}, guidance_len=${(mentorGuidance || "").length}`]);
          } catch (_) {}
          console.log(`[offense-agent] Mentor returned ${(mentorGuidance || "").length} chars of guidance`);
        } catch (e) {
          console.error(`[offense-agent] Mentor failed:`, e.message);
        }
      }
    }
  }

  // dir_1782242371780: halt detection. The stall-exhaustion break (stallStreak>=3
  // with no work, or the >=30 hard cap) is a harness-forced halt (haltedAbnormally
  // is already true). Emit a distinct 'loop_halted' telemetry outcome so
  // detectLoopHalt / analyze_engagement_telemetry surfaces it as a WARNING. (The
  // dark-loop halt-timeout sub-case already emitted its own loop_halted above.)
  const haltedByStall = haltedAbnormally && iter < maxIter && endReason && endReason.includes("engagement exhausted");
  if (haltedByStall) {
    try {
      await db.query(
        `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
         VALUES ($1, NULL, 'halt_detector', 'loop_health', 0, 0, false, true, 0, 0, 'loop_halted', $2)`,
        [engagementId, `stall_streak_exhaustion; iter=${iter}; steps_queued=${stepsQueued}; end_reason=${(endReason||"").slice(0,200)}`]);
    } catch (_) {}
  }

  // dir_1782251824781 Fix 1 — orphaned task drain at conclusion.
  // When the loop concludes for any terminal reason (model called end_engagement,
  // loop-breaker fired on terminal phase, halt-detector broke the loop), drain
  // any engagement_tasks that are still 'pending' or 'in_flight'. These are
  // tasks the orchestrator selected but never reached synthesis/execution — they
  // would silently linger and mislead re-runs. Mark them 'skipped' with
  // reason='engagement concluded' and emit 'task_drained_on_conclude' telemetry
  // so analyze_engagement_telemetry can surface the count as a WARNING.
  try {
    const drainResult = await db.query(
      `UPDATE engagement_tasks
          SET status='skipped',
              result = COALESCE(result, '{}'::jsonb) || jsonb_build_object(
                'skipped_reason', 'engagement concluded',
                'drained_at', NOW()::text,
                'iter', $2::int
              )
        WHERE engagement_id = $1
          AND status IN ('pending','in_flight')
        RETURNING id`,
      [engagementId, iter]);
    const drained = drainResult.rows.length;
    if (drained > 0) {
      console.log(`[offense-agent] task drain: ${drained} orphaned task(s) drained at conclusion for engagement ${engagementId} (dir_1782251824781 Fix 1)`);
      try {
        await db.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, NULL, 'conclude_drain', 'task_lifecycle', 0, 0, false, true, 0, 0,
                   'task_drained_on_conclude', $2)`,
          [engagementId,
           `drained=${drained}; reason=engagement_concluded; iter=${iter}; end_reason=${(endReason||"").slice(0,120)}`]);
      } catch (_) { /* telemetry never breaks drain */ }
    }
  } catch (e) {
    console.error(`[offense-agent] task drain at conclusion failed:`, e.message);
  }

  // dir_1782242371780: final-status mapping extracted to the exported
  // computeFinalStatus() pure helper so it can be unit-tested against the real code
  // (the prior tests asserted an inline COPY and hid the mislabel bug). Mapping:
  // 'halted' = harness-forced abnormal halt (loop-breaker terminal / dark-loop /
  // stall) | 'completed' = model cleanly ended (even with 0 findings) | 'paused' =
  // iter-cap budget hit (resumable via start_engagement_run) | 'error' = unexpected
  // early exit. All four are non-'running' (the loop is gone).
  const finalStatus = computeFinalStatus({ haltedAbnormally, endedByOrchestrator, iter, maxIter });
  const finalEndReason = endReason
    || (iter >= maxIter ? `hit max_iter=${maxIter} cap — re-call start_engagement_run to continue` : "(unknown)");
  await setAgentStatus(engagementId, finalStatus, { iter, tasks_added: tasksAdded, steps_queued: stepsQueued, end_reason: finalEndReason });

  return {
    engagement_id: engagementId,
    ok: true,
    iter,
    ended_by_orchestrator: endedByOrchestrator,
    end_reason: finalEndReason,
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

module.exports = { runAgent, runAgentToolCall, resetAgent, synthesizeCommand, computeFinalStatus };
