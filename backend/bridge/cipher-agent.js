// cipher-agent.js — Persistent autonomous agent service using Claude Agent SDK
// Replaces cipher-daemon.js subprocess spawning with a warm, long-running agent.
// Listens for watchdog alerts, directive changes, GPU events.
// Maintains session continuity, has MCP tools always connected, budget-capped.

"use strict";

const { query } = require("@anthropic-ai/claude-agent-sdk");
const http = require("http");

// ── Config ──

const COOLDOWN_PER_TYPE_MS = 5 * 60 * 1000;    // 5 min per event type
const MAX_RUNS_PER_HOUR = 8;                     // more generous than old daemon (was 5)
const MAX_BUDGET_PER_RUN_USD = 3.0;              // cost cap per autonomous run
const MAX_TURNS_PER_RUN = 25;                    // turn cap per run
const DAILY_BUDGET_USD = 20.0;                   // daily spend cap
const PROJECT_DIR = "/home/gcp/ozzu";
const BRIDGE_URL = "http://127.0.0.1:3333";

// Service severity for filtering events
const SERVICES_SEVERITY = {
  postgres: "critical", redis: "critical", nginx: "critical",
  openvpn: "high", qdrant: "medium", homeassistant: "medium",
  "face-recognition": "medium", "osint-tools": "low",
  browser: "low", "vast-gpu": "critical",
};

// ── State ──

let _ctx = null;
let _paused = false;
let _watchdogUnsub = null;
let _actionQueue = null;
let _sessionId = null; // Persistent session ID for continuity

// Rate limiting
const _lastRunByType = new Map();
const _runHistory = [];           // { ts, cost, eventKey }
let _dailySpend = 0;
let _dailySpendResetDate = null;
let _runCounter = 0;

// Stats
const _stats = {
  totalRuns: 0,
  totalSuppressed: 0,
  totalSpend: 0,
  lastRunAt: null,
  lastEvent: null,
  errors: [],
};

// ── Event Handlers ──

const EVENT_HANDLERS = {
  serviceTransition: (evt) => {
    if (evt.toStatus !== "down") return null;
    const svc = evt.service;
    const severity = SERVICES_SEVERITY[svc];
    if (!severity || (severity !== "critical" && severity !== "high")) return null;
    return {
      eventKey: `service_down:${svc}`,
      prompt: `URGENT: The ${svc} service just went DOWN (was ${evt.fromStatus}). Details: ${JSON.stringify(evt.details || {})}. Diagnose the root cause, fix it, and verify it's back up. Use docker logs, docker restart, systemctl as needed.`,
      reason: `${svc} service down`,
      priority: "critical",
    };
  },

  gpuIdle: (evt) => ({
    eventKey: "gpu_idle",
    prompt: `The Vast.ai GPU has been idle (${evt.details?.gpuUtil || 0}% utilization) for ${evt.details?.idleMinutes || "several"} minutes while an instance is running and costing money. Check if the training pipeline crashed or completed. If completed, consider stopping the instance. If crashed, investigate and restart.`,
    reason: "GPU idle",
    priority: "high",
  }),

  directiveDeployFailed: (evt) => ({
    eventKey: `deploy_failed:${evt.directiveId}`,
    prompt: `Directive ${evt.directiveId} ("${evt.title || "?"}") just failed deployment. Investigate: check merge-and-deploy logs, verify the branch, check for merge conflicts. Fix and retry the merge-and-deploy.`,
    reason: `deploy failed: ${evt.directiveId}`,
    priority: "high",
  }),

  directiveBlocked: (evt) => ({
    eventKey: `blocked:${evt.directiveId}`,
    prompt: `Directive ${evt.directiveId} ("${evt.title || "?"}") is now BLOCKED. Check failure_reason, check dependencies. If fixable, unblock it. If it requires King Kazuma's input, push an action to the queue describing what's needed.`,
    reason: `blocked: ${evt.directiveId}`,
    priority: "normal",
  }),
};

// ── Core Agent Loop ──

