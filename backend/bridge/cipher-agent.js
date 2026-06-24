// cipher-agent.js — Persistent autonomous agent service using Claude Agent SDK
// Replaces cipher-daemon.js subprocess spawning with a warm, long-running agent.
// Listens for: watchdog alerts, directive changes, GPU events, approved directives.
// Maintains session continuity, budget tracking (informational on Max plan), work queue.

"use strict";

const { query } = require("@anthropic-ai/claude-agent-sdk");
const http = require("http");

// ── Config ──

const COOLDOWN_PER_TYPE_MS = 5 * 60 * 1000;
const MAX_RUNS_PER_HOUR = 10;
const MAX_TURNS_PER_RUN = 30;
const MAX_TURNS_WORK_QUEUE = 50;             // more turns for implementation work
const PROJECT_DIR = "/home/gcp/ozzu";
const BRIDGE_URL = "http://127.0.0.1:3333";
const WORK_QUEUE_CHECK_INTERVAL_MS = 60000;  // check for approved directives every 60s
const MODEL = "opus";                         // Max subscription — use best model

const SERVICES_SEVERITY = {
  postgres: "critical", redis: "critical", nginx: "critical",
  qdrant: "medium",
  "face-recognition": "medium", "osint-tools": "low",
  browser: "low", "vast-gpu": "critical",
};

// Services that recovery-engine handles first (Tier 1 docker restart).
// cipher-agent only handles these on 'recoveryFailed' events.
const DOCKER_RECOVERABLE = new Set([
  "postgres", "redis", "nginx", "qdrant",
  "face-recognition", "osint-tools", "browser",
]);

// ── State ──

let _ctx = null;
let _paused = false;
let _watchdogUnsub = null;
let _recoveryUnsub = null;
let _actionQueue = null;
let _workQueueTimer = null;
// Directive-auto-implement work-queue. DISABLED by default: every spawn died in ~1s
// (exit 1) across unrelated directives and the churn stalled the bridge listener ~6s/60s.
// The intended model is "Cipher handles directives directly" (see agent-spawner.js). Opt
// in with CIPHER_WORK_QUEUE=on. Runtime toggle (POST /cipher/daemon/work-queue) still works.
let _workQueueEnabled = /^(1|true|on|yes)$/i.test(process.env.CIPHER_WORK_QUEUE || "");
let _workQueueBusy = false;      // prevent concurrent work queue runs
let _currentRun = null;          // { runId, eventKey, reason, startedAt }

// Rate limiting
const _lastRunByType = new Map();
const _runHistory = [];
let _runCounter = 0;

// Stats
const _stats = {
  totalRuns: 0,
  totalSuppressed: 0,
  totalTokensUsed: 0,
  lastRunAt: null,
  lastEvent: null,
  workQueue: { picked: 0, completed: 0, failed: 0 },
  errors: [],
};

// ── Event Handlers (reactive — fires on events) ──

