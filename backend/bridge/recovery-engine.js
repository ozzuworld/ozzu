// recovery-engine.js — Tier 1 self-healing: config-driven docker restart with backoff
// Intercepts watchdog DOWN events before cipher-agent. Fast, free, no LLM needed.
// Emits 'recoveryFailed' when all attempts exhausted → cipher-agent takes over.

"use strict";

const { execSync } = require("child_process");
const http = require("http");

// ── Recovery playbook — per-service config ──

const PLAYBOOK = {
  postgres:           { container: "ozzu-postgres",    maxAttempts: 2, backoffMs: [5000, 30000] },
  redis:              { container: "ozzu-redis",       maxAttempts: 2, backoffMs: [5000, 30000] },
  nginx:              { container: "nginx",            maxAttempts: 2, backoffMs: [5000, 15000] },
  qdrant:             { container: "qdrant",           maxAttempts: 2, backoffMs: [10000, 60000] },
  "face-recognition": { container: "face-recognition", maxAttempts: 2, backoffMs: [5000, 30000] },
  "osint-tools":      { container: "osint-tools",      maxAttempts: 1, backoffMs: [10000] },
  browser:            { container: "browser",          maxAttempts: 1, backoffMs: [10000] },
  "vast-gpu":         { skip: true },  // external — can't docker restart
};

// Dependency graph — don't restart X if its dependency is down
const DEPENDENCIES = {
  "face-recognition": ["qdrant"],
  "osint-tools":      ["browser"],
};

const COOLDOWN_MS = 5 * 60 * 1000;          // 5 min per-service cooldown
const CASCADE_WINDOW_MS = 60 * 1000;        // 3+ services down within 60s = cascade
const CASCADE_THRESHOLD = 3;
const HEALTH_CHECK_DELAY_MS = 3000;          // wait after restart before checking health

// ── State ──

let _ctx = null;
let _running = false;
const _recoveryState = {};   // per-service: { status, attempts, lastRecoveryAt, consecutiveFailures }
const _recoveryLog = [];     // ring buffer
const MAX_LOG_ENTRIES = 500;
const _listeners = [];       // recoveryFailed listeners
const _recentDownEvents = []; // for cascade detection

// ── Public API ──

function start(ctx) {
  _ctx = ctx;
  _running = true;

  // Initialize per-service state
  for (const svc of Object.keys(PLAYBOOK)) {
    _recoveryState[svc] = {
      status: "idle",          // idle | recovering | recovered | failed | cooldown
      attempts: 0,
      lastRecoveryAt: null,
      consecutiveFailures: 0,
      lastEvent: null,
    };
  }

  // Subscribe to watchdog state transitions
  if (ctx.watchdog?.onStateTransition) {
    ctx.watchdog.onStateTransition(handleWatchdogEvent);
  }

  log("Started — Tier 1 recovery engine");
}

function stop() {
  _running = false;
  log("Stopped");
}

function getState() {
  return { ..._recoveryState };
}

function getLog(limit = 50) {
  return _recoveryLog.slice(-limit);
}

function onRecoveryFailed(fn) {
  _listeners.push(fn);
  return () => { const i = _listeners.indexOf(fn); if (i >= 0) _listeners.splice(i, 1); };
}

// ── Core recovery flow ──

