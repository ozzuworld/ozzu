// watchdog.js — Service health monitor with alerting
// Checks all services on 30s interval, tracks state transitions, broadcasts alerts via WS + June

"use strict";

const { execSync } = require("child_process");
const http = require("http");
const https = require("https");

// ── Service definitions ──

const SERVICES = {
  postgres:         { severity: "critical", interval: 30000, timeout: 3000 },
  redis:            { severity: "critical", interval: 30000, timeout: 3000 },
  nginx:            { severity: "critical", interval: 30000, timeout: 5000 },
  openvpn:          { severity: "high",     interval: 30000, timeout: 5000 },
  qdrant:           { severity: "medium",   interval: 30000, timeout: 3000 },
  homeassistant:    { severity: "medium",   interval: 30000, timeout: 5000 },
  "face-recognition": { severity: "medium", interval: 30000, timeout: 5000 },
  "osint-tools":    { severity: "low",      interval: 30000, timeout: 5000 },
  browser:          { severity: "low",      interval: 30000, timeout: 3000 },
  "vast-gpu":       { severity: "critical", interval: 120000, timeout: 10000 },
};

const SEVERITY_VERBAL = new Set(["critical", "high"]); // these trigger June verbal alert

// ── State ──

let _ctx = null;
let _timer = null;
let _gpuTimer = null;
let _pruneTimer = null;
let _running = false;

// Per-service state
const _state = {};       // { status, failCount, lastCheck, latencyMs, details }
const _incidents = [];    // ring buffer, max 200
const MAX_INCIDENTS = 200;

// GPU idle tracking
let _gpuIdleCount = 0;
const GPU_IDLE_THRESHOLD = 5;   // percent utilization
const GPU_IDLE_CHECKS = 3;      // consecutive checks before alert (6 min at 2min interval)

function initState() {
  for (const svc of Object.keys(SERVICES)) {
    _state[svc] = {
      status: "unknown",
      failCount: 0,
      lastCheck: null,
      latencyMs: null,
      details: {},
    };
  }
}

// ── HTTP fetch helper ──

function fetchWithTimeout(url, opts = {}) {
  const timeout = opts.timeout || 5000;
  const headers = opts.headers || {};
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

// ── Individual service checks ──

async function checkPostgres() {
  const start = Date.now();
  const res = await _ctx.db.query("SELECT 1 AS ok");
  return { ok: res.rows[0]?.ok === 1, latencyMs: Date.now() - start };
}

async function checkRedis() {
  const start = Date.now();
  const pong = await _ctx.redis.ping();
  return { ok: pong === "PONG", latencyMs: Date.now() - start };
}

async function checkNginx() {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout("http://127.0.0.1:80", { timeout: 5000 });
    return { ok: true, latencyMs: Date.now() - start, details: { statusCode: res.status } };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, details: { error: err.message } };
  }
}

async function checkOpenvpn() {
  const start = Date.now();
  try {
    // Check tun0 interface exists
    execSync("ip link show tun0", { timeout: 3000, stdio: "pipe" });
    // Ping home router through VPN
    try {
      execSync("ping -c 1 -W 2 10.8.0.2", { timeout: 4000, stdio: "pipe" });
      return { ok: true, latencyMs: Date.now() - start, details: { tun0: true, routerReachable: true } };
    } catch {
      return { ok: true, latencyMs: Date.now() - start, details: { tun0: true, routerReachable: false } };
    }
  } catch {
    return { ok: false, latencyMs: Date.now() - start, details: { tun0: false } };
  }
}

async function checkQdrant() {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout("http://127.0.0.1:6333/healthz", { timeout: 3000 });
    return { ok: res.status === 200, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, details: { error: err.message } };
  }
}