const EVENT_HANDLERS = {
  serviceTransition: (evt) => {
    if (evt.toStatus !== "down") return null;
    const svc = evt.service;
    const severity = SERVICES_SEVERITY[svc];
    if (!severity || (severity !== "critical" && severity !== "high")) return null;
    // Docker-recoverable services are handled by recovery-engine (Tier 1).
    // cipher-agent only fires on recoveryFailed for those.
    if (DOCKER_RECOVERABLE.has(svc)) return null;
    return {
      eventKey: `service_down:${svc}`,
      prompt: `URGENT: The ${svc} service just went DOWN (was ${evt.fromStatus}). Details: ${JSON.stringify(evt.details || {})}. Diagnose the root cause, fix it, and verify it's back up. Use docker logs, docker restart, systemctl as needed.`,
      reason: `${svc} service down`,
      priority: "critical",
      maxTurns: MAX_TURNS_PER_RUN,
    };
  },

  gpuIdle: (evt) => ({
    eventKey: "gpu_idle",
    prompt: `The Vast.ai GPU has been idle (${evt.details?.gpuUtil || 0}% utilization) for ${evt.details?.idleMinutes || "several"} minutes while an instance is running. Check if the training pipeline crashed or completed. If completed, consider stopping the instance. If crashed, investigate and restart.`,
    reason: "GPU idle",
    priority: "high",
    maxTurns: MAX_TURNS_PER_RUN,
  }),

  directiveDeployFailed: (evt) => ({
    eventKey: `deploy_failed:${evt.directiveId}`,
    prompt: `Directive ${evt.directiveId} ("${evt.title || "?"}") just failed deployment. Investigate: check merge-and-deploy logs, verify the branch, check for merge conflicts. Fix and retry.`,
    reason: `deploy failed: ${evt.directiveId}`,
    priority: "high",
    maxTurns: MAX_TURNS_PER_RUN,
  }),

  // Tier 2: recovery-engine failed → LLM diagnoses root cause
  serviceTransitionForced: (evt) => {
    const svc = evt.service;
    const severity = SERVICES_SEVERITY[svc];
    if (!severity || (severity !== "critical" && severity !== "high")) return null;
    const recoveryDetail = evt.details?.detail || "unknown";
    return {
      eventKey: `recovery_failed:${svc}`,
      prompt: `The ${svc} service is DOWN and auto-recovery (docker restart) FAILED. Reason: ${evt.details?.recoveryReason || "exhausted"}. Detail: ${recoveryDetail}. Diagnose the ROOT CAUSE — check docker logs ${svc}, disk space, memory, dependencies. Fix it and verify it's back up.`,
      reason: `${svc} recovery failed — LLM diagnosis`,
      priority: "critical",
      maxTurns: MAX_TURNS_PER_RUN,
    };
  },

  directiveBlocked: (evt) => ({
    eventKey: `blocked:${evt.directiveId}`,
    prompt: `Directive ${evt.directiveId} ("${evt.title || "?"}") is now BLOCKED. Check failure_reason, check dependencies. If fixable, unblock it. If it requires King Kazuma's input, push an action to the queue.`,
    reason: `blocked: ${evt.directiveId}`,
    priority: "normal",
    maxTurns: MAX_TURNS_PER_RUN,
  }),
};

// ── System prompt builder ──

function buildSystemPrompt(mode) {
  const base = [
    "You are Cipher, the autonomous dev agent for the ozzu project.",
    "This is an AUTONOMOUS run — no user is present. You must handle everything yourself.",
    `Working directory: ${PROJECT_DIR}`,
    "",
    "CRITICAL RULES:",
    "- Follow CLAUDE.md pipeline rules strictly.",
    "- For any code changes: create a directive FIRST, then create a branch, then code.",
    "- After changes: commit with directive ID, verify, then merge-and-deploy.",
    "- Verify before merging: `cd frontend && npx expo export --platform android` for frontend, `node -c <file>` for backend.",
    "- If you can't fix something, push a clear action to the queue for King Kazuma:",
    `  curl -s -X POST ${BRIDGE_URL}/cipher/actions/push -H 'Content-Type: application/json' -d '{"type":"needs_human","message":"DESCRIPTION","priority":"high"}'`,
    "",
    `Bridge API: ${BRIDGE_URL}`,
    "Key endpoints:",
    "  GET /ops/status — service health",
    "  GET /directives — all directives",
    "  PATCH /directives/:id — update status",
    "  POST /directives/:id/merge-and-deploy — merge + deploy",
    "  POST /cipher/actions/push — queue action for King Kazuma",
  ];

  if (mode === "work") {
    base.push(
      "",
      "MODE: IMPLEMENTATION — You are picking up an approved directive to implement.",
      "Steps:",
      "1. Read the directive details (title, description, plan if available)",
      "2. Set status to in_progress: PATCH /directives/:id with {\"status\":\"in_progress\"}",
      "3. Create a branch: git checkout -b cipher/:directiveId",
      "4. Read relevant code, understand the codebase",
      "5. Implement the changes",
      "6. Commit with the directive ID in the message",
      "7. Verify the changes work",
      "8. Merge and deploy: POST /directives/:id/merge-and-deploy with {\"branch\":\"cipher/:directiveId\"}",
      "9. If merge fails or verification fails, fix and retry",
      "10. If blocked on something, set directive to blocked with failureReason and push to action queue",
    );
  }

  return base.join("\n");
}

