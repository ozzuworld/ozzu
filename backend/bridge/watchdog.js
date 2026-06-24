// watchdog.js — Service health monitor with alerting
// Checks all services on 30s interval, tracks state transitions, broadcasts alerts via WS + June

"use strict";

const { execSync } = require("child_process");
const http = require("http");
const https = require("https");
const { getDevice } = require("./lib/devices");

// ── Service definitions ──

const SERVICES = {
  postgres:         { severity: "critical", interval: 30000, timeout: 3000 },
  redis:            { severity: "critical", interval: 30000, timeout: 3000 },
  nginx:            { severity: "critical", interval: 30000, timeout: 5000 },
  qdrant:           { severity: "medium",   interval: 30000, timeout: 3000 },
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

// External listeners for state transitions
const _listeners = [];

// GPU idle tracking
let _gpuIdleCount = 0;
const GPU_IDLE_THRESHOLD = 5;   // percent utilization
const GPU_IDLE_CHECKS = 3;      // consecutive checks before alert (6 min at 2min interval)

// Training recovery
let _lastHeartbeat = 0;
let _recoveryAttempts = 0;
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;  // 5 min without heartbeat = stale
const MAX_RECOVERY_ATTEMPTS = 3;

// dir_1782242371780 (correction): silent-halt visibility. A harness-FORCED abnormal
// halt sets agent_status='halted' but queues NO pending step, so the per-step
// reaper/watchdog can't see it and the engagement goes dark. We extend THIS watchdog
// (rather than add a new always-on server.js poller — one was just removed) to flag
// 'halted' engagements once, on the running→halted transition. The set is the dedup:
// an id is added when first alerted and removed when the engagement leaves 'halted'
// (re-run/reset), so a later halt re-alerts but an already-flagged one never does.
const _haltedAlerted = new Set();

function recordHeartbeat() {
  _lastHeartbeat = Date.now();
  _recoveryAttempts = 0; // reset on successful heartbeat
}

async function checkTrainingRecovery() {
  // Skip if no heartbeat ever received, or GPU not running
  if (!_lastHeartbeat) return;
  const gpuState = _state["vast-gpu"];
  if (!gpuState || gpuState.status !== "healthy") return;
  const gpuDetails = gpuState.details || {};
  if (!gpuDetails.instanceId) return;

  const staleMs = Date.now() - _lastHeartbeat;
  if (staleMs < HEARTBEAT_STALE_MS) return;

  // Heartbeat is stale while GPU is running — training may have crashed
  if (_recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    // Already tried 3 times, stop trying and alert
    if (_recoveryAttempts === MAX_RECOVERY_ATTEMPTS) {
      console.error("[watchdog] Training recovery exhausted after 3 attempts");
      if (typeof _ctx?.sendNotification === "function") {
        _ctx.sendNotification("Training recovery failed after 3 attempts. The GPU is running but training is not responding. Manual intervention needed.");
      }
      _recoveryAttempts++; // prevent repeated alerts
    }
    return;
  }

  _recoveryAttempts++;
  const staleMin = Math.round(staleMs / 60000);
  console.log(`[watchdog] Training heartbeat stale (${staleMin}m). Recovery attempt ${_recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}`);

  // Alert King Kazuma
  if (typeof _ctx?.sendNotification === "function") {
    _ctx.sendNotification(`Training heartbeat lost for ${staleMin} minutes. Auto-recovery attempt ${_recoveryAttempts} of ${MAX_RECOVERY_ATTEMPTS}.`);
  }

  // SSH into Vast.ai and restart the orchestrator
  try {
    const sshAddr = gpuDetails.sshAddr || "ssh8.vast.ai";
    const sshPort = gpuDetails.sshPort || "14666";
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${sshPort} root@${sshAddr} "` +
      `pgrep -f 'run-all-datasets.sh' > /dev/null 2>&1 && echo 'ORCHESTRATOR_RUNNING' || ` +
      `(export QDRANT_URL=http://34.135.158.92:6333 BRIDGE_URL=http://34.135.158.92:3333; ` +
      `nohup bash /root/run-all-datasets.sh >> /tmp/all-datasets.log 2>&1 & echo 'ORCHESTRATOR_RESTARTED')"`;
    const result = execSync(cmd, { timeout: 30000, stdio: "pipe" }).toString().trim();
    console.log(`[watchdog] Training recovery result: ${result}`);
  } catch (err) {
    console.error(`[watchdog] Training recovery SSH failed: ${err.message}`);
  }
}

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
    // Nginx returns 444 (drops connection) without a valid Host header
    // Use the FQDN host header to get a real response
    const res = await fetchWithTimeout("http://127.0.0.1:80", {
      timeout: 5000,
      headers: { Host: "home.ozzu.world" },
    });
    // 301/302 redirects to HTTPS are healthy, 444 means config issue
    return { ok: res.status < 500, latencyMs: Date.now() - start, details: { statusCode: res.status } };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, details: { error: err.message } };
  }
}

