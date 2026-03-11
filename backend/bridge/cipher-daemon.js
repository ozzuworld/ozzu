// cipher-daemon.js — Event-driven autonomous agent spawner
// Listens for watchdog alerts, directive failures, and GPU events.
// Spawns `claude -p "..."` to handle issues without user intervention.
// Rate-limited: max 1 spawn per event type per 5 min, max 5 spawns/hour total.

"use strict";

const { execSync, spawn } = require("child_process");
const path = require("path");

// ── Config ──

const COOLDOWN_PER_TYPE_MS = 5 * 60 * 1000;  // 5 min per event type
const MAX_SPAWNS_PER_HOUR = 5;
const SPAWN_TIMEOUT_MS = 10 * 60 * 1000;      // kill after 10 min
const PROJECT_DIR = "/home/gcp/ozzu";

// Events that trigger a spawn
const EVENT_HANDLERS = {
  // Watchdog: critical/high service goes down
  serviceTransition: (evt) => {
    if (evt.toStatus !== "down") return null;
    const svc = evt.service;
    const severity = SERVICES_SEVERITY[svc];
    if (!severity || (severity !== "critical" && severity !== "high")) return null;
    return {
      eventKey: `service_down:${svc}`,
      prompt: `URGENT: The ${svc} service just went DOWN. Previous status: ${evt.fromStatus}. Details: ${JSON.stringify(evt.details || {})}. Diagnose and fix this immediately. Check logs with docker logs, restart if needed, verify it comes back. Report what you find.`,
      reason: `${svc} service down`,
    };
  },

  // GPU idle — burning money
  gpuIdle: (evt) => ({
    eventKey: "gpu_idle",
    prompt: `The Vast.ai GPU has been idle (${evt.details?.gpuUtil || 0}% utilization) for ${evt.details?.idleMinutes || "several"} minutes. Check if the training pipeline crashed, if there are more datasets to process, or if the instance should be stopped to save money. Check /ops/gpu for details.`,
    reason: "GPU idle",
  }),

  // Directive deploy failed
  directiveDeployFailed: (evt) => ({
    eventKey: `deploy_failed:${evt.directiveId}`,
    prompt: `Directive ${evt.directiveId} ("${evt.title || "unknown"}") just failed deployment. Previous status: ${evt.oldStatus}. Investigate: check the merge-and-deploy logs, verify the branch exists, check if there are merge conflicts. Try to recover by fixing the issue and re-running merge-and-deploy.`,
    reason: `deploy failed: ${evt.directiveId}`,
  }),

  // Directive blocked
  directiveBlocked: (evt) => ({
    eventKey: `blocked:${evt.directiveId}`,
    prompt: `Directive ${evt.directiveId} ("${evt.title || "unknown"}") is now BLOCKED. Investigate: check the failure_reason, check dependencies, see if the blocker can be resolved. If it requires King Kazuma's input, note what's needed.`,
    reason: `blocked: ${evt.directiveId}`,
  }),
};

const SERVICES_SEVERITY = {
  postgres: "critical",
  redis: "critical",
  nginx: "critical",
  openvpn: "high",
  qdrant: "medium",
  homeassistant: "medium",
  "face-recognition": "medium",
  "osint-tools": "low",
  browser: "low",
  "vast-gpu": "critical",
};

// ── State ──

let _ctx = null;
let _paused = false;
let _watchdogUnsub = null;

// Rate limiting
const _lastSpawnByType = new Map();  // eventKey → timestamp
const _spawnHistory = [];            // timestamps of all spawns (rolling 1hr window)
const _activeRuns = new Map();       // runId → { process, eventKey, startedAt, reason }
let _runCounter = 0;

// Stats
const _stats = {
  totalSpawns: 0,
  totalSuppressed: 0,
  lastSpawnAt: null,
  lastEvent: null,
};

// ── Core ──

function handleEvent(evt) {
  if (_paused) return;

  const handler = EVENT_HANDLERS[evt.type];
  if (!handler) return;

  const action = handler(evt);
  if (!action) return;

  _stats.lastEvent = { type: evt.type, key: action.eventKey, ts: Date.now() };

  // Rate limit: per-type cooldown
  const lastSpawn = _lastSpawnByType.get(action.eventKey);
  if (lastSpawn && Date.now() - lastSpawn < COOLDOWN_PER_TYPE_MS) {
    _stats.totalSuppressed++;
    log(`Suppressed spawn for "${action.eventKey}" — cooldown active (${Math.round((COOLDOWN_PER_TYPE_MS - (Date.now() - lastSpawn)) / 1000)}s left)`);
    return;
  }

  // Rate limit: global hourly cap
  const oneHourAgo = Date.now() - 3600000;
  const recentSpawns = _spawnHistory.filter((t) => t > oneHourAgo);
  if (recentSpawns.length >= MAX_SPAWNS_PER_HOUR) {
    _stats.totalSuppressed++;
    log(`Suppressed spawn for "${action.eventKey}" — hourly limit reached (${recentSpawns.length}/${MAX_SPAWNS_PER_HOUR})`);
    return;
  }

  spawnClaude(action);
}

