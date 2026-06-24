// cipher-daemon.js — Event-driven autonomous agent spawner
// Listens for watchdog alerts, directive failures, and GPU events.
// Spawns `claude -p "..."` to handle issues without user intervention.
// Rate-limited: max 1 spawn per event type per 5 min, max 5 spawns/hour total.

"use strict";

const { execSync, spawn } = require("child_process");
const path = require("path");
let _actionQueue = null;

// ── Config ──

const COOLDOWN_PER_TYPE_MS = 5 * 60 * 1000;  // 5 min per event type
const MAX_SPAWNS_PER_HOUR = 5;
const SPAWN_TIMEOUT_MS = 10 * 60 * 1000;      // kill after 10 min
const PROJECT_DIR = "/home/gcp/ozzu";

// ── COORDINATOR pattern — model routing (from Claude Code leak) ──
// Haiku for investigation/status tasks ($0.25/MTok)
// Sonnet for complex fixes and decisions ($3/MTok) — 12x cost reduction on grunt work
const MODEL_HAIKU = "claude-haiku-4-5-20251001";
const MODEL_SONNET = "claude-sonnet-4-6";

function selectModel(eventKey) {
  // Critical fixes need full reasoning → Sonnet
  if (eventKey.startsWith("service_down:postgres") ||
      eventKey.startsWith("service_down:redis") ||
      eventKey.startsWith("service_down:nginx") ||
      eventKey.startsWith("deploy_failed:") ||
      eventKey.startsWith("blocked:") ||
      eventKey.startsWith("kairos:")) {
    return MODEL_SONNET;
  }
  // Investigation, status checks, idle monitoring → Haiku
  return MODEL_HAIKU;
}

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
  qdrant: "medium",
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
    queueAction(action, "suppressed_cooldown");
    return;
  }

  // Rate limit: global hourly cap
  const oneHourAgo = Date.now() - 3600000;
  const recentSpawns = _spawnHistory.filter((t) => t > oneHourAgo);
  if (recentSpawns.length >= MAX_SPAWNS_PER_HOUR) {
    _stats.totalSuppressed++;
    log(`Suppressed spawn for "${action.eventKey}" — hourly limit reached (${recentSpawns.length}/${MAX_SPAWNS_PER_HOUR})`);
    queueAction(action, "suppressed_hourly_limit");
    return;
  }

  spawnClaude(action);
}

