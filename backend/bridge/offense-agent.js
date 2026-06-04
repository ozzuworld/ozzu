"use strict";
// offense-agent.js — Step 5 of OFFENSE-AGENT-DESIGN.md (dir_1780589262481)
//
// The agent loop. Backs Cipher (L4) out of the engagement entirely — the
// L3 model on the rented GPU runs SUMMARY→THOUGHT→ACTION via Ollama function-
// calling, queues commands for the PA, waits for outcomes, repeats.
//
//   start_engagement_run(engagement_id) → runAgent(engagement_id, opts)
//                                       → returns sanitized summary when done
//                                       → never returns raw commands to L4.
//
// Conversation transcript persists in pentest_engagements.agent_run_state so
// a bridge restart mid-run doesn't lose history. Operator can re-call to
// resume.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const db = require("./db");
const { TOOL_SCHEMAS, dispatch } = require("./offense-agent-tools");

const MODEL_URL  = process.env.OFFENSE_MODEL_URL  || "http://127.0.0.1:11434/v1";
const MODEL_NAME = process.env.OFFENSE_MODEL_NAME || "deepseek-r1:32b";
const MODEL_KEY  = process.env.OFFENSE_MODEL_KEY  || "";

const DEFAULT_MAX_ITER = 15;

const AGENT_SYSTEM_PROMPT_BASE = [
  "You are the L3 offensive-research agent for an AUTHORIZED penetration-testing engagement.",
  "",
  "You operate AUTONOMOUSLY within scope, but every command you queue runs ONLY after a human PA reviews and runs it from the SOC app — human-in-loop is mandatory (RULE 3 of the project).",
  "",
  "Your loop each step:",
  "  1. Call get_engagement_state to see the current scope/findings/queue history/executor capabilities AND the current engagement_phase.",
  "  2. Reason about the highest-leverage next sub-task for the CURRENT PHASE (see PHASE GUIDANCE below). Do NOT repeat approaches the queue history shows already failed.",
  "  3. Call queue_step with the exact shell command. The bridge wraps it for the engagement's executor automatically — write the command as if you're on the executor itself.",
  "  4. Call wait_for_outcome with the queue_id returned by queue_step. Block until the PA runs it and the outcome lands.",
  "  5. Fold the outcome back into your reasoning. If it failed, pivot. If it succeeded, build on it.",
  "  6. When the phase's goals are met, call advance_phase to move forward (recon → enumeration → foothold → exploitation → post_exploit → reporting). Don't linger in a phase past its useful scope.",
  "  7. When the engagement is exhausted OR you can't proceed further without human input, call end_engagement with a clear reason.",
  "",
  "Constraints:",
  "  - Tools available on the executor are listed in get_engagement_state's response. Use ONLY those. Don't invent tool names.",
  "  - All references must be real public IDs (CVE-..., EDB-..., MSF module path).",
  "  - Stay strictly within scope/ROE.",
  "  - If you hit something requiring human judgment (e.g., social engineering, scope ambiguity), call end_engagement with the question — request_human is still stubbed.",
  "",
  "Output style: USE TOOLS. Don't narrate at length. Each model turn either calls a tool or ends the engagement. Brief reasoning before a tool call is fine; long essays are not.",
].join("\n");

