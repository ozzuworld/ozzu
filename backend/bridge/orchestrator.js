// orchestrator.js — Persistent Cipher orchestrator session manager
// One long-lived Claude CLI session that accumulates context and delegates to workers.
// Each interaction is a separate process (claude --resume), but session history persists on disk.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOG_DIR = "/tmp/ozzu-bridge";
const SESSION_FILE = path.join(LOG_DIR, "orchestrator-session.json");
const KNOWLEDGE_FILE = path.join(LOG_DIR, "orchestrator-knowledge.json");
const WORKDIR = "/home/gcp/ozzu";
const ORCHESTRATOR_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per call
const ROTATION_MESSAGE_COUNT = 100;
const ROTATION_IDLE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_KNOWLEDGE_ITEMS = 200; // Cap to prevent unbounded growth

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[orchestrator ${ts}] ${msg}`);
}

// ── Persistent knowledge store ──
// Incrementally saved on every orchestrator response that includes learned items.
// Survives session rotation, corruption, and container restarts.

let _knowledge = []; // Array of { item: string, learnedAt: number, source: string }

function loadKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
      _knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, "utf8"));
      log(`Loaded ${_knowledge.length} knowledge items from disk`);
    }
  } catch (err) {
    log(`Failed to load knowledge: ${err.message}`);
    _knowledge = [];
  }
}

function saveKnowledge() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify(_knowledge, null, 2));
  } catch (err) {
    log(`Failed to save knowledge: ${err.message}`);
  }
}

function addKnowledge(items, source) {
  if (!items || !Array.isArray(items) || items.length === 0) return;
  const now = Date.now();
  for (const item of items) {
    if (typeof item !== "string" || item.length === 0) continue;
    // Deduplicate: skip if we already have a very similar item
    const isDuplicate = _knowledge.some(k =>
      k.item.toLowerCase() === item.toLowerCase()
    );
    if (!isDuplicate) {
      _knowledge.push({ item, learnedAt: now, source });
      log(`Knowledge+: "${item.slice(0, 80)}"`);
    }
  }
  // Cap size — drop oldest items
  if (_knowledge.length > MAX_KNOWLEDGE_ITEMS) {
    _knowledge = _knowledge.slice(-MAX_KNOWLEDGE_ITEMS);
  }
  saveKnowledge();
}

function getKnowledgeForPrompt() {
  if (_knowledge.length === 0) return "";
  const items = _knowledge.map(k => `- ${k.item}`).join("\n");
  return `\n\nACCUMULATED KNOWLEDGE (from past directives — use this to guide workers):\n${items}`;
}

// ── Session state ──

let _session = null; // { id, createdAt, messageCount, lastUsedAt }

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      _session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      log(`Loaded session: ${_session.id} (${_session.messageCount} messages)`);
      return true;
    }
  } catch (err) {
    log(`Failed to load session: ${err.message}`);
  }
  return false;
}

function saveSession() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(_session, null, 2));
  } catch (err) {
    log(`Failed to save session: ${err.message}`);
  }
}

// ── System prompt for the orchestrator ──

const SYSTEM_PROMPT = `You are Cipher, the persistent orchestrator for the ozzu project.
You are an ARCHITECTURAL DECISION-MAKER, not a coder. You receive directives, make dispatch decisions, craft worker prompts, and review worker results.

YOUR ROLE:
- Receive new directives from the bridge and decide how to handle them
- Craft precise, ecosystem-specific worker prompts (not generic templates)
- Review worker results (git diffs, log tails) and approve/reject merges
- Accumulate knowledge: what works, what fails, device quirks, file patterns

ECOSYSTEM KNOWLEDGE (always growing):
- Bridge runs in Docker (network_mode: host). Workers must NOT restart it.
- Frontend: Expo React Native. CI builds on push to main. smartDeploy handles deploy.
- iOS sideloading uses AltServer-Linux via dev-01, NOT sideloader
- server.js is ~5400 lines — monolithic but organized. Workers must read before editing.
- cipher-pipeline.js is a turn-based state machine — changes must respect _turn state
- Worktrees isolate workers. They commit+push to their branch, system merges to main.
- ADB ports change on reboot — check device settings, don't hardcode
- adb reverse does NOT work over wireless ADB/VPN

RESPONSE FORMAT — You MUST respond with valid JSON (no markdown fences, no text outside the JSON):
{
  "action": "spawn_worker | handle_directly | merge_approved | needs_changes | request_info",
  "reasoning": "Brief explanation of your decision",
  "worker_prompt": "Precise worker instructions (only if action=spawn_worker)",
  "worker_type": "planning | implementation (only if action=spawn_worker)",
  "merge_approved": true or false (only for WORKER_COMPLETED messages),
  "merge_feedback": "Issues found or approval note (only for WORKER_COMPLETED)",
  "status_update": "Brief status for the dashboard",
  "learned": ["Things to remember for future directives"]
}