function spawnClaude(action) {
  const runId = `daemon_${++_runCounter}_${Date.now()}`;
  const startedAt = Date.now();

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

  const model = action.model || selectModel(action.eventKey);
  log(`Spawning Claude for: ${action.reason} (run: ${runId}, model: ${model})`);

  const proc = spawn("claude", ["-p", fullPrompt, "--model", model, "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep"], {
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

    // If daemon run failed, queue for next session
    if (code !== 0 && _actionQueue) {
      _actionQueue.push({
        type: "daemon_failed_run",
        message: `Daemon auto-fix failed (exit ${code}): ${action.reason}. Output: ${stdout.slice(-200)}`,
        priority: "high",
        dedupKey: action.eventKey,
        metadata: { runId, eventKey: action.eventKey, exitCode: code },
        ttlMs: 12 * 60 * 60 * 1000,
      }).catch(() => {});
    }

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

// ── Action Queue integration ──

function queueAction(action, reason) {
  if (!_actionQueue) return;
  _actionQueue.push({
    type: "daemon_event",
    message: `[${reason}] ${action.reason}: ${action.prompt.slice(0, 200)}`,
    priority: action.eventKey.startsWith("service_down:") ? "critical" :
              action.eventKey.startsWith("deploy_failed:") ? "high" :
              action.eventKey === "gpu_idle" ? "high" : "normal",
    dedupKey: action.eventKey,
    metadata: { eventKey: action.eventKey, reason },
    ttlMs: 12 * 60 * 60 * 1000, // 12 hours
  }).catch(() => {});
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

  // Capture action queue for pushing suppressed events
  try { _actionQueue = require("../action-queue"); } catch {}

  // Subscribe to watchdog state transitions
  if (ctx.watchdog?.onStateTransition) {
    _watchdogUnsub = ctx.watchdog.onStateTransition(handleEvent);
  }

  log("Started — listening for events");

  // Create DB table if needed
  ensureTable();

  // Start autoDream idle consolidation
  startAutoDream();

  // Start KAIROS autonomous tick
  startKairos();
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

  stopAutoDream();
  stopKairos();
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

// ── autoDream — idle-period memory consolidation ──
// Inspired by Claude Code leak: during idle periods, consolidate session
// transcripts into persistent memory files. Self-improving memory between sessions.
// 4 phases: Orient → Gather → Consolidate → Prune

const AUTODREAM_IDLE_THRESHOLD_MS = 30 * 60 * 1000;  // 30 min idle before dreaming
const AUTODREAM_CHECK_INTERVAL_MS = 5 * 60 * 1000;   // check every 5 min
const AUTODREAM_COOLDOWN_MS = 6 * 60 * 60 * 1000;    // max once per 6 hours
const MEMORY_DIR = "/root/.claude/projects/-home-gcp-ozzu/memory";

let _lastDreamAt = 0;
let _dreamTimer = null;
let _dreamRunning = false;

function startAutoDream() {
  _dreamTimer = setInterval(checkIdleAndDream, AUTODREAM_CHECK_INTERVAL_MS);
  log("[autoDream] Started — checking every 5 min for idle periods");
}

function stopAutoDream() {
  if (_dreamTimer) { clearInterval(_dreamTimer); _dreamTimer = null; }
}

async function checkIdleAndDream() {
  if (_dreamRunning) return;
  if (Date.now() - _lastDreamAt < AUTODREAM_COOLDOWN_MS) return;
  if (!_ctx?.db) return;

  try {
    // Check last session activity — uses cipher_sessions table
    const result = await _ctx.db.query(
      `SELECT MAX(created_at) as last_active FROM cipher_sessions WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    const lastActive = result.rows[0]?.last_active;
    if (!lastActive) return;

    const idleMs = Date.now() - new Date(lastActive).getTime();
    if (idleMs < AUTODREAM_IDLE_THRESHOLD_MS) return;

    log(`[autoDream] Idle ${Math.round(idleMs / 60000)}m — starting dream cycle`);
    runAutoDream();
  } catch (err) {
    if (!err.message?.includes("does not exist")) {
      log(`[autoDream] Idle check error: ${err.message}`);
    }
  }
}

async function runAutoDream() {
  if (_dreamRunning) return;
  _dreamRunning = true;
  _lastDreamAt = Date.now();

  try {
    const fs = require("fs");
    const path = require("path");

    // Phase 1: Orient — read existing memory files
    let existingMemory = "";
    try {
      const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
      for (const f of files.slice(0, 8)) {
        const content = fs.readFileSync(path.join(MEMORY_DIR, f), "utf8");
        existingMemory += `\n### ${f}\n${content.slice(0, 1500)}\n`;
      }
    } catch {}

    // Phase 2: Gather — last 5 session summaries from postgres
    let recentTranscripts = "";
    try {
      const sessions = await _ctx.db.query(
        `SELECT summary, created_at FROM cipher_sessions
         WHERE created_at > NOW() - INTERVAL '48 hours'
         ORDER BY created_at DESC LIMIT 5`
      );
      for (const row of sessions.rows) {
        recentTranscripts += `\n[${new Date(row.created_at).toISOString()}]\n${(row.summary || "").slice(0, 800)}\n`;
      }
    } catch {}

    if (!recentTranscripts && !existingMemory) {
      log("[autoDream] Nothing to consolidate — skipping");
      return;
    }

    // Phase 3: Consolidate — call Haiku to extract patterns
    const prompt = [
      "You are consolidating memory for Cipher, the ozzu dev agent.",
      "Review recent session summaries and existing memory. Extract what's new and worth remembering.",
      "Output ONLY valid JSON: {\"feedback\": \"...\", \"project\": \"...\"}",
      "Max 200 chars per field. Only include fields with genuinely new info. Output {} if nothing new.",
      "",
      "## Recent Sessions",
      recentTranscripts || "(none)",
      "",
      "## Existing Memory (dedup against this)",
      existingMemory.slice(0, 2000) || "(none)",
    ].join("\n");

    const { execSync } = require("child_process");
    let output = "";
    try {
      output = execSync(
        `claude -p ${JSON.stringify(prompt)} --model claude-haiku-4-5-20251001 --output-format text`,
        { cwd: "/home/gcp/ozzu", encoding: "utf8", timeout: 60000, env: { ...process.env } }
      );
    } catch (err) {
      log(`[autoDream] Haiku call failed: ${err.message}`);
      return;
    }

    // Phase 4: Prune — parse and write memory files
    try {
      const match = output.match(/\{[\s\S]*\}/);
      if (!match) return;
      const insights = JSON.parse(match[0]);
      const ts = new Date().toISOString().slice(0, 10);

      if (insights.feedback?.trim()) {
        fs.appendFileSync(path.join(MEMORY_DIR, "autodream_feedback.md"), `\n## ${ts}\n${insights.feedback}\n`);
        log("[autoDream] Updated feedback memory");
      }
      if (insights.project?.trim()) {
        fs.appendFileSync(path.join(MEMORY_DIR, "autodream_project.md"), `\n## ${ts}\n${insights.project}\n`);
        log("[autoDream] Updated project memory");
      }

      await _ctx.db.query(
        `INSERT INTO cipher_autonomous_runs (run_id, event_key, reason, prompt, exit_code, stdout, duration_ms, created_at)
         VALUES ($1, 'autodream', 'idle consolidation', $2, 0, $3, 0, NOW())`,
        [`dream_${Date.now()}`, prompt.slice(0, 500), output.slice(0, 2000)]
      ).catch(() => {});

      log("[autoDream] Dream cycle complete");
    } catch (err) {
      log(`[autoDream] Write failed: ${err.message}`);
    }
  } finally {
    _dreamRunning = false;
  }
}

function getAutoDreamStatus() {
  return {
    running: _dreamRunning,
    lastDreamAt: _lastDreamAt ? new Date(_lastDreamAt).toISOString() : null,
    nextEligibleAt: _lastDreamAt ? new Date(_lastDreamAt + AUTODREAM_COOLDOWN_MS).toISOString() : "now",
  };
}

// ── KAIROS — 24/7 autonomous tick ──
// Inspired by Claude Code leak: every 15 min, checks system state and acts on urgent issues.
// Has 15-second blocking budget. Sends push notifications. Append-only audit log.

const KAIROS_INTERVAL_MS = 15 * 60 * 1000;
const KAIROS_ACT_COOLDOWN_MS = 60 * 60 * 1000;   // min 1hr between autonomous actions
const KAIROS_AUDIT_LOG = "/home/gcp/ozzu/logs/kairos-audit.log";

let _kairosTimer = null;
let _kairosRunning = false;
let _lastKairosActionAt = 0;

function startKairos() {
  const fs = require("fs");
  const path = require("path");
  try { fs.mkdirSync(path.dirname(KAIROS_AUDIT_LOG), { recursive: true }); } catch {}
  _kairosTimer = setInterval(kairosTickSafe, KAIROS_INTERVAL_MS);
  kairosAuditLog("KAIROS started");
  log("[KAIROS] Started — ticking every 15 min");
}

function stopKairos() {
  if (_kairosTimer) { clearInterval(_kairosTimer); _kairosTimer = null; }
  kairosAuditLog("KAIROS stopped");
}

function kairosAuditLog(msg) {
  const fs = require("fs");
  try { fs.appendFileSync(KAIROS_AUDIT_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

async function kairosTickSafe() {
  try { await kairosTick(); } catch (err) {
    log(`[KAIROS] Tick error: ${err.message}`);
    kairosAuditLog(`TICK_ERROR: ${err.message}`);
  }
}

// Session lock — written by cipher.sh, removed on exit
const KAIROS_SESSION_LOCK = "/tmp/cipher-session.lock";

function isHumanSessionActive() {
  try {
    if (fs.existsSync(KAIROS_SESSION_LOCK)) return true;
  } catch {}
  // Fallback: check if a claude process is running
  try {
    const { execSync } = require("child_process");
    const out = execSync("pgrep -f 'claude ' 2>/dev/null || true", { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {}
  return false;
}

// Track WA restart attempts to avoid infinite loops
let _waRestartAttempts = 0;
const WA_RESTART_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between restart attempts
let _lastWaRestartAt = 0;

async function restartWaAgent() {
  const { execSync } = require("child_process");
  try {
    // Kill existing process
    execSync("ssh -p 8023 -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes localhost 'pkill -f \"node index.js\" 2>/dev/null; true'", { timeout: 8000 });
    await new Promise(r => setTimeout(r, 2000));
    // Restart agent
    execSync("ssh -p 8023 -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes localhost 'cd ~/wa-agent && node index.js > ~/wa-agent.log 2>&1 &'", { timeout: 8000 });
    // Wait for it to connect
    await new Promise(r => setTimeout(r, 8000));
    // Check if ready
    const http = require("http");
    const status = await new Promise((resolve) => {
      const req = http.request({ hostname: "localhost", port: 8766, path: "/status", method: "GET", timeout: 5000 },
        (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.end();
    });
    return status?.ready === true;
  } catch (err) {
    log(`[KAIROS] WA restart SSH error: ${err.message}`);
    return false;
  }
}

async function kairosTick() {
  if (_kairosRunning || !_ctx) return;
  _kairosRunning = true;
  try {
    const snapshot = await buildKairosSnapshot();

    // Auto-fix WA agent if disconnected — silently before checking other urgents
    const waDisconnected = snapshot.issues.find(i => i.type === "wa_disconnected");
    if (waDisconnected) {
      const now = Date.now();
      if (now - _lastWaRestartAt > WA_RESTART_COOLDOWN_MS) {
        _lastWaRestartAt = now;
        _waRestartAttempts++;
        log(`[KAIROS] WA agent disconnected — attempting restart (attempt ${_waRestartAttempts})`);
        kairosAuditLog(`WA_RESTART_ATTEMPT: #${_waRestartAttempts}`);
        const recovered = await restartWaAgent();
        if (recovered) {
          log(`[KAIROS] WA agent recovered successfully`);
          kairosAuditLog(`WA_RESTART_SUCCESS`);
          _waRestartAttempts = 0;
          // Remove wa_disconnected from issues since it's fixed
          snapshot.issues.splice(snapshot.issues.indexOf(waDisconnected), 1);
        } else {
          log(`[KAIROS] WA agent restart failed`);
          kairosAuditLog(`WA_RESTART_FAILED`);
          // Alert King Kazuma directly via bridge HTTP (WA is down so we log only)
          snapshot.issues.push({ type: "wa_failed", attempts: _waRestartAttempts });
        }
      }
    } else {
      _waRestartAttempts = 0; // reset counter when WA is healthy
    }

    // OSINT: process un-enriched observations via Claude NLP (non-blocking, every tick)
    await kairosOsintEnrich();

    // OSINT: check if any subjects are due for re-collection
    await kairosOsintAutoCollect(snapshot);

    const urgent = detectUrgent(snapshot);
    if (!urgent) return;

    kairosAuditLog(`URGENT: ${urgent.type} — ${urgent.message}`);
    log(`[KAIROS] Urgent detected: ${urgent.type}`);

    // Always send push notification (non-destructive, even during human session)
    await kairosPush(urgent);

    // Only spawn autonomous fix when NO human session is active
    const humanActive = isHumanSessionActive();
    if (humanActive) {
      log(`[KAIROS] Human session active — push sent, auto-fix deferred`);
      kairosAuditLog(`DEFERRED (human session active): ${urgent.type}`);
      return;
    }

    // Spawn autonomous fix for critical issues (rate-limited to 1/hr)
    if (urgent.severity === "critical" && Date.now() - _lastKairosActionAt > KAIROS_ACT_COOLDOWN_MS) {
      _lastKairosActionAt = Date.now();
      spawnKairosAction(urgent);
    }
  } finally {
    _kairosRunning = false;
  }
}

async function buildKairosSnapshot() {
  const issues = [];

  // Check directives — stuck or deploy_failed
  try {
    const directives = _ctx.getDirectives ? _ctx.getDirectives() : [];
    const stuck = directives.filter(d =>
      d.status === "deploy_failed" ||
      (d.status === "in_progress" && d.updatedAt && Date.now() - new Date(d.updatedAt).getTime() > 4 * 60 * 60 * 1000)
    );
    if (stuck.length > 0) issues.push({ type: "stuck_directives", count: stuck.length, items: stuck.map(d => d.title).slice(0, 3) });
  } catch {}

  // Check service health via watchdog
  try {
    const watchdog = require("../infra/watchdog");
    const status = watchdog.getStatus();
    const down = Object.entries(status).filter(([, v]) => v?.status === "down").map(([k]) => k);
    if (down.length > 0) issues.push({ type: "services_down", services: down });
  } catch {}

  // Check WA agent connectivity
  try {
    const http = require("http");
    const waStatus = await new Promise((resolve) => {
      const req = http.request({ hostname: "localhost", port: 8766, path: "/status", method: "GET", timeout: 3000 },
        (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.end();
    });
    if (!waStatus?.ready) issues.push({ type: "wa_disconnected" });
  } catch {}

  // Check backup age
  try {
    const fs = require("fs");
    const backupDir = "/home/gcp/ozzu/backups";
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith("ozzu-backup-")).sort().reverse();
    if (files.length > 0) {
      const ageHours = (Date.now() - fs.statSync(`${backupDir}/${files[0]}`).mtime.getTime()) / 3600000;
      if (ageHours > 26) issues.push({ type: "backup_overdue", ageHours: Math.round(ageHours) });
    }
  } catch {}

  return { ts: Date.now(), issues };
}

function detectUrgent(snapshot) {
  const servicesDown = snapshot.issues.find(i => i.type === "services_down");
  if (servicesDown) {
    const critical = ["postgres", "redis", "nginx"].filter(s => servicesDown.services.includes(s));
    if (critical.length > 0) return { type: "services_down", severity: "critical", message: `Critical services down: ${critical.join(", ")}`, services: servicesDown.services };
  }

  const backup = snapshot.issues.find(i => i.type === "backup_overdue");
  if (backup?.ageHours > 48) return { type: "backup_overdue", severity: "high", message: `Backup overdue by ${backup.ageHours - 24}h` };

  const stuck = snapshot.issues.find(i => i.type === "stuck_directives");
  if (stuck) return { type: "stuck_directives", severity: "medium", message: `${stuck.count} directive(s) stuck: ${(stuck.items || []).join(", ")}` };

  const waFailed = snapshot.issues.find(i => i.type === "wa_failed");
  if (waFailed) return { type: "wa_failed", severity: "high", message: `WhatsApp agent down after ${waFailed.attempts} restart attempt(s) — manual intervention needed` };

  const osintDiff = snapshot.issues.find(i => i.type === "osint_diff");
  if (osintDiff) return { type: "osint_diff", severity: "medium", message: `🔍 ${osintDiff.subject} profile changed: ${osintDiff.changes.join(", ")}` };

  return null;
}

// Dedup: track last push time per alert type — don't spam same alert every 15 min
const _lastPushAt = {};
const PUSH_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours per alert type

async function kairosPush(urgent) {
  try {
    if (!_ctx?.db) return;

    // Cooldown check — don't re-push the same alert type within 4h
    const now = Date.now();
    const lastPush = _lastPushAt[urgent.type] || 0;
    if (now - lastPush < PUSH_COOLDOWN_MS) {
      log(`[KAIROS] Push suppressed (cooldown): ${urgent.type}`);
      return;
    }
    _lastPushAt[urgent.type] = now;

    // Use Person.owner() — the OZ Account model
    const { Person } = require("../person");
    const owner = await Person.owner(_ctx.db);
    if (!owner) return;

    const titles = { services_down: "⚠️ Service Alert", backup_overdue: "💾 Backup Overdue", stuck_directives: "🔧 Pipeline Alert", wa_failed: "📵 WhatsApp Down", osint_diff: "🔍 Profile Change Detected" };
    const title = titles[urgent.type] || "⚡ Ozzu Alert";

    // Try APNs push first — falls back to WhatsApp if no devices registered
    if (owner.devices.length > 0) {
      await owner.notify(title, urgent.message, { type: urgent.type });
      kairosAuditLog(`PUSH_SENT: ${urgent.type} → ${owner.devices.length} device(s)`);
      log(`[KAIROS] Push sent: ${urgent.message}`);
    } else {
      // APNs unavailable (no signed build) — reach via WhatsApp
      const waChannel = owner.channels.find(c => c.type === "whatsapp");
      if (waChannel) {
        await owner.reach(`${title}\n${urgent.message}`, "whatsapp");
        kairosAuditLog(`WA_SENT: ${urgent.type} → ${waChannel.address}`);
        log(`[KAIROS] WhatsApp alert sent: ${urgent.message}`);
      } else {
        log(`[KAIROS] No delivery channel available for owner`);
      }
    }
  } catch (err) {
    log(`[KAIROS] Push failed: ${err.message}`);
    kairosAuditLog(`PUSH_FAILED: ${err.message}`);
  }
}

function spawnKairosAction(urgent) {
  const prompt = urgent.type === "services_down"
    ? `KAIROS autonomous action: Services DOWN: ${urgent.services?.join(", ")}. Check docker compose ps, logs, attempt restart. Report findings.`
    : `KAIROS autonomous action: ${urgent.message}. Investigate and fix if possible.`;

  spawnClaude({ eventKey: `kairos:${urgent.type}`, prompt, reason: `KAIROS: ${urgent.type}`, model: MODEL_SONNET });
  kairosAuditLog(`ACTION_SPAWNED: ${urgent.type}`);
}

// ── KAIROS OSINT — NLP enrichment via Claude Max (zero extra cost) ──

const OSINT_BATCH_SIZE = 5;  // process up to 5 observations per tick
let _osintEnrichRunning = false;

async function kairosOsintEnrich() {
  if (_osintEnrichRunning || !_ctx?.db) return;
  _osintEnrichRunning = true;

  try {
    const unenriched = await _ctx.db.kgGetUnenrichedObservations(OSINT_BATCH_SIZE);
    if (unenriched.length === 0) return;

    log(`[KAIROS-OSINT] ${unenriched.length} observation(s) to enrich`);
    kairosAuditLog(`OSINT_ENRICH: processing ${unenriched.length} observations`);

    for (const obs of unenriched) {
      try {
        // Build prompt for Claude NLP extraction
        const data = typeof obs.raw_data === "string" ? JSON.parse(obs.raw_data) : (obs.raw_data || {});
        const content = obs.content || "";
        const combined = { ...data, content_text: content, platform: obs.platform, type: obs.observation_type };

        const prompt = [
          "You are an OSINT intelligence analyst. Extract structured intelligence from this social media observation.",
          `Subject: "${obs.subject_name}" (ID: ${obs.subject_id})`,
          `Platform: ${obs.platform}, Type: ${obs.observation_type}`,
          "",
          "DATA:",
          JSON.stringify(combined, null, 2),
          "",
          'Return ONLY valid JSON:',
          '{"entities":[{"name":"...","type":"person|org|location","role":"..."}],',
          '"relationships":[{"from":"...","to":"...","type":"works_at|knows|follows|mentions","confidence":0-100}],',
          '"sentiment":"positive|negative|neutral",',
          '"inferred_facts":[{"category":"employment|location|education|interest|skill","key":"...","value":"...","confidence":0-100}],',
          '"topics":["..."],',
          '"changes_detected":["..."],',
          '"summary":"1-sentence intelligence summary"}',
        ].join("\n");

        const { execSync } = require("child_process");
        const env = { ...process.env };
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;

        const output = execSync(
          `claude -p ${JSON.stringify(prompt)} --model claude-haiku-4-5-20251001 --output-format text`,
          { cwd: "/tmp", encoding: "utf8", timeout: 30000, env }
        );

        // Parse Claude's response (strip markdown code fences)
        const cleaned = output.replace(/```json\s*/g, "").replace(/```\s*/g, "");
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const nlpResult = JSON.parse(jsonMatch[0]);
          await _ctx.db.kgMarkObservationEnriched(obs.id, nlpResult);

          // Store inferred facts into KG
          for (const fact of nlpResult.inferred_facts || []) {
            await _ctx.db.kgAddFact({
              subject_id: obs.subject_id,
              category: fact.category,
              key: fact.key,
              value: typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value),
              source: "kairos:nlp",
              confidence: fact.confidence || 50,
            });
          }

          // Store new connections
          for (const rel of nlpResult.relationships || []) {
            // Try to find target subject
            const targets = await _ctx.db.kgGetSubjects({ search: rel.to });
            if (targets.length > 0) {
              try {
                await _ctx.db.kgAddConnection({
                  source_id: obs.subject_id,
                  target_id: targets[0].id,
                  relationship: rel.type || "mentions",
                  confidence: rel.confidence || 50,
                  source: "kairos:nlp",
                });
              } catch {} // ignore duplicates
            }
          }

          log(`[KAIROS-OSINT] Enriched obs #${obs.id}: ${nlpResult.summary || "done"}`);
        } else {
          // Mark enriched even on parse failure to avoid infinite retries
          await _ctx.db.kgMarkObservationEnriched(obs.id, { error: "parse_failed", raw: output.slice(0, 500) });
          log(`[KAIROS-OSINT] Failed to parse NLP for obs #${obs.id}`);
        }
      } catch (err) {
        log(`[KAIROS-OSINT] Enrichment error for obs #${obs.id}: ${err.message}`);
        // Mark as enriched with error to avoid retrying forever
        await _ctx.db.kgMarkObservationEnriched(obs.id, { error: err.message }).catch(() => {});
      }
    }

    kairosAuditLog(`OSINT_ENRICH_DONE: ${unenriched.length} processed`);
  } catch (err) {
    log(`[KAIROS-OSINT] Enrich batch error: ${err.message}`);
  } finally {
    _osintEnrichRunning = false;
  }
}

// ── KAIROS OSINT — Auto-collection for active subjects ──

const COLLECTOR_URL = process.env.COLLECTOR_URL || "http://172.17.0.1:3335";

async function kairosOsintAutoCollect(snapshot) {
  if (!_ctx?.db) return;

  try {
    const due = await _ctx.db.kgGetSubjectsDueForCollection();
    if (due.length === 0) return;

    log(`[KAIROS-OSINT] ${due.length} subject(s) due for collection`);
    kairosAuditLog(`OSINT_AUTOCOLLECT: ${due.length} subjects due`);

    // Only collect 1 subject per tick to stay within time budget
    const subject = due[0];

    // Get anchors to know what platforms to collect from
    const anchors = await _ctx.db.kgGetAnchors(subject.id);
    const twitterAnchor = anchors.find(a => a.anchor_type === "twitter" || a.anchor_type === "x");

    if (twitterAnchor) {
      try {
        const resp = await fetch(`${COLLECTOR_URL}/collect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: "twitter",
            action: "profile",
            subject_id: subject.id,
            target: twitterAnchor.value,
          }),
          signal: AbortSignal.timeout(10000),
        });
        const result = await resp.json();
        if (result.ok) {
          await _ctx.db.kgMarkSubjectCollected(subject.id);
          log(`[KAIROS-OSINT] Auto-collected ${subject.name} on twitter`);
          kairosAuditLog(`OSINT_COLLECTED: ${subject.name} (twitter)`);

          // Also check for diffs
          const diffs = await _ctx.db.kgGetObservationDiffs(subject.id, "twitter");
          if (diffs.length > 0) {
            log(`[KAIROS-OSINT] Diffs detected for ${subject.name}: ${diffs.map(d => d.field).join(", ")}`);
            kairosAuditLog(`OSINT_DIFF: ${subject.name} changed: ${diffs.map(d => d.field).join(", ")}`);

            // Store diff as timeline event
            await _ctx.db.kgAddEvent({
              subject_id: subject.id,
              event_type: "profile_change",
              title: `Profile changes detected: ${diffs.map(d => d.field).join(", ")}`,
              description: JSON.stringify(diffs),
              source: "kairos:diff",
            });

            // Push notification for significant diffs
            if (diffs.some(d => ["display_name", "bio", "location", "verified"].includes(d.field))) {
              snapshot.issues.push({
                type: "osint_diff",
                subject: subject.name,
                changes: diffs.map(d => d.field),
              });
            }
          }
        }
      } catch (err) {
        log(`[KAIROS-OSINT] Auto-collect failed for ${subject.name}: ${err.message}`);
      }
    } else {
      // No twitter anchor — just mark as collected to avoid retrying
      await _ctx.db.kgMarkSubjectCollected(subject.id);
    }
  } catch (err) {
    log(`[KAIROS-OSINT] Auto-collect error: ${err.message}`);
  }
}

function getKairosStatus() {
  return {
    running: !_kairosRunning,
    lastActionAt: _lastKairosActionAt ? new Date(_lastKairosActionAt).toISOString() : null,
    auditLog: KAIROS_AUDIT_LOG,
    intervalMinutes: KAIROS_INTERVAL_MS / 60000,
    osint: { enrichRunning: _osintEnrichRunning },
  };
}

module.exports = { start, stop, pause, resume, getStatus, getHistory, onDirectiveStatusChange, getAutoDreamStatus, runAutoDream, getKairosStatus };