async function handleEvent(evt) {
  if (_paused) return;

  const handler = EVENT_HANDLERS[evt.type];
  if (!handler) return;

  const action = handler(evt);
  if (!action) return;

  _stats.lastEvent = { type: evt.type, key: action.eventKey, ts: Date.now() };

  // Rate limit: per-type cooldown
  const lastRun = _lastRunByType.get(action.eventKey);
  if (lastRun && Date.now() - lastRun < COOLDOWN_PER_TYPE_MS) {
    _stats.totalSuppressed++;
    log(`Suppressed "${action.eventKey}" — cooldown (${Math.round((COOLDOWN_PER_TYPE_MS - (Date.now() - lastRun)) / 1000)}s left)`);
    queueAction(action, "suppressed_cooldown");
    return;
  }

  // Rate limit: hourly cap
  const oneHourAgo = Date.now() - 3600000;
  const recentRuns = _runHistory.filter(r => r.ts > oneHourAgo);
  if (recentRuns.length >= MAX_RUNS_PER_HOUR) {
    _stats.totalSuppressed++;
    log(`Suppressed "${action.eventKey}" — hourly limit (${recentRuns.length}/${MAX_RUNS_PER_HOUR})`);
    queueAction(action, "suppressed_hourly_limit");
    return;
  }

  // Rate limit: daily budget
  resetDailyBudgetIfNeeded();
  if (_dailySpend >= DAILY_BUDGET_USD) {
    _stats.totalSuppressed++;
    log(`Suppressed "${action.eventKey}" — daily budget exhausted ($${_dailySpend.toFixed(2)}/$${DAILY_BUDGET_USD})`);
    queueAction(action, "suppressed_daily_budget");
    return;
  }

  // Run the agent
  await runAgent(action);
}

async function runAgent(action) {
  const runId = `agent_${++_runCounter}_${Date.now()}`;
  const startedAt = Date.now();

  log(`Running agent for: ${action.reason} (${runId})`);

  _lastRunByType.set(action.eventKey, startedAt);
  _stats.totalRuns++;
  _stats.lastRunAt = startedAt;

  const systemPrompt = [
    "You are Cipher, the autonomous dev agent for the ozzu project.",
    "This is an AUTONOMOUS run triggered by the event daemon — no user is present.",
    `Working directory: ${PROJECT_DIR}`,
    "",
    "Rules:",
    "- Follow CLAUDE.md pipeline rules. Create directives for any code changes.",
    "- Be concise and efficient. Fix the issue with minimal steps.",
    "- If you can't fix it, explain what's needed clearly.",
    "- After fixing, verify your fix worked.",
    "- If the fix requires King Kazuma's input, push an action to the queue:",
    `  curl -s -X POST ${BRIDGE_URL}/cipher/actions/push -H 'Content-Type: application/json' -d '{"type":"needs_human","message":"...","priority":"high"}'`,
    "",
    "Bridge API available at: " + BRIDGE_URL,
    "Key endpoints: GET /ops/status, GET /directives, POST /directives/{id}/merge-and-deploy",
  ].join("\n");

  let output = "";
  let cost = 0;
  let exitReason = "unknown";
  let error = null;

  try {
    const messages = query({
      prompt: action.prompt,
      options: {
        systemPrompt,
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
        maxTurns: MAX_TURNS_PER_RUN,
        maxBudgetUsd: MAX_BUDGET_PER_RUN_USD,
        projectDir: PROJECT_DIR,
        permissionMode: "bypassPermissions",
        model: "sonnet",  // Sonnet for autonomous runs — cheaper, still capable
      },
    });

    for await (const message of messages) {
      if (message.type === "assistant" && message.message?.content) {
        for (const block of message.message.content) {
          if ("text" in block) {
            output += block.text + "\n";
          }
        }
      } else if (message.type === "result") {
        exitReason = message.subtype || "completed";
        cost = message.costUsd || 0;
        if (message.sessionId) _sessionId = message.sessionId;
      }
    }
  } catch (err) {
    error = err.message;
    exitReason = "error";
    log(`Run ${runId} error: ${err.message}`);
    _stats.errors.push({ runId, error: err.message, ts: Date.now() });
    if (_stats.errors.length > 20) _stats.errors.shift();
  }

  const duration = Date.now() - startedAt;
  _dailySpend += cost;
  _stats.totalSpend += cost;
  _runHistory.push({ ts: startedAt, cost, eventKey: action.eventKey });

  log(`Run ${runId} finished (${exitReason}, ${Math.round(duration / 1000)}s, $${cost.toFixed(4)})`);

  // Persist to DB
  await persistRun(runId, action, exitReason, output, error, duration, cost);

  // If failed, queue for next interactive session
  if (error || exitReason === "error") {
    queueAction(action, `agent_error: ${error || exitReason}`);
  }

  // Broadcast result
  if (_ctx?.broadcastToAll) {
    _ctx.broadcastToAll({
      type: "cipherAgentRun",
      runId,
      eventKey: action.eventKey,
      reason: action.reason,
      exitReason,
      durationMs: duration,
      costUsd: cost,
      output: output.slice(-500),
      ts: new Date().toISOString(),
    });
  }
}