function spawnClaude(action) {
  const runId = `daemon_${++_runCounter}_${Date.now()}`;
  const startedAt = Date.now();

  log(`Spawning Claude for: ${action.reason} (run: ${runId})`);

  // Record rate limit state
  _lastSpawnByType.set(action.eventKey, startedAt);
  _spawnHistory.push(startedAt);
  _stats.totalSpawns++;
  _stats.lastSpawnAt = startedAt;

  // Build the prompt with context
  const fullPrompt = [
    "You are Cipher, the autonomous dev agent for the ozzu project.",
    "This is an AUTONOMOUS run triggered by the event daemon — no user is present.",
    "Work directory: /home/gcp/ozzu",
    "Follow CLAUDE.md pipeline rules. Create directives for any code changes.",
    "Be concise. Fix the issue. If you can't fix it, explain what's needed.",
    "",
    action.prompt,
  ].join("\n");

  let stdout = "";
  let stderr = "";

  const proc = spawn("claude", ["-p", fullPrompt, "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep"], {
    cwd: PROJECT_DIR,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cipher-daemon" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SPAWN_TIMEOUT_MS,
  });

  _activeRuns.set(runId, { process: proc, eventKey: action.eventKey, startedAt, reason: action.reason });

  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    const duration = Date.now() - startedAt;
    _activeRuns.delete(runId);

    log(`Run ${runId} finished (exit=${code}, ${Math.round(duration / 1000)}s)`);

    // Persist to DB
    persistRun(runId, action, code, stdout, stderr, duration);

    // Broadcast result to dashboard
    if (_ctx?.broadcastToAll) {
      _ctx.broadcastToAll({
        type: "cipherDaemonRun",
        runId,
        eventKey: action.eventKey,
        reason: action.reason,
        exitCode: code,
        durationMs: duration,
        output: stdout.slice(-500),  // last 500 chars
        ts: new Date().toISOString(),
      });
    }
  });

  proc.on("error", (err) => {
    _activeRuns.delete(runId);
    log(`Run ${runId} failed to spawn: ${err.message}`);
    persistRun(runId, action, -1, "", err.message, 0);
  });
}

async function persistRun(runId, action, exitCode, stdout, stderr, durationMs) {
  if (!_ctx?.db) return;
  try {
    await _ctx.db.query(
      `INSERT INTO cipher_autonomous_runs (run_id, event_key, reason, prompt, exit_code, stdout, stderr, duration_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [runId, action.eventKey, action.reason, action.prompt, exitCode, stdout.slice(-10000), stderr.slice(-5000), durationMs]
    );
  } catch (err) {
    log(`Failed to persist run ${runId}: ${err.message}`);
  }
}

// ── Directive event handler (called from routes/directives.js) ──

function onDirectiveStatusChange(evt) {
  if (evt.newStatus === "deploy_failed") {
    handleEvent({ type: "directiveDeployFailed", ...evt });
  } else if (evt.newStatus === "blocked") {
    handleEvent({ type: "directiveBlocked", ...evt });
  }
}

// ── Public API ──

function start(ctx) {
  _ctx = ctx;
  _paused = false;

  // Subscribe to watchdog state transitions
  if (ctx.watchdog?.onStateTransition) {
    _watchdogUnsub = ctx.watchdog.onStateTransition(handleEvent);
  }

  log("Started — listening for events");

  // Create DB table if needed
  ensureTable();
}

function stop() {
  _paused = true;
  if (_watchdogUnsub) { _watchdogUnsub(); _watchdogUnsub = null; }

  // Kill active runs
  for (const [runId, run] of _activeRuns) {
    log(`Killing active run ${runId}`);
    try { run.process.kill("SIGTERM"); } catch {}
  }
  _activeRuns.clear();

  log("Stopped");
}

function pause() {
  _paused = true;
  log("Paused — events will be ignored until resumed");
}

function resume() {
  _paused = false;
  log("Resumed — listening for events");
}

function getStatus() {
  return {
    running: !_paused,
    activeRuns: Array.from(_activeRuns.entries()).map(([id, r]) => ({
      runId: id,
      eventKey: r.eventKey,
      reason: r.reason,
      startedAt: r.startedAt,
      runningFor: Math.round((Date.now() - r.startedAt) / 1000),
    })),
    stats: {
      ..._stats,
      spawnsLastHour: _spawnHistory.filter((t) => t > Date.now() - 3600000).length,
      maxPerHour: MAX_SPAWNS_PER_HOUR,
      cooldownPerTypeMs: COOLDOWN_PER_TYPE_MS,
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
  console.log(`[cipher-daemon] ${msg}`);
}

module.exports = { start, stop, pause, resume, getStatus, getHistory, onDirectiveStatusChange };
