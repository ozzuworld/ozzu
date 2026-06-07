// execution-monitor.js — dir_1780838519357
//
// PentAGI-style execution monitor. After every agent action, increment counters.
// Fire the Mentor LLM call when consecutive same-action threshold or total-action
// threshold trips. Tonight we watched the model retry `--script rtsp-info` 8+
// times across v8-v15 with no intervention. This catches that class.
//
// Mentor + Planner LLM calls share the same qwen3:32b endpoint (no new infra).
// Both prompts inlined to keep the deploy a single-file change.

"use strict";

const http = require("http");
const https = require("https");

const MODEL_URL = process.env.OFFENSE_MODEL_URL || "http://127.0.0.1:11434/v1";
const MODEL_NAME = process.env.OFFENSE_MODEL_NAME || "qwen3:32b";
const MODEL_KEY = process.env.OFFENSE_MODEL_KEY || "";

// ── Execution monitor state machine ────────────────────────────────────────
// dir_1780854966869: shape-normalizer. Reduces a queue command to its
// canonical structure so different-target/different-port runs of the same
// underlying command read as a single "shape".
function normalizeCommandShape(cmd) {
  if (!cmd) return "";
  let s = String(cmd);
  // Replace IPs first (long form before short)
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g, "<IP>");
  // Replace :PORT after host or IP
  s = s.replace(/:(?:\d{1,5})\b/g, ":<PORT>");
  // Replace stand-alone port numbers in nmap/hydra -p / -s contexts
  s = s.replace(/(-(?:p|P|s)\s+)(\d{1,5})/g, "$1<PORT>");
  // Replace absolute file paths with just the basename
  s = s.replace(/(\/[A-Za-z0-9_.\-]+){2,}/g, "<PATH>");
  // Replace URLs to <URL> when no specific structure left
  s = s.replace(/https?:\/\/[^\s'"]+/g, "<URL>");
  // Collapse whitespace + downcase
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  // Cap length
  return s.slice(0, 120);
}

class ExecutionMonitor {
  constructor({
    sameThreshold = 3,
    totalThreshold = 10,
    shapeThreshold = 3,           // dir_1780854966869
    enabled = true,
  } = {}) {
    this.sameThreshold = sameThreshold;
    this.totalThreshold = totalThreshold;
    this.shapeThreshold = shapeThreshold;
    this.enabled = enabled;
    this.sameToolCount = 0;
    this.totalCallCount = 0;
    this.lastActionSig = "";
    // dir_1780854966869: per-shape counters across all iters
    this.shapeCounts = new Map();  // normalizedShape -> count
    this.lastShape = "";
    this.sameShapeCount = 0;
  }

  // actionSig: a short string fingerprint of the agent's last action — e.g.
  // queue_step:Enumerate RTSP, advance_phase, end_engagement, etc.
  shouldInvokeMentor(actionSig) {
    if (!this.enabled || !actionSig) return false;
    this.totalCallCount += 1;
    if (actionSig === this.lastActionSig) {
      this.sameToolCount += 1;
    } else {
      this.sameToolCount = 1;
      this.lastActionSig = actionSig;
    }
    return this.sameToolCount >= this.sameThreshold ||
           this.totalCallCount >= this.totalThreshold ||
           this.sameShapeCount >= this.shapeThreshold;
  }

  // dir_1780854966869: register a synthesized command's shape. Called after
  // synthesizeCommand returns step.command, before the queue insert.
  recordCommandShape(commandText) {
    if (!this.enabled) return;
    const shape = normalizeCommandShape(commandText);
    if (!shape) return;
    this.shapeCounts.set(shape, (this.shapeCounts.get(shape) || 0) + 1);
    if (shape === this.lastShape) {
      this.sameShapeCount += 1;
    } else {
      this.sameShapeCount = 1;
      this.lastShape = shape;
    }
  }

  // For prompting Mentor: which shape is currently looping?
  topRepeatedShape() {
    if (this.shapeCounts.size === 0) return null;
    let best = null, bestN = 0;
    for (const [shape, n] of this.shapeCounts.entries()) {
      if (n > bestN) { best = shape; bestN = n; }
    }
    return { shape: best, count: bestN };
  }

  reset() {
    this.sameToolCount = 0;
    this.totalCallCount = 0;
    this.lastActionSig = "";
    this.shapeCounts.clear();
    this.lastShape = "";
    this.sameShapeCount = 0;
  }

  snapshot() {
    return {
      sameToolCount: this.sameToolCount,
      totalCallCount: this.totalCallCount,
      lastActionSig: this.lastActionSig,
      sameShapeCount: this.sameShapeCount,
      lastShape: this.lastShape,
      topRepeatedShape: this.topRepeatedShape(),
    };
  }
}

// ── Shared chat completion helper ──────────────────────────────────────────
function chatCompletion(messages, modelOverride) {
  return new Promise((resolve, reject) => {
    const base = MODEL_URL.replace(/\/+$/, "");
    const url = new URL(base + "/chat/completions");
    const lib = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify({
      model: modelOverride || MODEL_NAME,
      messages,
      temperature: 0.2,
      stream: false,
    });
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (MODEL_KEY) headers.Authorization = `Bearer ${MODEL_KEY}`;
    const reqAgent = new lib.Agent({ keepAlive: false });
    const req = lib.request(url, { method: "POST", headers, timeout: 180000, agent: reqAgent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`adviser HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(body);
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!content) return reject(new Error("adviser returned no content"));
          resolve(content);
        } catch (e) {
          reject(new Error(`adviser parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("adviser timeout")));
    req.write(payload);
    req.end();
  });
}

// ── Mentor prompt (adapted from PentAGI question_execution_monitor.tmpl) ──
function renderMentorPrompt({ agentType, subtaskDescription, agentPrompt, recentMessages, executedToolCalls, lastToolName, lastToolArgs, lastToolResult }) {
  const tcList = (executedToolCalls || []).slice(-20).map(t =>
    `<tool_call>\n<name>${t.name}</name>\n<arguments>${(t.args || "").slice(0, 400)}</arguments>\n<result>${(t.result || "").slice(0, 400)}</result>\n</tool_call>`
  ).join("\n");
  const rmList = (recentMessages || []).slice(-10).map(m => `<message tool_call="${m.name || ""}">${(m.msg || "").slice(0, 400)}</message>`).join("\n");
  return [
    `I am a ${agentType} agent currently executing a subtask, and I need your guidance to ensure I'm making efficient progress and not wasting efforts.`,
    `<my_current_assignment>\n${subtaskDescription || "(no subtask)"}\n</my_current_assignment>`,
    `<my_role_and_capabilities>\n${(agentPrompt || "").slice(0, 1500)}\n</my_role_and_capabilities>`,
    rmList ? `<recent_conversation_history>\n${rmList}\n</recent_conversation_history>` : "",
    tcList ? `<all_tool_calls_i_executed>\n${tcList}\n</all_tool_calls_i_executed>` : "",
    `<my_most_recent_action>\n<tool_name>${lastToolName || ""}</tool_name>\n<arguments>${(lastToolArgs || "").slice(0, 400)}</arguments>\n<result>${(lastToolResult || "").slice(0, 800)}</result>\n</my_most_recent_action>`,
    "",
    "Based on my execution history above, I need your expert analysis on the following critical questions:",
    "",
    "1. Am I making real, measurable progress toward completing my subtask objective, or am I just spinning my wheels?",
    "2. Have I been repeating the same actions or tool calls without achieving meaningful results?",
    "3. Am I stuck in a loop or heading in the wrong direction with my current approach?",
    "4. Should I try a completely different strategy? If yes, what specific alternative approaches would you recommend?",
    "5. Is this task impossible to complete as currently defined? Should I report what I've accomplished and terminate, or request assistance from the user?",
    "6. What are the most critical and actionable next steps I should take right now to move forward effectively?",
    "",
    "When analyzing the queued commands on this SOC executor (tablet-mediated Android with Kali chroot via `nh -s`), check for these common mistakes:",
    "- nmap without `-Pn -sT` (Android kernel denies raw sockets — request fails with 'route_dst_netlink: if_indextoname(2) failed: 13 Permission denied')",
    "- --script <name> referencing scripts that don't exist (the preflight linter has rejected the same fake script name 3+ times; STOP proposing it)",
    "- Citing fake CVE IDs (verify CVE existence + product match before claiming)",
    "- Re-attempting refuted hypotheses (CVE-2021-36260 is REFUTED on this engagement)",
    "- HTTP root URL 200 OK is NOT evidence of authentication success (Hikvision redirects to login page unauthenticated)",
    "",
    "Please provide specific, concrete recommendations. State whether to continue, pivot, or terminate. Keep your response under 400 words.",
  ].filter(Boolean).join("\n");
}

// ── Planner prompt (adapted from PentAGI question_task_planner.tmpl) ──
function renderPlannerPrompt({ agentType, taskQuestion, engagementContext }) {
  return [
    `I am a ${agentType} agent and I have just received the following task assignment:`,
    "",
    `<my_task>\n${taskQuestion}\n</my_task>`,
    "",
    engagementContext ? `<engagement_context>\n${engagementContext.slice(0, 2000)}\n</engagement_context>` : "",
    "",
    "I need your help to create a structured execution plan before I begin working. Please provide me with a concise checklist (3-7 steps) that will help me complete this task efficiently and correctly.",
    "",
    "The plan should:",
    "- Include specific, actionable steps I need to take",
    "- Specify what I should check or verify at each stage",
    "- Highlight potential pitfalls or mistakes I should avoid",
    "- Ensure I stay focused only on this current task without going beyond its scope",
    "- Help me avoid redundant work by leveraging available context",
    "- Guide me toward efficient task completion without unnecessary actions",
    "",
    "Important context for planning (SOC executor: tablet-mediated Android, Kali chroot via `nh -s`):",
    "- Terminal commands execute independently (no persistent state between queue items)",
    "- nmap REQUIRES `-Pn -sT` flags on this executor (Android kernel denies raw sockets)",
    "- --script only with REAL NSE script names (rtsp-methods, ssh2-enum-algos, ssh-hostkey, http-methods, ssl-enum-ciphers, snmp-info, etc. — DO NOT invent rtsp-info, ssh-auth-bypass, ssh-terrapin)",
    "- ALWAYS verify CVE existence via verify_cve before citing (do not cite CVE-2022-41932 for Dropbear — it's an XWiki CVE)",
    "- HTTP root URL 200 OK is NOT auth success on Hikvision (root redirects to login page unauthenticated)",
    "- For cred testing on Hikvision, hit /ISAPI/System/deviceInfo and look for HTTP 200 + DeviceInfo XML, NOT root 200",
    "",
    "Please format your response as a numbered checklist like this:",
    "1. [First critical action/verification step]",
    "2. [Second step with specific details]",
    "3. [Continue with remaining steps]",
    "...",
    "",
    "This plan will serve as my roadmap, though I may deviate from it if I discover better approaches during execution. Keep your response under 400 words.",
  ].filter(Boolean).join("\n");
}

// ── Public entry points ────────────────────────────────────────────────────

// performMentor: builds the prompt, calls the model, returns a guidance string
// to inject into the agent's next context as a system/user message.
async function performMentor(ctx) {
  const prompt = renderMentorPrompt(ctx);
  return await chatCompletion([
    { role: "user", content: prompt },
  ]);
}

// performPlanner: returns the operator intent wrapped with a 3-7 step plan,
// using PentAGI's task_assignment_wrapper structure.
async function performPlanner({ agentType, taskQuestion, engagementContext }) {
  const prompt = renderPlannerPrompt({ agentType, taskQuestion, engagementContext });
  const plan = await chatCompletion([
    { role: "user", content: prompt },
  ]);
  const wrapped = [
    "<task_assignment>",
    "<original_request>",
    taskQuestion,
    "</original_request>",
    "",
    "<execution_plan>",
    plan,
    "</execution_plan>",
    "",
    "<hint>",
    "The original_request is the primary objective.",
    "The execution_plan above was prepared by analyzing the broader context and decomposing the task into suggested steps.",
    "Use this plan as guidance to work efficiently, but adapt your actions to the actual circumstances while staying aligned with the objective.",
    "</hint>",
    "</task_assignment>",
  ].join("\n");
  return { plan, wrappedIntent: wrapped };
}

// ── Reflector prompt (adapted from PentAGI question_reflector.tmpl) ──
// When the model returns plain text instead of a structured JSON response
// the calling code expects, send the raw text back to the model with a
// "you must respond as JSON per this schema" instruction. ONE retry.
function renderReflectorPrompt({ rawText, expectedFormat, schemaHint }) {
  return [
    `You were asked for a structured ${expectedFormat || "JSON"} response and instead returned unstructured prose. The system can only process properly formatted responses.`,
    "",
    `<your_unstructured_response>`,
    String(rawText || "").slice(0, 3000),
    `</your_unstructured_response>`,
    "",
    `<required_schema>`,
    schemaHint || "(unspecified — return the JSON object the caller asked for)",
    `</required_schema>`,
    "",
    "Reply ONLY with the structured JSON matching the schema above. No prose, no markdown fences, no explanation — just the JSON object. If the schema requires specific fields, include them all. If your prose response indicated an intent (e.g. to add tasks, select a task, end the engagement, queue a step), translate that intent into the JSON now.",
  ].join("\n");
}

// performReflector: returns the corrected response text. Caller still has to
// parse it. Throws on its own LLM call failure — caller decides whether to
// re-throw to the agent loop.
async function performReflector({ rawText, expectedFormat, schemaHint }) {
  const prompt = renderReflectorPrompt({ rawText, expectedFormat, schemaHint });
  return await chatCompletion([
    { role: "user", content: prompt },
  ]);
}

// ── Refiner prompt (adapted from PentAGI subtasks_refiner.tmpl) ──
// When the orchestrator is stuck adding tasks but never selecting one — or
// when the pending pile is unmanageable — Refiner returns a pruned plan:
// one task to focus on, IDs to cancel, and a filtered subset of the proposed
// additions worth keeping.
function renderRefinerPrompt({ objective, completed, pending, proposed }) {
  const completedXml = (completed || []).slice(0, 5).map(t =>
    `<completed_task>\n<id>${t.id}</id>\n<title>${(t.title || "").slice(0, 200)}</title>\n<result>${(t.result || "").slice(0, 300)}</result>\n</completed_task>`
  ).join("\n");
  const pendingXml = (pending || []).map(t =>
    `<pending_task>\n<id>${t.id}</id>\n<title>${(t.title || "").slice(0, 200)}</title>\n<phase>${t.phase || ""}</phase>\n</pending_task>`
  ).join("\n");
  const proposedXml = (proposed || []).map((t, i) =>
    `<proposed_task>\n<index>${i}</index>\n<directive>${(t.directive || "").slice(0, 300)}</directive>\n<phase>${t.phase || ""}</phase>\n</proposed_task>`
  ).join("\n");
  return [
    "You are a pentest task plan refiner. The orchestrator is about to add new tasks but has not selected one to execute — or the pending pile is too large to make progress.",
    "",
    "Your job: produce a focused short plan. Pick ONE pending or proposed task that best advances the primary objective. Cancel duplicates. Filter the proposed additions down to only those that fill genuine gaps.",
    "",
    `<primary_objective>\n${objective || "(no explicit objective)"}\n</primary_objective>`,
    "",
    completedXml ? `<completed_tasks>\n${completedXml}\n</completed_tasks>` : "",
    "",
    pendingXml ? `<pending_tasks>\n${pendingXml}\n</pending_tasks>` : "<pending_tasks><status>empty</status></pending_tasks>",
    "",
    proposedXml ? `<orchestrator_proposed_new_tasks>\n${proposedXml}\n</orchestrator_proposed_new_tasks>` : "",
    "",
    "Return ONLY a JSON object with this exact shape (no markdown, no prose):",
    '{',
    '  "selected_task_id": <integer ID of the pending task to execute next, or null if the best next action is one of the proposed_new_tasks; in that case pick a NEW id by setting "select_proposed_index": <integer index into orchestrator_proposed_new_tasks>>,',
    '  "select_proposed_index": <integer index into orchestrator_proposed_new_tasks if selected_task_id is null and a proposed task should be selected, otherwise null>,',
    '  "prune_pending_ids":     [<array of pending task IDs to CANCEL because they are duplicates or no longer useful given completed results>],',
    '  "filtered_add":          [<array of indices into orchestrator_proposed_new_tasks worth keeping; drop the rest>],',
    '  "rationale":             "<one short sentence on why this pick advances the objective>"',
    '}',
    "",
    "Rules:",
    "- selected_task_id MUST be non-null UNLESS all pending tasks are redundant — in that case, pick from proposed via select_proposed_index.",
    "- prune_pending_ids: any pending task whose intent is already covered by a completed task's result, or duplicated by another pending task, should be in this list.",
    "- filtered_add: be aggressive. If 5 tasks were proposed and 2 are duplicates of pending, only the 3 unique indices belong here.",
    "- rationale: name the specific finding/host/CVE that motivates the selected task.",
  ].filter(Boolean).join("\n");
}

async function performRefiner(ctx) {
  const prompt = renderRefinerPrompt(ctx);
  const raw = await chatCompletion([
    { role: "user", content: prompt },
  ]);
  let parsed;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : raw);
  } catch (e) {
    throw new Error(`refiner parse failed: ${e.message}; raw=${raw.slice(0, 200)}`);
  }
  return {
    selected_task_id:        Number.isInteger(parsed.selected_task_id) ? parsed.selected_task_id : null,
    select_proposed_index:   Number.isInteger(parsed.select_proposed_index) ? parsed.select_proposed_index : null,
    prune_pending_ids:       Array.isArray(parsed.prune_pending_ids) ? parsed.prune_pending_ids.filter(Number.isInteger) : [],
    filtered_add:            Array.isArray(parsed.filtered_add) ? parsed.filtered_add.filter(Number.isInteger) : [],
    rationale:               typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 400) : "",
  };
}