// ── Persistence ──

async function persistRun(runId, action, exitReason, output, error, durationMs, costUsd) {
  if (!_ctx?.db) return;
  try {
    await _ctx.db.query(
      `INSERT INTO cipher_autonomous_runs (run_id, event_key, reason, prompt, exit_code, stdout, stderr, duration_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [runId, action.eventKey, action.reason, action.prompt,
       exitReason === "error" ? -1 : 0,
       output.slice(-10000),
       error ? `${error}\ncost: $${costUsd.toFixed(4)}` : `cost: $${costUsd.toFixed(4)}`,
       durationMs]
    );
  } catch (err) {
    log(`Failed to persist run ${runId}: ${err.message}`);
  }
}

// ── Action Queue ──

function queueAction(action, reason) {
  if (!_actionQueue) return;
  _actionQueue.push({
    type: "agent_event",
    message: `[${reason}] ${action.reason}: ${action.prompt.slice(0, 200)}`,
    priority: action.priority || "normal",
    dedupKey: action.eventKey,
    metadata: { eventKey: action.eventKey, reason },
    ttlMs: 12 * 60 * 60 * 1000,
  }).catch(() => {});
}

// ── Directive events ──

function onDirectiveStatusChange(evt) {
  if (evt.newStatus === "deploy_failed") {
    handleEvent({ type: "directiveDeployFailed", ...evt });
  } else if (evt.newStatus === "blocked") {
    handleEvent({ type: "directiveBlocked", ...evt });
  }
}

// ── Helpers ──

function resetDailyBudgetIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (_dailySpendResetDate !== today) {
    _dailySpendResetDate = today;
    _dailySpend = 0;
  }
}

function bridgeGet(path) {
  return new Promise((resolve) => {
    const req = http.get(`${BRIDGE_URL}${path}`, { timeout: 5000 }, (res) => {
      let body = ""; res.on("data", c => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ── Public API ──

function start(ctx) {
  _ctx = ctx;
  _paused = false;

  try { _actionQueue = require("./action-queue"); } catch {}

  // Subscribe to watchdog events
  if (ctx.watchdog?.onStateTransition) {
    _watchdogUnsub = ctx.watchdog.onStateTransition(handleEvent);
  }

  // Ensure DB table exists
  ensureTable();

  log("Started — persistent agent service listening for events");
  log(`Config: $${MAX_BUDGET_PER_RUN_USD}/run, $${DAILY_BUDGET_USD}/day, ${MAX_RUNS_PER_HOUR}/hr, ${MAX_TURNS_PER_RUN} turns/run, model=sonnet`);
}

function stop() {
  _paused = true;
  if (_watchdogUnsub) { _watchdogUnsub(); _watchdogUnsub = null; }
  log("Stopped");
}

function pause() {
  _paused = true;
  log("Paused");
}

function resume() {
  _paused = false;
  log("Resumed");
}

function getStatus() {
  resetDailyBudgetIfNeeded();
  return {
    running: !_paused,
    sessionId: _sessionId,
    stats: {
      ..._stats,
      runsLastHour: _runHistory.filter(r => r.ts > Date.now() - 3600000).length,
      maxPerHour: MAX_RUNS_PER_HOUR,
      dailySpend: _dailySpend,
      dailyBudget: DAILY_BUDGET_USD,
      budgetPerRun: MAX_BUDGET_PER_RUN_USD,
      turnsPerRun: MAX_TURNS_PER_RUN,
      model: "sonnet",
      recentErrors: _stats.errors.slice(-5),
    },
  };
}

async function getHistory(limit = 20) {
  if (!_ctx?.db) return [];
  try {
    const result = await _ctx.db.query(
      `SELECT run_id, event_key, reason, exit_code, duration_ms, created_at,
              LEFT(stdout, 500) as output_preview, LEFT(stderr, 200) as cost_info
       FROM cipher_autonomous_runs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch {
    return [];
  }
}

async function ensureTable() {
  if (!_ctx?.db) return;
  try {
    await _ctx.db.query(`
      CREATE TABLE IF NOT EXISTS cipher_autonomous_runs (
        id SERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        reason TEXT,
        prompt TEXT,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        duration_ms INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (err) {
    log(`Failed to create table: ${err.message}`);
  }
}

function log(msg) {
  console.log(`[cipher-agent] ${msg}`);
}

module.exports = { start, stop, pause, resume, getStatus, getHistory, onDirectiveStatusChange };