async function handleWatchdogEvent(evt) {
  if (!_running) return;
  if (evt.type !== "serviceTransition") return;
  if (evt.toStatus !== "down") {
    // Service came back up on its own — clear state if we were recovering
    if (evt.toStatus === "healthy" && _recoveryState[evt.service]) {
      const rs = _recoveryState[evt.service];
      if (rs.status === "recovering") {
        rs.status = "recovered";
        rs.consecutiveFailures = 0;
        logEntry(evt.service, "self_recovered", "Service recovered on its own during recovery wait");
      }
    }
    return;
  }

  const service = evt.service;
  const playbook = PLAYBOOK[service];
  if (!playbook) return;

  // Skip external services
  if (playbook.skip) {
    emitRecoveryFailed(service, evt, "external_service");
    return;
  }

  const rs = _recoveryState[service];
  if (!rs) return;

  // Cooldown check — don't hammer
  if (rs.lastRecoveryAt && Date.now() - rs.lastRecoveryAt < COOLDOWN_MS) {
    logEntry(service, "cooldown", `Skipping — last recovery ${Math.round((Date.now() - rs.lastRecoveryAt) / 1000)}s ago`);
    emitRecoveryFailed(service, evt, "cooldown");
    return;
  }

  // Cascade detection — 3+ services down within 60s = systemic issue
  _recentDownEvents.push({ service, ts: Date.now() });
  // Prune old events
  while (_recentDownEvents.length > 0 && Date.now() - _recentDownEvents[0].ts > CASCADE_WINDOW_MS) {
    _recentDownEvents.shift();
  }
  const uniqueDownServices = new Set(_recentDownEvents.map(e => e.service));
  if (uniqueDownServices.size >= CASCADE_THRESHOLD) {
    const downList = [...uniqueDownServices].join(", ");
    logEntry(service, "cascade", `${uniqueDownServices.size} services down within 60s (${downList}) — skipping individual recovery`);
    emitRecoveryFailed(service, evt, "cascade", `Cascade: ${downList}`);
    return;
  }

  // Dependency check — don't restart if dependency is down
  const deps = DEPENDENCIES[service];
  if (deps) {
    const watchdogStatus = _ctx.watchdog?.getStatus?.() || {};
    const downDeps = deps.filter(d => watchdogStatus[d]?.status === "down");
    if (downDeps.length > 0) {
      logEntry(service, "dep_blocked", `Dependency down: ${downDeps.join(", ")} — skipping recovery`);
      emitRecoveryFailed(service, evt, "dependency_down", `Dependencies down: ${downDeps.join(", ")}`);
      return;
    }
  }

  // Start recovery
  rs.status = "recovering";
  rs.attempts = 0;
  rs.lastEvent = evt;

  await executeRecovery(service, playbook, evt);
}

async function executeRecovery(service, playbook, originalEvt) {
  const rs = _recoveryState[service];

  for (let attempt = 0; attempt < playbook.maxAttempts; attempt++) {
    rs.attempts = attempt + 1;
    const backoff = playbook.backoffMs[attempt] || playbook.backoffMs[playbook.backoffMs.length - 1];

    logEntry(service, "restart", `Attempt ${attempt + 1}/${playbook.maxAttempts} — docker restart ${playbook.container}`);
    log(`Recovering ${service}: attempt ${attempt + 1}/${playbook.maxAttempts}`);

    // Execute docker restart
    let restartOk = false;
    try {
      execSync(`docker restart ${playbook.container}`, { timeout: 30000, stdio: "pipe" });
      restartOk = true;
    } catch (err) {
      logEntry(service, "restart_error", `docker restart failed: ${err.message}`);
    }

    if (!restartOk) {
      // Try docker start in case container was stopped (not just unhealthy)
      try {
        execSync(`docker start ${playbook.container}`, { timeout: 15000, stdio: "pipe" });
        restartOk = true;
        logEntry(service, "start_fallback", "docker restart failed, docker start succeeded");
      } catch {
        logEntry(service, "start_error", "docker start also failed");
      }
    }

    if (!restartOk) continue;

    // Wait backoff then check health
    await sleep(backoff);

    // Wait a bit more then let watchdog re-check
    await sleep(HEALTH_CHECK_DELAY_MS);

    // Force a watchdog check and see if service recovered
    let healthy = false;
    try {
      if (_ctx.watchdog?.forceCheck) {
        const status = await _ctx.watchdog.forceCheck();
        healthy = status[service]?.status === "healthy";
      }
    } catch {
      // Fallback: check container status directly
      try {
        const out = execSync(`docker inspect --format="{{.State.Running}}" ${playbook.container} 2>/dev/null`, {
          timeout: 5000, stdio: "pipe", encoding: "utf8",
        }).trim();
        healthy = out === "true";
      } catch {}
    }

    if (healthy) {
      rs.status = "recovered";
      rs.lastRecoveryAt = Date.now();
      rs.consecutiveFailures = 0;

      logEntry(service, "recovered", `Recovered on attempt ${attempt + 1}`);
      log(`${service} recovered on attempt ${attempt + 1}`);

      // Broadcast recovery event
      broadcast({
        type: "serviceRecovered",
        service,
        attempt: attempt + 1,
        method: "docker_restart",
        ts: new Date().toISOString(),
      });

      // Persist to DB
      persistRecovery(service, "success", attempt + 1);
      return;
    }

    logEntry(service, "still_down", `Still down after attempt ${attempt + 1}, backoff ${backoff}ms`);
  }

  // All attempts exhausted
  rs.status = "failed";
  rs.lastRecoveryAt = Date.now();
  rs.consecutiveFailures++;

  logEntry(service, "exhausted", `All ${playbook.maxAttempts} attempts failed`);
  log(`${service} recovery FAILED after ${playbook.maxAttempts} attempts`);

  persistRecovery(service, "failed", playbook.maxAttempts);
  emitRecoveryFailed(service, originalEvt, "exhausted");
}