// ── Core ──

async function handleEvent(evt) {
  if (_paused) return;

  const handler = EVENT_HANDLERS[evt.type];
  if (!handler) return;

  const action = handler(evt);
  if (!action) return;

  _stats.lastEvent = { type: evt.type, key: action.eventKey, ts: Date.now() };

  // Don't run if another run is active
  if (_currentRun) {
    log(`Queued "${action.eventKey}" — agent busy with ${_currentRun.reason}`);
    queueAction(action, "agent_busy");
    return;
  }

  // Rate limit: per-type cooldown
  const lastRun = _lastRunByType.get(action.eventKey);
  if (lastRun && Date.now() - lastRun < COOLDOWN_PER_TYPE_MS) {
    _stats.totalSuppressed++;
    queueAction(action, "suppressed_cooldown");
    return;
  }

  // Rate limit: hourly cap
  const recentRuns = _runHistory.filter(r => r.ts > Date.now() - 3600000);
  if (recentRuns.length >= MAX_RUNS_PER_HOUR) {
    _stats.totalSuppressed++;
    queueAction(action, "suppressed_hourly_limit");
    return;
  }

  await runAgent(action, "reactive");
}

async function runAgent(action, mode) {
  const runId = `agent_${++_runCounter}_${Date.now()}`;
  const startedAt = Date.now();

  _currentRun = { runId, eventKey: action.eventKey, reason: action.reason, startedAt };
  _lastRunByType.set(action.eventKey, startedAt);
  _stats.totalRuns++;
  _stats.lastRunAt = startedAt;

  log(`[${mode}] Running: ${action.reason} (${runId})`);

  let output = "";
  let exitReason = "unknown";
  let error = null;
  let tokenUsage = null;

  try {
    const messages = query({
      prompt: action.prompt,
      options: {
        systemPrompt: buildSystemPrompt(mode === "work" ? "work" : "reactive"),
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
        maxTurns: action.maxTurns || MAX_TURNS_PER_RUN,
        projectDir: PROJECT_DIR,
        permissionMode: "bypassPermissions",
        model: MODEL,
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
        // Capture token usage from Agent SDK result
        if (message.total_cost_usd != null || message.modelUsage) {
          tokenUsage = {
            costUsd: message.total_cost_usd || 0,
            modelUsage: message.modelUsage || {},
          };
        }
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
  _runHistory.push({ ts: startedAt, eventKey: action.eventKey });
  _currentRun = null;

  log(`[${mode}] ${runId} finished (${exitReason}, ${Math.round(duration / 1000)}s)`);

  await persistRun(runId, action, exitReason, output, error, duration, mode);

  // Persist token usage
  if (tokenUsage) {
    await persistTokenUsage(runId, tokenUsage, duration);
    // Update in-memory stats
    const totalTk = Object.values(tokenUsage.modelUsage || {}).reduce((sum, m) =>
      sum + (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0), 0);
    _stats.totalTokensUsed += totalTk;
  }

  if (error || exitReason === "error") {
    queueAction(action, `agent_error: ${error || exitReason}`);
  }

  if (_ctx?.broadcastToAll) {
    _ctx.broadcastToAll({
      type: "cipherAgentRun",
      runId, mode,
      eventKey: action.eventKey,
      reason: action.reason,
      exitReason,
      durationMs: duration,
      output: output.slice(-500),
      ts: new Date().toISOString(),
    });
  }

  return { runId, exitReason, duration, error };
}

// ── Work Queue: pick up approved directives ──

async function checkWorkQueue() {
  if (_paused || !_workQueueEnabled || _workQueueBusy || _currentRun) return;

  try {
    _workQueueBusy = true;
    const directives = await bridgeGet("/directives");
    if (!Array.isArray(directives)) return;

    // Find approved directives that are type=quick (auto-implement)
    // Features need explicit human approval + oversight, so skip those
    const ready = directives.filter(d =>
      d.status === "approved" &&
      d.type === "quick" &&
      d.createdBy === "cipher"  // only pick up directives Cipher created
    );

    if (ready.length === 0) return;

    // Pick the oldest approved directive
    const directive = ready.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];

    log(`[work-queue] Picking up approved directive: ${directive.id} "${directive.title}"`);
    _stats.workQueue.picked++;

    const action = {
      eventKey: `work:${directive.id}`,
      prompt: [
        `Implement approved directive ${directive.id}: "${directive.title}"`,
        "",
        `Description: ${directive.description || "No description"}`,
        directive.plan ? `Plan: ${directive.plan}` : "",
        directive.working_state?.plan ? `Working state plan: ${directive.working_state.plan}` : "",
        "",
        "This directive has been approved. Implement it now following the pipeline steps.",
        `Directive ID: ${directive.id}`,
      ].filter(Boolean).join("\n"),
      reason: `implement: ${directive.title}`,
      priority: "normal",
      maxTurns: MAX_TURNS_WORK_QUEUE,
    };

    const result = await runAgent(action, "work");

    if (!result.error && result.exitReason !== "error") {
      _stats.workQueue.completed++;
      log(`[work-queue] Completed: ${directive.id}`);
    } else {
      _stats.workQueue.failed++;
      log(`[work-queue] Failed: ${directive.id} — ${result.error || result.exitReason}`);
    }
  } catch (err) {
    log(`[work-queue] Check error: ${err.message}`);
  } finally {
    _workQueueBusy = false;
  }
}

// ── Persistence ──

async function persistRun(runId, action, exitReason, output, error, durationMs, mode) {
  if (!_ctx?.db) return;
  try {
    await _ctx.db.query(
      `INSERT INTO cipher_autonomous_runs (run_id, event_key, reason, prompt, exit_code, stdout, stderr, duration_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [runId, action.eventKey, `[${mode}] ${action.reason}`, action.prompt,
       exitReason === "error" ? -1 : 0,
       output.slice(-10000),
       error || "",
       durationMs]
    );
  } catch (err) {
    log(`Failed to persist run ${runId}: ${err.message}`);
  }
}

// ── Token Usage Persistence ──

async function persistTokenUsage(runId, usage, durationMs) {
  if (!_ctx?.db) return;
  try {
    // Insert per-model breakdown
    const models = usage.modelUsage || {};
    for (const [model, data] of Object.entries(models)) {
      await _ctx.db.query(
        `INSERT INTO token_usage (source, run_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          "agent_sdk",
          runId,
          model,
          data.inputTokens || 0,
          data.outputTokens || 0,
          data.cacheReadInputTokens || 0,
          data.cacheCreationInputTokens || 0,
          data.costUSD || 0,
          durationMs,
          JSON.stringify({ totalCost: usage.costUsd }),
        ]
      );
    }
    // If no per-model data, insert aggregate
    if (Object.keys(models).length === 0 && usage.costUsd > 0) {
      await _ctx.db.query(
        `INSERT INTO token_usage (source, run_id, model, cost_usd, duration_ms, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ["agent_sdk", runId, MODEL, usage.costUsd, durationMs, JSON.stringify(usage)]
      );
    }
    log(`Token usage saved for ${runId}: $${usage.costUsd?.toFixed(4) || "0"}`);
  } catch (err) {
    log(`Failed to persist token usage: ${err.message}`);
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
  // Approved directives are picked up by the work queue timer, not here
  // This avoids race conditions with the approval flow
}

// ── Helpers ──

function bridgeGet(urlPath) {
  return new Promise((resolve) => {
    const req = http.get(`${BRIDGE_URL}${urlPath}`, { timeout: 5000 }, (res) => {
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

  // Subscribe to watchdog events (non-recoverable services only — see serviceTransition filter)
  if (ctx.watchdog?.onStateTransition) {
    _watchdogUnsub = ctx.watchdog.onStateTransition(handleEvent);
  }

  // Subscribe to recovery-engine failures (Tier 2 — LLM diagnoses after docker restart failed)
  if (ctx.recoveryEngine?.onRecoveryFailed) {
    _recoveryUnsub = ctx.recoveryEngine.onRecoveryFailed((payload) => {
      // Skip external services and cooldown — those don't need LLM
      if (payload.reason === "external_service" || payload.reason === "cooldown") return;
      handleEvent({
        type: "serviceTransitionForced",
        service: payload.service,
        toStatus: "down",
        fromStatus: "recovering",
        details: { recoveryReason: payload.reason, detail: payload.detail },
      });
    });
  }

  // Start work queue polling only when enabled (default OFF — see _workQueueEnabled).
  // When disabled, no 60s interval runs at all, so the broken spawner stays fully silent.
  if (_workQueueEnabled) {
    _workQueueTimer = setInterval(checkWorkQueue, WORK_QUEUE_CHECK_INTERVAL_MS);
  }

  ensureTable();

  log("Started — persistent agent service (Agent SDK)");
  log(`Config: model=${MODEL}, ${MAX_RUNS_PER_HOUR}/hr, ${MAX_TURNS_PER_RUN} turns/reactive, ${MAX_TURNS_WORK_QUEUE} turns/work, work-queue=${_workQueueEnabled ? "on" : "off"}`);
}

function stop() {
  _paused = true;
  if (_watchdogUnsub) { _watchdogUnsub(); _watchdogUnsub = null; }
  if (_recoveryUnsub) { _recoveryUnsub(); _recoveryUnsub = null; }
  if (_workQueueTimer) { clearInterval(_workQueueTimer); _workQueueTimer = null; }
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

function setWorkQueue(enabled) {
  _workQueueEnabled = !!enabled;
  // Arm/disarm the poller so the runtime toggle works without a restart.
  if (_workQueueEnabled && !_workQueueTimer) {
    _workQueueTimer = setInterval(checkWorkQueue, WORK_QUEUE_CHECK_INTERVAL_MS);
  } else if (!_workQueueEnabled && _workQueueTimer) {
    clearInterval(_workQueueTimer);
    _workQueueTimer = null;
  }
  log(`Work queue ${_workQueueEnabled ? "enabled" : "disabled"}`);
}

function getStatus() {
  return {
    running: !_paused,
    model: MODEL,
    currentRun: _currentRun ? {
      runId: _currentRun.runId,
      reason: _currentRun.reason,
      runningFor: Math.round((Date.now() - _currentRun.startedAt) / 1000),
    } : null,
    workQueue: {
      enabled: _workQueueEnabled,
      busy: _workQueueBusy,
      ..._stats.workQueue,
    },
    stats: {
      totalRuns: _stats.totalRuns,
      totalSuppressed: _stats.totalSuppressed,
      lastRunAt: _stats.lastRunAt,
      lastEvent: _stats.lastEvent,
      runsLastHour: _runHistory.filter(r => r.ts > Date.now() - 3600000).length,
      maxPerHour: MAX_RUNS_PER_HOUR,
      turnsPerRun: MAX_TURNS_PER_RUN,
      turnsPerWork: MAX_TURNS_WORK_QUEUE,
      recentErrors: _stats.errors.slice(-5),
    },
  };
}

async function getHistory(limit = 20) {
  if (!_ctx?.db) return [];
  try {
    const result = await _ctx.db.query(
      `SELECT run_id, event_key, reason, exit_code, duration_ms, created_at,
              LEFT(stdout, 500) as output_preview
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

module.exports = { start, stop, pause, resume, setWorkQueue, getStatus, getHistory, onDirectiveStatusChange };