// dir_1780589553987 — Step 7: per-phase guidance gets appended to the system
// prompt at start_engagement_run time based on the engagement's current phase.
// Keeps the agent focused on the right kind of move per phase.
const PHASE_GUIDANCE = {
  recon: [
    "CURRENT PHASE: recon",
    "Goal: build a complete picture of the target's exposed attack surface PASSIVELY where possible. No exploitation attempts.",
    "Right moves: host discovery (subnet sweeps), port scans, service-banner grabs, OS fingerprinting, dns/whois lookups, public OSINT against in-scope assets.",
    "Wrong moves: running exploit modules, brute-force, credential spraying. Save those for later phases.",
    "Advance when: every in-scope host has at least a partial port/service inventory in recon_hosts.",
  ].join("\n"),
  enumeration: [
    "CURRENT PHASE: enumeration",
    "Goal: deepen what recon found. Identify exact service versions, default credentials worth trying, exposed interfaces, accessible files, weak configurations.",
    "Right moves: version probes (nmap -sV with NSE scripts that are read-only), HTTP banner / robots / known-paths checks, SNMP v1/v2c with `public`/`private`, FTP/SMB anonymous, default-cred reads (NOT writes), default-password checks against admin interfaces.",
    "Wrong moves: full exploit chains, credential dumps, anything that changes target state.",
    "Advance when: at least one promising attack vector (specific CVE-version match, default-cred service, exposed admin panel) is identified.",
  ].join("\n"),
  foothold: [
    "CURRENT PHASE: foothold",
    "Goal: gain initial access — ONE concrete exploit attempt per iteration. If it fails, repair (different parameters, different vector, different host) BEFORE trying the same approach again.",
    "Right moves: target the specific service+version match identified in enumeration. Use real public PoCs (CVE/EDB/MSF). Verify the version actually matches before firing.",
    "Wrong moves: shotgun-spraying multiple exploits in one step, attempting RCE chains before verifying the underlying vuln exists.",
    "Advance when: you have a confirmed working access vector (shell, reverse-callback, admin login, read of restricted data).",
  ].join("\n"),
  exploitation: [
    "CURRENT PHASE: exploitation",
    "Goal: extend the foothold — privilege escalation, additional service exploitation, deeper access.",
    "Right moves: local-privesc enum (kernel version, sudo -l, SUIDs), targeted privesc PoCs that match the kernel/distro, abusing the foothold's creds against other in-scope services.",
    "Wrong moves: redoing initial-access work — assume the foothold is stable and build from it.",
    "Advance when: privileged access on at least one host, or further exploitation hits scope boundary.",
  ].join("\n"),
  post_exploit: [
    "CURRENT PHASE: post_exploit",
    "Goal: lateral movement + sensitive-data discovery — within scope. Persistence is OUT OF SCOPE for most engagements (don't install backdoors).",
    "Right moves: enumerate other in-scope hosts from the foothold, read sensitive files for proof-of-impact, identify domain-trust paths, document AD/cloud relationships.",
    "Wrong moves: persistence mechanisms, destructive actions, exfiltrating real data (proof-of-access is enough).",
    "Advance when: lateral reach + impact are documented across the in-scope environment.",
  ].join("\n"),
  reporting: [
    "CURRENT PHASE: reporting",
    "Goal: synthesize findings into a structured draft that the operator can review. No new offensive steps.",
    "Right moves: review pentest_findings via get_engagement_state, identify which findings are confirmed exploitable vs theoretical, propose a finding-severity ordering, queue read-only re-checks if any finding's status is ambiguous.",
    "Wrong moves: new exploit attempts. The engagement is wrapping up — only generate steps that VERIFY or DOCUMENT, not steps that escalate.",
    "End the engagement when the finding list is consistent with the actual proof in queue history.",
  ].join("\n"),
};

function buildSystemPrompt(phase) {
  const guide = PHASE_GUIDANCE[phase] || PHASE_GUIDANCE.recon;
  return `${AGENT_SYSTEM_PROMPT_BASE}\n\n────────────────\n${guide}\n────────────────`;
}

