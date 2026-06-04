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

const AGENT_SYSTEM_PROMPT = [
  "You are the L3 offensive-research agent for an AUTHORIZED penetration-testing engagement.",
  "",
  "You operate AUTONOMOUSLY within scope, but every command you queue runs ONLY after a human PA reviews and runs it from the SOC app — human-in-loop is mandatory (RULE 3 of the project).",
  "",
  "Your loop each step:",
  "  1. Call get_engagement_state to see the current scope/findings/queue history/executor capabilities.",
  "  2. Reason about the highest-leverage next sub-task. Do NOT repeat approaches the queue history shows already failed.",
  "  3. Call queue_step with the exact shell command. The bridge wraps it for the engagement's executor automatically — write the command as if you're on the executor itself.",
  "  4. Call wait_for_outcome with the queue_id returned by queue_step. Block until the PA runs it and the outcome lands.",
  "  5. Fold the outcome back into your reasoning. If it failed, pivot. If it succeeded, build on it.",
  "  6. Loop. When the engagement is exhausted OR you can't proceed further without human input, call end_engagement with a clear reason.",
  "",
  "Constraints:",
  "  - Tools available on the executor are listed in get_engagement_state's response. Use ONLY those. Don't invent tool names.",
  "  - All references must be real public IDs (CVE-..., EDB-..., MSF module path).",
  "  - Stay strictly within scope/ROE.",
  "  - At end, advance_phase as you transition (recon → enumeration → foothold → exploitation → post_exploit → reporting).",
  "  - If you hit something requiring human judgment (e.g., social engineering, scope ambiguity), call end_engagement with the question — request_human is still stubbed.",
  "",
  "Output style: USE TOOLS. Don't narrate at length. Each model turn either calls a tool or ends the engagement. Brief reasoning before a tool call is fine; long essays are not.",
].join("\n");

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
    `SELECT agent_run_state, agent_status FROM pentest_engagements WHERE id = $1`,
    [engagementId]);
  if (r.rows.length === 0) throw new Error(`engagement ${engagementId} not found`);
  const state = r.rows[0].agent_run_state || {};
  return {
    status:   r.rows[0].agent_status || "idle",
    messages: Array.isArray(state.messages) ? state.messages : null,
    iter:     Number(state.iter) || 0,
  };
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
  const resumed = !!messages;

  if (!messages) {
    messages = [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      { role: "user", content: `Start the L3 offense loop for engagement ${engagementId}.${intent ? ` Operator intent: ${intent}.` : ""} Begin by calling get_engagement_state.` },
    ];
  } else if (intent) {
    messages.push({ role: "user", content: `(Resuming.) Updated operator intent: ${intent}.` });
  } else {
    messages.push({ role: "user", content: `(Resuming.) Continue the loop from where you left off.` });
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