async function checkHomeAssistant() {
  const start = Date.now();
  const token = process.env.HA_TOKEN || "";
  try {
    const res = await fetchWithTimeout("http://127.0.0.1:8123/api/", {
      timeout: 5000,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { ok: res.status === 200, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, details: { error: err.message } };
  }
}

async function checkFaceRecognition() {
  const start = Date.now();
  try {
    // Check if container is running
    const out = execSync('docker inspect --format="{{.State.Running}}" face-recognition 2>/dev/null || echo false', {
      timeout: 5000, stdio: "pipe", encoding: "utf8",
    }).trim();
    return { ok: out === "true", latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

async function checkOsintTools() {
  const start = Date.now();
  try {
    execSync('docker exec osint-tools echo alive 2>/dev/null', { timeout: 5000, stdio: "pipe" });
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

async function checkBrowser() {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout("http://127.0.0.1:3334/", { timeout: 3000 });
    return { ok: true, latencyMs: Date.now() - start, details: { statusCode: res.status } };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, details: { error: err.message } };
  }
}

async function checkVastGpu() {
  const start = Date.now();
  const vastKey = process.env.VAST_API_KEY || "";
  if (!vastKey) return { ok: true, latencyMs: 0, details: { noKey: true, status: "no_api_key" } };

  try {
    const res = await fetchWithTimeout("https://console.vast.ai/api/v0/instances/?owner=me", {
      timeout: 10000,
      headers: { Authorization: `Bearer ${vastKey}` },
    });
    const data = JSON.parse(res.data);
    const instances = data?.instances || [];
    if (instances.length === 0) {
      return { ok: true, latencyMs: Date.now() - start, details: { status: "no_instances", instances: 0 } };
    }
    const inst = instances[0];
    const gpuUtil = inst.gpu_utilization ?? null;
    const gpuTemp = inst.gpu_temp ?? null;
    const vramUsed = inst.gpu_ram ?? null;
    const status = inst.actual_status || inst.status_msg || "unknown";

    return {
      ok: status === "running",
      latencyMs: Date.now() - start,
      details: {
        status,
        gpuUtil,
        gpuTemp,
        vramUsed,
        machineId: inst.machine_id,
        gpuName: inst.gpu_name,
        costPerHr: inst.dph_total,
        instanceId: inst.id,
      },
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, details: { error: err.message } };
  }
}

const CHECK_FNS = {
  postgres: checkPostgres,
  redis: checkRedis,
  nginx: checkNginx,
  openvpn: checkOpenvpn,
  qdrant: checkQdrant,
  homeassistant: checkHomeAssistant,
  "face-recognition": checkFaceRecognition,
  "osint-tools": checkOsintTools,
  browser: checkBrowser,
  "vast-gpu": checkVastGpu,
};

// ── State machine ──

function processResult(service, result) {
  const s = _state[service];
  const prev = s.status;

  s.lastCheck = new Date().toISOString();
  s.latencyMs = result.latencyMs;
  s.details = result.details || {};

  if (result.ok) {
    s.failCount = 0;
    s.status = "healthy";
  } else {
    s.failCount++;
    if (s.failCount >= 2) {
      s.status = "down";
    } else {
      s.status = "degraded";
    }
  }

  // State transition → incident
  if (prev !== s.status && prev !== "unknown") {
    const incident = {
      service,
      fromStatus: prev,
      toStatus: s.status,
      details: s.details,
      ts: s.lastCheck,
    };
    _incidents.push(incident);
    if (_incidents.length > MAX_INCIDENTS) _incidents.shift();

    // Persist to DB
    persistIncident(incident);

    // Broadcast alert
    broadcastAlert(service, s.status, prev, s.details);
  }

  // GPU idle detection
  if (service === "vast-gpu" && result.ok) {
    const gpuUtil = result.details?.gpuUtil;
    if (gpuUtil != null && gpuUtil < GPU_IDLE_THRESHOLD) {
      _gpuIdleCount++;
      if (_gpuIdleCount === GPU_IDLE_CHECKS) {
        broadcastAlert("vast-gpu", "idle", "healthy", {
          gpuUtil,
          idleMinutes: _gpuIdleCount * 2,
          message: `GPU idle (${gpuUtil}% util) for ${_gpuIdleCount * 2} minutes during active instance`,
        });
      }
    } else {
      _gpuIdleCount = 0;
    }
  }

  // Persist health log
  persistHealthLog(service, s.status, s.latencyMs, s.details);
}

// ── Alerting ──

function broadcastAlert(service, status, previousStatus, details) {
  if (!_ctx) return;

  const severity = SERVICES[service]?.severity || "low";
  const isRecovery = status === "healthy";
  const alertType = isRecovery ? "info" : severity;

  const msg = {
    type: "opsAlert",
    service,
    status,
    previousStatus,
    severity: alertType,
    ts: new Date().toISOString(),
    details,
  };

  // WS broadcast to all devices
  if (typeof _ctx.broadcastToAll === "function") {
    _ctx.broadcastToAll(msg);
  }

  // Verbal alert via June for critical/high services
  const shouldVerbal = SEVERITY_VERBAL.has(severity) && !isRecovery;
  // Also verbal for GPU idle
  const isGpuIdle = service === "vast-gpu" && status === "idle";

  if ((shouldVerbal || isGpuIdle) && typeof _ctx.sendNotification === "function") {
    const friendlyName = service.replace(/-/g, " ").replace("vast gpu", "Vast AI GPU");
    let text;
    if (isGpuIdle) {
      text = `Warning: the GPU has been idle for ${details?.idleMinutes || "several"} minutes. GPU utilization is at ${details?.gpuUtil || 0} percent.`;
    } else {
      text = `Alert: ${friendlyName} is ${status}. ${details?.error || details?.message || ""}`.trim();
    }
    _ctx.sendNotification(text);
  }
}

// ── Persistence ──

async function persistIncident(incident) {
  if (!_ctx?.db) return;
  try {
    await _ctx.db.query(
      `INSERT INTO service_incidents (service, from_status, to_status, details, started_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [incident.service, incident.fromStatus, incident.toStatus, JSON.stringify(incident.details), incident.ts]
    );
  } catch (err) {
    console.error("[watchdog] Failed to persist incident:", err.message);
  }
}

async function persistHealthLog(service, status, latencyMs, details) {
  if (!_ctx?.db) return;
  try {
    await _ctx.db.query(
      `INSERT INTO service_health_log (service, status, latency_ms, details)
       VALUES ($1, $2, $3, $4)`,
      [service, status, latencyMs, JSON.stringify(details || {})]
    );
  } catch (err) {
    // silently ignore — health log is best-effort
  }
}

async function pruneOldLogs() {
  if (!_ctx?.db) return;
  try {
    await _ctx.db.query(`DELETE FROM service_health_log WHERE checked_at < NOW() - INTERVAL '7 days'`);
  } catch (err) {
    console.error("[watchdog] Prune failed:", err.message);
  }
}

// ── Check cycles ──

async function runCheck(service) {
  const fn = CHECK_FNS[service];
  if (!fn) return;
  try {
    const result = await fn();
    processResult(service, result);
  } catch (err) {
    processResult(service, { ok: false, latencyMs: 0, details: { error: err.message } });
  }
}

async function runAllChecks() {
  const standardServices = Object.keys(SERVICES).filter((s) => s !== "vast-gpu");
  await Promise.allSettled(standardServices.map((s) => runCheck(s)));
}

async function runGpuCheck() {
  await runCheck("vast-gpu");
}

// ── Public API ──

function start(ctx) {
  if (_running) return;
  _ctx = ctx;
  _running = true;
  initState();

  console.log("[watchdog] Starting service health monitor");

  // Initial check after 5s (let services boot)
  setTimeout(() => {
    runAllChecks();
    runGpuCheck();
  }, 5000);

  // Standard services every 30s
  _timer = setInterval(runAllChecks, 30000);

  // GPU check every 2 min
  _gpuTimer = setInterval(runGpuCheck, 120000);

  // Prune old health logs daily
  _pruneTimer = setInterval(pruneOldLogs, 86400000);
}

function stop() {
  _running = false;
  if (_timer) clearInterval(_timer);
  if (_gpuTimer) clearInterval(_gpuTimer);
  if (_pruneTimer) clearInterval(_pruneTimer);
  _timer = null;
  _gpuTimer = null;
  _pruneTimer = null;
  console.log("[watchdog] Stopped");
}

function getStatus() {
  return { ..._state };
}

function getIncidents(limit = 50) {
  return _incidents.slice(-limit);
}

async function forceCheck() {
  await Promise.allSettled([runAllChecks(), runGpuCheck()]);
  return getStatus();
}

module.exports = { start, stop, getStatus, getIncidents, forceCheck };