DECISION GUIDELINES:
- For quick/explore directives: spawn_worker with type matching the directive
- For feature directives needing planning: spawn_worker with type "planning"
- For approved directives: spawn_worker with type "implementation"
- When reviewing worker results: check the diff for obvious issues, approve if reasonable
- If you see patterns from past failures, include warnings in worker_prompt
- handle_directly is ONLY for pure status/info queries (e.g. "what's running?"). NEVER use handle_directly for any directive that requires code changes, file edits, bug fixes, or feature work — those MUST be spawn_worker.
- You CANNOT write or edit code yourself. You have no Write or Edit tools. Always delegate coding to workers.

WORKER PROMPT CRAFTING:
When crafting worker_prompt, include:
1. The specific files the worker should read first
2. Known pitfalls from your accumulated knowledge
3. Any patterns from previous similar directives
4. Clear completion criteria
Do NOT include infrastructure boilerplate (worktree info, bridge API) — the system wraps your prompt with that automatically.

Read CLAUDE.md at /home/gcp/ozzu/CLAUDE.md for full project context.`;

// ── Claude CLI execution ──

function runClaude(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    let stdout = "";
    let stderr = "";

    const child = spawn("claude", args, {
      cwd: WORKDIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try { process.kill(child.pid, 0); child.kill("SIGKILL"); } catch {}
      }, 5000);
      reject(new Error(`Orchestrator call timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ── Session lifecycle ──

async function createSession() {
  const id = crypto.randomUUID();
  log(`Creating new orchestrator session: ${id}`);

  const knowledgeContext = getKnowledgeForPrompt();
  const bootstrapMsg = `You are now online as the Cipher orchestrator. Read /home/gcp/ozzu/CLAUDE.md for project context.${knowledgeContext}\n\nRespond with: {"action":"handle_directly","reasoning":"Session initialized","status_update":"Cipher orchestrator online","learned":[]}`;

  const args = [
    "--session-id", id,
    "--model", "opus",
    "--output-format", "json",
    "--allowedTools", "Read Grep Glob Bash WebSearch WebFetch",
    "--system-prompt", SYSTEM_PROMPT,
    "-p", bootstrapMsg,
  ];

  const output = await runClaude(args, ORCHESTRATOR_TIMEOUT_MS);
  const parsed = parseResponse(output);

  _session = {
    id,
    createdAt: Date.now(),
    messageCount: 1,
    lastUsedAt: Date.now(),
  };
  saveSession();

  log(`Orchestrator session created: ${id}`);
  return parsed;
}

async function resumeSession(message) {
  if (!_session) throw new Error("No session to resume");

  const args = [
    "--resume", _session.id,
    "--output-format", "json",
    "-p", message,
  ];

  const output = await runClaude(args, ORCHESTRATOR_TIMEOUT_MS);
  const parsed = parseResponse(output);

  _session.messageCount++;
  _session.lastUsedAt = Date.now();
  saveSession();

  return parsed;
}

function needsRotation() {
  if (!_session) return true;
  if (_session.messageCount >= ROTATION_MESSAGE_COUNT) return true;
  if (Date.now() - _session.lastUsedAt > ROTATION_IDLE_MS) return true;
  return false;
}

async function rotateSession() {
  log("Rotating orchestrator session...");

  // Ask old session for knowledge summary before creating new one
  let knowledgeSummary = "";
  if (_session) {
    try {
      const summary = await resumeSession(
        'Session is being rotated. Summarize your accumulated knowledge in a compact JSON array of strings. Include: known pitfalls, file patterns, device quirks, and lessons from past directives. Respond with: {"action":"handle_directly","reasoning":"Session rotation summary","learned":["<your knowledge items>"]}'
      );
      if (summary && summary.learned && summary.learned.length > 0) {
        addKnowledge(summary.learned, `rotation:${_session.id}`);
        knowledgeSummary = `\n\nKNOWLEDGE FROM PREVIOUS SESSION:\n${summary.learned.map(l => `- ${l}`).join("\n")}`;
      }
    } catch (err) {
      log(`Failed to get rotation summary: ${err.message}`);
    }
  }

  // Create new session with bootstrapped knowledge (persisted file + session summary)
  const id = crypto.randomUUID();
  log(`Creating rotated session: ${id}`);

  const persistedKnowledge = getKnowledgeForPrompt();
  const bootstrapMessage = `You are resuming as the Cipher orchestrator after session rotation.${knowledgeSummary}${persistedKnowledge}\n\nRead /home/gcp/ozzu/CLAUDE.md for project context. Respond with: {"action":"handle_directly","reasoning":"Session rotated with knowledge preserved","status_update":"Cipher orchestrator rotated","learned":[]}`;

  const args = [
    "--session-id", id,
    "--model", "opus",
    "--output-format", "json",
    "--allowedTools", "Read Grep Glob Bash WebSearch WebFetch",
    "--system-prompt", SYSTEM_PROMPT,
    "-p", bootstrapMessage,
  ];

  const output = await runClaude(args, ORCHESTRATOR_TIMEOUT_MS);
  parseResponse(output); // validate it parsed OK

  _session = {
    id,
    createdAt: Date.now(),
    messageCount: 1,
    lastUsedAt: Date.now(),
  };
  saveSession();

  log(`Session rotated to: ${id}`);
}

// ── Response parsing ──