// ── Summarizer prompt (adapted from PentAGI summarizer.tmpl) ──
// Compress long context (findings, graph, queue history) while keeping the
// technical anchors qwen3:32b needs to reason about the engagement:
// CVE IDs, IPs, ports, versions, file paths, severity, status.
function renderSummarizerPrompt({ content, instructions, contentType }) {
  return [
    "# PRECISION SUMMARIZATION ENGINE",
    "",
    "Your sole purpose: convert lengthy content into a concise summary that retains 100% of the essential information while eliminating redundancy.",
    "",
    "## CRITICAL: PRESERVE WITHOUT EXCEPTION",
    "- All CVE IDs (CVE-YYYY-NNNN)",
    "- All IP addresses, hostnames, ports",
    "- All product names and version strings (e.g. 'Dropbear 2020.81', 'Hikvision V5.7.3')",
    "- All file paths and URL endpoints",
    "- All numeric IDs (finding #, queue item #, task #)",
    "- All severity levels and statuses (CRIT/HIGH/MED/LOW/INFO, confirmed/refuted/pending)",
    "- All cause-and-effect relationships ('finding X informed_by finding Y enables finding Z')",
    "- All warnings, limitations, refutations",
    "",
    "## DO NOT",
    "- Reproduce XML tags from the input in your output",
    "- Add headers, markdown sections, or narrative framing",
    "- Add disclaimers, caveats, or your own commentary",
    "- Drop technical specs even if 'similar' — every distinct CVE/IP/version is unique",
    "",
    instructions ? `## SPECIFIC INSTRUCTIONS\n${instructions}` : "",
    "",
    `## CONTENT TYPE: ${contentType || "(unspecified)"}`,
    "",
    "## CONTENT TO SUMMARIZE",
    "```",
    String(content || "").slice(0, 30000),
    "```",
    "",
    "Reply with ONLY the compressed summary. No prose, no headers, no explanation. Bullet form is fine if appropriate to the content type.",
  ].filter(Boolean).join("\n");
}

async function performSummarizer({ content, instructions, contentType }) {
  const prompt = renderSummarizerPrompt({ content, instructions, contentType });
  return await chatCompletion([
    { role: "user", content: prompt },
  ]);
}

// Simple FNV-1a hash for content-keyed caching (no crypto dep).
function hashContent(s) {
  let h = 0x811c9dc5;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

module.exports = { ExecutionMonitor, performMentor, performPlanner, performReflector, performRefiner, performSummarizer, hashContent, normalizeCommandShape };