// ── Escalation ──

function emitRecoveryFailed(service, originalEvt, reason, detail) {
  const payload = {
    type: "recoveryFailed",
    service,
    reason,
    detail: detail || null,
    originalEvent: originalEvt,
    ts: new Date().toISOString(),
  };

  // Notify listeners (cipher-agent subscribes here)
  for (const fn of _listeners) {
    try { fn(payload); } catch {}
  }

  // Escalate to human
  escalateToHuman(service, reason, detail);

  // Broadcast to all WS clients
  broadcast(payload);
}

async function escalateToHuman(service, reason, detail) {
  const friendlyName = service.replace(/-/g, " ");
  const rs = _recoveryState[service];
  const attempts = rs?.attempts || 0;

  // Channel 1: Email via bridge
  const subject = `[OZZU] ${friendlyName} DOWN — auto-recovery failed`;
  const text = [
    `Service: ${service}`,
    `Reason: ${reason}`,
    detail ? `Detail: ${detail}` : null,
    `Recovery attempts: ${attempts}`,
    `Consecutive failures: ${rs?.consecutiveFailures || 0}`,
    "",
    "Manual intervention required.",
    "",
    `— Cipher Recovery Engine`,
  ].filter(Boolean).join("\n");

  try {
    const payload = JSON.stringify({ to: "eng.ozzu@gmail.com", subject, text });
    const req = http.request({
      hostname: "localhost", port: 3333, path: "/business/email/send", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, () => {});
    req.on("error", () => {});
    req.write(payload);
    req.end();
  } catch {}

  // Channel 2: App push via WS (recoveryFailed flag already broadcast above)

  // Channel 3: June verbal notification
  if (typeof _ctx?.sendNotification === "function") {
    const msg = reason === "cascade"
      ? `Multiple services went down at the same time. ${detail || ""}. I couldn't auto-recover — this might be a system-wide issue.`
      : reason === "external_service"
        ? `${friendlyName} went down. It's an external service so I can't restart it — King Kazuma needs to check it.`
        : `${friendlyName} went down. I tried restarting ${attempts > 1 ? `${attempts} times` : "it"} but it's still not responding. Manual intervention needed.`;
    _ctx.sendNotification(msg);
  }
}

// ── Helpers ──

function logEntry(service, action, message) {
  const entry = { service, action, message, ts: new Date().toISOString() };
  _recoveryLog.push(entry);
  if (_recoveryLog.length > MAX_LOG_ENTRIES) _recoveryLog.shift();
}

function broadcast(msg) {
  if (typeof _ctx?.broadcastToAll === "function") {
    _ctx.broadcastToAll(msg);
  }
}

async function persistRecovery(service, outcome, attempts) {
  if (!_ctx?.db) return;
  try {
    await _ctx.db.query(
      `INSERT INTO recovery_log (service, outcome, attempts, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [service, outcome, attempts, JSON.stringify(_recoveryState[service] || {})]
    );
  } catch {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
  console.log(`[recovery-engine] ${msg}`);
}

module.exports = { start, stop, getState, getLog, onRecoveryFailed };