async function checkWireguard() {
  // Replaces the old checkOpenvpn (decommissioned 2026-05-02). Healthy when
  // wg0 exists on the host AND at least one peer (dev-01 or orangepi5) pings.
  const start = Date.now();
  try {
    const fs = require("fs");
    const wg0Exists = fs.existsSync("/sys/class/net/wg0");
    if (!wg0Exists) {
      return { ok: false, latencyMs: Date.now() - start, details: { wg0: false } };
    }
    let peerOk = false;
    let peerHit = null;
    for (const candidate of [getDevice("dev-01")?.wg_ip, getDevice("orangepi5")?.wg_ip]) {
      if (!candidate) continue;
      try {
        execSync(`ping -c 1 -W 2 ${candidate}`, { timeout: 4000, stdio: "pipe" });
        peerOk = true; peerHit = candidate; break;
      } catch {}
    }
    return {
      ok: true, // wg0 up alone counts as healthy; peer reachability is informational
      latencyMs: Date.now() - start,
      details: { wg0: true, peerReachable: peerOk, peer: peerHit },
    };
  } catch {
    return { ok: false, latencyMs: Date.now() - start, details: { wg0: false } };
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
        sshAddr: inst.ssh_host || inst.public_ipaddr,
        sshPort: inst.ssh_port || inst.direct_port_start,
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
  wireguard: checkWireguard,
  qdrant: checkQdrant,
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

    // Notify external listeners (cipher-daemon etc.)
    for (const fn of _listeners) {
      try { fn({ type: "serviceTransition", ...incident }); } catch {}
    }

    // Trigger proactive report if 3+ services down
    if (s.status === "down") {
      const downCount = Object.values(_state).filter(s => s.status === "down").length;
      if (downCount >= 3) {
        try {
          const reporter = require("./proactive-reporter");
          reporter.triggerEventReport(`${downCount} services down: ${Object.entries(_state).filter(([,s]) => s.status === "down").map(([k]) => k).join(", ")}`);
        } catch {}
      }
    }
  }

  // GPU idle detection
  if (service === "vast-gpu" && result.ok) {
    const gpuUtil = result.details?.gpuUtil;
    if (gpuUtil != null && gpuUtil < GPU_IDLE_THRESHOLD) {
      _gpuIdleCount++;
      if (_gpuIdleCount === GPU_IDLE_CHECKS) {
        const idleDetails = {
          gpuUtil,
          idleMinutes: _gpuIdleCount * 2,
          message: `GPU idle (${gpuUtil}% util) for ${_gpuIdleCount * 2} minutes during active instance`,
        };
        broadcastAlert("vast-gpu", "idle", "healthy", idleDetails);
        for (const fn of _listeners) {
          try { fn({ type: "gpuIdle", service: "vast-gpu", details: idleDetails }); } catch {}
        }
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
  // dir_1782242371780 (correction): piggy-back the silent-halt sweep on the same
  // 30s cadence. Best-effort and isolated — its own try/catch inside, never blocks
  // or fails the service checks.
  await checkHaltedEngagements();
}

// dir_1782242371780 (correction): flag engagements that the offense loop force-halted.
// These set agent_status='halted' with no pending queue step, so they are invisible to
// the per-step reaper and to the boot scanner (which resumes 'running' only). Alert ONCE
// per halt, gated on the running→halted transition via the _haltedAlerted dedup set.
// Membrane-safe: surfaces only the engagement id, status, and a count — never command,
// finding, or target text. Idempotent and fully try/catch'd; never throws into the loop.
async function checkHaltedEngagements() {
  if (!_ctx?.db) return;
  let rows = [];
  try {
    const r = await _ctx.db.query(
      `SELECT id FROM pentest_engagements WHERE agent_status = 'halted'`);
    rows = r.rows || [];
  } catch (err) {
    console.error("[watchdog] halt sweep query failed:", err.message);
    return;
  }
  const currentlyHalted = new Set(rows.map((row) => String(row.id)));

  // Clear acks for engagements that have LEFT 'halted' (re-run / reset) so a future
  // halt of the same engagement alerts again — mirrors the per-service transition reset.
  for (const id of [..._haltedAlerted]) {
    if (!currentlyHalted.has(id)) _haltedAlerted.delete(id);
  }

  // Alert only on the running→halted transition (id not yet acked) — never re-fire.
  for (const id of currentlyHalted) {
    if (_haltedAlerted.has(id)) continue;
    _haltedAlerted.add(id);
    try {
      broadcastHaltAlert(id);
    } catch (err) {
      console.error("[watchdog] halt alert failed:", err.message);
    }
  }
}

// Reuses the same alert hooks as broadcastAlert (WS broadcast + June notification +
// external listeners) so the halt rides the existing alert path, not a new one.
function broadcastHaltAlert(engagementId) {
  if (!_ctx) return;
  const msg = {
    type: "opsAlert",
    service: "offense-engagement",
    status: "halted",
    previousStatus: "running",
    severity: "high",
    engagementId,
    ts: new Date().toISOString(),
    details: { message: `Offense engagement ${engagementId} halted abnormally (no clean conclusion, no pending step).` },
  };
  if (typeof _ctx.broadcastToAll === "function") _ctx.broadcastToAll(msg);
  if (typeof _ctx.sendNotification === "function") {
    _ctx.sendNotification(`Alert: offense engagement ${engagementId} halted abnormally and needs review.`);
  }
  for (const fn of _listeners) {
    try { fn({ type: "engagementHalted", engagementId, status: "halted", previousStatus: "running", ts: msg.ts }); } catch {}
  }
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

  // GPU check every 2 min + training recovery check
  _gpuTimer = setInterval(async () => {
    await runGpuCheck();
    await checkTrainingRecovery();
  }, 120000);

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

function onStateTransition(fn) {
  _listeners.push(fn);
  return () => { const i = _listeners.indexOf(fn); if (i >= 0) _listeners.splice(i, 1); };
}

// dir_1782242371780 (correction): test hook — inject a mock _ctx and reset the
// dedup set so the silent-halt sweep can be unit-tested WITHOUT start()'s service
// timers (which would make real network/db calls). Production callers never use this.
function __setTestContext(ctx) {
  _ctx = ctx;
  _haltedAlerted.clear();
}

module.exports = {
  start, stop, getStatus, getIncidents, forceCheck, recordHeartbeat, onStateTransition,
  // dir_1782242371780: exported for the silent-halt visibility test.
  checkHaltedEngagements, __setTestContext,
};