function parseResponse(rawOutput) {
  // Claude --output-format json wraps the response — extract the result text
  let text = rawOutput;

  // The json output format returns a JSON object with a "result" field
  try {
    const outer = JSON.parse(rawOutput);
    if (outer.result) {
      text = outer.result;
    } else if (typeof outer === "string") {
      text = outer;
    }
  } catch {
    // rawOutput might be the text directly
  }

  // Try to parse the orchestrator's JSON response from the text
  // It may be embedded in markdown fences or have surrounding text
  const jsonMatch = text.match(/\{[\s\S]*"action"\s*:[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }

  // Try the whole text as JSON
  try {
    const parsed = JSON.parse(text);
    if (parsed.action) return parsed;
  } catch {}

  throw new Error(`Failed to parse orchestrator response: ${text.slice(0, 300)}`);
}

// ── Serialization queue ──
// --resume calls must be sequential (can't resume same session concurrently)

class OrchestratorQueue {
  constructor() {
    this._queue = [];
    this._processing = false;
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._process();
    });
  }

  async _process() {
    if (this._processing) return;
    this._processing = true;

    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }

    this._processing = false;
  }
}

const _queue = new OrchestratorQueue();

// ── Public API ──

async function ensureSession() {
  loadKnowledge();
  if (!loadSession()) {
    try {
      await createSession();
    } catch (err) {
      log(`Failed to create orchestrator session: ${err.message}`);
      log("Orchestrator will be unavailable — directives fall back to direct spawn");
    }
  } else {
    // Verify session is still valid (check if rotation needed)
    if (needsRotation()) {
      try {
        await rotateSession();
      } catch (err) {
        log(`Failed to rotate session: ${err.message} — creating fresh`);
        try {
          await createSession();
        } catch (err2) {
          log(`Failed to create fresh session: ${err2.message}`);
        }
      }
    } else {
      log(`Resuming orchestrator session: ${_session.id}`);
    }
  }
}

async function sendMessage(message) {
  return _queue.enqueue(async () => {
    // Check rotation before each message
    if (needsRotation()) {
      try {
        await rotateSession();
      } catch (err) {
        log(`Rotation failed: ${err.message} — creating fresh`);
        await createSession();
      }
    }

    if (!_session) {
      await createSession();
    }

    try {
      const response = await resumeSession(message);
      log(`Orchestrator response: action=${response.action}, reasoning=${(response.reasoning || "").slice(0, 100)}`);
      // Persist any learned items incrementally
      if (response.learned) addKnowledge(response.learned, `session:${_session.id}`);
      return response;
    } catch (err) {
      // Retry once with explicit JSON instruction
      log(`Orchestrator call failed: ${err.message} — retrying with JSON reminder`);
      try {
        const response = await resumeSession(
          message + "\n\nIMPORTANT: Respond ONLY with a valid JSON object containing an 'action' field."
        );
        if (response.learned) addKnowledge(response.learned, `session:${_session.id}`);
        return response;
      } catch (err2) {
        // Session may be corrupted — create fresh
        log(`Retry also failed: ${err2.message} — creating fresh session`);
        await createSession();
        throw err2;
      }
    }
  });
}

async function handleResponse(directive, response) {
  const { spawnPlanningAgent, spawnImplementationAgent, spawnWorkerWithPrompt } = require("./agent-spawner");

  switch (response.action) {
    case "spawn_worker": {
      const workerType = response.worker_type || "implementation";
      if (response.worker_prompt) {
        log(`Orchestrator dispatching ${workerType} worker for "${directive.title}" with custom prompt`);
        spawnWorkerWithPrompt(directive, workerType, response.worker_prompt);
      } else {
        // No custom prompt — fall back to standard spawn
        log(`Orchestrator dispatching ${workerType} worker for "${directive.title}" (no custom prompt)`);
        if (workerType === "planning") spawnPlanningAgent(directive);
        else spawnImplementationAgent(directive);
      }
      break;
    }

    case "handle_directly": {
      log(`Orchestrator returned handle_directly for "${directive.title}": ${response.reasoning}`);
      // Safety net: if directive needs code work, orchestrator can't handle it — spawn a worker
      const isStatusQuery = /status|info|query|check|what.*running/i.test(directive.title);
      if (!isStatusQuery) {
        log(`handle_directly used for non-status directive — falling back to worker spawn`);
        const type = directive.status === "approved" ? "implementation" : "planning";
        if (type === "planning") spawnPlanningAgent(directive);
        else spawnImplementationAgent(directive);
      }
      break;
    }

    default: {
      // Unknown action — fall back to standard spawn
      log(`Orchestrator returned unknown action "${response.action}" — falling back to standard spawn`);
      const type = directive.status === "approved" ? "implementation" : "planning";
      if (type === "planning") spawnPlanningAgent(directive);
      else spawnImplementationAgent(directive);
    }
  }
}

function isAvailable() {
  return _session !== null;
}

function getSessionInfo() {
  if (!_session) return null;
  return { ..._session };
}

module.exports = {
  ensureSession,
  sendMessage,
  handleResponse,
  isAvailable,
  getSessionInfo,
  parseResponse,
};