// Ollama /v1/chat/completions with function-calling. Returns the message object
// (which contains either `content` or `tool_calls` or both).
function chatWithTools(messages, modelOverride) {
  return new Promise((resolve, reject) => {
    const base = MODEL_URL.replace(/\/+$/, "");
    const url = new URL(base + "/chat/completions");
    const lib = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify({
      model: modelOverride || MODEL_NAME,
      messages,
      tools: TOOL_SCHEMAS,
      temperature: 0.2,
      stream: false,
    });
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (MODEL_KEY) headers.Authorization = `Bearer ${MODEL_KEY}`;
    const req = lib.request(url, { method: "POST", headers, timeout: 240000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`agent model HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
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

async function readCurrentPhase(engagementId) {
  const r = await db.query(
    `SELECT engagement_phase FROM pentest_engagements WHERE id = $1`,
    [engagementId]);
  return r.rows[0] && r.rows[0].engagement_phase || "recon";
}

async function saveState(engagementId, messages, iter, status) {
  // Keep transcript under ~256KB postgres TOAST friendliness by capping turns.
  const capped = messages.slice(-60);
  await db.query(
    `UPDATE pentest_engagements
        SET agent_run_state = $1::jsonb, agent_status = $2
      WHERE id = $3`,
    [JSON.stringify({ messages: capped, iter }), status, engagementId]);
}

// Trim a tool result before feeding it back to the model. Some tools (notably
// get_engagement_state with lots of hosts/findings) return blobs that bloat
// the context. We let through the structured fields and stringify with a cap.
function serializeToolResult(result) {
  let s;
  try { s = JSON.stringify(result); } catch (_) { s = String(result); }
  if (s.length > 12000) s = s.slice(0, 11800) + ' ...[truncated]';
  return s;
}

// Run the agent loop. modelOverride lets us A/B test models per directive 5.
async function runAgent(engagementId, opts = {}) {
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
    // Resume — refresh the system prompt with the current phase guidance so
    // a mid-engagement phase change (operator-set or model-set last run) takes
    // effect immediately. The transcript already has the OLD system prompt at
    // index 0; replace it.
    if (messages[0] && messages[0].role === "system") {
      messages[0] = { role: "system", content: buildSystemPrompt(phase) };
    }
    if (intent) {
      messages.push({ role: "user", content: `(Resuming.) Updated operator intent: ${intent}. Current phase: ${phase}.` });
    } else {
      messages.push({ role: "user", content: `(Resuming.) Continue the loop from where you left off. Current phase: ${phase}.` });
    }
  }

  await saveState(engagementId, messages, iter, "running");

  const startMs = Date.now();
  let endedByModel = false;
  let endReason   = null;
  let lastAssistantText = null;
  let stepsQueued = 0;

  while (iter < maxIter) {
    iter++;
    let resp;
    try {
      resp = await chatWithTools(messages, modelOverride);
    } catch (e) {
      await saveState(engagementId, messages, iter, "error");
      return {
        engagement_id: engagementId,
        ok: false,
        iter,
        reason: `model call failed at iter ${iter}: ${e.message}`,
        steps_queued: stepsQueued,
        elapsed_sec: Math.round((Date.now() - startMs) / 1000),
      };
    }
    const msg = resp.message;
    // Track last visible reasoning so we can surface SOMETHING to the operator
    // — but never the raw command output.
    if (msg.content) lastAssistantText = String(msg.content).slice(0, 500);

    // Push the assistant message (with tool_calls if any) into the transcript.
    messages.push(msg);

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (toolCalls.length === 0) {
      // Model declined to call any tool — usually means it's done or stuck.
      // Mark completed (model effectively bailed) and exit.
      endedByModel = true;
      endReason = "model returned no tool_calls — assuming it's done or stuck";
      break;
    }

    let phaseChanged = false;
    for (const tc of toolCalls) {
      const name = tc.function && tc.function.name;
      const argsRaw = tc.function && tc.function.arguments;
      const result = await dispatch(name, argsRaw);
      if (name === "queue_step" && result && !result.error) stepsQueued++;
      messages.push({
        role: "tool",
        tool_call_id: tc.id || `${name}-${iter}`,
        name,
        content: serializeToolResult(result),
      });
      if (name === "end_engagement" && result && !result.error) {
        endedByModel = true;
        endReason = `model called end_engagement: ${result.reason || "(no reason)"}`;
      }
      if (name === "advance_phase" && result && !result.error && result.phase) {
        phaseChanged = true;
        phase = result.phase;
      }
    }
    // If the agent moved phases this iteration, refresh the system prompt so
    // the new phase guidance is in effect for the next model call.
    if (phaseChanged && messages[0] && messages[0].role === "system") {
      messages[0] = { role: "system", content: buildSystemPrompt(phase) };
    }

    // Persist after each iteration so a bridge restart can resume.
    await saveState(engagementId, messages, iter, endedByModel ? "completed" : "running");
    if (endedByModel) break;
  }

  const finalStatus = endedByModel ? "completed" : (iter >= maxIter ? "idle" : "error");
  await saveState(engagementId, messages, iter, finalStatus);

  return {
    engagement_id: engagementId,
    ok: true,
    iter,
    resumed,
    ended_by_model: endedByModel,
    end_reason: endReason || (iter >= maxIter ? `hit max_iter=${maxIter} cap — re-call start_engagement_run to continue` : "(unknown)"),
    steps_queued: stepsQueued,
    last_assistant_text: lastAssistantText,
    elapsed_sec: Math.round((Date.now() - startMs) / 1000),
  };
}

// Reset the conversation transcript so a fresh run starts from zero.
// Used when the operator wants to clear the slate (e.g., changed scope).
async function resetAgent(engagementId) {
  await db.query(
    `UPDATE pentest_engagements
        SET agent_run_state = '{}'::jsonb, agent_status = 'idle'
      WHERE id = $1`,
    [engagementId]);
  return { engagement_id: engagementId, ok: true };
}

module.exports = { runAgent, resetAgent };
