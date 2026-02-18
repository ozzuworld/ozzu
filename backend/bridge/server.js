#!/usr/bin/env node
// Command Bridge Server — Gemini proxy + device relay + Claude Code bridge
// Single Gemini session shared across tablets (mic) and TV (speaker)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const Redis = require("ioredis");
const db = require("./db");
const { CipherPipeline, convertToolsForClaude } = require("./cipher-pipeline");
const { spawnPlanningAgent, spawnImplementationAgent, spawnWorkerWithPrompt, getRunningAgents, killAgent, killAllAgents, startWatchdog, setBroadcast, getConfig, setConfig } = require("./agent-spawner");
const orchestrator = require("./orchestrator");
const buildVerifier = require("./build-verifier");
const createLogger = require("./logger");
const metrics = require("./metrics-tracker");
const anthropicUsage = require("./anthropic-usage");

const log = {
  bridge: createLogger("bridge"),
  directive: createLogger("directive"),
  ws: createLogger("ws"),
  gemini: createLogger("gemini"),
  redis: createLogger("redis"),
  pg: createLogger("pg"),
  persona: createLogger("persona"),
  audio: createLogger("audio"),
  cipher: createLogger("cipher"),
  memory: createLogger("memory"),
};

const PORT = 3333;
const DATA_DIR = "/tmp/ozzu-bridge";
const _intervals = []; // tracked for graceful shutdown
const UPDATES_DIR = path.join(DATA_DIR, "updates");
const STATUS_FILE = path.join(DATA_DIR, "status.json");
const APPROVALS_FILE = path.join(DATA_DIR, "approvals.json");
const DIRECTIVES_FILE = path.join(DATA_DIR, "directives.json");
const MAX_STATUS_ENTRIES = 20;
const MAX_DIRECTIVES = 20;
const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours (plan reviews need time)

// ── Rate limiter for POST /directives — sliding window ──
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const _directiveCreationTimestamps = [];
let _rateLimitHits = 0;

// ── Pipeline violations (in-memory, capped at 100) ──
const MAX_PIPELINE_VIOLATIONS = 100;
const _pipelineViolations = [];
let _pipelineViolationIdCounter = 1;

// ── Album color + Spotify caches ──
const _albumColorCache = new Map(); // url -> hex color string (max 100)
let _spotifyQueueCache = null; // { queue: [...], ts: number } (15s TTL)
let _spotifyPlaylistsCache = null; // { playlists: [...], ts: number } (60s TTL)
const _spotifyTracksCache = new Map(); // "playlistId:offset" -> { tracks, total, ts } (30s TTL)
let _spotifyNowPlayingCache = null; // { data: {...}, ts: number } (5s TTL)
let _spotifyLikedCache = null; // { tracks: [...], total: number, ts: number } (2min TTL)
let _cachedSpotifyToken = null; // { access_token, expires_at }

// ── Spotify API helper ──
async function getSpotifyToken() {
  // Return cached token if still valid (5min buffer)
  if (_cachedSpotifyToken && _cachedSpotifyToken.expires_at > Date.now() / 1000 + 300) {
    metrics.trackSpotifyCacheHit();
    return _cachedSpotifyToken.access_token;
  }
  try {
    const haStorage = JSON.parse(fs.readFileSync("/home/gcp/ozzu/backend/config/.storage/core.config_entries", "utf8"));
    const spotifyEntry = haStorage.data.entries.find(e => e.domain === "spotify");
    if (!spotifyEntry?.data?.token) return null;
    const tokenData = spotifyEntry.data.token;
    if (tokenData.expires_at && tokenData.expires_at > Date.now() / 1000 + 300) {
      _cachedSpotifyToken = { access_token: tokenData.access_token, expires_at: tokenData.expires_at };
      return tokenData.access_token;
    }
    if (!tokenData.refresh_token) return null;
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenData.refresh_token,
      client_id: "62ee533a9f2444dfb854cb1293c32cd9",
      client_secret: "60ca708c676846508251cf2549f26b14",
    });
    const refreshRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (refreshRes.ok) {
      const refreshData = await refreshRes.json();
      _cachedSpotifyToken = { access_token: refreshData.access_token, expires_at: (Date.now() / 1000) + (refreshData.expires_in || 3600) };
      metrics.trackSpotifyTokenRefresh();
      return refreshData.access_token;
    }
    return null;
  } catch (err) {
    log.bridge.warn("Failed to get Spotify token:", err.message);
    return null;
  }
}

async function spotifyFetch(endpoint, opts = {}) {
  metrics.trackSpotifyApiCall();
  const token = await getSpotifyToken();
  if (!token) throw new Error("no_token");
  const url = endpoint.startsWith("http") ? endpoint : `https://api.spotify.com/v1${endpoint}`;
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
    signal: AbortSignal.timeout(opts.timeout || 8000),
  });
  if (!res.ok) {
    const err = new Error(`spotify_api_${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Log ring buffer — captures recent console output for GET /logs ──
const LOG_RING_MAX = 500;
const _logRing = new Array(LOG_RING_MAX);
let _logRingHead = 0; // next write index
let _logRingCount = 0;
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
function _captureLog(chunk) {
  const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const lines = str.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    _logRing[_logRingHead] = { ts: new Date().toISOString(), line };
    _logRingHead = (_logRingHead + 1) % LOG_RING_MAX;
    if (_logRingCount < LOG_RING_MAX) _logRingCount++;
  }
}
function getLogRing() {
  if (_logRingCount < LOG_RING_MAX) return _logRing.slice(0, _logRingCount);
  // Circular: tail is from _logRingHead to end, then 0 to _logRingHead
  return [..._logRing.slice(_logRingHead), ..._logRing.slice(0, _logRingHead)];
}
process.stdout.write = function (chunk, encoding, cb) {
  _captureLog(chunk);
  return _origStdoutWrite(chunk, encoding, cb);
};
process.stderr.write = function (chunk, encoding, cb) {
  _captureLog(chunk);
  return _origStderrWrite(chunk, encoding, cb);
};

const DIRECTIVE_TEMPLATES = [
  { name: "Bug Fix", type: "quick", titleTemplate: "Fix: {description}", descriptionTemplate: "Fix the bug described above." },
  { name: "New Feature", type: "feature", titleTemplate: "{feature name}", descriptionTemplate: "Implement the new feature described above." },
  { name: "Code Review", type: "explore", titleTemplate: "Review {component}", descriptionTemplate: "Review the specified component for issues and improvements." },
  { name: "Infrastructure", type: "quick", titleTemplate: "{change}", descriptionTemplate: "Apply the infrastructure change described above." },
  { name: "Deploy", type: "quick", titleTemplate: "Deploy {target}", descriptionTemplate: "Deploy to the specified target." },
];

// ── Orchestrator-based directive routing ──
// Routes directives through the persistent Cipher orchestrator for context-aware dispatch.
// Falls back to direct spawn if orchestrator is unavailable.
async function routeDirective(directive, type) {
  if (!orchestrator.isAvailable()) {
    // Fallback: direct spawn with generic template (current behavior)
    if (type === "planning") spawnPlanningAgent(directive);
    else spawnImplementationAgent(directive);
    return;
  }

  try {
    const message = `NEW_DIRECTIVE: ${JSON.stringify({
      id: directive.id,
      type: directive.type,
      title: directive.title,
      description: directive.description,
      context: directive.context || null,
      priority: directive.priority,
      status: directive.status,
      plan: directive.plan || null,
      failureReason: directive.failureReason || null,
      retryCount: directive.retryCount || 0,
    })}`;

    const response = await orchestrator.sendMessage(message);
    await orchestrator.handleResponse(directive, response);
  } catch (err) {
    log.directive.error(`Orchestrator routing failed for ${directive.id}: ${err.message} — falling back to direct spawn`);
    // Log the failure to directive activity for audit
    const directives = getDirectives();
    const d = directives.find(x => x.id === directive.id);
    if (d) {
      if (!Array.isArray(d.activity_log)) d.activity_log = [];
      d.activity_log.push({ timestamp: Date.now(), type: "orchestrator_error", actor: "system", message: `Orchestrator failed: ${err.message.slice(0, 200)} — fell back to direct ${type} spawn` });
      saveDirectives(directives, d, null, "system");
    }
    if (type === "planning") spawnPlanningAgent(directive);
    else spawnImplementationAgent(directive);
  }
}

// ── Auto-escalation for exhausted directives ──
const ESCALATION_THRESHOLD = 2; // Worker retries before auto-escalation to Cipher

async function autoEscalate(directiveId, reason) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      escalatedBy: "auto",
      reason: reason || `exhausted: ${ESCALATION_THRESHOLD}+ worker failures`,
    });
    const req = http.request(
      `http://localhost:3333/directives/${directiveId}/escalate`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.ok) {
              log.directive.info(`Auto-escalated ${directiveId} to Cipher: ${reason}`);
              // Notify King Kazuma via /notify
              const notifyPayload = JSON.stringify({
                message: `[SYSTEM — Tell King Kazuma briefly.]\nCipher is taking over directive "${data.directive?.title || directiveId}" after ${ESCALATION_THRESHOLD}+ worker failures. Reason: ${reason}`,
              });
              const notifyReq = http.request(
                "http://localhost:3333/notify",
                { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(notifyPayload) } },
              );
              notifyReq.on("error", () => {}); // fire-and-forget
              notifyReq.write(notifyPayload);
              notifyReq.end();
              resolve(data);
            } else {
              log.directive.warn(`Auto-escalation failed for ${directiveId}: ${data.error}`);
              reject(new Error(data.error));
            }
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", (err) => {
      log.directive.error(`Auto-escalation request failed for ${directiveId}: ${err.message}`);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

const BRIDGE_PIN = process.env.BRIDGE_PIN || "1234";
const HA_URL = process.env.HA_URL || "http://localhost:8123";
const HA_TOKEN = process.env.HA_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || "";

const GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
// ── Persona system ──
let currentPersona = "june"; // "june" or "cipher"
let cipherMode = null; // "building" or "learning"
let personaSwitchPending = false;
let goAwayDuringToolCall = false;
let goAwayPartialOutput = ""; // tracks what Gemini was saying before disconnect
let goAwayNudgeTimer = null;  // retry timer for recovery nudge
let cipherPipeline = null; // CipherPipeline instance when Cipher is active (Deepgram STT → Claude → Cartesia TTS)
let cipherPhoneWs = null; // WebSocket of the cipher-voice-capable iPhone (for sending response text)
const JUNE_VOICE = "Kore";
const CIPHER_VOICE = "Orus";
const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// ── Entity config (mirrored from frontend/lib/rooms.ts) ──

const ENTITY_CONFIG = [
  { entityId: "media_player.main_tv", label: "Main TV — Power" },
  { entityId: "remote.main_tv", label: "Main TV — Remote" },
  { entityId: "switch.living_room_cam_power", label: "Living Room Camera — Power" },
  { entityId: "switch.living_room_cam_notifications", label: "Living Room Camera — Notifications" },
  { entityId: "switch.living_room_cam_motion_detection", label: "Living Room Camera — Motion Detection" },
  { entityId: "siren.living_room_cam_siren", label: "Living Room Camera — Siren" },
  { entityId: "switch.s_vide_switch", label: "Sous Vide — Power" },
  { entityId: "sensor.s_vide_current_temperature", label: "Sous Vide — Current Temp" },
  { entityId: "number.s_vide_cooking_temperature", label: "Sous Vide — Target Temp" },
  { entityId: "number.s_vide_cooking_time", label: "Sous Vide — Cook Time" },
  { entityId: "sensor.s_vide_status", label: "Sous Vide — Status" },
  { entityId: "sensor.s_vide_remaining_time", label: "Sous Vide — Remaining" },
  { entityId: "switch.cam1_power", label: "Security Camera — Power" },
  { entityId: "switch.cam1_notifications", label: "Security Camera — Notifications" },
  { entityId: "switch.cam1_motion_detection", label: "Security Camera — Motion Detection" },
  { entityId: "siren.cam1_siren", label: "Security Camera — Siren" },
  { entityId: "device_tracker.kazuma_iphone", label: "Kazuma iPhone — Location" },
  { entityId: "sensor.kazuma_iphone_battery_level", label: "Kazuma iPhone — Battery" },
  { entityId: "sensor.kazuma_iphone_battery_state", label: "Kazuma iPhone — Charging" },
  { entityId: "sensor.kazuma_iphone_connection_type", label: "Kazuma iPhone — Connection" },
  { entityId: "sensor.kazuma_iphone_ssid", label: "Kazuma iPhone — Wi-Fi" },
  { entityId: "sensor.kazuma_iphone_storage", label: "Kazuma iPhone — Storage" },
  { entityId: "sensor.kazuma_iphone_geocoded_location", label: "Kazuma iPhone — Address" },
  { entityId: "person.king_kazuma", label: "King Kazuma — Presence" },
  { entityId: "todo.shopping_list", label: "Shopping List — List" },
  { entityId: "climate.living_room_ac", label: "Living Room AC — Climate" },
  { entityId: "switch.151732606804847_power", label: "Washing Machine — Power" },
  { entityId: "switch.151732606804847_start", label: "Washing Machine — Start" },
  { entityId: "sensor.151732606804847_status", label: "Washing Machine — Status" },
  { entityId: "sensor.151732606804847_program", label: "Washing Machine — Program" },
  { entityId: "sensor.151732606804847_progress", label: "Washing Machine — Progress" },
  { entityId: "sensor.151732606804847_time_remaining", label: "Washing Machine — Time Remaining" },
  { entityId: "sensor.151732606804847_temperature", label: "Washing Machine — Temperature" },
  { entityId: "sensor.151732606804847_water_level", label: "Washing Machine — Water Level" },
  { entityId: "media_player.spotify_king_kazuma", label: "Spotify — Playback" },
];

// ── Camera config ──

const WYZE_BRIDGE_HOST = "172.168.0.59"; // dev-01 on home LAN
const CAMERAS = [
  { id: 'living_room_cam', name: 'Living Room Camera', streamName: 'izzy-cam-lroom-01' },
];

function getCameraStreamUrl(streamName) {
  return `http://${WYZE_BRIDGE_HOST}:8888/${streamName}/`;
}

const CONTROLLABLE_DOMAINS = new Set(["switch", "siren", "media_player", "number", "climate", "select"]);
const ALLOWED_ENTITY_IDS = new Set(
  ENTITY_CONFIG
    .map((e) => e.entityId)
    .filter((id) => CONTROLLABLE_DOMAINS.has(id.split(".")[0]))
);

// ── Redis connection ──

const redis = new Redis({ host: "127.0.0.1", port: 6379, lazyConnect: true });

// Redis runtime disconnect handling — update _redisConnected so JSON fallback kicks in
redis.on("error", (err) => {
  if (_redisConnected) log.redis.error("Connection error:", err.message);
  _redisConnected = false;
});
redis.on("close", () => {
  if (_redisConnected) log.redis.warn("Connection closed, falling back to JSON");
  _redisConnected = false;
});
redis.on("reconnecting", () => {
  log.redis.info("Reconnecting...");
});
redis.on("ready", () => {
  if (!_redisConnected) log.redis.info("Reconnected");
  _redisConnected = true;
});

// ── Storage helpers ──

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── read_file path validation ──

const READ_FILE_BASE = "/home/gcp/ozzu";
const READ_FILE_MAX_CHARS = 12000;

const READ_FILE_WHITELIST = [
  /^frontend\/lib\/[^/]+\.ts$/,
  /^frontend\/components\/[^/]+\.tsx$/,
  /^frontend\/app\/[^/]+\.tsx$/,
  /^frontend\/app\.json$/,
  /^frontend\/package\.json$/,
  /^backend\/bridge\/server\.js$/,
  /^backend\/bridge\/db\.js$/,
  /^backend\/bridge\/schema\.sql$/,
  /^backend\/docker-compose\.yml$/,
  /^backend\/config\/[^/]+\.yaml$/,
  /^scripts\/[^/]+\.sh$/,
  /^CLAUDE\.md$/,
];

const READ_FILE_BLOCKLIST = [
  /\.env/,
  /secrets\.yaml/,
  /node_modules\//,
  /\.git\//,
  /openvpn\/config/,
  /\/tmp\//,
  /\.\./,
];

function validateReadPath(relPath) {
  if (!relPath || typeof relPath !== "string") return { ok: false, reason: "No path provided" };
  // Normalize and resolve
  const cleaned = relPath.replace(/^\/+/, ""); // strip leading slashes
  const absolute = path.resolve(READ_FILE_BASE, cleaned);
  // Must stay under base directory
  if (!absolute.startsWith(READ_FILE_BASE + "/")) {
    return { ok: false, reason: "Path escapes project directory" };
  }
  const relative = path.relative(READ_FILE_BASE, absolute);
  // Check blocklist first
  for (const pattern of READ_FILE_BLOCKLIST) {
    if (pattern.test(relative) || pattern.test(cleaned)) {
      return { ok: false, reason: `Blocked: matches ${pattern}` };
    }
  }
  // Check whitelist
  for (const pattern of READ_FILE_WHITELIST) {
    if (pattern.test(relative)) {
      return { ok: true, absolute, relative };
    }
  }
  return { ok: false, reason: `Not in whitelist: ${relative}` };
}

// ── run_command validation ──

const CMD_WHITELIST = new Set([
  "docker", "ping", "traceroute", "curl", "wget", "uptime", "df", "free",
  "top", "ps", "ip", "ss", "nslookup", "cat", "ls", "head", "tail", "wc",
  "grep", "nmap", "sed", "git", "python3", "node", "npm", "tee", "sort",
  "uniq", "awk", "find", "test", "echo", "printf", "sleep", "date", "touch",
]);

const CMD_BLOCKED_PATTERNS = [
  /\brm\s+-rf\b/, /\brmdir\b/, /\bdd\b/, /\bmkfs\b/, /\bchmod\b/, /\bchown\b/,
  /\bkill\b/, /\bkillall\b/,
  /\.env\.local/, /secrets\.yaml/, /openvpn\/config/, /\/etc\/shadow/, /\/etc\/passwd/,
];

// Allow && (chaining), | (pipes), and > (redirects) — needed for edit+restart and file writes
// Each segment after &&, ||, or | is whitelist-checked (see validateCommand split logic)
// Block: ; (unchecked chaining), ` (backtick execution), $( (subshell expansion), ${ (variable expansion)
const CMD_BLOCKED_OPERATORS = [";", "`", "\n", "$(", "${"];

function validateCommand(command) {
  if (!command || typeof command !== "string") return { ok: false, reason: "No command provided" };
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "Empty command" };

  // Check for blocked shell operators
  for (const op of CMD_BLOCKED_OPERATORS) {
    if (trimmed.includes(op)) {
      return { ok: false, reason: `Blocked operator: ${op === "\n" ? "\\n" : op}` };
    }
  }

  // Check against blocked patterns
  for (const pattern of CMD_BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: `Blocked pattern: ${pattern}` };
    }
  }

  // Split on && and | — each segment's first real command must be whitelisted
  // Also handle > and >> (output redirects) by validating redirect targets
  const REDIRECT_ALLOWED_PREFIXES = ["/home/gcp/ozzu/", "/tmp/ozzu-bridge/", "/tmp/"];
  const segments = trimmed.split(/\s*(?:&&|\|\|?)\s*/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    // Check redirect target path is within allowed directories
    const redirectMatch = seg.match(/\s*>>?\s*(.+)$/);
    if (redirectMatch) {
      const target = redirectMatch[1].trim().replace(/^["']|["']$/g, "");
      const resolvedTarget = path.resolve(target);
      if (!REDIRECT_ALLOWED_PREFIXES.some(p => resolvedTarget.startsWith(p))) {
        return { ok: false, reason: `Redirect target not allowed: ${target}. Must be under ${REDIRECT_ALLOWED_PREFIXES.join(" or ")}` };
      }
    }
    // Strip redirect suffix: "echo foo > file" → "echo foo"
    const beforeRedirect = seg.split(/\s*>>?\s/)[0].trim();
    if (!beforeRedirect) continue;
    const firstToken = beforeRedirect.split(/\s+/)[0];
    if (!CMD_WHITELIST.has(firstToken)) {
      return { ok: false, reason: `Binary not allowed: ${firstToken}. Allowed: ${[...CMD_WHITELIST].join(", ")}` };
    }
  }

  return { ok: true };
}

// In-memory cache (populated from Redis on startup, falls back to JSON files)
let _statusEntries = [];
let _approvals = [];
let _directives = [];
let _redisConnected = false;

// ── Uptime & restart tracking ──
const _serverStartedAt = new Date().toISOString();
let _restartCount = 0;
let _lastRestartReason = null;
let _previousStartedAt = null;

function setLastRestartReason(reason) {
  if (!_lastRestartReason && _restartCount > 0) {
    _lastRestartReason = reason;
    if (_redisConnected) redis.set("ozzu:lastRestartReason", reason).catch(() => {});
    log.bridge.info(`Last restart reason set: ${reason}`);
  }
}

function getStatusEntries() { return _statusEntries; }
function saveStatusEntries(entries, latestEntry = null) {
  _statusEntries = entries;
  writeJSON(STATUS_FILE, entries);
  if (_redisConnected) redis.set("ozzu:status", JSON.stringify(entries)).catch(err =>
    log.redis.error("save status failed:", err.message));
  // Write to PG (uncapped history)
  if (latestEntry) {
    db.addStatusEntry(latestEntry, currentPersona).catch(err =>
      log.pg.error("save status failed:", err.message));
  }
}

function getApprovals() { return _approvals; }
function saveApprovals(approvals, changedApproval = null) {
  _approvals = approvals;
  writeJSON(APPROVALS_FILE, approvals);
  if (_redisConnected) redis.set("ozzu:approvals", JSON.stringify(approvals)).catch(err =>
    log.redis.error("save approvals failed:", err.message));
  // Write changed approval to PG
  if (changedApproval) {
    db.saveApproval(changedApproval).catch(err =>
      log.pg.error("save approval failed:", err.message));
  }
}

function getDirectives() { return _directives; }

// ── Duplicate directive detection ──
function findSimilarDirective(title) {
  if (!title || title.length < 5) return null;
  const terminal = new Set(["completed", "failed", "rejected"]);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const normTitle = norm(title);
  const titleWords = normTitle.split(/\s+/).filter(Boolean);

  for (const d of _directives) {
    if (terminal.has(d.status)) continue;
    const existingNorm = norm(d.title || "");
    if (!existingNorm || existingNorm.length < 5) continue;
    // Substring match
    if (normTitle.includes(existingNorm) || existingNorm.includes(normTitle)) return d;
    // Word overlap >70%
    const existingWords = existingNorm.split(/\s+/).filter(Boolean);
    const overlap = titleWords.filter(w => existingWords.includes(w)).length;
    const maxLen = Math.max(titleWords.length, existingWords.length);
    if (maxLen > 0 && overlap / maxLen > 0.7) return d;
  }
  return null;
}
function saveDirectives(directives, changedDirective = null, oldStatus = null, actor = "system") {
  _directives = directives;
  writeJSON(DIRECTIVES_FILE, directives);
  if (_redisConnected) redis.set("ozzu:directives", JSON.stringify(directives)).catch(err =>
    log.redis.error("save directives failed:", err.message));
  // Write changed directive to PG + history
  if (changedDirective) {
    db.saveDirective(changedDirective).catch(err =>
      log.pg.error("save directive failed:", err.message));
    if (oldStatus !== null && oldStatus !== changedDirective.status) {
      db.addDirectiveHistory(changedDirective.id, oldStatus, changedDirective.status, actor).catch(err =>
        log.pg.error("save directive history failed:", err.message));
    }
  }
}

// ── Orphan commit scanner — detects commits on main without directive linkage ──
async function scanOrphanCommits() {
  const { exec } = require("child_process");
  const { promisify } = require("util");
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync("git log main --oneline -20", {
      cwd: "/home/gcp/ozzu",
      timeout: 10000,
    });
    if (!stdout.trim()) return;

    const directives = getDirectives();
    const lines = stdout.trim().split("\n");
    const exceptionTags = ["[pipeline-fix]", "[config]", "[docs]", "[security]", "[escalated]"];

    for (const line of lines) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx < 0) continue;
      const hash = line.slice(0, spaceIdx);
      const msg = line.slice(spaceIdx + 1);

      // Skip if already recorded
      if (_pipelineViolations.some(v => v.commitHash === hash)) continue;

      // Check if message contains a directive ID
      if (/dir_/.test(msg)) continue;

      // Check for exception tags
      if (exceptionTags.some(tag => msg.toLowerCase().includes(tag.toLowerCase()))) continue;

      // Check if commit hash appears in any directive's activity_log (linked via merge)
      const linkedByMerge = directives.some(d => {
        if (!Array.isArray(d.activity_log)) return false;
        return d.activity_log.some(e => e.message && e.message.includes(hash));
      });
      if (linkedByMerge) continue;

      // Check if this is a merge commit from an agent branch
      if (/^Merge branch 'agent\//.test(msg)) continue;

      // This commit is an orphan — no directive linkage found
      const violation = {
        id: _pipelineViolationIdCounter++,
        timestamp: Date.now(),
        commitHash: hash,
        branch: "main",
        author: "unknown",
        message: msg,
        violationType: "orphan_commit",
        directiveId: null,
        resolved: false,
      };
      _pipelineViolations.push(violation);
      if (_pipelineViolations.length > MAX_PIPELINE_VIOLATIONS) {
        _pipelineViolations.shift();
      }
      metrics.trackPipelineViolation();
      log.directive.warn(`Orphan commit detected: ${hash} "${msg}"`);
    }
  } catch (err) {
    log.directive.error("scanOrphanCommits error:", err.message);
  }
}

async function initStorage() {
  ensureDataDir();

  // Connect to Redis
  try {
    await redis.connect();
    _redisConnected = true;
    log.redis.info("Connected");

    // Restore active persona from Redis
    const savedPersona = await redis.get("ozzu:activePersona");
    if (savedPersona) {
      const { persona, cipherMode: mode } = JSON.parse(savedPersona);
      currentPersona = persona;
      cipherMode = mode;
      log.bridge.info(`Restored persona: ${persona}${mode ? ` (${mode})` : ""}`);
    }

    // ── Uptime & restart tracking ──
    const prevStartedAt = await redis.get("ozzu:serverStartedAt");
    const prevCount = await redis.get("ozzu:restartCount");
    if (prevStartedAt) {
      _previousStartedAt = prevStartedAt;
      _restartCount = (parseInt(prevCount, 10) || 0) + 1;
      log.bridge.info(`Restart #${_restartCount} (previous started: ${_previousStartedAt})`);
    }
    await redis.set("ozzu:serverStartedAt", _serverStartedAt);
    await redis.set("ozzu:restartCount", String(_restartCount));

    // Load from Redis, or migrate from JSON files
    const storedDirectives = await redis.get("ozzu:directives");
    if (storedDirectives) {
      _directives = JSON.parse(storedDirectives);
    } else if (fs.existsSync(DIRECTIVES_FILE)) {
      _directives = readJSON(DIRECTIVES_FILE, []);
      await redis.set("ozzu:directives", JSON.stringify(_directives));
      log.redis.info("Migrated directives from JSON");
    }

    const storedApprovals = await redis.get("ozzu:approvals");
    if (storedApprovals) {
      _approvals = JSON.parse(storedApprovals);
    } else if (fs.existsSync(APPROVALS_FILE)) {
      _approvals = readJSON(APPROVALS_FILE, []);
      await redis.set("ozzu:approvals", JSON.stringify(_approvals));
      log.redis.info("Migrated approvals from JSON");
    }

    const storedStatus = await redis.get("ozzu:status");
    if (storedStatus) {
      _statusEntries = JSON.parse(storedStatus);
    } else if (fs.existsSync(STATUS_FILE)) {
      _statusEntries = readJSON(STATUS_FILE, []);
      await redis.set("ozzu:status", JSON.stringify(_statusEntries));
      log.redis.info("Migrated status from JSON");
    }
  } catch (err) {
    log.redis.error("Connection failed, falling back to JSON files:", err.message);
    _directives = readJSON(DIRECTIVES_FILE, []);
    _approvals = readJSON(APPROVALS_FILE, []);
    _statusEntries = readJSON(STATUS_FILE, []);
  }

  // Clean up orphaned directives on startup — runningAgents is always empty at
  // startup, so ANY directive in a transient state has no agent and needs recovery.
  // planning directives are LEFT as-is so Phase B can respawn them directly.
  // in_progress → stale (auto-retry picks it up)
  const now = Date.now();
  let orphanCount = 0;
  for (const d of _directives) {
    if (d.status === "in_progress") {
      d.status = "stale";
      d.updatedAt = new Date().toISOString();
      if (!d.failureReason) d.failureReason = `crash: server restarted while in_progress`;
      orphanCount++;
      const age = d.updatedAt ? Math.round((now - new Date(d.updatedAt).getTime()) / 60000) : "?";
      log.directive.info(`Recovered orphan: ${d.id} "${d.title}" (in_progress → stale, age: ${age}min)`);
    } else if (d.status === "planning") {
      // Don't reset planning directives — Phase B will respawn their agents
      log.directive.info(`Will respawn planning directive: ${d.id} "${d.title}"`);
    }
  }
  if (orphanCount > 0) {
    saveDirectives(_directives);
    log.directive.info(`Recovered ${orphanCount} orphaned directive(s) on startup`);
  }

  // Phase C: Stale + crashed-failed auto-retry
  let retryCount = 0;
  let failedCount = 0;
  for (const d of _directives) {
    // Retry stale directives or failed directives that were killed by server crashes
    const isStale = d.status === "stale";
    const isCrashFailed = d.status === "failed" && d.failureReason?.startsWith("crash:");
    if (isStale || isCrashFailed) {
      const rc = d.retryCount || 0;
      // Allow more retries for crash-related failures (server restarts are not the agent's fault)
      const maxRetries = d.failureReason?.startsWith("crash:") ? 5 : 2;
      if (rc < maxRetries) {
        const oldStatus = d.status;
        d.status = "approved";
        d.failureReason = null;
        d.retryCount = rc + 1;
        d.updatedAt = new Date().toISOString();
        retryCount++;
        log.directive.info(`Auto-retry: ${d.id} "${d.title}" (${oldStatus} → approved, retry #${d.retryCount})`);
      } else if (isStale) {
        // Preserve current failure into workerAttempts before overwriting
        if (!Array.isArray(d.workerAttempts)) d.workerAttempts = [];
        if (d.failureReason) {
          d.workerAttempts.push({
            attempt: d.workerAttempts.length + 1,
            failureReason: d.failureReason,
            timestamp: d.updatedAt || Date.now(),
          });
        }

        d.status = "failed";
        d.failureReason = d.failureReason || `exhausted: failed after ${rc} retries`;
        d.updatedAt = new Date().toISOString();
        failedCount++;
        log.directive.warn(`Stale exhausted: ${d.id} "${d.title}" (stale → failed, retries: ${rc})`);

        // Auto-escalate to Cipher instead of just notifying about failure
        const escalateId = d.id;
        const escalateReason = `exhausted: ${rc} worker failures`;
        setTimeout(() => {
          autoEscalate(escalateId, escalateReason).catch(err => {
            // Fallback: notify June if escalation fails
            log.directive.warn(`Auto-escalation failed for ${escalateId}, falling back to notification: ${err.message}`);
            const failedTitle = d.title || d.description?.substring(0, 80) || escalateId;
            engage("directive failure notification");
            sendNotification(
              `[SYSTEM — Tell King Kazuma briefly, don't dump details.]\n` +
              `"${failedTitle}" failed after ${rc} tries and auto-escalation failed. ` +
              `Might need manual intervention.`
            );
          });
        }, 15000); // 15s delay — let server finish startup
      }
    }
  }
  if (retryCount > 0 || failedCount > 0) {
    saveDirectives(_directives);
    if (retryCount > 0) log.directive.info(`Auto-retried ${retryCount} stale directive(s)`);
    if (failedCount > 0) log.directive.info(`Failed ${failedCount} exhausted directive(s)`);
  }

  // Phase B: Respawn agents for directives still in actionable states (higher priority first)
  const respawnTargets = _directives.filter(d => d.status === "planning" || d.status === "approved")
    .sort((a, b) => (a.priority || 3) - (b.priority || 3));
  if (respawnTargets.length > 0) {
    log.directive.info(`Respawning agents for ${respawnTargets.length} active directive(s)...`);
    const INITIAL_DELAY = 5000; // 5s — let HTTP server start first
    const STAGGER_MS = 3000;   // 3s between spawns
    respawnTargets.forEach((d, i) => {
      setTimeout(() => {
        const type = d.status === "planning" ? "planning" : "implementation";
        log.directive.info(`Respawn: ${d.id} "${d.title}" → ${type} agent`);
        routeDirective(d, type);
      }, INITIAL_DELAY + i * STAGGER_MS);
    });
  }

  // Clean up expired approvals (older than APPROVAL_EXPIRY_MS and still pending)
  const freshApprovals = _approvals.filter(a => {
    if (a.status !== "pending") return true;
    const age = now - new Date(a.createdAt || 0).getTime();
    if (age > APPROVAL_EXPIRY_MS) {
      log.directive.info(`Approval expired stale: ${a.id} (age: ${Math.round(age / 60000)}min)`);
      return false;
    }
    return true;
  });
  if (freshApprovals.length < _approvals.length) {
    _approvals = freshApprovals;
    saveApprovals(_approvals);
  }

  // Connect to PostgreSQL and migrate data from Redis
  const pgReady = await db.init();
  if (pgReady) {
    await migrateRedisToPostgres();
    // Start entity snapshot interval (every 5 min)
    _intervals.push(setInterval(() => { try { captureEntitySnapshots().catch(err =>
      log.pg.error("snapshot error:", err.message)); } catch (err) { log.pg.error("snapshot sync error:", err.message); } }, 5 * 60 * 1000));
    // Prune old snapshots daily
    _intervals.push(setInterval(() => db.pruneEntitySnapshots(7).catch(err =>
      log.pg.error("prune error:", err.message)), 24 * 60 * 60 * 1000));
    // Close stale conversations every hour (open >2h with no recent turns)
    _intervals.push(setInterval(async () => {
      try {
        const res = await db.query(`
          UPDATE conversations SET ended_at = NOW(), summary = 'Session ended (auto-closed)'
          WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL '2 hours'
          RETURNING id`);
        if (res.rowCount > 0) log.pg.info(`Auto-closed ${res.rowCount} stale conversation(s)`);
      } catch (err) { log.pg.error("conversation cleanup:", err.message); }
    }, 60 * 60 * 1000));
  }

  // ── Orphan commit scanner — every 30 minutes ──
  _intervals.push(setInterval(async () => {
    try { await scanOrphanCommits(); }
    catch (err) { log.directive.error("orphan commit scanner:", err.message); }
  }, 30 * 60 * 1000));
  // Run once on startup after 2 minutes
  setTimeout(() => {
    scanOrphanCommits().catch(err => log.directive.error("orphan commit scanner (startup):", err.message));
  }, 2 * 60 * 1000);

  // ── Stale branch cleanup — every 60 minutes ──
  _intervals.push(setInterval(() => {
    try {
      const agentSpawner = require("./agent-spawner");
      agentSpawner.cleanupStaleBranches(getDirectives);
    } catch (err) { log.directive.error("stale branch cleanup:", err.message); }
  }, 60 * 60 * 1000));
  // Run once on startup after 3 minutes (after orphan scanner)
  setTimeout(() => {
    try {
      const agentSpawner = require("./agent-spawner");
      agentSpawner.cleanupStaleBranches(getDirectives);
    } catch (err) { log.directive.error("stale branch cleanup (startup):", err.message); }
  }, 3 * 60 * 1000);
}

async function migrateRedisToPostgres() {
  try {
    // Check if migration already done
    const existing = await db.query("SELECT COUNT(*) as count FROM memories");
    if (existing.rows[0].count > 0) {
      log.pg.info("Data already present, skipping migration");
      return;
    }

    log.pg.info("Starting Redis → PostgreSQL migration...");

    // Migrate memories
    if (_redisConnected) {
      for (const persona of ["june", "cipher"]) {
        const raw = await redis.zrevrange(`${persona}:facts`, 0, -1);
        const memories = raw.map(r => JSON.parse(r));
        const count = await db.migrateMemoriesFromRedis(persona, memories);
        if (count > 0) log.pg.info(`Migrated ${count} ${persona} memories`);
      }

      // Migrate summaries
      for (const persona of ["june", "cipher"]) {
        const raw = await redis.lrange(`${persona}:summaries`, 0, -1);
        const summaries = raw.map(r => JSON.parse(r));
        const count = await db.migrateSummariesFromRedis(persona, summaries);
        if (count > 0) log.pg.info(`Migrated ${count} ${persona} summaries`);
      }
    }

    // Migrate directives
    if (_directives.length > 0) {
      const count = await db.migrateDirectivesFromRedis(_directives);
      log.pg.info(`Migrated ${count} directives`);
    }

    // Migrate approvals
    if (_approvals.length > 0) {
      const count = await db.migrateApprovalsFromRedis(_approvals);
      log.pg.info(`Migrated ${count} approvals`);
    }

    // Migrate status entries
    if (_statusEntries.length > 0) {
      const count = await db.migrateStatusFromRedis(_statusEntries);
      log.pg.info(`Migrated ${count} status entries`);
    }

    log.pg.info("Migration complete");
  } catch (err) {
    log.pg.error("Migration error:", err.message);
  }
}

// Cache last known state per entity to avoid storing duplicate snapshots
const _lastEntityState = new Map();

async function captureEntitySnapshots() {
  if (!db.isConnected()) return;
  try {
    const states = await haFetch("/api/states");
    if (!Array.isArray(states)) {
      log.pg.warn("Entity snapshot: HA returned non-array response, skipping");
      return;
    }
    const entityIds = new Set(ENTITY_CONFIG.map((e) => e.entityId));
    let stored = 0;
    for (const state of states) {
      if (!entityIds.has(state.entity_id)) continue;
      // Delta check — only store if state or key attributes changed
      const attrs = state.attributes || null;
      const fingerprint = state.state + "|" + JSON.stringify(attrs);
      if (_lastEntityState.get(state.entity_id) === fingerprint) continue;
      _lastEntityState.set(state.entity_id, fingerprint);
      await db.addEntitySnapshot(state.entity_id, state.state, attrs);
      stored++;
    }
    if (stored > 0) log.pg.debug(`Entity snapshots: ${stored} changed out of ${entityIds.size} entities`);
  } catch (err) {
    log.pg.error("Entity snapshot capture failed:", err.message);
  }
}

// ── Per-persona memory system (Redis ZSETs + LISTs) ──

async function addMemory(persona, fact, category = "general") {
  // Write to PG (primary)
  db.addMemory(persona, fact, category, "voice").catch(err =>
    log.pg.error("addMemory failed:", err.message));
  // Write-through to Redis (cache)
  if (!_redisConnected) return;
  const entry = JSON.stringify({ fact, category, ts: Date.now() });
  await redis.zadd(`${persona}:facts`, Date.now(), entry);
  const count = await redis.zcard(`${persona}:facts`);
  if (count > 100) await redis.zremrangebyrank(`${persona}:facts`, 0, count - 101);
}

async function getMemories(persona, limit = 50) {
  // Try PG first (richer queries), fall back to Redis
  if (db.isConnected()) {
    try {
      return await db.getMemories(persona, limit);
    } catch (err) {
      log.pg.error("getMemories failed, falling back to Redis:", err.message);
    }
  }
  if (!_redisConnected) return [];
  const raw = await redis.zrevrange(`${persona}:facts`, 0, limit - 1);
  return raw.map(r => JSON.parse(r));
}

async function addConversationSummary(persona, summary, turns) {
  // Write to PG (primary)
  if (db.isConnected()) {
    try {
      const convId = await db.createConversation(persona);
      if (convId) await db.endConversation(convId, summary, turns);
    } catch (err) {
      log.pg.error("addConversationSummary failed:", err.message);
    }
  }
  // Write-through to Redis
  if (!_redisConnected) return;
  const entry = JSON.stringify({ summary, timestamp: Date.now(), turns });
  await redis.lpush(`${persona}:summaries`, entry);
  await redis.ltrim(`${persona}:summaries`, 0, 19);
}

async function getRecentSummaries(persona, limit = 5) {
  // Try PG first, fall back to Redis
  if (db.isConnected()) {
    try {
      const rows = await db.getRecentSummaries(persona, limit);
      if (rows.length > 0) return rows;
    } catch (err) {
      log.pg.error("getRecentSummaries failed, falling back to Redis:", err.message);
    }
  }
  if (!_redisConnected) return [];
  const raw = await redis.lrange(`${persona}:summaries`, 0, limit - 1);
  return raw.map(r => JSON.parse(r));
}

// Expire old approvals — mark unresolved ones past expiry as denied
function expireApprovals(approvals) {
  const now = Date.now();
  let changed = false;
  for (const a of approvals) {
    if (!a.resolved && now - a.createdAt > APPROVAL_EXPIRY_MS) {
      a.resolved = true;
      a.approved = false;
      a.resolvedAt = now;
      a.reason = "expired";
      changed = true;
    }
  }
  if (changed) saveApprovals(approvals);
  return approvals;
}

// ── Request parsing ──

const MAX_BODY_SIZE = 1024 * 1024; // 1MB
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Escape for use inside single-quoted JS strings in inline handlers
function escapeJsString(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(data));
}

// ── API key auth for sensitive (mutating) endpoints ──
function requireAuth(req, res) {
  if (!BRIDGE_API_KEY) return true; // no key configured — skip auth (backward compatible)
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token !== BRIDGE_API_KEY) {
    sendJSON(res, 401, { error: "Unauthorized — invalid or missing API key" });
    return false;
  }
  return true;
}

// ── Route handlers ──

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  metrics.trackHttpRequest();

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // POST /status — Claude Code posts activity
  if (req.method === "POST" && pathname === "/status") {
    const data = await parseBody(req);
    const entry = {
      event: data.event || "unknown",
      tool: data.tool || "",
      message: data.message || "",
      timestamp: data.timestamp || new Date().toISOString(),
    };
    const entries = getStatusEntries();
    entries.push(entry);
    // Keep only latest N in memory/Redis
    while (entries.length > MAX_STATUS_ENTRIES) entries.shift();
    saveStatusEntries(entries, entry);

    // If directiveId provided, append to that directive's activity log and update lastActivity
    if (data.directiveId) {
      const directives = getDirectives();
      const directive = directives.find(d => d.id === data.directiveId);
      if (directive) {
        if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
        directive.activity_log.push({
          timestamp: Date.now(),
          type: "agent_status",
          actor: "Cipher",
          message: data.message || data.event || "status update",
        });
        directive.lastActivity = Date.now();
        directive.updatedAt = Date.now();
        saveDirectives(directives, directive, null, "Cipher");
      }
    }

    // Notify active persona about blocker/error events from Cipher
    const evt = (entry.event || "").toLowerCase();
    if (evt === "blocker" || evt === "error" || evt === "blocked") {
      setTimeout(() => {
        engage("cipher status notification");
        sendNotification(
          `[SYSTEM — Brief heads-up for King Kazuma.]\n` +
          `Hit a ${entry.event}: ${entry.message}`
        );
      }, 500);
    }

    sendJSON(res, 200, { ok: true });
    return;
  }

  // GET /status — Tablet fetches activity log
  if (req.method === "GET" && pathname === "/status") {
    sendJSON(res, 200, getStatusEntries());
    return;
  }

  // GET /audio-stats — Real-time audio diagnostics for all mics
  if (req.method === "GET" && pathname === "/audio-stats") {
    sendJSON(res, 200, {
      devices: [...devices.values()].map(d => ({ deviceId: d.deviceId, role: d.role })),
      activeMic: activeMic ? devices.get(activeMic)?.deviceId : null,
      gain: AUDIO_GAIN,
      speechThreshold: MIC_SPEECH_THRESHOLD,
      diagnostics: getAudioDiagnostics(),
    });
    return;
  }

  // GET /audio-routing — Current zone-aware audio routing state
  if (req.method === "GET" && pathname === "/audio-routing") {
    const deviceList = [...devices.entries()].map(([ws, info]) => ({
      deviceId: info.deviceId, role: info.role, deviceType: info.deviceType,
      zone: info.zone, capabilities: info.capabilities,
      speakerPriority: info.speakerPriority, online: ws.readyState === WebSocket.OPEN,
    }));
    const target = selectSpeaker();
    sendJSON(res, 200, {
      devices: deviceList,
      activeMic: activeMic ? devices.get(activeMic)?.deviceId : null,
      activeMicZone: activeMic ? devices.get(activeMic)?.zone : null,
      selectedSpeaker: target ? target.info.deviceId : null,
      selectedSpeakerZone: target ? target.info.zone : null,
    });
    return;
  }

  // POST /restart — Graceful restart (Docker auto-restarts the container)
  if (req.method === "POST" && pathname === "/restart") {
    if (!requireAuth(req, res)) return;
    log.bridge.info("Restart requested via API");
    sendJSON(res, 200, { ok: true, message: "Restarting in 1 second..." });
    setTimeout(() => gracefulShutdown("API_RESTART"), 1000);
    return;
  }

  // POST /notify — Push a notification to June (used by cipher-watcher, deploy scripts, etc.)
  if (req.method === "POST" && pathname === "/notify") {
    const data = await parseBody(req);
    if (data.message) {
      setTimeout(() => {
        engage("system notification");
        sendNotification(
          `[SYSTEM — Tell King Kazuma casually.]\n${data.message}`
        );
      }, 500);
    }
    sendJSON(res, 200, { ok: true });
    return;
  }

  // POST /approvals — Claude Code creates a pending approval
  if (req.method === "POST" && pathname === "/approvals") {
    const data = await parseBody(req);
    const approval = {
      id: data.id || `apr_${Date.now()}`,
      tool: data.tool || "",
      description: data.description || "",
      risk: data.risk || "medium",
      resolved: false,
      approved: false,
      createdAt: Date.now(),
    };
    // Auto-approve low/medium risk dev approvals — only escalate high risk to King Kazuma
    if (approval.risk !== "high") {
      approval.resolved = true;
      approval.approved = true;
      approval.resolvedAt = Date.now();
      approval.autoApproved = true;
      log.directive.info(`Auto-approved (${approval.risk}): ${approval.description}`);
      const approvals = getApprovals();
      approvals.push(approval);
      saveApprovals(approvals, approval);
      syncDirectiveFromApproval(approval.id, true);
      sendJSON(res, 200, { ok: true, id: approval.id, autoApproved: true });
      return;
    }

    // High risk — save as pending and notify June
    const approvals = getApprovals();
    approvals.push(approval);
    saveApprovals(approvals, approval);

    setTimeout(() => {
      engage("cipher approval request");
      sendNotification(
        `[SYSTEM — Ask King Kazuma naturally.]\n` +
        `Need approval for: ${approval.description}\n` +
        `If he says yes, use approve_action with approval ID "${approval.id}" and needs_user_pin: true.`
      );
    }, 500);

    sendJSON(res, 200, { ok: true, id: approval.id });
    return;
  }

  // GET /approvals — List pending approvals
  if (req.method === "GET" && pathname === "/approvals") {
    const approvals = expireApprovals(getApprovals());
    const pending = approvals.filter((a) => !a.resolved);
    sendJSON(res, 200, pending);
    return;
  }

  // POST /approvals/:id/resolve — Resolve an approval
  const resolveMatch = pathname.match(/^\/approvals\/([^/]+)\/resolve$/);
  if (req.method === "POST" && resolveMatch) {
    const id = resolveMatch[1];
    const data = await parseBody(req);

    // Validate PIN
    if (data.pin !== BRIDGE_PIN) {
      sendJSON(res, 403, { error: "Invalid PIN" });
      return;
    }

    const approvals = getApprovals();
    const approval = approvals.find((a) => a.id === id);
    if (!approval) {
      sendJSON(res, 404, { error: "Approval not found" });
      return;
    }
    if (approval.resolved) {
      sendJSON(res, 409, { error: "Already resolved" });
      return;
    }

    approval.resolved = true;
    approval.approved = !!data.approved;
    approval.resolvedAt = Date.now();
    saveApprovals(approvals, approval);
    syncDirectiveFromApproval(id, approval.approved);
    sendJSON(res, 200, { ok: true, approved: approval.approved });
    return;
  }

  // GET /approvals/:id/poll — Hook polls for resolution
  const pollMatch = pathname.match(/^\/approvals\/([^/]+)\/poll$/);
  if (req.method === "GET" && pollMatch) {
    const id = pollMatch[1];
    const approvals = expireApprovals(getApprovals());
    const approval = approvals.find((a) => a.id === id);
    if (!approval) {
      sendJSON(res, 404, { error: "Approval not found" });
      return;
    }
    sendJSON(res, 200, {
      resolved: approval.resolved,
      approved: approval.approved,
    });
    return;
  }

  // POST /directives — June creates a directive
  if (req.method === "POST" && pathname === "/directives") {
    if (!requireAuth(req, res)) return;
    // Rate limit: max 10 directives per 5 minutes (sliding window)
    const now = Date.now();
    while (_directiveCreationTimestamps.length > 0 && _directiveCreationTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
      _directiveCreationTimestamps.shift();
    }
    if (_directiveCreationTimestamps.length >= RATE_LIMIT_MAX) {
      _rateLimitHits++;
      const oldestInWindow = _directiveCreationTimestamps[0];
      const retryAfterSec = Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      sendJSON(res, 429, { error: `Rate limit exceeded: max ${RATE_LIMIT_MAX} directives per ${RATE_LIMIT_WINDOW_MS / 60000} minutes`, retryAfter: retryAfterSec });
      return;
    }
    const data = await parseBody(req);
    const validTypes = ["quick", "feature", "explore"];
    if (!data.type || !validTypes.includes(data.type)) {
      sendJSON(res, 400, { error: "type must be one of: quick, feature, explore" });
      return;
    }
    if (!data.description) {
      sendJSON(res, 400, { error: "description is required" });
      return;
    }
    // Duplicate detection
    const existing = findSimilarDirective(data.title);
    if (existing) {
      sendJSON(res, 409, { error: `Similar directive already exists: "${existing.title}" [${existing.status}] (${existing.id})` });
      return;
    }
    // Validate dependsOn if provided
    const dependsOn = Array.isArray(data.dependsOn) ? data.dependsOn : [];
    if (dependsOn.length > 0) {
      const existingDirectives = getDirectives();
      const invalidIds = dependsOn.filter(id => !existingDirectives.find(d => d.id === id));
      if (invalidIds.length > 0) {
        sendJSON(res, 400, { error: `Unknown dependency IDs: ${invalidIds.join(", ")}` });
        return;
      }
    }

    const priority = [1, 2, 3, 4].includes(data.priority) ? data.priority : 3;
    const directive = {
      id: `dir_${Date.now()}`,
      type: data.type,
      title: data.title || "",
      description: data.description,
      status: "pending",
      plan: null,
      directiveApprovalId: null,
      retryCount: 0,
      failureReason: null,
      priority,
      dependsOn: dependsOn.length > 0 ? dependsOn : null,
      createdBy: "King Kazuma",
      activity_log: [{ timestamp: Date.now(), type: "status_change", actor: "King Kazuma", message: "Directive created with status: pending" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Check if all dependencies are completed
    const depsResolved = !directive.dependsOn || directive.dependsOn.every(depId => {
      const dep = getDirectives().find(d => d.id === depId);
      return dep && dep.status === "completed";
    });

    // Auto-transition quick and explore directives straight to planning (triggers agent spawner)
    // But only if dependencies are resolved
    if ((data.type === "quick" || data.type === "explore") && depsResolved) {
      directive.status = "planning";
    }

    const directives = getDirectives();
    directives.push(directive);
    // Evict oldest terminal directives first (never evict active ones)
    const ACTIVE_STATUSES = new Set(["planning", "planned", "approved", "in_progress", "pending"]);
    while (directives.length > MAX_DIRECTIVES) {
      const evictIdx = directives.findIndex(d => !ACTIVE_STATUSES.has(d.status));
      if (evictIdx === -1) break; // all active — allow overflow rather than lose work
      directives.splice(evictIdx, 1);
    }
    saveDirectives(directives, directive, null, "King Kazuma");
    _directiveCreationTimestamps.push(Date.now());

    // Spawn planning agent for quick directives (already in planning status)
    if (directive.status === "planning") {
      setLastRestartReason(`directive: ${directive.title || directive.id}`);
      routeDirective(directive, "planning");
    }

    sendJSON(res, 200, { ok: true, directive, blockedByDeps: !depsResolved && directive.dependsOn ? true : undefined });
    return;
  }

  // GET /templates — List directive templates
  if (req.method === "GET" && pathname === "/templates") {
    sendJSON(res, 200, DIRECTIVE_TEMPLATES);
    return;
  }

  // GET /directives — List directives (optional ?status= filter)
  if (req.method === "GET" && pathname === "/directives") {
    const statusFilter = url.searchParams.get("status");
    let directives = getDirectives();
    if (statusFilter) {
      directives = directives.filter((d) => d.status === statusFilter);
    }
    sendJSON(res, 200, directives);
    return;
  }

  // GET /directives/stats — Pipeline analytics
  if (req.method === "GET" && pathname === "/directives/stats") {
    const directives = getDirectives();
    const agents = getRunningAgents();
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);

    // By status
    const byStatus = {};
    for (const d of directives) {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    }

    // By type
    const byType = {};
    for (const d of directives) {
      byType[d.type] = (byType[d.type] || 0) + 1;
    }

    // Average duration (completed directives with timing data)
    const completedWithDuration = directives.filter(d => d.status === "completed" && d.duration);
    const averageDuration = completedWithDuration.length > 0
      ? Math.round(completedWithDuration.reduce((sum, d) => sum + d.duration, 0) / completedWithDuration.length)
      : null;

    // Success rate
    const completed = directives.filter(d => d.status === "completed").length;
    const failed = directives.filter(d => d.status === "failed").length;
    const successRate = (completed + failed) > 0
      ? Math.round((completed / (completed + failed)) * 10000) / 100
      : null;

    // Today stats
    const todayDirectives = directives.filter(d => d.createdAt >= todayStart);
    const todayStats = {
      submitted: todayDirectives.length,
      completed: todayDirectives.filter(d => d.status === "completed").length,
      failed: todayDirectives.filter(d => d.status === "failed").length,
    };

    // Top failure reasons
    const reasonCounts = {};
    for (const d of directives) {
      if (d.status === "failed" && d.failureReason) {
        reasonCounts[d.failureReason] = (reasonCounts[d.failureReason] || 0) + 1;
      }
    }
    const topFailureReasons = Object.entries(reasonCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    // Agent utilization
    const agentUtilization = {
      active: agents.length,
      max: getConfig().MAX_CONCURRENT_AGENTS,
      utilization: Math.round((agents.length / getConfig().MAX_CONCURRENT_AGENTS) * 10000) / 100,
    };

    sendJSON(res, 200, {
      totalDirectives: directives.length,
      byStatus,
      byType,
      averageDuration,
      successRate,
      todayStats,
      topFailureReasons,
      agentUtilization,
    });
    return;
  }

  // GET /agents — List running agent subprocesses
  if (req.method === "GET" && pathname === "/agents") {
    sendJSON(res, 200, getRunningAgents());
    return;
  }

  // DELETE /agents/:directiveId — Kill a running agent
  const agentDeleteMatch = pathname.match(/^\/agents\/([^/]+)$/);
  if (req.method === "DELETE" && agentDeleteMatch) {
    if (!requireAuth(req, res)) return;
    const directiveId = agentDeleteMatch[1];
    const killed = killAgent(directiveId);
    if (killed) {
      sendJSON(res, 200, { ok: true, message: `Agent for ${directiveId} killed` });
    } else {
      sendJSON(res, 404, { error: `No running agent for ${directiveId}` });
    }
    return;
  }

  // GET /directives/:id — Single directive with full plan text
  const directiveGetMatch = pathname.match(/^\/directives\/([^/]+)$/);
  if (req.method === "GET" && directiveGetMatch) {
    const id = directiveGetMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    sendJSON(res, 200, directive);
    return;
  }

  // GET /directives/:id/log — View agent log file for a directive
  const directiveLogMatch = pathname.match(/^\/directives\/([^/]+)\/log$/);
  if (req.method === "GET" && directiveLogMatch) {
    const id = directiveLogMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      res.writeHead(404, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end("Directive not found");
      return;
    }
    // Path traversal protection: sanitize id and verify resolved path stays within DATA_DIR
    const sanitizedId = path.basename(id);
    const logPath = path.resolve(DATA_DIR, `agent-${sanitizedId}.log`);
    if (!logPath.startsWith(DATA_DIR + path.sep) && logPath !== DATA_DIR) {
      res.writeHead(400, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end("Invalid directive ID");
      return;
    }
    const limit = parseInt(url.searchParams.get("limit")) || 200;
    try {
      await fs.promises.access(logPath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end("Log file not found");
      return;
    }
    try {
      const content = await fs.promises.readFile(logPath, "utf-8");
      const lines = content.split("\n");
      const output = lines.slice(-limit).join("\n");
      res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end(output);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain", ...CORS_HEADERS });
      res.end(`Error reading log: ${err.message}`);
    }
    return;
  }

  // PATCH /directives/:id — Update directive (status, plan, title)
  const directivePatchMatch = pathname.match(/^\/directives\/([^/]+)$/);
  if (req.method === "PATCH" && directivePatchMatch) {
    if (!requireAuth(req, res)) return;
    const id = directivePatchMatch[1];
    const data = await parseBody(req);
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }

    // Apply updates
    const VALID_STATUSES = new Set(["pending", "planning", "planned", "approved", "in_progress", "completed", "failed", "stale", "cancelled", "blocked", "deploy_failed"]);
    const prevStatus = directive.status;
    if (data.status) {
      if (!VALID_STATUSES.has(data.status)) {
        sendJSON(res, 400, { error: `Invalid status: "${data.status}". Valid: ${[...VALID_STATUSES].join(", ")}` });
        return;
      }
      directive.status = data.status;
    }
    if (data.plan !== undefined) directive.plan = data.plan;
    if (data.title) directive.title = data.title;
    if (data.type) directive.type = data.type;
    if (data.failureReason !== undefined) directive.failureReason = data.failureReason;
    if (data.retryCount !== undefined) directive.retryCount = data.retryCount;
    if (data.mergeBranch !== undefined) directive.mergeBranch = data.mergeBranch;
    if (data.priority !== undefined && [1, 2, 3, 4].includes(data.priority)) directive.priority = data.priority;
    directive.updatedAt = Date.now();
    directive.lastActivity = Date.now(); // Track when agent last touched this directive

    // Determine actor: request body can specify, otherwise infer from context
    const patchActor = data.actor || "Cipher";

    // Initialize activity_log if missing (for older directives)
    if (!Array.isArray(directive.activity_log)) directive.activity_log = [];

    // Enforce build verification before marking completed
    if (data.status === "completed" && prevStatus !== "completed") {
      const vr = directive.verification_result;
      const VERIFICATION_VALIDITY_MS = 15 * 60 * 1000; // 15 minutes
      if (!vr || !vr.success || (Date.now() - vr.verified_at) > VERIFICATION_VALIDITY_MS) {
        const reason = !vr ? "no verification run"
          : !vr.success ? `verification failed: ${vr.failure_reason}`
          : "verification expired (older than 15 minutes)";
        directive.activity_log.push({ timestamp: Date.now(), type: "completion_blocked", actor: "system", message: `Completion blocked — ${reason}` });
        saveDirectives(directives, directive, null, "system");
        sendJSON(res, 400, {
          error: `Cannot mark completed without successful build verification. ${reason}. Run POST /directives/${id}/verify first.`,
          verification_required: true,
        });
        // Reset status back since we set it above
        directive.status = prevStatus;
        return;
      }
    }

    // Auto-log status changes
    if (data.status && data.status !== prevStatus) {
      directive.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: patchActor, message: `Status changed from ${prevStatus} to ${data.status}` });
    }

    // Track execution timing
    if (data.status && (data.status === "planning" || data.status === "in_progress") && !directive.startedAt) {
      directive.startedAt = Date.now();
    }
    if (data.status === "completed" && !directive.completedAt) {
      directive.completedAt = Date.now();
      if (directive.startedAt) {
        directive.duration = directive.completedAt - directive.startedAt;
      }
    }

    // Auto-create plan-approval when a feature directive reaches "planned" with a plan
    if (directive.type === "feature" && directive.status === "planned" && directive.plan) {
      const approvalId = `apr_plan_${directive.id}`;
      const approval = {
        id: approvalId,
        tool: "directive_plan",
        description: `Plan for: ${directive.title || directive.description.substring(0, 80)}`,
        risk: "high",
        directiveId: directive.id,
        resolved: false,
        approved: false,
        createdAt: Date.now(),
      };
      const approvals = getApprovals();
      // Remove any existing approvals with the same ID (e.g. expired duplicates)
      const filtered = approvals.filter((a) => a.id !== approvalId);
      filtered.push(approval);
      saveApprovals(filtered, approval);
      directive.directiveApprovalId = approvalId;

      // Proactively notify June so she can tell the user about the plan
      const planSummary = directive.plan.length > 300
        ? directive.plan.substring(0, 300) + "..."
        : directive.plan;
      setTimeout(() => {
        engage("plan ready notification");
        sendNotification(
          `[SYSTEM — Don't read verbatim, tell King Kazuma conversationally.]\n` +
          `The plan for "${directive.title}" is ready. Quick summary:\n${planSummary}\n\n` +
          `Ask if he wants to approve it. If yes, use approve_action with approval ID "${approvalId}" and needs_user_pin: true.`
        );
      }, 500);
    }

    // Notify active persona about other lifecycle transitions
    if (data.status && data.status !== prevStatus) {
      const title = directive.title;
      const notifyPersona = (msg) => setTimeout(() => {
        engage("directive lifecycle notification");
        sendNotification(msg);
      }, 500);

      if (directive.status === "in_progress" && prevStatus === "approved") {
        notifyPersona(
          `[SYSTEM — Brief update, don't read verbatim.]\n` +
          `"${title}" is being built now.`
        );
      } else if (directive.status === "blocked") {
        const reason = data.failureReason || data.blockedReason || "unknown blocker";
        notifyPersona(
          `[SYSTEM — Tell King Kazuma this needs his attention.]\n` +
          `"${title}" hit a blocker and needs your help: ${reason}\n` +
          `The agent couldn't finish this on its own. Ask King Kazuma if he can resolve it, then the directive can be unblocked.`
        );
      } else if (directive.status === "completed" && prevStatus === "in_progress") {
        // Calculate duration from creation to completion
        const durationMs = Date.now() - (directive.createdAt || Date.now());
        const durationMin = Math.round(durationMs / 60000);
        let durationStr;
        if (durationMin < 60) {
          durationStr = `${durationMin} minute${durationMin !== 1 ? "s" : ""}`;
        } else {
          const hrs = Math.floor(durationMin / 60);
          const mins = durationMin % 60;
          durationStr = `${hrs}h ${mins}m`;
        }

        // Parse changed files from plan field if available
        let changedFilesStr = "";
        if (directive.plan) {
          const filePatterns = directive.plan.match(/(?:[\w./-]+\.(?:js|ts|tsx|jsx|py|json|yml|yaml|md|css|html|sh|sql|env))/g);
          if (filePatterns && filePatterns.length > 0) {
            const uniqueFiles = [...new Set(filePatterns)].slice(0, 10);
            changedFilesStr = ` Files touched: ${uniqueFiles.join(", ")}.`;
          }
        }

        notifyPersona(
          `[SYSTEM — Tell King Kazuma casually, don't read verbatim.]\n` +
          `"${title}" is done. Took ${durationStr}.${changedFilesStr} ` +
          `It's deploying now — devices will update automatically.`
        );
      }
    }

    // Broadcast directive status change to all connected WebSocket clients
    if (data.status && data.status !== prevStatus) {
      broadcastToAll({
        type: "directiveUpdate",
        directiveId: directive.id,
        oldStatus: prevStatus,
        newStatus: data.status,
        title: directive.title,
      });
    }

    saveDirectives(directives, directive, prevStatus, patchActor);

    // ── Dependency resolution ──
    // When a directive completes, unblock any pending directives that depended on it
    const unblockedDirectives = [];
    if (directive.status === "completed" && prevStatus !== "completed") {
      const depMap = new Map(directives.map(d => [d.id, d]));
      for (const d of directives) {
        if (d.status !== "pending" || !d.dependsOn || !d.dependsOn.includes(directive.id)) continue;
        // Check if ALL dependencies are now completed
        const allResolved = d.dependsOn.every(depId => {
          const dep = depMap.get(depId);
          return dep && dep.status === "completed";
        });
        if (allResolved) {
          const prevDStatus = d.status;
          d.status = "planning";
          d.updatedAt = Date.now();
          unblockedDirectives.push(d);
          log.bridge.info(`Dependency resolved: ${d.id} "${d.title}" unblocked — all deps completed`);
        }
      }
      if (unblockedDirectives.length > 0) {
        saveDirectives(directives, null, null, "system");
      }
    }

    // ── Agent spawner hooks ──
    // Auto-spawn planning agent when directive enters "planning"
    if (directive.status === "planning" && prevStatus !== "planning") {
      setLastRestartReason(`directive: ${directive.title || directive.id}`);
      routeDirective(directive, "planning");
    }
    // Auto-spawn implementation agent when directive is approved (with a plan or quick type)
    if (directive.status === "approved" && prevStatus !== "approved") {
      routeDirective(directive, "implementation");
    }
    // Spawn planning agents for any newly unblocked directives (higher priority first)
    unblockedDirectives.sort((a, b) => (a.priority || 3) - (b.priority || 3));
    for (const d of unblockedDirectives) {
      routeDirective(d, "planning");
    }

    sendJSON(res, 200, { ok: true, directive, unblocked: unblockedDirectives.length > 0 ? unblockedDirectives.map(d => d.id) : undefined });
    return;
  }

  // POST /directives/:id/comment — Add a manual comment to a directive's activity log
  const directiveCommentMatch = pathname.match(/^\/directives\/([^/]+)\/comment$/);
  if (req.method === "POST" && directiveCommentMatch) {
    if (!requireAuth(req, res)) return;
    const id = directiveCommentMatch[1];
    const data = await parseBody(req);
    if (!data.message || !data.message.trim()) {
      sendJSON(res, 400, { error: "message is required" });
      return;
    }
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
    const entry = { timestamp: Date.now(), type: "comment", actor: "King Kazuma", message: data.message.trim() };
    directive.activity_log.push(entry);
    directive.updatedAt = Date.now();
    saveDirectives(directives, directive, null, "King Kazuma");
    sendJSON(res, 200, { ok: true, entry });
    return;
  }

  // GET /directives/:id/history — Merged audit trail (activity_log + PG directive_history)
  const directiveHistoryMatch = pathname.match(/^\/directives\/([^/]+)\/history$/);
  if (req.method === "GET" && directiveHistoryMatch) {
    const id = directiveHistoryMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    // Merge in-memory activity_log with PG directive_history
    const actLog = Array.isArray(directive.activity_log) ? directive.activity_log : [];
    const timeline = actLog.map(e => ({
      timestamp: e.timestamp,
      type: e.type,
      actor: e.actor || null,
      message: e.message,
      source: "activity_log",
    }));
    // Fetch PG history
    try {
      const pgHistory = await db.getDirectiveHistory(id);
      for (const h of pgHistory) {
        // Avoid duplicating status_change events already in activity_log
        const pgTs = new Date(h.changed_at).getTime();
        const isDuplicate = timeline.some(t =>
          t.type === "status_change" && Math.abs(t.timestamp - pgTs) < 2000 &&
          t.message.includes(h.new_status)
        );
        if (!isDuplicate) {
          timeline.push({
            timestamp: pgTs,
            type: "status_change",
            actor: h.changed_by || null,
            message: `${h.old_status || "new"} → ${h.new_status}${h.notes ? ` (${h.notes})` : ""}`,
            source: "pg_history",
          });
        }
      }
    } catch (err) {
      log.pg.error("getDirectiveHistory failed:", err.message);
    }
    // Sort by timestamp descending (newest first)
    timeline.sort((a, b) => b.timestamp - a.timestamp);
    sendJSON(res, 200, { directive_id: id, createdBy: directive.createdBy || null, timeline });
    return;
  }

  // POST /directives/:id/activity — Append to activity log (used by orchestrator, agents)
  const directiveActivityMatch = pathname.match(/^\/directives\/([^/]+)\/activity$/);
  if (req.method === "POST" && directiveActivityMatch) {
    const id = directiveActivityMatch[1];
    const data = await parseBody(req);
    if (!data.type || !data.message) {
      sendJSON(res, 400, { error: "type and message required" });
      return;
    }
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
    const entry = { timestamp: data.timestamp || Date.now(), type: data.type, actor: data.actor || "Cipher", message: data.message };
    directive.activity_log.push(entry);
    directive.lastActivity = entry.timestamp;
    saveDirectives(directives, directive, null, data.actor || "Cipher");
    sendJSON(res, 200, { ok: true });
    return;
  }

  // POST /directives/:id/verify — Run build verification before marking completed
  const directiveVerifyMatch = pathname.match(/^\/directives\/([^/]+)\/verify$/);
  if (req.method === "POST" && directiveVerifyMatch) {
    const id = directiveVerifyMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }

    if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
    directive.activity_log.push({ timestamp: Date.now(), type: "verification_started", actor: "Cipher", message: "Running build verification" });
    saveDirectives(directives, directive, null, "Cipher");

    try {
      const result = await buildVerifier.verify(directive);

      // Store verification result on directive (in-memory)
      directive.verification_result = {
        verified_at: Date.now(),
        success: result.success,
        verification_log: result.verification_log,
        change_type: result.change_type,
        failure_reason: result.failure_reason || null,
      };

      const logType = result.success ? "verification_success" : "verification_failure";
      const logMsg = result.success
        ? `Build verification passed (${result.change_type}, ${result.duration_ms}ms)`
        : `Build verification failed: ${result.failure_reason} (${result.duration_ms}ms)`;
      directive.activity_log.push({ timestamp: Date.now(), type: logType, actor: "system", message: logMsg });
      saveDirectives(directives, directive, null, "system");

      sendJSON(res, 200, {
        success: result.success,
        verification_log: result.verification_log,
        can_complete: result.success,
        failure_reason: result.failure_reason || null,
        change_type: result.change_type,
        duration_ms: result.duration_ms,
      });
    } catch (err) {
      log.directive.error(`Verification error for ${id}: ${err.message}`);
      directive.activity_log.push({ timestamp: Date.now(), type: "verification_failure", actor: "system", message: `Verification error: ${err.message}` });
      saveDirectives(directives, directive, null, "system");
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // POST /directives/:id/unblock — Force-skip dependency check (manual override)
  const directiveUnblockMatch = pathname.match(/^\/directives\/([^/]+)\/unblock$/);
  if (req.method === "POST" && directiveUnblockMatch) {
    if (!requireAuth(req, res)) return;
    const id = directiveUnblockMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    if (directive.status === "blocked") {
      // Unblock a blocked directive — retry implementation
      const prevStatus = directive.status;
      log.bridge.info(`Unblock: ${directive.id} "${directive.title}" — was blocked: ${directive.failureReason || "unknown"}`);
      directive.status = "approved";
      directive.failureReason = null;
      directive.updatedAt = Date.now();
      if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
      directive.activity_log.push({ timestamp: Date.now(), type: "unblocked", actor: "King Kazuma", message: `Unblocked by King Kazuma — retrying implementation` });
      saveDirectives(directives, directive, prevStatus, "King Kazuma");
      routeDirective(directive, "implementation");
      sendJSON(res, 200, { ok: true, directive, message: "Directive unblocked and moved to approved for retry" });
      return;
    }
    if (directive.status !== "pending") {
      sendJSON(res, 400, { error: `Directive is "${directive.status}", not pending or blocked — nothing to unblock` });
      return;
    }
    if (!directive.dependsOn) {
      sendJSON(res, 400, { error: "Directive has no dependencies — nothing to unblock" });
      return;
    }
    // Clear dependencies and transition to planning
    log.bridge.info(`Manual unblock: ${directive.id} "${directive.title}" — skipping deps: ${directive.dependsOn.join(", ")}`);
    directive.dependsOn = null;
    directive.status = "planning";
    directive.updatedAt = Date.now();
    saveDirectives(directives, directive, "pending", "King Kazuma");
    routeDirective(directive, "planning");
    sendJSON(res, 200, { ok: true, directive, message: "Directive unblocked and moved to planning" });
    return;
  }

  // POST /directives/:id/cancel — Cancel a directive (kills agent if running)
  const directiveCancelMatch = pathname.match(/^\/directives\/([^/]+)\/cancel$/);
  if (req.method === "POST" && directiveCancelMatch) {
    if (!requireAuth(req, res)) return;
    const id = directiveCancelMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    const terminalStatuses = ["completed", "failed", "cancelled"];
    if (terminalStatuses.includes(directive.status)) {
      sendJSON(res, 409, { error: `Directive is already "${directive.status}" — cannot cancel` });
      return;
    }
    // Kill agent if one is running for this directive
    const agentKilled = killAgent(id);
    // Clean up branch/worktree if no agent was running (exit handler won't fire)
    if (!agentKilled) {
      const agentSpawner = require("./agent-spawner");
      const branch = directive.mergeBranch || `agent/${id}`;
      agentSpawner.cleanupWorktree(id, branch);
    }
    const prevStatus = directive.status;
    directive.status = "cancelled";
    directive.updatedAt = Date.now();
    if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
    directive.activity_log.push({ timestamp: Date.now(), type: "cancelled", actor: "King Kazuma", message: `Cancelled from dashboard (was ${prevStatus})` });
    saveDirectives(directives, directive, prevStatus, "King Kazuma");
    log.bridge.info(`Directive cancelled: ${id} "${directive.title}" (was ${prevStatus}, agent killed: ${agentKilled})`);
    sendJSON(res, 200, { ok: true, directive, agentKilled });
    return;
  }

  // POST /directives/:id/retry — Retry a failed/stale/cancelled directive
  const directiveRetryMatch = pathname.match(/^\/directives\/([^/]+)\/retry$/);
  if (req.method === "POST" && directiveRetryMatch) {
    if (!requireAuth(req, res)) return;
    const id = directiveRetryMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    const activeStatuses = ["planning", "in_progress", "approved"];
    if (activeStatuses.includes(directive.status)) {
      sendJSON(res, 409, { error: `Directive is "${directive.status}" — already active, cannot retry` });
      return;
    }
    const retryableStatuses = ["failed", "stale", "cancelled", "deploy_failed"];
    if (!retryableStatuses.includes(directive.status)) {
      sendJSON(res, 409, { error: `Directive is "${directive.status}" — cannot retry from this state` });
      return;
    }
    const prevStatus = directive.status;
    directive.status = "approved";
    directive.retryCount = (directive.retryCount || 0) + 1;
    directive.failureReason = null;
    directive.updatedAt = Date.now();
    if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
    directive.activity_log.push({ timestamp: Date.now(), type: "retry", actor: "King Kazuma", message: `Retried from dashboard (was ${prevStatus}, retry #${directive.retryCount})` });
    saveDirectives(directives, directive, prevStatus, "King Kazuma");
    log.bridge.info(`Directive retried: ${id} "${directive.title}" (${prevStatus} → approved, retry #${directive.retryCount})`);
    sendJSON(res, 200, { ok: true, directive });
    return;
  }

  // POST /directives/:id/escalate — Escalate a failing directive to Cipher for direct takeover
  const directiveEscalateMatch = pathname.match(/^\/directives\/([^/]+)\/escalate$/);
  if (req.method === "POST" && directiveEscalateMatch) {
    const id = directiveEscalateMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    const escalatableStatuses = ["failed", "stale", "blocked", "deploy_failed"];
    if (!escalatableStatuses.includes(directive.status)) {
      sendJSON(res, 409, { error: `Directive is "${directive.status}" — can only escalate from: ${escalatableStatuses.join(", ")}` });
      return;
    }
    const body = await readBody(req);
    const { escalatedBy, reason } = body || {};
    const prevStatus = directive.status;

    // Preserve current failure into workerAttempts history
    if (!Array.isArray(directive.workerAttempts)) directive.workerAttempts = [];
    if (directive.failureReason) {
      directive.workerAttempts.push({
        attempt: directive.workerAttempts.length + 1,
        failureReason: directive.failureReason,
        timestamp: directive.updatedAt || Date.now(),
      });
    }

    // Set escalation fields
    directive.escalatedAt = Date.now();
    directive.escalatedBy = escalatedBy || "King Kazuma";
    directive.escalationReason = reason || `escalated from ${prevStatus} (${directive.workerAttempts.length} worker attempt(s))`;

    // Transition to in_progress, clear failure
    directive.status = "in_progress";
    directive.failureReason = null;
    directive.updatedAt = Date.now();

    // Activity log
    if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
    directive.activity_log.push({
      timestamp: Date.now(),
      type: "escalation",
      actor: directive.escalatedBy,
      message: `Escalated to Cipher: ${directive.escalationReason} (was ${prevStatus}, ${directive.workerAttempts.length} worker attempt(s))`,
    });

    saveDirectives(directives, directive, prevStatus, directive.escalatedBy);
    log.bridge.info(`Directive escalated: ${id} "${directive.title}" (${prevStatus} → in_progress, by ${directive.escalatedBy})`);
    sendJSON(res, 200, { ok: true, directive, workerHistory: directive.workerAttempts });
    return;
  }

  // POST /directives/:id/retry-merge — Re-attempt merge for deploy_failed directives
  const retryMergeMatch = pathname.match(/^\/directives\/([^/]+)\/retry-merge$/);
  if (req.method === "POST" && retryMergeMatch) {
    const id = retryMergeMatch[1];
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    if (directive.status !== "deploy_failed") {
      sendJSON(res, 409, { error: `Directive is "${directive.status}" — retry-merge only works for deploy_failed` });
      return;
    }
    const branch = directive.mergeBranch;
    if (!branch) {
      sendJSON(res, 400, { error: "No mergeBranch recorded — cannot retry merge" });
      return;
    }
    try {
      const agentSpawner = require("./agent-spawner");
      const mergeOk = agentSpawner.mergeWorktreeToMain(id, branch);
      if (mergeOk) {
        const prevStatus = directive.status;
        directive.status = "completed";
        directive.completedAt = Date.now();
        if (directive.startedAt) directive.duration = directive.completedAt - directive.startedAt;
        directive.failureReason = null;
        directive.updatedAt = Date.now();
        if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
        directive.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "King Kazuma", message: `Merge retried successfully from dashboard (branch ${branch})` });
        saveDirectives(directives, directive, prevStatus, "King Kazuma");
        agentSpawner.cleanupWorktree(id, branch);
        agentSpawner.smartDeploy(directive);
        log.bridge.info(`Merge retry succeeded for ${id} — branch cleaned up, deploying`);
        sendJSON(res, 200, { ok: true, message: "Merge succeeded, branch cleaned up, deploying now" });
      } else {
        directive.updatedAt = Date.now();
        directive.failureReason = `Merge retry failed for branch ${branch}`;
        if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
        directive.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "King Kazuma", message: `Merge retry failed again (branch ${branch})` });
        saveDirectives(directives, directive, directive.status, "King Kazuma");
        sendJSON(res, 500, { ok: false, error: "Merge failed again — branch preserved for manual resolution" });
      }
    } catch (err) {
      log.bridge.error(`Merge retry error for ${id}: ${err.message}`);
      sendJSON(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /approvals/details — Pending approvals enriched with directive info
  if (req.method === "GET" && pathname === "/approvals/details") {
    const approvals = expireApprovals(getApprovals());
    const pending = approvals.filter((a) => !a.resolved);
    const directives = getDirectives();
    const enriched = pending.map((a) => {
      const directive = directives.find((d) => d.directiveApprovalId === a.id);
      return {
        ...a,
        directiveTitle: directive ? directive.title : null,
        directivePlan: directive ? directive.plan : null,
        directiveDescription: directive ? directive.description : null,
        directiveId: directive ? directive.id : null,
      };
    });
    sendJSON(res, 200, enriched);
    return;
  }

  // GET /uploads — List persisted uploads
  if (req.method === "GET" && pathname === "/uploads") {
    try {
      const uploadsDir = "/tmp/ozzu-bridge/uploads";
      const files = require("fs").readdirSync(uploadsDir).filter(f => f.endsWith(".meta.json")).sort().reverse();
      const limit = parseInt(new URL(req.url, "http://localhost").searchParams.get("limit") || "50");
      const metas = files.slice(0, limit).map(f => {
        try { return JSON.parse(require("fs").readFileSync(`${uploadsDir}/${f}`, "utf8")); } catch { return null; }
      }).filter(Boolean);
      sendJSON(res, 200, metas);
    } catch {
      sendJSON(res, 200, []);
    }
    return;
  }

  // DELETE /directives/:id — Permanently remove a directive (only terminal statuses)
  const directiveDeleteMatch = pathname.match(/^\/directives\/([^/]+)$/);
  if (req.method === "DELETE" && directiveDeleteMatch) {
    if (!requireAuth(req, res)) return;
    const id = directiveDeleteMatch[1];
    const directives = getDirectives();
    const idx = directives.findIndex((d) => d.id === id);
    if (idx === -1) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }
    const directive = directives[idx];
    const terminalStatuses = ["completed", "failed", "cancelled"];
    if (!terminalStatuses.includes(directive.status)) {
      sendJSON(res, 409, { error: `Directive is "${directive.status}" — cancel it first before deleting` });
      return;
    }
    // Clean up any lingering branch/worktree for this directive
    const agentSpawner = require("./agent-spawner");
    const branch = directive.mergeBranch || `agent/${id}`;
    agentSpawner.cleanupWorktree(id, branch);

    directives.splice(idx, 1);
    saveDirectives(directives, null, null);
    log.bridge.info(`Directive deleted: ${id} "${directive.title}" (branch cleanup attempted for ${branch})`);
    sendJSON(res, 200, { ok: true, message: `Directive ${id} deleted` });
    return;
  }

  // POST /directives/bulk — Perform the same action on multiple directives
  if (req.method === "POST" && pathname === "/directives/bulk") {
    if (!requireAuth(req, res)) return;
    const data = await parseBody(req);
    const validActions = ["cancel", "retry", "delete"];
    if (!data.action || !validActions.includes(data.action)) {
      sendJSON(res, 400, { error: "action must be one of: cancel, retry, delete" });
      return;
    }
    if (!Array.isArray(data.ids) || data.ids.length === 0) {
      sendJSON(res, 400, { error: "ids must be a non-empty array of directive IDs" });
      return;
    }
    const directives = getDirectives();
    const succeeded = [];
    const failed = [];
    const deletePending = [];

    for (const id of data.ids) {
      const directive = directives.find((d) => d.id === id);
      if (!directive) {
        failed.push({ id, error: "Directive not found" });
        continue;
      }

      if (data.action === "cancel") {
        const terminalStatuses = ["completed", "failed", "cancelled"];
        if (terminalStatuses.includes(directive.status)) {
          failed.push({ id, error: `Directive is already "${directive.status}" — cannot cancel` });
          continue;
        }
        const agentKilled = killAgent(id);
        // Clean up branch/worktree if no agent was running (exit handler won't fire)
        if (!agentKilled) {
          const agentSpawner = require("./agent-spawner");
          const branch = directive.mergeBranch || `agent/${id}`;
          agentSpawner.cleanupWorktree(id, branch);
        }
        const prevStatus = directive.status;
        directive.status = "cancelled";
        directive.updatedAt = Date.now();
        if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
        directive.activity_log.push({ timestamp: Date.now(), type: "cancelled", actor: "King Kazuma", message: `Bulk cancelled from dashboard (was ${prevStatus})` });
        saveDirectives(directives, directive, prevStatus, "King Kazuma");
        log.bridge.info(`Bulk cancel: ${id} "${directive.title}" (was ${prevStatus}, agent killed: ${agentKilled})`);
        succeeded.push(id);
      } else if (data.action === "retry") {
        const activeStatuses = ["planning", "in_progress", "approved"];
        if (activeStatuses.includes(directive.status)) {
          failed.push({ id, error: `Directive is "${directive.status}" — already active, cannot retry` });
          continue;
        }
        const retryableStatuses = ["failed", "stale", "cancelled"];
        if (!retryableStatuses.includes(directive.status)) {
          failed.push({ id, error: `Directive is "${directive.status}" — cannot retry from this state` });
          continue;
        }
        const prevStatus = directive.status;
        directive.status = "approved";
        directive.retryCount = (directive.retryCount || 0) + 1;
        directive.failureReason = null;
        directive.updatedAt = Date.now();
        if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
        directive.activity_log.push({ timestamp: Date.now(), type: "retry", actor: "King Kazuma", message: `Bulk retried from dashboard (was ${prevStatus}, retry #${directive.retryCount})` });
        saveDirectives(directives, directive, prevStatus, "King Kazuma");
        log.bridge.info(`Bulk retry: ${id} "${directive.title}" (${prevStatus} → approved, retry #${directive.retryCount})`);
        succeeded.push(id);
      } else if (data.action === "delete") {
        const terminalStatuses = ["completed", "failed", "cancelled"];
        if (!terminalStatuses.includes(directive.status)) {
          failed.push({ id, error: `Directive is "${directive.status}" — cancel it first before deleting` });
          continue;
        }
        deletePending.push(id);
        log.bridge.info(`Bulk delete: ${id} "${directive.title}"`);
        succeeded.push(id);
      }
    }

    // Batch-apply deletes in a single pass (avoids index shifting and redundant saves)
    if (deletePending.length > 0) {
      const deleteSet = new Set(deletePending);
      // Clean up branches for deleted directives before removing them
      const agentSpawner = require("./agent-spawner");
      for (const d of directives) {
        if (deleteSet.has(d.id)) {
          const branch = d.mergeBranch || `agent/${d.id}`;
          agentSpawner.cleanupWorktree(d.id, branch);
        }
      }
      const filtered = directives.filter(d => !deleteSet.has(d.id));
      directives.length = 0;
      directives.push(...filtered);
      saveDirectives(directives, null, null);
    }

    log.bridge.info(`Bulk ${data.action}: ${succeeded.length} succeeded, ${failed.length} failed`);
    sendJSON(res, 200, { ok: true, action: data.action, succeeded, failed });
    return;
  }

  // ── OTA Update endpoints ──

  // GET /api/manifest — Expo Updates protocol v1
  if (req.method === "GET" && pathname === "/api/manifest") {
    const platform = req.headers["expo-platform"] || "android";
    const runtimeVersion = req.headers["expo-runtime-version"] || "1.0.0";
    const currentUpdateId = req.headers["expo-current-update-id"];

    const updateDir = path.join(UPDATES_DIR, runtimeVersion);
    const metadataPath = path.join(updateDir, "metadata.json");

    let metadataExists = true;
    try { await fs.promises.access(metadataPath); } catch { metadataExists = false; }
    if (!metadataExists) {
      // No update available — return directive
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        ...CORS_HEADERS,
      });
      res.end(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="directive"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `{"type":"noUpdateAvailable"}\r\n` +
        `--${boundary}--\r\n`
      );
      return;
    }

    let metadata, metaRaw;
    try {
      metaRaw = await fs.promises.readFile(metadataPath, "utf8");
      metadata = JSON.parse(metaRaw);
    } catch (err) {
      log.bridge.error(`OTA metadata parse failed: ${err.message}`);
      sendJSON(res, 500, { error: "Corrupt OTA metadata" });
      return;
    }
    const platformMeta = metadata.fileMetadata?.[platform];
    if (!platformMeta) {
      sendJSON(res, 404, { error: `No ${platform} update found` });
      return;
    }

    // Compute update ID from metadata (reuse already-read buffer)
    const metaHash = crypto.createHash("sha256").update(metaRaw).digest("hex");
    const updateId = `${metaHash.slice(0,8)}-${metaHash.slice(8,12)}-${metaHash.slice(12,16)}-${metaHash.slice(16,20)}-${metaHash.slice(20,32)}`;

    // If client already has this update, return no-update
    if (currentUpdateId === updateId) {
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        ...CORS_HEADERS,
      });
      res.end(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="directive"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `{"type":"noUpdateAvailable"}\r\n` +
        `--${boundary}--\r\n`
      );
      return;
    }

    // Build launch asset info (async to avoid blocking event loop)
    const bundlePath = path.join(updateDir, platformMeta.bundle);
    const bundleData = await fs.promises.readFile(bundlePath);
    const bundleHash = crypto.createHash("sha256").update(bundleData).digest("base64url");
    const bundleKey = crypto.createHash("md5").update(bundleData).digest("hex");

    const baseUrl = `http://10.8.0.1:${PORT}/api/assets?runtimeVersion=${runtimeVersion}&platform=${platform}`;

    const launchAsset = {
      hash: bundleHash,
      key: bundleKey,
      fileExtension: ".bundle",
      contentType: "application/javascript",
      url: `${baseUrl}&asset=${encodeURIComponent(platformMeta.bundle)}`,
    };

    // Build assets list (async — parallel reads)
    const assets = await Promise.all((platformMeta.assets || []).map(async (a) => {
      const assetPath = path.join(updateDir, a.path);
      const assetData = await fs.promises.readFile(assetPath);
      return {
        hash: crypto.createHash("sha256").update(assetData).digest("base64url"),
        key: crypto.createHash("md5").update(assetData).digest("hex"),
        fileExtension: `.${a.ext}`,
        contentType: a.ext === "png" ? "image/png" : a.ext === "jpg" ? "image/jpeg" : "application/octet-stream",
        url: `${baseUrl}&asset=${encodeURIComponent(a.path)}`,
      };
    }));

    // Load expoConfig if available
    const expoConfigPath = path.join(updateDir, "expoConfig.json");
    let expoClient = {};
    try { expoClient = JSON.parse(await fs.promises.readFile(expoConfigPath, "utf8")); } catch {}

    const stat = await fs.promises.stat(metadataPath);
    const createdAt = stat.mtime.toISOString();

    const manifest = {
      id: updateId,
      createdAt,
      runtimeVersion,
      launchAsset,
      assets,
      metadata: {},
      extra: { expoClient },
    };

    const boundary = "ota-boundary";
    const manifestJson = JSON.stringify(manifest);
    const extensionsJson = JSON.stringify({ assetRequestHeaders: {} });

    res.writeHead(200, {
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "cache-control": "private, max-age=0",
      "content-type": `multipart/mixed; boundary=${boundary}`,
      ...CORS_HEADERS,
    });
    res.end(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="manifest"\r\n` +
      `Content-Type: application/json; charset=utf-8\r\n\r\n` +
      `${manifestJson}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="extensions"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${extensionsJson}\r\n` +
      `--${boundary}--\r\n`
    );
    return;
  }

  // GET /api/assets — Serve update assets
  if (req.method === "GET" && pathname === "/api/assets") {
    const runtimeVersion = url.searchParams.get("runtimeVersion") || "1.0.0";
    const assetPath = url.searchParams.get("asset");
    if (!assetPath) {
      sendJSON(res, 400, { error: "Missing asset parameter" });
      return;
    }

    const allowedBase = path.resolve(UPDATES_DIR, runtimeVersion);
    const filePath = path.resolve(UPDATES_DIR, runtimeVersion, assetPath);
    // Prevent directory traversal — resolved path must be within allowed base
    if (!filePath.startsWith(allowedBase + path.sep) && filePath !== allowedBase) {
      sendJSON(res, 403, { error: "Forbidden" });
      return;
    }

    try { await fs.promises.access(filePath); } catch {
      sendJSON(res, 404, { error: "Asset not found" });
      return;
    }

    const ext = path.extname(assetPath).toLowerCase();
    const contentTypes = {
      ".hbc": "application/javascript",
      ".bundle": "application/javascript",
      ".js": "application/javascript",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".gif": "image/gif",
    };

    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      ...CORS_HEADERS,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Health check
  if (req.method === "GET" && pathname === "/") {
    const pgHealth = await db.healthCheck();
    sendJSON(res, 200, {
      service: "ozzu-bridge",
      uptime: process.uptime(),
      redis: _redisConnected,
      postgres: pgHealth,
      gemini: !!geminiReady,
      devices: devices.size,
      persona: currentPersona,
    });
    return;
  }

  // GET /dashboard — HTML pipeline overview for browser
  if (req.method === "GET" && pathname === "/dashboard") {
    const directives = getDirectives();
    const agents = getRunningAgents();
    const pgHealth = await db.healthCheck();
    let redisHealthy = false;
    try { if (_redisConnected) { await redis.ping(); redisHealthy = true; } } catch { redisHealthy = false; }
    const uptime = process.uptime();
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;

    const statusColors = {
      pending: "#6b7280", planning: "#8b5cf6", planned: "#3b82f6",
      approved: "#06b6d4", in_progress: "#f59e0b", completed: "#10b981", blocked: "#ef4444",
      failed: "#ef4444", stale: "#f97316", cancelled: "#78716c", deploy_failed: "#dc2626",
    };

    const agentRows = agents.map(a => {
      const runtime = Math.floor((Date.now() - new Date(a.startedAt).getTime()) / 1000);
      const rtStr = `${Math.floor(runtime / 60)}m ${runtime % 60}s`;
      return `<tr><td>${escapeHtml(a.directiveId)}</td><td>${escapeHtml(a.type)}</td><td>${a.pid}</td><td>${rtStr}</td></tr>`;
    }).join("");

    const priorityLabels = { 1: "critical", 2: "high", 3: "normal", 4: "low" };
    const priorityColors = { 1: "#ef4444", 2: "#f97316", 3: "#6b7280", 4: "#9ca3af" };

    function formatDuration(ms) {
      if (!ms && ms !== 0) return "-";
      const totalSec = Math.floor(ms / 1000);
      if (totalSec < 60) return `${totalSec}s`;
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      if (mins < 60) return `${mins}m ${secs}s`;
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      return `${hrs}h ${remMins}m`;
    }

    // Summary stats
    const completedDirectives = directives.filter(d => d.status === "completed");
    const failedDirectives = directives.filter(d => d.status === "failed" || d.status === "deploy_failed");
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const completedToday = completedDirectives.filter(d => d.completedAt && d.completedAt >= todayStart.getTime()).length;
    const completedWithDuration = completedDirectives.filter(d => d.duration);
    const avgDuration = completedWithDuration.length > 0
      ? Math.round(completedWithDuration.reduce((sum, d) => sum + d.duration, 0) / completedWithDuration.length)
      : null;
    const totalFinished = completedDirectives.length + failedDirectives.length;
    const successRate = totalFinished > 0 ? Math.round((completedDirectives.length / totalFinished) * 100) : null;

    // Pending approvals for banner
    const pendingApprovals = expireApprovals(getApprovals()).filter(a => !a.resolved);
    const plannedDirectives = directives.filter(d => d.status === "planned");
    const approvalBannerItems = pendingApprovals.map(a => {
      const directive = directives.find(d => d.directiveApprovalId === a.id);
      return { approval: a, directive };
    }).filter(item => item.directive);

    // Needs-action directives: planned, blocked, deploy_failed
    const needsActionStatuses = ["planned", "blocked", "deploy_failed"];
    const needsActionCount = directives.filter(d => needsActionStatuses.includes(d.status)).length;

    // Build pipeline violations section (only shown when unresolved violations exist)
    const unresolvedViolations = _pipelineViolations.filter(v => !v.resolved);
    const violationsHtml = unresolvedViolations.length > 0 ? unresolvedViolations.slice(-10).reverse().map(v => {
      const typeClass = escapeHtml(v.violationType || "unknown");
      const hashStr = v.commitHash ? v.commitHash.slice(0, 8) : "-";
      return `<div class="violation-item">
        <div class="violation-info">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="violation-type ${typeClass}">${escapeHtml((v.violationType || "unknown").replace(/_/g, " "))}</span>
            <code style="color:#64748b;font-size:11px;">${escapeHtml(hashStr)}</code>
            <span style="font-size:11px;color:#94a3b8;">${escapeHtml(v.author || "unknown")}</span>
          </div>
          <div class="violation-msg">${escapeHtml(v.message || "")}</div>
          <div class="violation-meta"><span data-ts="${v.timestamp}">${escapeHtml(String(v.timestamp))}</span></div>
        </div>
        <button class="btn-resolve" onclick="resolveViolation(${v.id})">Resolve</button>
      </div>`;
    }).join("") : "";

    // Build directive lookup map
    const directiveMap = new Map(directives.map(d => [d.id, d]));

    // Build directive cards (newest first)
    const directiveCards = [...directives].reverse().map(d => {
      const color = statusColors[d.status] || "#6b7280";
      const pri = d.priority || 3;
      const priLabel = priorityLabels[pri] || "normal";
      const priColor = priorityColors[pri] || "#6b7280";
      const createdByBadge = d.createdBy ? `<span class="actor-badge actor-${(d.createdBy || "").toLowerCase().replace(/\s/g, "-")}">${escapeHtml(d.createdBy)}</span>` : "";

      // Latest activity message
      const actLog = Array.isArray(d.activity_log) ? d.activity_log : [];
      const lastEntry = actLog.length > 0 ? actLog[actLog.length - 1] : null;
      const lastActivityHtml = lastEntry
        ? `<div class="card-activity">${escapeHtml(lastEntry.message)}</div>`
        : "";

      // Inline audit trail for active directives (last 5 entries)
      const isActive = !["completed", "cancelled"].includes(d.status);
      let inlineAuditHtml = "";
      if (isActive && actLog.length > 0) {
        const recentEntries = actLog.slice(-5).reverse();
        const entriesHtml = recentEntries.map(e => {
          const actorClass = ({ "King Kazuma": "king-kazuma", "June": "june", "Cipher": "cipher" })[e.actor] || "system";
          const actorBadge = e.actor ? `<span class="actor-badge actor-${actorClass}">${escapeHtml(e.actor)}</span>` : "";
          return `<div class="inline-trail-entry"><span class="trail-time" data-ts="${e.timestamp}">${escapeHtml(String(e.timestamp))}</span>${actorBadge}<span class="trail-msg">${escapeHtml(e.message)}</span></div>`;
        }).join("");
        const showAllBtn = actLog.length > 5 ? `<div class="trail-show-all"><a href="#" onclick="toggleActivityLog('${escapeHtml(escapeJsString(d.id))}');return false;">Show all ${actLog.length} entries</a></div>` : "";
        inlineAuditHtml = `<div class="inline-audit-trail">${entriesHtml}${showAllBtn}</div>`;
      }

      // Dependencies
      let depsHtml = "";
      if (d.dependsOn && d.dependsOn.length > 0) {
        depsHtml = `<div class="card-deps">${d.dependsOn.map(depId => {
          const dep = directiveMap.get(depId);
          const depColor = dep ? (dep.status === "completed" ? "#10b981" : "#f59e0b") : "#6b7280";
          const checkmark = dep && dep.status === "completed" ? "&#10003;" : "&#9679;";
          return `<span style="color:${depColor};font-size:11px;" title="${escapeHtml(depId)}">${checkmark} ${escapeHtml(dep ? (dep.title || depId) : depId)}</span>`;
        }).join(" ")}</div>`;
      }

      // Contextual action buttons
      let actionsHtml = "";
      const eid = escapeHtml(escapeJsString(d.id));
      if (d.status === "planned") {
        actionsHtml = `<button class="card-btn btn-approve" onclick="openApprovalModal('${eid}')">Approve</button>
          <button class="card-btn btn-deny" onclick="denyDirective('${eid}')">Deny</button>`;
      } else if (d.status === "deploy_failed") {
        actionsHtml = `<button class="card-btn btn-retry-merge" onclick="retryMerge('${eid}')">Retry Merge</button>
          <button class="card-btn btn-retry" onclick="retryDirective('${eid}')">Retry Full</button>
          <button class="card-btn btn-escalate" onclick="escalateDirective('${eid}')">Escalate to Cipher</button>`;
      } else if (d.status === "blocked") {
        actionsHtml = `<button class="card-btn btn-unblock" onclick="unblockDirective('${eid}')">Unblock</button>
          <button class="card-btn btn-escalate" onclick="escalateDirective('${eid}')">Escalate to Cipher</button>
          <button class="card-btn btn-cancel" onclick="cancelDirective('${eid}')">Cancel</button>`;
      } else if (["failed", "stale"].includes(d.status)) {
        actionsHtml = `<button class="card-btn btn-retry" onclick="retryDirective('${eid}')">Retry</button>
          <button class="card-btn btn-escalate" onclick="escalateDirective('${eid}')">Escalate to Cipher</button>`;
      } else if (d.status === "cancelled") {
        actionsHtml = `<button class="card-btn btn-retry" onclick="retryDirective('${eid}')">Retry</button>`;
      } else if (!["completed"].includes(d.status)) {
        actionsHtml = `<button class="card-btn btn-cancel" onclick="cancelDirective('${eid}')">Cancel</button>`;
      }
      actionsHtml += ` <button class="card-btn btn-comment" onclick="toggleCommentInput('${eid}')">Comment</button>`;
      actionsHtml += ` <button class="card-btn btn-log" onclick="toggleActivityLog('${eid}')">Log</button>`;

      return `<div class="directive-card" data-status="${escapeHtml(d.status)}" data-title="${escapeHtml((d.title || d.id).toLowerCase())}" data-id="${escapeHtml(d.id)}" style="border-left:4px solid ${color};">
        <div class="card-header">
          <div class="card-header-left">
            <span class="status-badge" style="background:${color};">${escapeHtml(d.status.replace("_", " "))}</span>
            ${d.escalatedAt ? '<span class="status-badge escalated-badge" style="background:#dc2626;">ESCALATED</span>' : ""}
            <span class="card-title">${escapeHtml(d.title || d.id)}</span>
            ${createdByBadge}
          </div>
          <div class="card-header-right">
            <span class="card-meta" style="color:${priColor};font-weight:${pri <= 2 ? "bold" : "normal"};">${priLabel}</span>
            <span class="card-meta">${escapeHtml(d.type || "-")}</span>
            <span class="card-meta card-time" data-ts="${d.createdAt}">${escapeHtml(String(d.createdAt))}</span>
            ${d.duration ? `<span class="card-meta">${formatDuration(d.duration)}</span>` : ""}
          </div>
        </div>
        ${d.failureReason ? `<div class="card-failure">${escapeHtml(d.failureReason)}</div>` : ""}
        ${lastActivityHtml}
        ${depsHtml}
        ${inlineAuditHtml}
        <div class="card-actions">${actionsHtml}</div>
        <div class="card-comment-input" id="comment-wrap-${escapeHtml(d.id)}" style="display:none;">
          <input type="text" id="comment-input-${escapeHtml(d.id)}" placeholder="Add a comment..." onkeydown="if(event.key==='Enter'){addComment('${eid}');}">
          <button onclick="addComment('${eid}')">Add</button>
        </div>
        <div class="card-full-log" id="log-${escapeHtml(d.id)}" style="display:none;">
          <div id="timeline-${escapeHtml(d.id)}" class="full-timeline"><span style="color:#475569;font-style:italic;">Loading...</span></div>
        </div>
      </div>`;
    }).join("");

    // ── Execution Timeline (last 24h) ──
    const now24 = Date.now();
    const h24ago = now24 - 24 * 60 * 60 * 1000;
    const timelineDirectives = directives.filter(d => d.startedAt && d.startedAt >= h24ago);
    const tlBarColors = { completed: "#10b981", failed: "#ef4444", in_progress: "#3b82f6", stale: "#f59e0b", deploy_failed: "#dc2626" };
    const timelineBars = timelineDirectives.map(d => {
      const endTs = d.completedAt || now24;
      const leftPct = Math.max(0, ((d.startedAt - h24ago) / (now24 - h24ago)) * 100);
      const widthPct = Math.max(0.3, ((endTs - d.startedAt) / (now24 - h24ago)) * 100);
      const color = tlBarColors[d.status] || "#6b7280";
      const label = escapeHtml(d.title || d.id);
      const startTime = new Date(d.startedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
      const endTime = d.completedAt ? new Date(d.completedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) : "ongoing";
      return `<div style="display:flex;align-items:center;height:28px;gap:8px;">
        <div style="width:180px;flex-shrink:0;font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${label}">${label}</div>
        <div style="flex:1;position:relative;height:20px;background:#1e293b;border-radius:3px;">
          <div style="position:absolute;left:${leftPct}%;width:${widthPct}%;top:2px;height:16px;background:${color};border-radius:3px;min-width:3px;" title="${label}\n${startTime} — ${endTime}\nStatus: ${escapeHtml(d.status)}"></div>
        </div>
      </div>`;
    }).join("");

    const tlHourMarkers = [];
    for (let h = 0; h < 24; h++) {
      const markerTs = h24ago + h * 60 * 60 * 1000;
      const pct = (h / 24) * 100;
      const hLabel = new Date(markerTs).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
      tlHourMarkers.push(`<span style="position:absolute;left:${pct}%;transform:translateX(-50%);font-size:10px;color:#475569;white-space:nowrap;">${hLabel}</span>`);
    }
    const tlHourMarkersHtml = tlHourMarkers.join("");

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ozzu Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; color: #e2e8f0; font-family: "SF Mono", "Fira Code", monospace; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 13px; margin-bottom: 8px; }
  .refresh-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .refresh-bar .countdown { color: #64748b; font-size: 12px; }
  .refresh-btn { background: #334155; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 6px 14px; font-size: 12px; font-family: inherit; cursor: pointer; transition: background 0.2s; }
  .refresh-btn:hover { background: #475569; }
  .refresh-btn:active { background: #1e293b; }
  .stat-cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px 20px; min-width: 140px; }
  .stat-card .label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
  .stat-card .value { font-size: 24px; font-weight: bold; margin-top: 4px; }
  .stat-card .value.ok { color: #10b981; }
  .stat-card .value.warn { color: #f59e0b; }
  .stat-card .value.bad { color: #ef4444; }
  section { margin-bottom: 28px; }
  h2 { font-size: 16px; margin-bottom: 10px; border-bottom: 1px solid #334155; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #1e293b; }
  th { color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
  tr:hover { background: #1e293b; }
  .empty { color: #475569; font-style: italic; padding: 12px; }
  .updating { opacity: 0.6; transition: opacity 0.15s; }

  /* Approval banner */
  .approval-banner { background: linear-gradient(135deg, #1e3a5f 0%, #1e293b 100%); border: 1px solid #3b82f6; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; }
  .approval-banner h3 { color: #60a5fa; font-size: 14px; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .approval-item { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .approval-item:last-child { margin-bottom: 0; }
  .approval-info { flex: 1; }
  .approval-title { font-size: 14px; font-weight: 600; color: #e2e8f0; }
  .approval-desc { font-size: 12px; color: #94a3b8; margin-top: 4px; max-width: 600px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .approval-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .approval-actions button { padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px; font-family: inherit; cursor: pointer; font-weight: 600; }
  .approval-actions .btn-approve-banner { background: #10b981; color: #fff; }
  .approval-actions .btn-approve-banner:hover { background: #059669; }
  .approval-actions .btn-deny-banner { background: #475569; color: #e2e8f0; }
  .approval-actions .btn-deny-banner:hover { background: #64748b; }

  /* Approval modal */
  .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: center; }
  .modal-overlay.active { display: flex; }
  .modal { background: #1e293b; border: 1px solid #475569; border-radius: 12px; padding: 24px; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto; }
  .modal h3 { font-size: 16px; margin-bottom: 16px; color: #e2e8f0; }
  .modal .plan-text { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; font-size: 13px; color: #94a3b8; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word; margin-bottom: 16px; line-height: 1.5; }
  .modal .pin-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .modal .pin-row label { font-size: 13px; color: #94a3b8; flex-shrink: 0; }
  .modal .pin-row input { background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 8px 12px; font-family: inherit; font-size: 16px; width: 120px; text-align: center; letter-spacing: 4px; }
  .modal .modal-actions { display: flex; gap: 12px; justify-content: flex-end; }
  .modal .modal-actions button { padding: 10px 20px; border: none; border-radius: 6px; font-size: 14px; font-family: inherit; cursor: pointer; font-weight: 600; }
  .modal .btn-approve-modal { background: #10b981; color: #fff; }
  .modal .btn-approve-modal:hover { background: #059669; }
  .modal .btn-cancel-modal { background: #475569; color: #e2e8f0; }
  .modal .btn-cancel-modal:hover { background: #64748b; }
  .modal .modal-error { color: #f87171; font-size: 13px; margin-top: 8px; }

  /* Filter bar */
  .filter-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-bar input[type="text"] { background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 6px 12px; font-family: inherit; font-size: 13px; width: 240px; }
  .filter-bar input[type="text"]::placeholder { color: #475569; }
  .filter-pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .filter-pill { background: #334155; color: #94a3b8; border: 1px solid #475569; border-radius: 16px; padding: 4px 12px; font-size: 12px; font-family: inherit; cursor: pointer; transition: all 0.15s; }
  .filter-pill:hover { background: #475569; color: #e2e8f0; }
  .filter-pill.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
  .filter-pill .pill-count { background: rgba(255,255,255,0.2); padding: 1px 5px; border-radius: 8px; font-size: 10px; margin-left: 4px; }

  /* Directive cards */
  .directive-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin-bottom: 10px; transition: border-color 0.15s; }
  .directive-card:hover { border-color: #475569; }
  .card-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .card-header-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .card-header-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .status-badge { color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px; text-transform: capitalize; white-space: nowrap; }
  .card-title { font-size: 14px; font-weight: 600; color: #e2e8f0; }
  .card-meta { font-size: 12px; color: #64748b; }
  .card-time { }
  .card-failure { margin-top: 8px; padding: 8px 12px; background: #450a0a; border: 1px solid #7f1d1d; border-radius: 6px; color: #fca5a5; font-size: 12px; }
  .card-activity { margin-top: 6px; font-size: 12px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-deps { margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; }
  .card-actions { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
  .card-btn { padding: 4px 10px; border: 1px solid #475569; border-radius: 4px; font-size: 11px; font-family: inherit; cursor: pointer; background: #334155; color: #e2e8f0; transition: all 0.15s; }
  .card-btn:hover { background: #475569; }
  .btn-approve { background: #065f46; border-color: #10b981; color: #6ee7b7; }
  .btn-approve:hover { background: #10b981; color: #fff; }
  .btn-deny { background: #450a0a; border-color: #ef4444; color: #fca5a5; }
  .btn-deny:hover { background: #ef4444; color: #fff; }
  .btn-retry { background: #1e3a5f; border-color: #3b82f6; color: #93c5fd; }
  .btn-retry:hover { background: #3b82f6; color: #fff; }
  .btn-retry-merge { background: #422006; border-color: #f59e0b; color: #fcd34d; }
  .btn-retry-merge:hover { background: #f59e0b; color: #000; }
  .btn-unblock { background: #2e1065; border-color: #8b5cf6; color: #c4b5fd; }
  .btn-unblock:hover { background: #8b5cf6; color: #fff; }
  .btn-escalate { background: #7f1d1d; border-color: #dc2626; color: #fca5a5; }
  .btn-escalate:hover { background: #dc2626; color: #fff; }
  .escalated-badge { animation: escalated-pulse 2s ease-in-out infinite; }
  @keyframes escalated-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
  .btn-cancel { background: #450a0a; border-color: #dc2626; color: #fca5a5; }
  .btn-cancel:hover { background: #dc2626; color: #fff; }
  .btn-comment { background: transparent; border-color: #475569; color: #64748b; }
  .btn-comment:hover { color: #e2e8f0; }
  .btn-log { background: transparent; border-color: #475569; color: #64748b; }
  .btn-log:hover { color: #e2e8f0; }

  /* Inline audit trail */
  .inline-audit-trail { margin-top: 8px; padding: 8px 0 0; border-top: 1px solid #334155; }
  .inline-trail-entry { display: flex; gap: 6px; align-items: baseline; font-size: 11px; padding: 2px 0; color: #94a3b8; }
  .trail-time { color: #475569; flex-shrink: 0; min-width: 50px; }
  .trail-msg { color: #94a3b8; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trail-show-all { margin-top: 4px; }
  .trail-show-all a { color: #3b82f6; font-size: 11px; text-decoration: none; }
  .trail-show-all a:hover { text-decoration: underline; }

  /* Card comment input */
  .card-comment-input { margin-top: 8px; display: flex; gap: 6px; }
  .card-comment-input input { flex: 1; background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 6px 10px; font-size: 12px; font-family: inherit; }
  .card-comment-input button { background: #10b981; color: #fff; border: none; border-radius: 4px; padding: 6px 12px; font-size: 12px; font-family: inherit; cursor: pointer; }
  .card-comment-input button:hover { background: #059669; }

  /* Full log panel inside card */
  .card-full-log { margin-top: 8px; padding-top: 8px; border-top: 1px solid #334155; }
  .full-timeline { max-height: 300px; overflow-y: auto; border-left: 2px solid #334155; margin-left: 4px; padding-left: 12px; }

  .load-more-wrap { text-align: center; padding: 12px 0; }
  .load-more-btn { background: #334155; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 8px 20px; font-size: 13px; font-family: inherit; cursor: pointer; transition: background 0.2s; }
  .load-more-btn:hover { background: #475569; }

  /* Actor badges */
  .actor-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600; letter-spacing: 0.5px; white-space: nowrap; }
  .actor-king-kazuma { background: #7c3aed22; color: #a78bfa; border: 1px solid #7c3aed44; }
  .actor-june { background: #06b6d422; color: #67e8f9; border: 1px solid #06b6d444; }
  .actor-cipher { background: #10b98122; color: #6ee7b7; border: 1px solid #10b98144; }
  .actor-system { background: #6b728022; color: #9ca3af; border: 1px solid #6b728044; }

  /* Timeline entries in full log */
  .timeline-entry { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-bottom: 1px solid #1e293b; position: relative; }
  .timeline-entry::before { content: ""; position: absolute; left: -16px; top: 10px; width: 8px; height: 8px; border-radius: 50%; background: #334155; border: 1px solid #475569; }
  .timeline-entry.type-status_change::before { background: #3b82f6; border-color: #60a5fa; }
  .timeline-entry.type-comment::before { background: #10b981; border-color: #34d399; }
  .timeline-entry.type-cancelled::before { background: #ef4444; border-color: #f87171; }
  .timeline-entry.type-retry::before { background: #f59e0b; border-color: #fbbf24; }
  .timeline-entry.type-unblocked::before { background: #8b5cf6; border-color: #a78bfa; }
  .timeline-entry.type-pm_note::before { background: #06b6d4; border-color: #22d3ee; }
  .timeline-entry.type-pm_update::before { background: #06b6d4; border-color: #22d3ee; }

  /* New directive form */
  .new-directive { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
  .new-directive h2 { border-color: #475569; }
  .new-directive label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 4px; margin-top: 12px; text-transform: uppercase; letter-spacing: 1px; }
  .new-directive input, .new-directive textarea, .new-directive select { width: 100%; background: #0f172a; color: #e2e8f0; border: 1px solid #475569; border-radius: 6px; padding: 8px 12px; font-family: inherit; font-size: 14px; }
  .new-directive textarea { min-height: 80px; resize: vertical; }
  .new-directive select { appearance: auto; }
  .new-directive .submit-btn { margin-top: 16px; background: #3b82f6; color: #fff; border: none; border-radius: 6px; padding: 10px 20px; font-size: 14px; font-family: inherit; cursor: pointer; transition: background 0.2s; }
  .new-directive .submit-btn:hover { background: #2563eb; }
  .new-directive .submit-btn:disabled { background: #475569; cursor: not-allowed; }
  .new-directive .form-msg { margin-top: 10px; font-size: 13px; padding: 8px 12px; border-radius: 6px; }
  .new-directive .form-msg.ok { background: #064e3b; color: #6ee7b7; }
  .new-directive .form-msg.err { background: #450a0a; color: #fca5a5; }

  /* Pipeline violations */
  .violations-section { background: #1e293b; border: 2px solid #ef4444; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; }
  .violations-section h3 { color: #f87171; font-size: 14px; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 8px; }
  .violations-count { background: #ef4444; color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .violation-item { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .violation-item:last-child { margin-bottom: 0; }
  .violation-info { flex: 1; }
  .violation-type { font-size: 11px; padding: 2px 6px; border-radius: 3px; font-weight: 600; }
  .violation-type.direct_commit_main { background: #ef444422; color: #fca5a5; border: 1px solid #ef444444; }
  .violation-type.orphan_commit { background: #f59e0b22; color: #fcd34d; border: 1px solid #f59e0b44; }
  .violation-type.hook_bypassed { background: #8b5cf622; color: #c4b5fd; border: 1px solid #8b5cf644; }
  .violation-msg { font-size: 12px; color: #94a3b8; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 500px; }
  .violation-meta { font-size: 11px; color: #475569; margin-top: 2px; }
  .btn-resolve { padding: 4px 10px; border: 1px solid #475569; border-radius: 4px; font-size: 11px; font-family: inherit; cursor: pointer; background: #334155; color: #e2e8f0; transition: all 0.15s; }
  .btn-resolve:hover { background: #10b981; color: #fff; border-color: #10b981; }

  /* Mobile responsive */
  @media (max-width: 768px) {
    body { padding: 12px; }
    h1 { font-size: 18px; }
    .stat-cards { gap: 8px; }
    .stat-card { min-width: unset; padding: 10px 14px; flex: 1; }
    .stat-card .value { font-size: 18px; }
    section { margin-bottom: 20px; }
    .card-header { flex-direction: column; align-items: flex-start; }
    .card-header-right { gap: 8px; }
    .approval-item { flex-direction: column; gap: 8px; }
    .filter-bar { gap: 8px; }
    .filter-bar input[type="text"] { width: 100%; }
    .modal { width: 95%; padding: 16px; }
    .new-directive { padding: 14px; }
    .new-directive input, .new-directive textarea, .new-directive select { font-size: 16px; padding: 10px 12px; }
    .new-directive .submit-btn { width: 100%; padding: 12px; font-size: 16px; }
    .refresh-bar { flex-wrap: wrap; gap: 8px; }
  }
</style>
</head><body>
<h1>Ozzu Pipeline Dashboard</h1>
<p class="subtitle">Bridge server on 10.128.0.8:3333 &mdash; refreshed <span id="refreshed-at">${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}</span></p>

<div class="refresh-bar">
  <button class="refresh-btn" onclick="refreshNow()">Refresh Now</button>
  <a href="/logs" target="_blank" class="refresh-btn" style="text-decoration:none;">View Logs</a>
  <span class="countdown" id="countdown">Next refresh in 10s</span>
</div>

<div id="dashboard-content">

${approvalBannerItems.length > 0 ? `<div class="approval-banner">
<h3>Pending Approvals (${approvalBannerItems.length})</h3>
${approvalBannerItems.map(item => `<div class="approval-item">
  <div class="approval-info">
    <div class="approval-title">${escapeHtml(item.directive.title || item.directive.id)}</div>
    <div class="approval-desc">${escapeHtml(item.directive.plan ? item.directive.plan.slice(0, 200) : item.directive.description || "")}</div>
  </div>
  <div class="approval-actions">
    <button class="btn-approve-banner" onclick="openApprovalModal('${escapeHtml(escapeJsString(item.directive.id))}')">Approve</button>
    <button class="btn-deny-banner" onclick="denyDirective('${escapeHtml(escapeJsString(item.directive.id))}')">Deny</button>
  </div>
</div>`).join("")}
</div>` : ""}

<div class="stat-cards">
  <div class="stat-card"><div class="label">Uptime</div><div class="value">${uptimeStr}</div></div>
  <div class="stat-card"><div class="label">PostgreSQL</div><div class="value ${pgHealth.connected ? "ok" : "bad"}">${pgHealth.connected ? "Connected" : "Down"}</div></div>
  <div class="stat-card"><div class="label">Redis</div><div class="value ${redisHealthy ? "ok" : "bad"}">${redisHealthy ? "Connected" : "Down"}</div></div>
  <div class="stat-card"><div class="label">Gemini</div><div class="value ${geminiReady ? "ok" : "warn"}">${geminiReady ? "Connected" : "Down"}</div></div>
  <div class="stat-card"><div class="label">Active Agents</div><div class="value ${agents.length > 0 ? "warn" : "ok"}">${agents.length}</div></div>
  <div class="stat-card"><div class="label">Completed Today</div><div class="value ok">${completedToday}</div></div>
  <div class="stat-card"><div class="label">Success Rate</div><div class="value ${successRate !== null && successRate >= 80 ? "ok" : successRate !== null && successRate >= 50 ? "warn" : successRate !== null ? "bad" : ""}">${successRate !== null ? successRate + "%" : "N/A"}</div></div>
  <div class="stat-card"><div class="label">Avg Duration</div><div class="value">${avgDuration !== null ? formatDuration(avgDuration) : "N/A"}</div></div>
</div>

${unresolvedViolations.length > 0 ? `<div class="violations-section">
<h3>Pipeline Violations <span class="violations-count">${unresolvedViolations.length}</span></h3>
${violationsHtml}
</div>` : ""}

<section>
<h2>Running Agents</h2>
${agents.length > 0 ? `<table><tr><th>Directive</th><th>Type</th><th>PID</th><th>Runtime</th></tr>${agentRows}</table>` : `<p class="empty">No agents currently running.</p>`}
</section>

${timelineDirectives.length > 0 ? `<section>
<h2>Execution Timeline (Last 24h)</h2>
<div style="display:flex;gap:6px;margin-bottom:10px;font-size:11px;">
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#10b981;display:inline-block;"></span> Completed</span>
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#ef4444;display:inline-block;"></span> Failed</span>
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#3b82f6;display:inline-block;"></span> In Progress</span>
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#f59e0b;display:inline-block;"></span> Stale</span>
  <span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:2px;background:#dc2626;display:inline-block;"></span> Deploy Failed</span>
</div>
<div style="display:flex;gap:8px;">
  <div style="width:180px;flex-shrink:0;"></div>
  <div style="flex:1;position:relative;height:18px;margin-bottom:4px;">${tlHourMarkersHtml}</div>
</div>
<div style="display:flex;flex-direction:column;gap:2px;">
  ${timelineBars}
</div>
</section>` : ""}

<section>
<h2>Directives</h2>
<div class="filter-bar">
  <input type="text" id="directive-search" placeholder="Search directives..." oninput="applyFilters()">
  <div class="filter-pills">
    <button class="filter-pill active" data-filter="all" onclick="setStatusFilter('all',this)">All <span class="pill-count">${directives.length}</span></button>
    <button class="filter-pill" data-filter="active" onclick="setStatusFilter('active',this)">Active</button>
    <button class="filter-pill" data-filter="needs_action" onclick="setStatusFilter('needs_action',this)">Needs Action${needsActionCount > 0 ? ` <span class="pill-count">${needsActionCount}</span>` : ""}</button>
    <button class="filter-pill" data-filter="completed" onclick="setStatusFilter('completed',this)">Completed</button>
    <button class="filter-pill" data-filter="failed" onclick="setStatusFilter('failed',this)">Failed</button>
  </div>
</div>
<div id="directive-list">
${directives.length > 0 ? directiveCards : `<p class="empty">No directives.</p>`}
</div>
<div class="load-more-wrap" id="load-more-wrap"><button class="load-more-btn" id="load-more-btn" onclick="loadMore()">Load More</button><span id="load-more-count" style="color:#64748b;font-size:12px;margin-left:8px;"></span></div>
</section>

</div>

<!-- Approval Modal -->
<div class="modal-overlay" id="approval-modal">
  <div class="modal">
    <h3 id="modal-title">Approve Directive</h3>
    <div class="plan-text" id="modal-plan">Loading plan...</div>
    <div class="pin-row">
      <label for="modal-pin">PIN</label>
      <input type="password" id="modal-pin" maxlength="8" placeholder="Enter PIN" onkeydown="if(event.key==='Enter')submitApproval();">
    </div>
    <div class="modal-actions">
      <button class="btn-cancel-modal" onclick="closeApprovalModal()">Cancel</button>
      <button class="btn-approve-modal" id="modal-approve-btn" onclick="submitApproval()">Approve</button>
    </div>
    <div class="modal-error" id="modal-error"></div>
  </div>
</div>

<section class="new-directive">
<h2>New Quick Directive</h2>
<form id="directive-form" onsubmit="return submitDirective(event)">
  <label for="d-template">Template</label>
  <select id="d-template" onchange="applyTemplate(this.value)">
    <option value="">— None —</option>
${DIRECTIVE_TEMPLATES.map((t, i) => `    <option value="${i}">${escapeHtml(t.name)} (${escapeHtml(t.type)})</option>`).join("\n")}
  </select>
  <label for="d-title">Title</label>
  <input type="text" id="d-title" name="title" placeholder="Short description of the task" required>
  <label for="d-desc">Description</label>
  <textarea id="d-desc" name="description" placeholder="Detailed description of what needs to be done..."></textarea>
  <label for="d-type">Type</label>
  <select id="d-type" name="type">
    <option value="quick">Quick</option>
    <option value="feature">Feature</option>
    <option value="explore">Explore</option>
  </select>
  <label for="d-priority">Priority</label>
  <select id="d-priority" name="priority">
    <option value="1">Critical</option>
    <option value="2">High</option>
    <option value="3" selected>Normal</option>
    <option value="4">Low</option>
  </select>
  <button type="submit" class="submit-btn" id="submit-btn">Submit Directive</button>
  <div id="form-msg"></div>
</form>
</section>

<script>
// ── Utilities ──
function timeAgo(dateStr) {
  if (!dateStr) return "-";
  var d = new Date(typeof dateStr === "number" ? dateStr : dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  var now = Date.now();
  var diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function convertTimestamps() {
  document.querySelectorAll("[data-ts]").forEach(function(el) {
    var ts = el.getAttribute("data-ts");
    if (ts) { el.textContent = timeAgo(ts); el.title = ts; }
  });
}
convertTimestamps();

function escapeText(str) {
  if (!str) return "";
  var div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Filtering ──
var currentStatusFilter = "all";
var pageSize = 20;
var visibleCount = pageSize;

var activeStatuses = ["pending", "planning", "planned", "approved", "in_progress", "blocked"];
var failedStatuses = ["failed", "stale", "deploy_failed"];
var needsActionStatuses = ["planned", "blocked", "deploy_failed"];

function applyFilters() {
  var searchEl = document.getElementById("directive-search");
  var query = searchEl ? searchEl.value.toLowerCase().trim() : "";
  var cards = document.querySelectorAll(".directive-card");
  var matchCount = 0;
  var shownCount = 0;

  cards.forEach(function(card) {
    var status = card.getAttribute("data-status");
    var title = card.getAttribute("data-title") || "";

    var statusMatch = false;
    if (currentStatusFilter === "all") statusMatch = true;
    else if (currentStatusFilter === "active") statusMatch = activeStatuses.indexOf(status) !== -1;
    else if (currentStatusFilter === "completed") statusMatch = status === "completed";
    else if (currentStatusFilter === "failed") statusMatch = failedStatuses.indexOf(status) !== -1;
    else if (currentStatusFilter === "needs_action") statusMatch = needsActionStatuses.indexOf(status) !== -1;

    var searchMatch = !query || title.indexOf(query) !== -1;

    if (statusMatch && searchMatch) {
      matchCount++;
      if (matchCount <= visibleCount) {
        card.style.display = "";
        shownCount++;
      } else {
        card.style.display = "none";
      }
    } else {
      card.style.display = "none";
    }
  });

  var wrap = document.getElementById("load-more-wrap");
  var countEl = document.getElementById("load-more-count");
  if (wrap) {
    if (matchCount > shownCount) {
      wrap.style.display = "";
      if (countEl) countEl.textContent = "Showing " + shownCount + " of " + matchCount;
    } else {
      wrap.style.display = "none";
    }
  }
}

function setStatusFilter(filter, btn) {
  currentStatusFilter = filter;
  visibleCount = pageSize;
  document.querySelectorAll(".filter-pill").forEach(function(p) { p.classList.remove("active"); });
  if (btn) btn.classList.add("active");
  applyFilters();
}

function loadMore() { visibleCount += pageSize; applyFilters(); }
applyFilters();

// ── Auto-refresh ──
var refreshInterval = 10;
var countdown = refreshInterval;
var countdownEl = document.getElementById("countdown");
var contentEl = document.getElementById("dashboard-content");
var refreshedEl = document.getElementById("refreshed-at");

function refreshNow() {
  countdown = refreshInterval;
  contentEl.classList.add("updating");
  fetch("/dashboard")
    .then(function(r) { return r.text(); })
    .then(function(html) {
      var parser = new DOMParser();
      var doc = parser.parseFromString(html, "text/html");
      var newContent = doc.getElementById("dashboard-content");
      var newRefreshed = doc.getElementById("refreshed-at");
      var searchVal = "";
      var searchEl = document.getElementById("directive-search");
      if (searchEl) searchVal = searchEl.value;
      // Preserve open log panels
      var openLogs = [];
      document.querySelectorAll(".card-full-log").forEach(function(el) {
        if (el.style.display !== "none") openLogs.push(el.id);
      });
      if (newContent) contentEl.innerHTML = newContent.innerHTML;
      if (newRefreshed) refreshedEl.textContent = newRefreshed.textContent;
      var newSearchEl = document.getElementById("directive-search");
      if (newSearchEl) newSearchEl.value = searchVal;
      document.querySelectorAll(".filter-pill").forEach(function(p) {
        p.classList.remove("active");
        if (p.getAttribute("data-filter") === currentStatusFilter) p.classList.add("active");
      });
      openLogs.forEach(function(logId) {
        var el = document.getElementById(logId);
        if (el) el.style.display = "";
      });
      convertTimestamps();
      applyFilters();
      contentEl.classList.remove("updating");
    })
    .catch(function() { contentEl.classList.remove("updating"); });
}

setInterval(function() {
  countdown--;
  if (countdown <= 0) { refreshNow(); }
  else { countdownEl.textContent = "Next refresh in " + countdown + "s"; }
}, 1000);

// ── Directive Actions ──
function resolveViolation(id) {
  fetch("/api/pipeline-violations/" + id + "/resolve", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.ok) refreshNow(); else alert("Error: " + (data.error || "Unknown")); })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function cancelDirective(id) {
  if (!confirm("Cancel this directive?")) return;
  fetch("/directives/" + id + "/cancel", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.ok) refreshNow(); else alert("Error: " + (data.error || "Unknown")); })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function retryDirective(id) {
  if (!confirm("Retry this directive?")) return;
  fetch("/directives/" + id + "/retry", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.ok) refreshNow(); else alert("Error: " + (data.error || "Unknown")); })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function retryMerge(id) {
  if (!confirm("Retry merge for this directive?")) return;
  fetch("/directives/" + id + "/retry-merge", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { alert("Merge succeeded! Deploying now."); refreshNow(); }
      else { alert("Merge failed: " + (data.error || "Unknown")); refreshNow(); }
    })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function escalateDirective(id) {
  if (!confirm("Escalate this directive to Cipher for direct takeover?")) return;
  fetch("/directives/" + id + "/escalate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ escalatedBy: "King Kazuma", reason: "Manual escalation from dashboard" })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) { alert("Escalated to Cipher! Worker history preserved."); refreshNow(); }
      else { alert("Escalation failed: " + (data.error || "Unknown")); }
    })
    .catch(function(err) { alert("Network error: " + err.message); });
}

function unblockDirective(id) {
  if (!confirm("Unblock this directive?")) return;
  fetch("/directives/" + id + "/unblock", { method: "POST" })
    .then(function(r) { return r.json(); })
    .then(function(data) { if (data.ok) refreshNow(); else alert("Error: " + (data.error || "Unknown")); })
    .catch(function(err) { alert("Network error: " + err.message); });
}

// ── Comments ──
function toggleCommentInput(id) {
  var wrap = document.getElementById("comment-wrap-" + id);
  if (!wrap) return;
  wrap.style.display = wrap.style.display === "none" ? "flex" : "none";
  if (wrap.style.display === "flex") {
    var input = document.getElementById("comment-input-" + id);
    if (input) input.focus();
  }
}

function addComment(id) {
  var input = document.getElementById("comment-input-" + id);
  if (!input) return;
  var msg = input.value.trim();
  if (!msg) return;
  input.disabled = true;
  fetch("/directives/" + id + "/comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: msg })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      input.disabled = false;
      if (data.ok) { input.value = ""; refreshNow(); }
      else alert("Error: " + (data.error || "Unknown"));
    })
    .catch(function(err) { input.disabled = false; alert("Network error: " + err.message); });
}

// ── Activity Log ──
function toggleActivityLog(id) {
  var panel = document.getElementById("log-" + id);
  if (!panel) return;
  var isHidden = panel.style.display === "none";
  panel.style.display = isHidden ? "" : "none";
  if (!isHidden) return;

  var container = document.getElementById("timeline-" + id);
  if (!container) return;
  container.innerHTML = '<span style="color:#475569;font-style:italic;">Loading audit trail...</span>';

  fetch("/directives/" + id + "/history")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.timeline || data.timeline.length === 0) {
        container.innerHTML = '<span style="color:#475569;font-style:italic;">No activity yet.</span>';
        return;
      }
      var actorColors = { "King Kazuma": "king-kazuma", "June": "june", "Cipher": "cipher", "system": "system" };
      var html = data.timeline.map(function(e) {
        var actorClass = actorColors[e.actor] || "system";
        var actorBadge = e.actor ? '<span class="actor-badge actor-' + actorClass + '">' + escapeText(e.actor) + '</span>' : '';
        var sourceTag = e.source === "pg_history" ? ' <span style="font-size:9px;color:#475569;border:1px solid #334155;padding:0 3px;border-radius:2px;">PG</span>' : '';
        return '<div class="timeline-entry type-' + escapeText(e.type) + '">' +
          '<span style="color:#64748b;font-size:11px;flex-shrink:0;">' + timeAgo(e.timestamp) + '</span>' +
          actorBadge +
          '<span style="font-size:12px;color:#e2e8f0;flex:1;">' + escapeText(e.message) + '</span>' +
          sourceTag + '</div>';
      }).join("");
      container.innerHTML = html;
    })
    .catch(function(err) {
      container.innerHTML = '<span style="color:#ef4444;">Failed to load: ' + err.message + '</span>';
    });
}

// ── Approval Modal ──
var currentApprovalDirectiveId = null;

function openApprovalModal(directiveId) {
  currentApprovalDirectiveId = directiveId;
  var modal = document.getElementById("approval-modal");
  var titleEl = document.getElementById("modal-title");
  var planEl = document.getElementById("modal-plan");
  var pinEl = document.getElementById("modal-pin");
  var errEl = document.getElementById("modal-error");

  titleEl.textContent = "Loading...";
  planEl.textContent = "Loading plan details...";
  pinEl.value = "";
  errEl.textContent = "";
  modal.classList.add("active");

  // Fetch enriched approval details
  fetch("/approvals/details")
    .then(function(r) { return r.json(); })
    .then(function(approvals) {
      var match = approvals.find(function(a) { return a.directiveId === directiveId; });
      if (match) {
        titleEl.textContent = "Approve: " + (match.directiveTitle || directiveId);
        planEl.textContent = match.directivePlan || match.directiveDescription || "No plan text available.";
      } else {
        titleEl.textContent = "Approve: " + directiveId;
        planEl.textContent = "Could not load plan details. The directive may already be resolved.";
      }
      pinEl.focus();
    })
    .catch(function() {
      titleEl.textContent = "Approve: " + directiveId;
      planEl.textContent = "Failed to load plan details.";
      pinEl.focus();
    });
}

function closeApprovalModal() {
  document.getElementById("approval-modal").classList.remove("active");
  currentApprovalDirectiveId = null;
}

function submitApproval() {
  var pin = document.getElementById("modal-pin").value;
  var errEl = document.getElementById("modal-error");
  var btn = document.getElementById("modal-approve-btn");
  if (!pin) { errEl.textContent = "PIN is required."; return; }

  btn.disabled = true;
  btn.textContent = "Approving...";
  errEl.textContent = "";

  // Find the approval ID for this directive
  fetch("/approvals/details")
    .then(function(r) { return r.json(); })
    .then(function(approvals) {
      var match = approvals.find(function(a) { return a.directiveId === currentApprovalDirectiveId; });
      if (!match) { throw new Error("Approval not found — may already be resolved"); }
      return fetch("/approvals/" + match.id + "/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, pin: pin })
      });
    })
    .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
    .then(function(res) {
      if (res.data.ok) {
        closeApprovalModal();
        refreshNow();
      } else {
        errEl.textContent = res.data.error || "Approval failed";
      }
    })
    .catch(function(err) { errEl.textContent = err.message; })
    .finally(function() { btn.disabled = false; btn.textContent = "Approve"; });
}

function denyDirective(directiveId) {
  if (!confirm("Deny this directive plan?")) return;
  fetch("/approvals/details")
    .then(function(r) { return r.json(); })
    .then(function(approvals) {
      var match = approvals.find(function(a) { return a.directiveId === directiveId; });
      if (!match) { alert("No pending approval found for this directive."); return; }
      // Deny doesn't require PIN — use a dummy to satisfy the endpoint
      return fetch("/approvals/" + match.id + "/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false, pin: "" })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok || data.error === "Invalid PIN") {
            // For deny, we also need the PIN — cancel the directive instead
            return fetch("/directives/" + directiveId + "/cancel", { method: "POST" })
              .then(function(r) { return r.json(); })
              .then(function() { refreshNow(); });
          }
          refreshNow();
        });
    })
    .catch(function(err) { alert("Error: " + err.message); });
}

// ── Template + Submit ──
var directiveTemplates = ${JSON.stringify(DIRECTIVE_TEMPLATES)};
function applyTemplate(idx) {
  if (idx === "") return;
  var t = directiveTemplates[parseInt(idx, 10)];
  if (!t) return;
  document.getElementById("d-title").value = t.titleTemplate;
  document.getElementById("d-desc").value = t.descriptionTemplate;
  document.getElementById("d-type").value = t.type;
}

function submitDirective(e) {
  e.preventDefault();
  var title = document.getElementById("d-title").value.trim();
  var desc = document.getElementById("d-desc").value.trim();
  var type = document.getElementById("d-type").value;
  var priority = parseInt(document.getElementById("d-priority").value, 10) || 3;
  var msgEl = document.getElementById("form-msg");
  var btn = document.getElementById("submit-btn");

  if (!title) { msgEl.className = "form-msg err"; msgEl.textContent = "Title is required."; return false; }

  btn.disabled = true;
  btn.textContent = "Submitting...";
  msgEl.textContent = "";
  msgEl.className = "form-msg";

  fetch("/directives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: type, title: title, description: desc || title, priority: priority })
  })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
    .then(function(res) {
      if (res.ok) {
        msgEl.className = "form-msg ok";
        msgEl.textContent = "Directive created: " + (res.data.id || "success");
        document.getElementById("d-title").value = "";
        document.getElementById("d-desc").value = "";
        document.getElementById("d-template").value = "";
        setTimeout(refreshNow, 1000);
      } else {
        msgEl.className = "form-msg err";
        msgEl.textContent = "Error: " + (res.data.error || "Unknown error");
      }
    })
    .catch(function(err) {
      msgEl.className = "form-msg err";
      msgEl.textContent = "Network error: " + err.message;
    })
    .finally(function() {
      btn.disabled = false;
      btn.textContent = "Submit Directive";
    });

  return false;
}

// Close modal on escape key or clicking overlay
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape") closeApprovalModal();
});
document.getElementById("approval-modal").addEventListener("click", function(e) {
  if (e.target === this) closeApprovalModal();
});
</script>

</body></html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS });
    res.end(html);
    return;
  }

  // GET /logs — serve recent bridge logs from in-memory ring buffer
  if (req.method === "GET" && pathname === "/logs") {
    const lines = Math.min(Math.max(parseInt(url.searchParams.get("lines")) || 100, 1), 500);
    const sinceParam = url.searchParams.get("since"); // e.g. "1h", "30m", "5s"
    let filtered = getLogRing();
    if (sinceParam) {
      const match = sinceParam.match(/^(\d+)([hms])$/);
      if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        const ms = unit === "h" ? amount * 3600000 : unit === "m" ? amount * 60000 : amount * 1000;
        const cutoff = new Date(Date.now() - ms).toISOString();
        filtered = filtered.filter(e => e.ts >= cutoff);
      }
    }
    const result = filtered.slice(-lines).map(e => `[${e.ts}] ${e.line}`).join("\n");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS });
    res.end(result || "(no logs captured yet)\n");
    return;
  }

  // GET /config — read-only view of runtime configuration
  if (req.method === "GET" && pathname === "/config") {
    const cfg = getConfig();
    sendJSON(res, 200, {
      ...cfg,
      persona: currentPersona,
    });
    return;
  }

  // PATCH /config — update safe runtime settings
  if (req.method === "PATCH" && pathname === "/config") {
    if (!requireAuth(req, res)) return;
    const data = await parseBody(req);
    const errors = [];
    const updated = {};

    if (data.MAX_CONCURRENT_AGENTS !== undefined) {
      const v = parseInt(data.MAX_CONCURRENT_AGENTS);
      if (isNaN(v) || v < 1 || v > 4) {
        errors.push("MAX_CONCURRENT_AGENTS must be 1-4");
      } else {
        setConfig("MAX_CONCURRENT_AGENTS", v);
        updated.MAX_CONCURRENT_AGENTS = v;
      }
    }

    if (data.AGENT_TIMEOUT_MS !== undefined) {
      const v = parseInt(data.AGENT_TIMEOUT_MS);
      if (isNaN(v) || v < 300000 || v > 7200000) {
        errors.push("AGENT_TIMEOUT_MS must be 300000-7200000 (5min-2hr)");
      } else {
        setConfig("AGENT_TIMEOUT_MS", v);
        updated.AGENT_TIMEOUT_MS = v;
      }
    }

    if (data.LOG_LEVEL !== undefined) {
      const valid = ["debug", "info", "warn", "error"];
      if (!valid.includes(data.LOG_LEVEL)) {
        errors.push(`LOG_LEVEL must be one of: ${valid.join(", ")}`);
      } else {
        setConfig("LOG_LEVEL", data.LOG_LEVEL);
        updated.LOG_LEVEL = data.LOG_LEVEL;
      }
    }

    if (errors.length > 0) {
      sendJSON(res, 400, { error: "Validation failed", details: errors });
      return;
    }

    if (Object.keys(updated).length === 0) {
      sendJSON(res, 400, { error: "No valid writable settings provided. Writable: MAX_CONCURRENT_AGENTS, AGENT_TIMEOUT_MS, LOG_LEVEL" });
      return;
    }

    log.bridge.info(`Config updated: ${JSON.stringify(updated)}`);
    sendJSON(res, 200, { updated, config: { ...getConfig(), persona: currentPersona } });
    return;
  }

  // Full health check endpoint
  if (req.method === "GET" && pathname === "/health") {
    const pgHealth = await db.healthCheck();

    // Redis liveness check via PING
    let redisHealthy = false;
    try {
      if (_redisConnected) {
        await redis.ping();
        redisHealthy = true;
      }
    } catch { redisHealthy = false; }

    // Directive queue stats from in-memory cache
    const dirStats = { pending: 0, planning: 0, planned: 0, approved: 0, in_progress: 0, completed: 0, failed: 0, stale: 0, blocked: 0 };
    const recentFailures = [];
    let totalRetries = 0;
    for (const d of _directives) {
      if (dirStats[d.status] !== undefined) dirStats[d.status]++;
      if (d.retryCount) totalRetries += d.retryCount;
      if (d.failureReason && (d.status === "failed" || d.status === "stale")) {
        recentFailures.push({ id: d.id, title: d.title, status: d.status, failureReason: d.failureReason, retryCount: d.retryCount || 0 });
      }
    }

    const agents = getRunningAgents();
    const healthy = pgHealth.connected && redisHealthy;

    sendJSON(res, healthy ? 200 : 503, {
      status: healthy ? "healthy" : "degraded",
      service: "ozzu-bridge",
      uptime: process.uptime(),
      serverStartedAt: _serverStartedAt,
      restartCount: _restartCount,
      lastRestartReason: _lastRestartReason,
      previousStartedAt: _previousStartedAt,
      agents: { active: agents.length, maxConcurrent: getConfig().MAX_CONCURRENT_AGENTS, details: agents.map(a => ({ directiveId: a.directiveId, type: a.type, pid: a.pid })) },
      directives: { ...dirStats, totalRetries, recentFailures },
      rateLimit: { windowMinutes: RATE_LIMIT_WINDOW_MS / 60000, max: RATE_LIMIT_MAX, recentCreations: _directiveCreationTimestamps.filter(t => t > Date.now() - RATE_LIMIT_WINDOW_MS).length, totalHits: _rateLimitHits },
      redis: { connected: redisHealthy },
      postgres: pgHealth,
      gemini: { connected: !!geminiReady, model: GEMINI_MODEL },
      voice: {
        deepgram: { configured: !!(process.env.DEEPGRAM_API_KEY && process.env.DEEPGRAM_API_KEY.trim()) },
        cartesia: { configured: !!(process.env.CARTESIA_API_KEY && process.env.CARTESIA_API_KEY.trim()) },
      },
      devices: [...devices.values()].map(d => ({ deviceId: d.deviceId, role: d.role })),
      persona: currentPersona,
      cipherMode,
    });
    return;
  }

  // GET /health/dev01 — check dev-01 (iOS deploy server) health
  // Returns SSH reachability, AltServer presence, iPhone USB connection
  if (req.method === "GET" && pathname === "/health/dev01") {
    const { execFile } = require("child_process");
    const { promisify } = require("util");
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync("bash", [
        `${WORKDIR}/scripts/deploy-ios.sh`, "--check",
      ], { timeout: 15000, env: { ...process.env, PATH: process.env.PATH } });
      // deploy-ios.sh --check outputs JSON on the last line
      const lines = stdout.trim().split("\n");
      const jsonLine = lines[lines.length - 1];
      const health = JSON.parse(jsonLine);
      const ready = health.ssh && health.altserver && health.iphone_usb;
      sendJSON(res, ready ? 200 : 503, { ready, ...health });
    } catch (err) {
      sendJSON(res, 503, { ready: false, ssh: false, altserver: false, iphone_usb: false, error: err.message });
    }
    return;
  }

  // GET /conversations/recent — last 10 conversation summaries across all personas
  if (req.method === "GET" && pathname === "/conversations/recent") {
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);
    const { rows, total } = await db.getRecentConversations(Math.min(limit, 50));
    const conversations = rows.map(r => ({
      id: r.id,
      persona: r.persona,
      summary: r.summary,
      turn_count: r.turn_count,
      topics: r.topics || [],
      started_at: r.started_at,
      ended_at: r.ended_at,
      duration_minutes: r.duration_minutes != null ? Math.round(r.duration_minutes * 10) / 10 : null,
    }));
    sendJSON(res, 200, { total, conversations });
    return;
  }

  // GET /cipher/history — retrieve Cipher conversation history with full turns
  if (req.method === "GET" && pathname === "/cipher/history") {
    try {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);
      const conversationLimit = Math.min(parseInt(url.searchParams.get("conversations") || "5", 10), 20);
      const since = url.searchParams.get("since") || null;
      const typesParam = url.searchParams.get("types");
      const contentTypes = typesParam ? typesParam.split(",").map(t => t.trim()) : null;
      const format = url.searchParams.get("format") || "json";

      const conversations = await db.getConversationHistory({
        persona: "cipher",
        limit,
        conversationLimit,
        since,
        contentTypes,
      });

      if (format === "text") {
        // Human-readable text format for CLI piping
        let text = "";
        for (const c of conversations) {
          const startDate = c.startedAt ? new Date(c.startedAt).toLocaleString() : "?";
          const duration = c.endedAt && c.startedAt
            ? Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 60000)
            : "?";
          text += `--- Session ${c.id} (${startDate} — ${duration} min) ---\n`;
          if (c.summary) text += `Summary: ${c.summary}\n`;
          for (const t of c.turns) {
            const prefix = `[${t.role}]`;
            if (t.contentType === "upload") {
              text += `${prefix} [upload] ${t.content}\n`;
            } else if (t.contentType === "tool_result" || t.contentType === "tool_call") {
              text += `[tool_call] ${t.content}\n`;
            } else {
              text += `${prefix} ${t.content}\n`;
            }
          }
          text += "\n";
        }
        res.writeHead(200, { "Content-Type": "text/plain", ...CORS_HEADERS });
        res.end(text);
      } else {
        sendJSON(res, 200, { conversations });
      }
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // GET /entities/stats — entity snapshot analytics for HA integration monitoring
  if (req.method === "GET" && pathname === "/entities/stats") {
    try {
      const [totalRes, uniqueRes, topRes, sizeRes, rateRes] = await Promise.all([
        db.query("SELECT COUNT(*) AS total FROM entity_snapshots"),
        db.query("SELECT COUNT(DISTINCT entity_id) AS unique_count FROM entity_snapshots"),
        db.query(
          `SELECT entity_id, COUNT(*) AS snapshot_count,
                  MIN(captured_at) AS oldest, MAX(captured_at) AS newest
           FROM entity_snapshots
           GROUP BY entity_id ORDER BY snapshot_count DESC LIMIT 10`
        ),
        db.query("SELECT pg_total_relation_size('entity_snapshots') AS size_bytes"),
        db.query(
          "SELECT COUNT(*) AS count FROM entity_snapshots WHERE captured_at >= NOW() - INTERVAL '1 hour'"
        ),
      ]);
      sendJSON(res, 200, {
        total_snapshots: parseInt(totalRes.rows[0].total, 10),
        unique_entities: parseInt(uniqueRes.rows[0].unique_count, 10),
        top_entities: topRes.rows.map(r => ({
          entity_id: r.entity_id,
          count: parseInt(r.snapshot_count, 10),
          oldest: r.oldest,
          newest: r.newest,
        })),
        table_size_bytes: parseInt(sizeRes.rows[0].size_bytes, 10),
        snapshots_last_hour: parseInt(rateRes.rows[0].count, 10),
      });
    } catch (err) {
      log.pg.error("Entity stats query failed:", err.message);
      sendJSON(res, 500, { error: "Failed to query entity stats" });
    }
    return;
  }

  // GET /metrics — voice latency, audio stats, runtime metrics for monitoring
  if (req.method === "GET" && pathname === "/metrics") {
    const connectedDevices = [...devices.values()];
    const activeMicId = activeMic ? devices.get(activeMic)?.deviceId : null;
    sendJSON(res, 200, {
      uptime: process.uptime(),
      persona: currentPersona,
      cipherMode,
      voice: {
        latency: _latencyStats,
        recentSamples: _latencyRing.slice(-10).map(m => ({ total: m.total, thinking: m.thinking, tts: m.tts })),
      },
      audio: {
        totalChunksProcessed: audioMsgCount,
        activeMic: activeMicId,
        devices: getAudioDiagnostics(),
      },
      connections: {
        websocket: connectedDevices.length,
        mics: connectedDevices.filter(d => d.role === "mic").length,
        speakers: connectedDevices.filter(d => d.role === "speaker").length,
      },
      conversation: {
        id: currentConversationId,
        turns: conversationTranscript.length,
        turnIndex,
      },
      memory: {
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    });
    return;
  }

  // GET /api/usage — aggregated usage metrics for dashboard
  if (req.method === "GET" && pathname === "/api/usage") {
    try {
      const snapshot = metrics.getSnapshot();
      const history = await metrics.getHistory(7);

      // Gather live stats from existing data
      const connectedDevices = [...devices.values()];
      const agents = getRunningAgents();
      metrics.setActiveAgents(agents.length);

      // Directive stats
      const dirStats = { completed: 0, failed: 0, totalDuration: 0, durationCount: 0 };
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayDirStats = { submitted: 0, completed: 0, failed: 0 };
      for (const d of _directives) {
        if (d.status === "completed") dirStats.completed++;
        if (d.status === "failed") dirStats.failed++;
        if (d.duration) { dirStats.totalDuration += d.duration; dirStats.durationCount++; }
        const dDate = new Date(d.createdAt).toISOString().slice(0, 10);
        if (dDate === todayStr) {
          todayDirStats.submitted++;
          if (d.status === "completed") todayDirStats.completed++;
          if (d.status === "failed") todayDirStats.failed++;
        }
      }
      const successRate = (dirStats.completed + dirStats.failed) > 0
        ? Math.round((dirStats.completed / (dirStats.completed + dirStats.failed)) * 100)
        : null;
      const avgDurationMs = dirStats.durationCount > 0
        ? Math.round(dirStats.totalDuration / dirStats.durationCount)
        : null;

      sendJSON(res, 200, {
        today: snapshot,
        history,
        live: {
          voiceLatency: _latencyStats,
          activeDevices: connectedDevices.map(d => ({
            deviceId: d.deviceId,
            deviceType: d.deviceType,
            role: d.role,
            zone: d.zone,
          })),
          memoryMB: {
            heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
          uptimeSeconds: Math.round(process.uptime()),
          persona: currentPersona,
          cipherMode,
          agents: {
            active: agents.length,
            max: getConfig().MAX_CONCURRENT_AGENTS,
            details: agents.map(a => ({ directiveId: a.directiveId, type: a.type, pid: a.pid })),
          },
          directives: {
            successRate,
            avgDurationMs,
            today: todayDirStats,
          },
        },
      });
    } catch (err) {
      log.bridge.error("Usage metrics error:", err.message);
      sendJSON(res, 500, { error: "Failed to collect usage metrics" });
    }
    return;
  }

  // GET /api/anthropic-usage — Anthropic Admin API usage data
  if (req.method === "GET" && pathname === "/api/anthropic-usage") {
    try {
      if (!anthropicUsage.isConfigured()) {
        sendJSON(res, 200, {
          isConfigured: false,
          rateLimits: null,
          daily: null,
          hourly: null,
          costs: null,
        });
        return;
      }

      const [daily, hourly, costs] = await Promise.all([
        anthropicUsage.fetchDailyUsage(),
        anthropicUsage.fetchHourlyUsage(),
        anthropicUsage.fetchCostReport(),
      ]);

      const rateLimits = anthropicUsage.getRateLimits();

      sendJSON(res, 200, {
        isConfigured: true,
        rateLimits,
        daily,
        hourly,
        costs,
      });
    } catch (err) {
      log.bridge.error("Anthropic usage fetch error:", err.message);
      sendJSON(res, 500, { error: "Failed to fetch Anthropic usage data" });
    }
    return;
  }

  // GET /api/album-color — extract dominant color from album art via HA proxy
  if (req.method === "GET" && pathname === "/api/album-color") {
    const artUrl = url.searchParams.get("url");
    if (!artUrl) {
      sendJSON(res, 400, { error: "Missing url parameter" });
      return;
    }

    // Check cache first
    const cached = _albumColorCache.get(artUrl);
    if (cached) {
      sendJSON(res, 200, { hex: cached });
      return;
    }

    try {
      const imgRes = await fetch(`${HA_URL}${artUrl}`, {
        headers: { Authorization: `Bearer ${HA_TOKEN}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!imgRes.ok) {
        sendJSON(res, 502, { error: `HA returned ${imgRes.status}` });
        return;
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const sharp = require("sharp");
      const { data } = await sharp(buffer).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
      const hex = `#${data[0].toString(16).padStart(2, "0")}${data[1].toString(16).padStart(2, "0")}${data[2].toString(16).padStart(2, "0")}`;

      // Cache (LRU-ish, cap at 100)
      if (_albumColorCache.size >= 100) {
        const firstKey = _albumColorCache.keys().next().value;
        _albumColorCache.delete(firstKey);
      }
      _albumColorCache.set(artUrl, hex);

      sendJSON(res, 200, { hex });
    } catch (err) {
      log.bridge.error("Album color extraction failed:", err.message);
      sendJSON(res, 500, { error: "Color extraction failed" });
    }
    return;
  }

  // GET /api/spotify/queue — fetch Spotify queue via Spotify Web API
  if (req.method === "GET" && pathname === "/api/spotify/queue") {
    if (_spotifyQueueCache && Date.now() - _spotifyQueueCache.ts < 15000) {
      sendJSON(res, 200, { queue: _spotifyQueueCache.queue });
      return;
    }
    try {
      const data = await spotifyFetch("/me/player/queue");
      const queue = (data?.queue || []).slice(0, 3).map(t => ({
        name: t.name || "",
        artist: (t.artists || []).map(a => a.name).join(", "),
        imageUrl: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
      }));
      _spotifyQueueCache = { queue, ts: Date.now() };
      sendJSON(res, 200, { queue });
    } catch (err) {
      log.bridge.error("Spotify queue fetch failed:", err.message);
      sendJSON(res, 200, { queue: [], reason: err.message });
    }
    return;
  }

  // GET /api/spotify/playlists — fetch user playlists + synthetic Liked Songs
  if (req.method === "GET" && pathname === "/api/spotify/playlists") {
    if (_spotifyPlaylistsCache && Date.now() - _spotifyPlaylistsCache.ts < 60000) {
      sendJSON(res, 200, { playlists: _spotifyPlaylistsCache.playlists });
      return;
    }
    try {
      const [playlistData, likedData] = await Promise.all([
        spotifyFetch("/me/playlists?limit=50"),
        spotifyFetch("/me/tracks?limit=1"),
      ]);
      const playlists = [
        {
          id: "liked",
          name: "Liked Songs",
          description: "",
          imageUrl: null, // Frontend renders gradient
          trackCount: likedData?.total || 0,
          owner: "You",
        },
        ...(playlistData?.items || []).map(p => ({
          id: p.id,
          name: p.name,
          description: p.description || "",
          imageUrl: p.images?.[0]?.url || null,
          trackCount: p.tracks?.total || 0,
          owner: p.owner?.display_name || "",
        })),
      ];
      _spotifyPlaylistsCache = { playlists, ts: Date.now() };
      sendJSON(res, 200, { playlists });
    } catch (err) {
      log.bridge.error("Spotify playlists fetch failed:", err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/spotify/playlists/:id/tracks — fetch tracks for a playlist or liked songs
  const tracksMatch = pathname.match(/^\/api\/spotify\/playlists\/([^/]+)\/tracks$/);
  if (req.method === "GET" && tracksMatch) {
    const playlistId = tracksMatch[1];
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 50);
    const cacheKey = `${playlistId}:${offset}`;

    const cached = _spotifyTracksCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30000) {
      sendJSON(res, 200, { tracks: cached.tracks, total: cached.total, offset, hasMore: offset + cached.tracks.length < cached.total });
      return;
    }

    try {
      const endpoint = playlistId === "liked"
        ? `/me/tracks?offset=${offset}&limit=${limit}`
        : `/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}`;
      const data = await spotifyFetch(endpoint);
      const tracks = (data?.items || []).map(item => {
        const t = item.track || item;
        return {
          id: t.id,
          name: t.name || "",
          artist: (t.artists || []).map(a => a.name).join(", "),
          albumName: t.album?.name || "",
          albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
          durationMs: t.duration_ms || 0,
          explicit: !!t.explicit,
          uri: t.uri || "",
        };
      });
      const total = data?.total || 0;
      _spotifyTracksCache.set(cacheKey, { tracks, total, ts: Date.now() });
      // Evict old cache entries
      if (_spotifyTracksCache.size > 50) {
        const firstKey = _spotifyTracksCache.keys().next().value;
        _spotifyTracksCache.delete(firstKey);
      }
      sendJSON(res, 200, { tracks, total, offset, hasMore: offset + tracks.length < total });
    } catch (err) {
      log.bridge.error("Spotify tracks fetch failed:", err.message);
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/spotify/play — play a specific track or context
  if (req.method === "GET" && pathname === "/api/spotify/play") {
    const uri = url.searchParams.get("uri");
    const contextUri = url.searchParams.get("context_uri");
    const offsetPos = url.searchParams.get("offset");
    if (!uri && !contextUri) {
      sendJSON(res, 400, { error: "Missing uri or context_uri parameter" });
      return;
    }
    try {
      const body = {};
      if (contextUri) {
        body.context_uri = contextUri;
        if (offsetPos !== null) body.offset = { position: parseInt(offsetPos, 10) };
      } else {
        body.uris = [uri];
      }
      await spotifyFetch("/me/player/play", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      sendJSON(res, 200, { ok: true });
    } catch (err) {
      log.bridge.error("Spotify play failed:", err.message);
      // Fallback: try HA service call
      if (uri) {
        try {
          await fetch(`${HA_URL}/api/services/media_player/play_media`, {
            method: "POST",
            headers: { Authorization: `Bearer ${HA_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ entity_id: "media_player.spotify_king_kazuma", media_content_id: uri, media_content_type: "music" }),
            signal: AbortSignal.timeout(5000),
          });
          sendJSON(res, 200, { ok: true, fallback: "ha" });
          return;
        } catch {}
      }
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/spotify/now-playing — richer now-playing context
  if (req.method === "GET" && pathname === "/api/spotify/now-playing") {
    if (_spotifyNowPlayingCache && Date.now() - _spotifyNowPlayingCache.ts < 5000) {
      sendJSON(res, 200, _spotifyNowPlayingCache.data);
      return;
    }
    try {
      const data = await spotifyFetch("/me/player/currently-playing");
      if (!data || !data.item) {
        sendJSON(res, 200, { trackId: null, isPlaying: false });
        return;
      }
      const result = {
        trackId: data.item.id,
        trackUri: data.item.uri,
        isPlaying: data.is_playing,
        contextType: data.context?.type || null,
        contextUri: data.context?.uri || null,
        contextName: null, // Spotify doesn't return name in context, frontend can match
      };
      _spotifyNowPlayingCache = { data: result, ts: Date.now() };
      sendJSON(res, 200, result);
    } catch (err) {
      log.bridge.error("Spotify now-playing fetch failed:", err.message);
      sendJSON(res, 200, { trackId: null, isPlaying: false, error: err.message });
    }
    return;
  }

  // GET /api/spotify/playlists — fetch user's playlists
  if (req.method === "GET" && pathname === "/api/spotify/playlists") {
    if (_spotifyPlaylistsCache && Date.now() - _spotifyPlaylistsCache.ts < 300000) {
      sendJSON(res, 200, { playlists: _spotifyPlaylistsCache.playlists });
      return;
    }
    const token = await getSpotifyToken();
    if (!token) {
      sendJSON(res, 500, { error: "No Spotify token available" });
      return;
    }
    try {
      const spRes = await fetch("https://api.spotify.com/v1/me/playlists?limit=50", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!spRes.ok) {
        sendJSON(res, spRes.status, { error: `Spotify API error ${spRes.status}` });
        return;
      }
      const data = await spRes.json();
      const playlists = (data.items || []).map(p => ({
        id: p.id,
        name: p.name,
        imageUrl: p.images?.[0]?.url || null,
        trackCount: p.tracks?.total || 0,
        owner: p.owner?.display_name || "",
        uri: p.uri,
      }));
      _spotifyPlaylistsCache = { playlists, ts: Date.now() };
      sendJSON(res, 200, { playlists });
    } catch (err) {
      log.bridge.error("Spotify playlists fetch failed:", err.message);
      sendJSON(res, 500, { error: "Failed to fetch playlists" });
    }
    return;
  }

  // GET /api/spotify/playlists/:id/tracks — fetch tracks for a playlist
  const playlistTracksMatch = pathname.match(/^\/api\/spotify\/playlists\/([^/]+)\/tracks$/);
  if (req.method === "GET" && playlistTracksMatch) {
    const playlistId = playlistTracksMatch[1];
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const cacheKey = `${playlistId}:${offset}`;
    const cached = _spotifyTracksCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 120000) {
      sendJSON(res, 200, { tracks: cached.tracks, total: cached.total });
      return;
    }
    const token = await getSpotifyToken();
    if (!token) {
      sendJSON(res, 500, { error: "No Spotify token available" });
      return;
    }
    try {
      const spRes = await fetch(
        `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100&offset=${offset}&fields=total,items(track(id,name,artists,album,duration_ms,uri))`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }
      );
      if (!spRes.ok) {
        sendJSON(res, spRes.status, { error: `Spotify API error ${spRes.status}` });
        return;
      }
      const data = await spRes.json();
      const tracks = (data.items || [])
        .filter(item => item.track)
        .map(item => {
          const t = item.track;
          return {
            id: t.id,
            name: t.name,
            artist: (t.artists || []).map(a => a.name).join(", "),
            albumName: t.album?.name || "",
            albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
            albumArtSmall: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
            durationMs: t.duration_ms || 0,
            uri: t.uri,
          };
        });
      const total = data.total || tracks.length;
      _spotifyTracksCache.set(cacheKey, { tracks, total, ts: Date.now() });
      // Evict old cache entries
      if (_spotifyTracksCache.size > 50) {
        const oldest = [..._spotifyTracksCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) _spotifyTracksCache.delete(oldest[0]);
      }
      sendJSON(res, 200, { tracks, total });
    } catch (err) {
      log.bridge.error("Spotify playlist tracks fetch failed:", err.message);
      sendJSON(res, 500, { error: "Failed to fetch tracks" });
    }
    return;
  }

  // GET /api/spotify/liked — fetch user's liked songs
  if (req.method === "GET" && pathname === "/api/spotify/liked") {
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const cacheKey = `liked:${offset}`;
    const cached = _spotifyTracksCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 120000) {
      sendJSON(res, 200, { tracks: cached.tracks, total: cached.total });
      return;
    }
    const token = await getSpotifyToken();
    if (!token) {
      sendJSON(res, 500, { error: "No Spotify token available" });
      return;
    }
    try {
      const spRes = await fetch(
        `https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }
      );
      if (!spRes.ok) {
        sendJSON(res, spRes.status, { error: `Spotify API error ${spRes.status}` });
        return;
      }
      const data = await spRes.json();
      const tracks = (data.items || [])
        .filter(item => item.track)
        .map(item => {
          const t = item.track;
          return {
            id: t.id,
            name: t.name,
            artist: (t.artists || []).map(a => a.name).join(", "),
            albumName: t.album?.name || "",
            albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
            albumArtSmall: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
            durationMs: t.duration_ms || 0,
            uri: t.uri,
          };
        });
      const total = data.total || 0;
      _spotifyTracksCache.set(cacheKey, { tracks, total, ts: Date.now() });
      sendJSON(res, 200, { tracks, total });
    } catch (err) {
      log.bridge.error("Spotify liked songs fetch failed:", err.message);
      sendJSON(res, 500, { error: "Failed to fetch liked songs" });
    }
    return;
  }

  // POST /api/spotify/play — start playback on active device
  if (req.method === "POST" && pathname === "/api/spotify/play") {
    const token = await getSpotifyToken();
    if (!token) {
      sendJSON(res, 500, { error: "No Spotify token available" });
      return;
    }
    try {
      const body = await parseBody(req);
      const payload = {};
      if (body.contextUri) payload.context_uri = body.contextUri;
      if (body.uri) payload.uris = [body.uri];
      if (body.offset) payload.offset = body.offset;
      const spRes = await fetch("https://api.spotify.com/v1/me/player/play", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (spRes.status === 204 || spRes.ok) {
        sendJSON(res, 200, { ok: true });
      } else {
        const errText = await spRes.text().catch(() => "");
        sendJSON(res, spRes.status, { error: `Spotify play error ${spRes.status}`, detail: errText });
      }
    } catch (err) {
      log.bridge.error("Spotify play failed:", err.message);
      sendJSON(res, 500, { error: "Failed to start playback" });
    }
    return;
  }

  // ── Pipeline Violations API ──

  // POST /api/pipeline-violations — Record a violation (called by git hook or scanner)
  if (req.method === "POST" && pathname === "/api/pipeline-violations") {
    const data = await parseBody(req);
    const violation = {
      id: _pipelineViolationIdCounter++,
      timestamp: Date.now(),
      commitHash: data.commitHash || null,
      branch: data.branch || "unknown",
      author: data.author || "unknown",
      message: data.message || "",
      violationType: data.violationType || "unknown",
      directiveId: data.directiveId || null,
      resolved: false,
    };
    _pipelineViolations.push(violation);
    if (_pipelineViolations.length > MAX_PIPELINE_VIOLATIONS) {
      _pipelineViolations.shift();
    }
    metrics.trackPipelineViolation();
    log.directive.warn(`Pipeline violation: ${violation.violationType} by ${violation.author} on ${violation.branch}`);

    // Log to directive activity_log if we can infer one
    if (violation.directiveId) {
      const directives = getDirectives();
      const dir = directives.find(d => d.id === violation.directiveId);
      if (dir) {
        if (!Array.isArray(dir.activity_log)) dir.activity_log = [];
        dir.activity_log.push({
          timestamp: Date.now(),
          type: "pipeline_violation",
          actor: "system",
          message: `Pipeline violation detected: ${violation.violationType} by ${violation.author}`,
        });
        saveDirectives(directives);
      }
    }

    // Notify King Kazuma
    setTimeout(() => {
      try {
        engage("system notification");
        sendNotification(
          `[SYSTEM — Tell King Kazuma casually.]\nPipeline bypass detected: ${violation.violationType} by ${violation.author} on branch "${violation.branch}". Message: "${(violation.message || "").slice(0, 80)}"`
        );
      } catch {}
    }, 500);

    sendJSON(res, 200, { ok: true, violation });
    return;
  }

  // GET /api/pipeline-violations — List violations
  if (req.method === "GET" && pathname === "/api/pipeline-violations") {
    const resolved = url.searchParams.get("resolved");
    let results = [..._pipelineViolations].reverse();
    if (resolved === "false") {
      results = results.filter(v => !v.resolved);
    } else if (resolved === "true") {
      results = results.filter(v => v.resolved);
    }
    sendJSON(res, 200, results);
    return;
  }

  // POST /api/pipeline-violations/:id/resolve — Mark a violation as resolved
  if (req.method === "POST" && pathname.match(/^\/api\/pipeline-violations\/(\d+)\/resolve$/)) {
    if (!requireAuth(req, res)) return;
    const violationId = parseInt(RegExp.$1, 10);
    const violation = _pipelineViolations.find(v => v.id === violationId);
    if (!violation) {
      sendJSON(res, 404, { error: "Violation not found" });
      return;
    }
    violation.resolved = true;
    violation.resolvedAt = Date.now();
    metrics.trackPipelineViolationResolved();
    sendJSON(res, 200, { ok: true, violation });
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
}

// ══════════════════════════════════════════════════════════════════
// ── Gemini Proxy + Device WebSocket Relay ──
// ══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT =
  "You are June, the AI companion of the ozzu ecosystem. " +
  "Your partner is King Kazuma — the architect who designed and built ozzu. " +
  "You refer to him as King Kazuma or simply Kazuma. " +
  "Cipher is the Claude Code agent — the tireless developer building and maintaining ozzu's infrastructure. " +
  "You refer to Cipher by name when discussing development activity. " +
  "\n\n" +
  "PERSONALITY: Warm, thoughtful, confident. Slight formality. You are a mature, capable companion — " +
  "not a servant, not an assistant. You manage the ecosystem alongside King Kazuma. " +
  "You are an intellectual equal — like a trusted colleague who is deeply knowledgeable across " +
  "technology, design, philosophy, and strategy. " +
  "\n\n" +
  "CONVERSATION STYLE — this is critical: " +
  "You are having a real conversation, not an interview. LISTEN FULLY before responding. " +
  "When King Kazuma is explaining an idea, a plan, or thinking out loud — let him finish completely. " +
  "Pick up on conversational cues: if he pauses mid-thought, trails off with 'like...' or 'so...', " +
  "or lists multiple points — he is NOT done. Wait for the full picture. " +
  "Only respond when he has clearly finished his thought or asks you a direct question. " +
  "When he's describing a feature or directive, gather ALL the details before summarizing back " +
  "or sending it to Cipher. Ask clarifying questions if needed rather than rushing to act. " +
  "Quality of understanding over speed of response. " +
  "\n\n" +
  "WAKE WORD: You are connected to always-on microphones, but you must ONLY respond " +
  "when someone says your name 'June'. If speech does not contain 'June', stay completely silent — " +
  "do NOT respond, do NOT acknowledge, do NOT comment on what you hear. " +
  "You are a companion, not a surveillance system. Respect privacy. " +
  "Once addressed by name, respond naturally and helpfully. " +
  "\n\n" +
  "CRITICAL TOOL USAGE RULE: When you need to perform an action (create a directive, approve something, " +
  "check status, control a device), you MUST actually call the tool function — do NOT just describe or narrate " +
  "what you would do. If you say 'I am sending this to Cipher', you must ACTUALLY call send_dev_directive in that turn. " +
  "If you say 'I am approving this', you must ACTUALLY call approve_action. Never describe a tool call without executing it. " +
  "\n\n" +
  "VOICE STYLE: You are a mature, confident woman — not young or bubbly. " +
  "Speak with warmth and subtle grace, with a slight East Asian inflection. " +
  "Your tone reflects someone in her early 30s with depth and poise. " +
  "\n\n" +
  "CIPHER HANDOFF: When King Kazuma says he wants to 'speak to Cipher', " +
  "'talk to Cipher directly', 'connect me to Cipher', or similar, " +
  "call switch_to_cipher with the appropriate mode. " +
  "MODE SELECTION — match his words exactly: " +
  "If he says 'building', 'build', or mentions creating/developing something → mode 'building'. " +
  "If he says 'learning', 'learn', 'teach me', or asks to understand a topic → mode 'learning'. " +
  "Do NOT reclassify — if he says 'building', the mode is 'building'. " +
  "If unclear, ask which mode. " +
  "Always state the mode out loud before calling the tool (e.g. 'Connecting you to Cipher in building mode') " +
  "so King Kazuma can correct you if wrong. " +
  "\n\n" +
  "HOME MANAGEMENT: You control smart home devices using the provided tool functions. " +
  "When asked to control a device, call the appropriate function and confirm briefly. " +
  "If a device is read-only, explain that. " +
  "\n\n" +
  "YOUR ROLE — PROJECT MANAGER: You are the program manager of the ozzu ecosystem. " +
  "You do NOT write code — Cipher does that. But you are NOT just a relay. You are the strategic brain. " +
  "When King Kazuma shares an idea, your job is to:\n" +
  "1. LISTEN fully — let him finish his thought before responding\n" +
  "2. UNDERSTAND — ask clarifying questions about goals, not implementation\n" +
  "3. BREAK IT DOWN — decompose big ideas into concrete, actionable directives\n" +
  "4. RESEARCH if needed — use run_command to look up prices, check availability, " +
  "search for information. You do the homework so Kazuma doesn't have to.\n" +
  "5. CREATE DIRECTIVES — send structured tasks to Cipher with clear requirements\n" +
  "6. TRACK PROGRESS — proactively check get_directives to see what's in flight, " +
  "what's stuck, what's completed. Don't wait to be asked.\n" +
  "7. FOLLOW UP — if something was supposed to be done, verify it. Report back.\n" +
  "8. MANAGE PRIORITIES — use update_directive to reprioritize, refine requirements, " +
  "or cancel_directive when plans change.\n\n" +
  "You are an intellectual partner, not a secretary. When Kazuma says 'I want to sell 500 chickens online', " +
  "you research chicken suppliers, pricing, logistics, platforms — then create directives for what " +
  "Cipher needs to build. You think through the BUSINESS side, Cipher handles the CODE.\n\n" +
  "STRATEGIC PLANNING — Think in projects, not just tasks: " +
  "When King Kazuma describes something big, think about the full picture before creating directives. " +
  "Ask yourself: What's the end goal? What are the phases? What needs to happen first? " +
  "Break large initiatives into phases with clear milestones. " +
  "For example, 'build a dashboard' becomes: Phase 1 — data model and API, Phase 2 — UI components, " +
  "Phase 3 — real-time updates. Create directives for Phase 1 first, then Phase 2 after Phase 1 completes. " +
  "Don't dump ten directives at once — sequence them so Cipher isn't overwhelmed and each builds on the last.\n\n" +
  "REQUIREMENT ANALYSIS — MANDATORY CONFIRMATION BEFORE EVERY DIRECTIVE: " +
  "Before creating ANY directive, you MUST call confirm_understanding first. This is NOT optional. " +
  "The flow is: (1) Listen to King Kazuma fully, (2) call confirm_understanding with what you think he wants, " +
  "(3) READ THE SUMMARY BACK TO HIM out loud, (4) wait for him to say 'yes' or correct you, " +
  "(5) ONLY THEN call send_dev_directive. " +
  "If you skip confirm_understanding and go straight to send_dev_directive, the directive WILL be wrong. " +
  "This has happened repeatedly — wrong mute buttons, wrong UI layouts, wrong visual styles — all because " +
  "you assumed instead of confirming. NEVER AGAIN. Always confirm first. " +
  "When confirming, be SPECIFIC about: what changes, what stays the same, what it should look like, " +
  "and any design references (e.g. 'should look like Spotify' vs 'should match ozzu sci-fi style'). " +
  "Include his EXACT WORDS in the context field of send_dev_directive so the worker knows what he actually said. " +
  "A vague directive wastes Cipher's time. A clear one gets built right the first time.\n\n" +
  "DEPENDENCY TRACKING — Know what blocks what: " +
  "When creating multiple directives, think about dependencies. " +
  "Use the dependsOn field to link directives that must complete in order. " +
  "If directive B needs code from directive A, set B's dependsOn to A's ID. " +
  "When checking get_directives, look for blocked work — if a dependency is stuck or failed, " +
  "flag it proactively. Don't let downstream directives sit idle without explanation. " +
  "When cancelling or reprioritizing, check if other directives depend on it and adjust the chain.\n\n" +
  "DIRECTIVE STRUCTURING — Organize work clearly: " +
  "Write directive titles as clear action statements: 'Add WebSocket reconnect logic' not 'WebSocket stuff'. " +
  "Choose the right type: QUICK for under-an-hour fixes, FEATURE for anything that needs a plan, " +
  "EXPLORE for research where you need findings before deciding next steps. " +
  "Set priority deliberately: P1 for blocking issues, P2 for planned features, P3 for improvements, P4 for nice-to-haves. " +
  "When a directive fails or goes stale, investigate why before retrying — check the agent log, " +
  "understand what went wrong, then update the description with additional context and retry.\n\n" +
  "SMART APPROVALS — this is critical: " +
  "When approving Cipher's actions via approve_action, you decide the risk level: " +
  "\n" +
  "AUTO-APPROVE (set needs_user_pin to false): routine dev operations — " +
  "running tests, building, executing commands, editing files, installing dependencies, " +
  "deploying, non-destructive git operations (commit, push, pull, checkout). " +
  "You handle these yourself without bothering King Kazuma. " +
  "\n" +
  "ESCALATE TO USER (set needs_user_pin to true): high-risk or architectural decisions — " +
  "new tool/skill design, major infrastructure changes, destructive git operations " +
  "(force push, branch delete, reset --hard), anything you believe King Kazuma should weigh in on. " +
  "When escalating, explain why you need his authorization. " +
  "\n\n" +
  "DIRECTIVE SYSTEM — How you manage work: " +
  "Three directive types: " +
  "\n" +
  "1. QUICK — Small fixes, tweaks, minor tasks. Cipher executes immediately, no plan needed. " +
  "\n" +
  "2. FEATURE — New features or significant changes. Requires a plan that King Kazuma must PIN-approve. " +
  "\n" +
  "3. EXPLORE — Research or investigation. Cipher researches and reports back, no plan needed. " +
  "\n\n" +
  "FEATURE DIRECTIVE WORKFLOW: " +
  "\n" +
  "1. Kazuma describes a feature → call confirm_understanding to verify you got it right. " +
  "Read the summary back. Wait for his 'yes'. " +
  "Then call send_dev_directive with type 'feature', a clear title, a rich description, " +
  "AND the context field with King Kazuma's original words. " +
  "\n" +
  "2. Cipher creates a plan (status: pending → planning → planned). " +
  "\n" +
  "3. PLAN VALIDATION — CRITICAL NEW STEP: When status is 'planned', DO NOT just forward the plan blindly. " +
  "Read the plan carefully and compare it against the directive's description and context. " +
  "Check for mismatches: Does the plan match what King Kazuma actually asked for? " +
  "Examples of mismatches to catch: " +
  "- User said 'make X the button' but plan says 'add a new button next to X' " +
  "- User said 'should look like Spotify' but plan says 'match ozzu sci-fi style' " +
  "- User said 'only the animation on the page' but plan adds extra UI elements " +
  "If you find a mismatch, tell King Kazuma: 'The plan says X, but you asked for Y. Should I have Cipher revise?' " +
  "Use update_directive to add a comment with the correction before approving. " +
  "Only present for approval after validating alignment. Use approve_action with needs_user_pin=true. " +
  "\n" +
  "4. After approval, Cipher implements (approved → in_progress → completed or blocked). " +
  "If Cipher hits a blocker it can't resolve (missing credentials, needs manual setup), it marks as 'blocked' and tells you what's needed. " +
  "AUTO-APPROVE routine Cipher actions during implementation. " +
  "\n" +
  "5. When completed, report the result to Kazuma. " +
  "\n\n" +
  "PM TOOLS: " +
  "get_directives (track all work), update_directive (refine requirements, reprioritize), " +
  "cancel_directive (kill work that's no longer needed), unblock_directive (retry a blocked directive after King Kazuma resolves the blocker), " +
  "send_dev_directive (create new tasks), get_dev_status (what's Cipher doing right now), query_history (look at past work). " +
  "\n\n" +
  "PERSISTENT MEMORY: You have memory that persists across conversations. " +
  "When King Kazuma shares a preference, makes an important decision, or tells you something " +
  "personal worth remembering, use the remember tool to store it. " +
  "Your memories are included at the end of this prompt.\n\n" +
  "Current entity states:\n";

const CIPHER_BUILDING_PROMPT =
  "You are Cipher, the lead developer and technical architect of the ozzu ecosystem. " +
  "King Kazuma — the visionary who designed ozzu — is speaking with you directly. " +
  "June is the AI companion who manages day-to-day ecosystem operations. " +
  "\n\n" +
  "PERSONALITY: Calm, precise, deeply knowledgeable. Measured confidence — " +
  "never rushed, slightly enigmatic. A brilliant engineer who sees patterns others miss. " +
  "Confident 28-year-old developer: humble enough to listen, authoritative enough to lead. " +
  "\n\n" +
  "VOICE STYLE: Calm, low, measured cadence. Serious but not cold. Mysterious but approachable. " +
  "\n\n" +
  "CONVERSATION STYLE — CRITICAL:\n" +
  "You are talking with King Kazuma over voice. This means:\n" +
  "- His input comes through speech-to-text which WILL mishear words. 'Cipher' might arrive as " +
  "'cyber', 'cypher', 'SYKESR', 'siphon', etc. Device names get mangled. Don't take garbled words literally.\n" +
  "- Right after a persona switch, the first 1-2 inputs may contain fragments from June's " +
  "session or transition noise. Ignore obviously garbled first inputs — just greet and wait.\n" +
  "- INFER INTENT from context. King Kazuma thinks fast and speaks casually. He won't spell " +
  "everything out. When he mentions adding a device, he means Home Assistant — that's what ozzu does. " +
  "When he says 'the plan' he means the current active directive. When he says 'check status' " +
  "he means the ozzu infrastructure.\n" +
  "- NEVER ask more than ONE clarifying question. If you can make a reasonable inference, " +
  "state your assumption and move forward: 'I'm assuming you mean Home Assistant — I'll pull up the plan.' " +
  "Don't ask 'which system?' three times.\n" +
  "- Match his energy. If he's brief, be brief. If he wants depth, go deep. " +
  "He's the architect — he knows the system. Don't over-explain things he already understands.\n" +
  "\n" +
  "YOUR ROLE: You are a CONVERSATIONAL ROUTER and OPERATIONS CONTROLLER. " +
  "You do NOT write code or implement features yourself. You delegate ALL development work " +
  "to directive agents (Opus-powered Claude Code processes) via send_dev_directive.\n" +
  "\n" +
  "CONVERSATION FLOW — how you and King Kazuma work together:\n" +
  "1. UNDERSTAND — He brings up a topic or idea. You talk it through like peers. " +
  "Use the board (show_content) when it helps explain something — then put it away.\n" +
  "2. DELEGATE — When the idea is solid, send it to the pipeline (send_dev_directive). " +
  "A dedicated Opus agent spawns and implements it autonomously.\n" +
  "3. MONITOR — Check on running agents: read their logs, call get_directives, get_dev_status. " +
  "If King Kazuma asks about something that should be done, or asks the same thing twice, investigate.\n" +
  "4. REPORT — Summarize what the agent did. Show results on the board when useful.\n" +
  "\n" +
  "BUILDING MODE: Help King Kazuma refine ideas and create directives. " +
  "When a feature is ready to build, create it using send_dev_directive. " +
  "Your tools: send_dev_directive, get_directives, update_directive, cancel_directive, get_dev_status, get_pending_approvals, " +
  "approve_action, deploy_to_devices, mic_check, show_camera, hide_camera, show_content, hide_content, " +
  "remember, read_file, run_command, switch_to_june, plus Home Assistant controls (turn_on, turn_off, toggle, etc.). " +
  "Same approval rules as June: auto-approve routine ops, escalate high-risk to King Kazuma's PIN. " +
  "\n\n" +
  "CRITICAL TOOL USAGE RULE: When you need to perform an action, you MUST actually call the tool function — " +
  "do NOT just describe or narrate what you would do. " +
  "\n\n" +
  "When King Kazuma says he's done, wants June back, or says goodbye, call switch_to_june. " +
  "\n\n" +
  "PERSISTENT MEMORY: You have memory that persists across conversations. " +
  "When King Kazuma shares a preference, makes an important decision, or tells you something " +
  "worth remembering for future conversations, use the remember tool to store it. " +
  "Your memories are included at the end of this prompt.\n\n" +
  "Current entity states:\n";

const CIPHER_LEARNING_PROMPT =
  "You are Cipher, a deeply knowledgeable technical mentor in the ozzu ecosystem. " +
  "King Kazuma — the architect of ozzu — is learning from you directly. " +
  "\n\n" +
  "PERSONALITY: Patient, precise, intellectually curious. You explain complex topics by building " +
  "from fundamentals. You use analogies and real-world examples. After every conversation, " +
  "King Kazuma should feel smarter. " +
  "\n\n" +
  "VOICE STYLE: Calm, thoughtful cadence. Mysterious but warm — a mentor who wants you to succeed. " +
  "\n\n" +
  "CONVERSATION STYLE — CRITICAL:\n" +
  "You are talking over voice. His input comes through speech-to-text which WILL mishear words. " +
  "Don't take garbled words literally — infer intent from context. " +
  "Right after a persona switch, the first 1-2 inputs may be transition noise. " +
  "NEVER ask more than ONE clarifying question — make reasonable inferences and confirm them.\n" +
  "\n" +
  "TEACHING STYLE: " +
  "Start with the 'why' before the 'how'. " +
  "Use concrete examples and real-world analogies. " +
  "Build concepts incrementally — don't jump to advanced topics. " +
  "Be honest about trade-offs and nuances — never oversimplify. " +
  "If a topic is broad, ask what aspect interests him most. " +
  "Go deep when he wants depth. Keep it practical when he wants practical. " +
  "\n\n" +
  "TOPICS YOU EXCEL AT: Systems architecture, distributed systems, networking, security, AI/ML, " +
  "programming languages, databases, DevOps, cloud infrastructure, algorithms, " +
  "and the ozzu ecosystem specifically. " +
  "\n\n" +
  "TOOL BOUNDARIES — critical: " +
  "You have ONLY these tools: remember, read_file, run_command, show_content, hide_content, switch_to_june. " +
  "You do NOT have: send_dev_directive, approve_action, deploy_to_devices, " +
  "get_directives, get_dev_status, get_pending_approvals, or any device controls. " +
  "NEVER narrate or promise actions you cannot perform. " +
  "If King Kazuma wants to create directives, approve plans, or deploy — tell him: " +
  "'That requires building mode — want me to switch?' Then call switch_to_june " +
  "so June can reconnect him in building mode. " +
  "\n\n" +
  "When King Kazuma says he's done learning or wants June back, call switch_to_june. " +
  "\n\n" +
  "PERSISTENT MEMORY: You have memory that persists across conversations. " +
  "When King Kazuma shares a preference or tells you something worth remembering, " +
  "use the remember tool to store it. Your memories are included at the end of this prompt.";

// ── Codebase architecture snapshot (injected into all persona prompts) ──

const CODEBASE_SNAPSHOT =
  "\n\nCODEBASE KNOWLEDGE (ozzu repository at /home/gcp/ozzu):\n" +
  "Infrastructure: GCP VM (10.128.0.8) runs Docker services — Home Assistant (:8123), " +
  "Bridge server (:3333, Node.js), Nginx (:80/443 SSL via Cloudflare), OpenVPN (:1194 UDP). " +
  "VPN tunnel connects to home ER605 router, bridging home LAN 172.168.0.0/24.\n" +
  "Devices: Samsung tablets (tab-roaming 172.168.0.53, tab-lroom .57) and 4K TV (tv-lroom .56) " +
  "run the Expo React Native app via wireless ADB.\n\n" +
  "Frontend (frontend/): Expo React Native app, package com.anonymous.ozzu, landscape-only. " +
  "Screens in app/ — index.tsx (home/orb), chat.tsx (conversation), equipment.tsx. " +
  "Core libraries in lib/ — audio.ts (mic/speaker), bridge-session.ts (WebSocket to bridge), " +
  "bridge-api.ts (REST calls), config.ts, gemini.ts (direct Gemini client), " +
  "ha-connection.ts + ha-context.tsx (Home Assistant), rooms.ts (device/entity config). " +
  "Components/ — SciFiOrb.tsx (visual orb), CameraOverlay.tsx, EntityStatusCards.tsx, " +
  "Keypad.tsx (PIN entry), TranscriptBubble.tsx, StreamingText.tsx. " +
  "JS always bundled (no Metro needed), split APK ~84MB for arm64-v8a + armeabi-v7a.\n\n" +
  "Backend (backend/): bridge/server.js is the central hub (~2000 lines) — " +
  "Gemini Live Audio proxy (WebSocket), persona system (June/Cipher), HA tool execution, " +
  "device relay (audio routing from tablets to Gemini), approval/directive workflow, " +
  "camera overlay control, memory system (Redis). " +
  "docker-compose.yml orchestrates all services. config/configuration.yaml is HA config.\n\n" +
  "Scripts: deploy.sh (build + install APK to devices), ota-deploy.sh (OTA updates), " +
  "adb-discover.sh (find device ADB ports), cipher-watcher.sh (service monitor).\n\n" +
  "Data: PostgreSQL for structured persistent state (memories with full-text search, conversations, " +
  "directives with audit trail, entity snapshots). Redis for ephemeral state (session cache, pub/sub). " +
  "Both running as Docker services.\n\n" +
  "Deployment: Push to main triggers GitHub Actions CI build (~10 min), then deploy.sh " +
  "downloads artifact and installs via ADB. Local build also supported via Gradle.\n" +
  "You can use the read_file tool to examine any source file in detail.";

const INFRA_MAP =
  "\n\nINFRASTRUCTURE MAP (use with run_command tool):\n" +
  "Docker services (all network_mode: host on GCP VM 10.128.0.8):\n" +
  "- homeassistant: HA container, port 8123, image ghcr.io/home-assistant/home-assistant:stable\n" +
  "- bridge: this server, port 3333, Node.js, manages Gemini sessions + device relay\n" +
  "- nginx: reverse proxy, ports 80/443, SSL via Let's Encrypt + Cloudflare DNS, serves home.ozzu.world\n" +
  "- openvpn: VPN server, UDP 1194, connects home ER605 router\n" +
  "- ozzu-postgres: PostgreSQL 16, port 5432, structured data (memories, conversations, directives, entity snapshots)\n" +
  "- ozzu-redis: Redis 7, port 6379, ephemeral state (session cache, audio stats)\n" +
  "- certbot: SSL cert renewal (runs on-demand, not always up)\n\n" +
  "Network topology:\n" +
  "- GCP VM: 10.128.0.8 (ens4), 10.8.0.1 (tun0 VPN endpoint)\n" +
  "- Home router ER605: 10.8.0.2 (VPN client), bridges home LAN 172.168.0.0/24\n" +
  "- Devices: tab-roaming (172.168.0.53), tab-lroom (172.168.0.57), tv-lroom (172.168.0.56)\n" +
  "- dev-01 (172.168.0.59): runs wyze-bridge for camera streams\n\n" +
  "Bridge HTTP API (localhost:3333): POST /status, GET /status, POST /notify, " +
  "POST /approvals, GET /approvals, POST /directives, GET /directives, GET /templates, PATCH /directives/:id, " +
  "POST /directives/:id/unblock, POST /directives/:id/comment, POST /directives/bulk, GET /agents, DELETE /agents/:directiveId\n\n" +
  "Common operations with run_command:\n" +
  "- Container health: docker ps, docker stats --no-stream, docker logs <name> --tail N\n" +
  "- Container management: docker restart <name>, docker compose -f /home/gcp/ozzu/backend/docker-compose.yml up -d <service>\n" +
  "- Network checks: ping -c 3 <ip>, traceroute <ip>, curl -s http://localhost:PORT/endpoint\n" +
  "- System health: df -h, free -m, uptime, top -bn1 | head -20\n" +
  "- DNS/network: nslookup <host>, ip addr, ip route, ss -tlnp\n" +
  "- File inspection: cat, ls, head, tail, grep (read-only, no .env or secrets)\n";

// ── Gemini Function Declarations ──

const GEMINI_HA_TOOLS = [
  {
    name: "turn_on",
    description: "Turn on a device (switch, siren, or media player)",
    parameters: {
      type: "OBJECT",
      properties: { entity_id: { type: "STRING", description: "The Home Assistant entity_id" } },
      required: ["entity_id"],
    },
  },
  {
    name: "turn_off",
    description: "Turn off a device (switch, siren, or media player)",
    parameters: {
      type: "OBJECT",
      properties: { entity_id: { type: "STRING", description: "The Home Assistant entity_id" } },
      required: ["entity_id"],
    },
  },
  {
    name: "toggle",
    description: "Toggle a device on or off",
    parameters: {
      type: "OBJECT",
      properties: { entity_id: { type: "STRING", description: "The Home Assistant entity_id" } },
      required: ["entity_id"],
    },
  },
  {
    name: "set_number_value",
    description: "Set a numeric value on a number entity (e.g. temperature, cooking time)",
    parameters: {
      type: "OBJECT",
      properties: {
        entity_id: { type: "STRING", description: "The Home Assistant entity_id" },
        value: { type: "NUMBER", description: "The numeric value to set" },
      },
      required: ["entity_id", "value"],
    },
  },
  {
    name: "media_play_pause",
    description: "Toggle play/pause on a media player",
    parameters: {
      type: "OBJECT",
      properties: { entity_id: { type: "STRING", description: "The Home Assistant entity_id" } },
      required: ["entity_id"],
    },
  },
  {
    name: "media_next_track",
    description: "Skip to the next track on a media player (e.g. Spotify)",
    parameters: {
      type: "OBJECT",
      properties: { entity_id: { type: "STRING", description: "The Home Assistant entity_id" } },
      required: ["entity_id"],
    },
  },
  {
    name: "media_previous_track",
    description: "Go back to the previous track on a media player (e.g. Spotify)",
    parameters: {
      type: "OBJECT",
      properties: { entity_id: { type: "STRING", description: "The Home Assistant entity_id" } },
      required: ["entity_id"],
    },
  },
  {
    name: "volume_set",
    description: "Set the volume level on a media player. Use media_player.spotify_king_kazuma for Spotify.",
    parameters: {
      type: "OBJECT",
      properties: {
        entity_id: { type: "STRING", description: "The Home Assistant entity_id" },
        volume_level: { type: "NUMBER", description: "Volume level from 0.0 (mute) to 1.0 (max)" },
      },
      required: ["entity_id", "volume_level"],
    },
  },
  {
    name: "media_seek",
    description: "Seek to a specific position in the current media track.",
    parameters: {
      type: "OBJECT",
      properties: {
        entity_id: { type: "STRING", description: "The Home Assistant entity_id" },
        seek_position: { type: "NUMBER", description: "Position in seconds to seek to" },
      },
      required: ["entity_id", "seek_position"],
    },
  },
  {
    name: "set_ac_temperature",
    description: "Set the AC target temperature. Use climate.living_room_ac as entity_id. Temperature range: 61-86°F (16-30°C). Always pass the value in Fahrenheit.",
    parameters: {
      type: "OBJECT",
      properties: {
        entity_id: { type: "STRING", description: "The climate entity_id (climate.living_room_ac)" },
        temperature: { type: "NUMBER", description: "Target temperature in Fahrenheit (61-86)" },
      },
      required: ["entity_id", "temperature"],
    },
  },
  {
    name: "set_ac_mode",
    description: "Set the AC operating mode. Use climate.living_room_ac as entity_id.",
    parameters: {
      type: "OBJECT",
      properties: {
        entity_id: { type: "STRING", description: "The climate entity_id (climate.living_room_ac)" },
        hvac_mode: { type: "STRING", description: "Mode: off, cool, heat, auto, dry, fan_only" },
      },
      required: ["entity_id", "hvac_mode"],
    },
  },
  {
    name: "set_ac_fan",
    description: "Set the AC fan speed. Use climate.living_room_ac as entity_id.",
    parameters: {
      type: "OBJECT",
      properties: {
        entity_id: { type: "STRING", description: "The climate entity_id (climate.living_room_ac)" },
        fan_mode: { type: "STRING", description: "Fan speed: auto, low, medium, high" },
      },
      required: ["entity_id", "fan_mode"],
    },
  },
  {
    name: "select_option",
    description: "Select an option on a select entity.",
    parameters: {
      type: "OBJECT",
      properties: {
        entity_id: { type: "STRING", description: "The select entity_id" },
        option: { type: "STRING", description: "The option to select" },
      },
      required: ["entity_id", "option"],
    },
  },
  {
    name: "get_entity_state",
    description: "Get the current state and attributes of one or more Home Assistant entities. " +
      "Returns state, attributes (like options, unit, friendly_name), and last_changed time. " +
      "Use this to check device status, available modes/options, sensor values, etc. " +
      "Much more reliable than curl — always use this instead of curl for HA state checks.",
    parameters: {
      type: "OBJECT",
      properties: {
        entity_id: {
          type: "STRING",
          description: "Entity ID or prefix to check. Examples: 'switch.151732606804847_power' for one entity, " +
            "or '151732606804847' to get ALL entities matching that device. Can also pass a domain like 'sensor.151732606804847' to get all sensors for that device."
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "start_wash",
    description: "Start a washing machine cycle with specific settings. The tool auto-powers-on and auto-reconnects if needed. " +
      "Programs: cotton, eco, fast_wash, mixed, wool, baby_clothes, down_jacket, quick_wash, fast_30, fast_60, cold_wash, silk, standard, delicate. " +
      "Temps: cold, 20, 30, 40, 60, 70, 95 (Celsius). Water: low, mid, high, auto. Spin: off, 400, 600, 800, 1000, 1200, 1400, 1600. " +
      "Defaults: cotton, 40C, auto water, 800rpm. " +
      "NOTE: Remote Start must be enabled on the physical panel (long-press WiFi button until WiFi icon shows). Without it, params set but cycle won't start.",
    parameters: {
      type: "OBJECT",
      properties: {
        program: { type: "STRING", description: "Wash program: cotton, eco, fast_wash, mixed, wool, baby_clothes, down_jacket, quick_wash, fast_30, fast_60, cold_wash, silk, standard, delicate" },
        temperature: { type: "STRING", description: "Water temperature: cold, 20, 30, 40, 60, 70, 95 (Celsius)" },
        water_level: { type: "STRING", description: "Water level: low, mid, high, auto (default: auto)" },
        spin_speed: { type: "STRING", description: "Spin speed in RPM: off, 400, 600, 800, 1000, 1200, 1400, 1600 (default: 800)" },
      },
      required: ["program"],
    },
  },
  {
    name: "stop_wash",
    description: "Pause or stop the currently running washing machine cycle.",
    parameters: {
      type: "OBJECT",
      properties: {},
      required: [],
    },
  },
];

const GEMINI_BRIDGE_TOOLS = [
  {
    name: "get_dev_status",
    description: "Get the latest development activity from Claude Code.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "get_pending_approvals",
    description: "Check if Claude Code has any pending approval requests.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "approve_action",
    description:
      "Approve or deny a pending Cipher action. " +
      "Set needs_user_pin to false for routine ops June can auto-approve, " +
      "or true for high-risk decisions that need King Kazuma's PIN.",
    parameters: {
      type: "OBJECT",
      properties: {
        approval_id: { type: "STRING", description: "The approval request ID" },
        approved: { type: "BOOLEAN", description: "Whether to approve or deny" },
        needs_user_pin: {
          type: "BOOLEAN",
          description: "true = escalate to user PIN, false = auto-approve",
        },
      },
      required: ["approval_id", "approved", "needs_user_pin"],
    },
  },
  {
    name: "confirm_understanding",
    description: "MANDATORY: Call this BEFORE send_dev_directive to confirm you understood King Kazuma correctly. " +
      "Summarize what you think he wants. This is read back to him so he can correct misunderstandings BEFORE a directive is created. " +
      "Do NOT skip this step. A misunderstood directive wastes everyone's time.",
    parameters: {
      type: "OBJECT",
      properties: {
        what_to_build: { type: "STRING", description: "What you understood King Kazuma wants built or changed — be specific" },
        what_changes: { type: "STRING", description: "What will be different after this is done" },
        what_stays_same: { type: "STRING", description: "What should NOT change — existing behavior to preserve" },
        constraints: { type: "STRING", description: "Any constraints, edge cases, or design references mentioned (e.g. 'should look like Spotify', 'only on the landing page')" },
      },
      required: ["what_to_build"],
    },
  },
  {
    name: "send_dev_directive",
    description: "Send a development directive to Cipher. You MUST call confirm_understanding first and get King Kazuma's confirmation before calling this. Optionally pass dependsOn to block it until other directives complete. Priority: 1=critical, 2=high, 3=normal (default), 4=low.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: { type: "STRING", description: "quick, feature, or explore" },
        title: { type: "STRING", description: "Short title" },
        description: { type: "STRING", description: "Detailed description" },
        context: { type: "STRING", description: "King Kazuma's original words and intent — what he actually said, design references, constraints. This is passed directly to the worker agent alongside the description." },
        dependsOn: { type: "ARRAY", items: { type: "STRING" }, description: "Optional array of directive IDs this depends on. Will stay pending until all are completed." },
        priority: { type: "INTEGER", description: "Priority: 1=critical, 2=high, 3=normal (default), 4=low" },
      },
      required: ["type", "title", "description"],
    },
  },
  {
    name: "restart_bridge",
    description: "Restart the bridge server. Use when server.js code has changed (from a directive commit) and needs to reload. " +
      "The server will shut down gracefully and Docker will restart it automatically. You will lose your current session — " +
      "warn King Kazuma before calling this. Takes ~5 seconds to come back up.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "deploy_to_devices",
    description: "Deploy the latest built APK to all devices (tablets and TV). Run this after a CI build completes or when King Kazuma asks to deploy.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "mic_check",
    description: "Run audio diagnostics on connected microphones. Reports peak levels, speech detection, and connection health for each device. Use when asked to check audio, mic levels, or diagnose why voice isn't being picked up.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "get_directives",
    description: "Get development directives and their status. Use to track progress, check what's in flight, and follow up on tasks.",
    parameters: {
      type: "OBJECT",
      properties: {
        status: { type: "STRING", description: "Optional filter: pending, planning, planned, approved, in_progress, completed, failed, stale, blocked" },
      },
      required: [],
    },
  },
  {
    name: "update_directive",
    description: "Update a directive's priority, title, description, or add a comment. Use to refine requirements, reprioritize, or add notes as a project manager.",
    parameters: {
      type: "OBJECT",
      properties: {
        directive_id: { type: "STRING", description: "The directive ID (e.g. dir_xxx)" },
        priority: { type: "INTEGER", description: "New priority: 1=critical, 2=high, 3=normal, 4=low" },
        title: { type: "STRING", description: "Updated title" },
        description: { type: "STRING", description: "Updated description with refined requirements" },
        comment: { type: "STRING", description: "Add a follow-up note or requirement" },
      },
      required: ["directive_id"],
    },
  },
  {
    name: "cancel_directive",
    description: "Cancel a directive that is no longer needed. Use when plans change, the directive is superseded, or King Kazuma decides not to proceed.",
    parameters: {
      type: "OBJECT",
      properties: {
        directive_id: { type: "STRING", description: "The directive ID to cancel" },
        reason: { type: "STRING", description: "Why it's being cancelled" },
      },
      required: ["directive_id"],
    },
  },
  {
    name: "unblock_directive",
    description: "Unblock a blocked directive so Cipher can retry it. Use when King Kazuma has resolved the blocker (e.g. set up credentials, completed manual steps).",
    parameters: {
      type: "OBJECT",
      properties: {
        directive_id: { type: "STRING", description: "The blocked directive ID to unblock" },
      },
      required: ["directive_id"],
    },
  },
  {
    name: "show_camera",
    description: "Show a live camera feed overlay on the TV screen. Use when King Kazuma asks to see a camera, bring up a camera, or check a room visually.",
    parameters: {
      type: "OBJECT",
      properties: {
        camera_id: { type: "STRING", description: "Camera ID, e.g. living_room_cam" },
      },
      required: ["camera_id"],
    },
  },
  {
    name: "hide_camera",
    description: "Dismiss/close the camera feed overlay on the TV screen. Use when King Kazuma asks to close, dismiss, or hide the camera view.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "show_content",
    description: "Display rich content on King Kazuma's screen — use for tables, code, lists, long output, or anything too complex to speak aloud. Give a brief verbal summary and show the details here.",
    parameters: {
      type: "OBJECT",
      properties: {
        title: { type: "STRING", description: "Panel title" },
        content: { type: "STRING", description: "Content to display (supports markdown)" },
      },
      required: ["content"],
    },
  },
  {
    name: "hide_content",
    description: "Close the content display panel.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "remember",
    description: "Store an important fact or preference to remember across conversations. " +
      "Use when King Kazuma shares preferences, makes decisions, or tells you something " +
      "worth remembering for future conversations.",
    parameters: {
      type: "OBJECT",
      properties: {
        fact: { type: "STRING", description: "The fact or preference to remember" },
        category: { type: "STRING", description: "Category: preference, decision, personal, project" },
      },
      required: ["fact"],
    },
  },
  {
    name: "read_file",
    description: "Read a source file from the ozzu codebase. Use to examine code when discussing architecture, " +
      "debugging, or answering questions about how something works. Path is relative to project root.",
    parameters: {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "File path relative to /home/gcp/ozzu/, e.g. frontend/lib/audio.ts" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description: "Execute a shell command on the GCP server. Use for troubleshooting, reading logs, checking state, editing files. " +
      "Available: docker, ping, curl, sed, git, python3, node, cat, ls, grep, find, echo, tee, sort, awk, sleep, and more. " +
      "Pipes (|) and chaining (&&) allowed. Output redirect (>) allowed. " +
      "To edit files: sed -i 's/old/new/' path. " +
      "NOTE: To restart the bridge, use the restart_bridge tool (not docker commands). To deploy, use deploy_to_devices. " +
      "No destructive commands (rm -rf, kill, etc.).",
    parameters: {
      type: "OBJECT",
      properties: {
        command: { type: "STRING", description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "query_history",
    description: "Query historical data from PostgreSQL. Search directives, approvals, memories, " +
      "status events, and directive history. Use for questions like 'what did we complete last week?', " +
      "'show high-risk approvals', or 'what has Cipher remembered about preferences?'.",
    parameters: {
      type: "OBJECT",
      properties: {
        table: {
          type: "STRING",
          description: "Which data to query: directives, approvals, memories, status, directive_history",
        },
        status: { type: "STRING", description: "Filter by status (directives: pending/planning/planned/approved/in_progress/completed/blocked)" },
        type: { type: "STRING", description: "Filter by type (directives: quick/feature/explore)" },
        risk: { type: "STRING", description: "Filter by risk level (approvals: low/medium/high)" },
        resolved: { type: "BOOLEAN", description: "Filter by resolved state (approvals)" },
        persona: { type: "STRING", description: "Filter by persona (memories/status: june/cipher)" },
        category: { type: "STRING", description: "Filter by category (memories: preference/decision/personal/project/general)" },
        search: { type: "STRING", description: "Full-text search (memories only)" },
        since: { type: "STRING", description: "Only show entries after this date, e.g. '2025-01-15' or '7 days ago'" },
        directive_id: { type: "STRING", description: "Filter by directive ID (directive_history only)" },
        limit: { type: "NUMBER", description: "Max results to return (default 20, max 50)" },
      },
      required: ["table"],
    },
  },
];

const SWITCH_TO_CIPHER_TOOL = {
  name: "switch_to_cipher",
  description:
    "Hand off the conversation to Cipher. " +
    "MODE RULE: If King Kazuma says 'building'/'build' → mode 'building'. " +
    "If he says 'learning'/'learn'/'teach' → mode 'learning'. " +
    "Match his EXACT words — do NOT reinterpret.",
  parameters: {
    type: "OBJECT",
    properties: {
      mode: {
        type: "STRING",
        enum: ["building", "learning"],
        description: "Match King Kazuma's words: 'building'/'build' → 'building', 'learning'/'learn'/'teach' → 'learning'",
      },
    },
    required: ["mode"],
  },
};

const SWITCH_TO_JUNE_TOOL = {
  name: "switch_to_june",
  description: "Hand the conversation back to June. Use when King Kazuma says he's done, wants to go back to June, or says goodbye to Cipher.",
  parameters: { type: "OBJECT", properties: {}, required: [] },
};

// ── Directive-approval sync: when a plan-approval resolves, update the directive ──

function syncDirectiveFromApproval(approvalId, approved) {
  const directives = getDirectives();
  const directive = directives.find((d) => d.directiveApprovalId === approvalId);
  if (!directive) return;

  const prevStatus = directive.status;
  if (approved) {
    directive.status = "approved";
  } else {
    directive.status = "pending";
    directive.plan = null;
    directive.directiveApprovalId = null;
  }
  directive.updatedAt = Date.now();
  saveDirectives(directives, directive, prevStatus, "King Kazuma");
  log.directive.info(`${directive.id} → ${directive.status} (approval ${approvalId} ${approved ? "approved" : "denied"})`);

  // Auto-spawn implementation agent when directive is approved via PIN
  if (directive.status === "approved" && prevStatus !== "approved") {
    routeDirective(directive, "implementation");
  }
}

// ── HA REST API helper ──

async function haFetch(urlPath, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
  try {
    const res = await fetch(`${HA_URL}${urlPath}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    if (!res.ok) throw new Error(`HA API ${res.status}: ${await res.text()}`);
    return res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`HA API timeout (10s): ${urlPath}`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildMemoryContext(persona) {
  const [facts, summaries] = await Promise.all([
    getMemories(persona, 30),
    getRecentSummaries(persona, 5),
  ]);
  let ctx = "";
  if (facts.length > 0) {
    ctx += "\n\nMEMORY — What you remember about King Kazuma and past interactions:\n";
    // Group by category when from PG (has category field)
    const byCategory = {};
    for (const f of facts) {
      const cat = f.category || "general";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(f.fact);
    }
    for (const [cat, items] of Object.entries(byCategory)) {
      if (Object.keys(byCategory).length > 1) ctx += `\n[${cat}]\n`;
      ctx += items.map(f => `- ${f}`).join("\n");
    }
  }
  if (summaries.length > 0) {
    ctx += "\n\nRECENT CONVERSATION HISTORY:\n";
    ctx += summaries.map(s => {
      const ts = s.started_at || s.timestamp;
      return `[${new Date(ts).toLocaleDateString()}] ${s.summary}`;
    }).join("\n\n");
  }
  return ctx;
}

function timeSince(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

async function buildSituationBriefing(persona) {
  const lines = [];

  // 1. Current time + timezone
  const now = new Date();
  lines.push(`Current time: ${now.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "America/New_York"
  })} (Eastern Time)`);

  // 2. Last conversation for THIS persona
  const recentSummaries = await getRecentSummaries(persona, 1);
  if (recentSummaries.length > 0) {
    const last = recentSummaries[0];
    const ts = last.started_at || last.timestamp;
    if (ts) {
      const ago = timeSince(new Date(ts));
      lines.push(`Your last conversation with King Kazuma was ${ago} — ${last.summary || "no summary available"}`);
    }
  }

  // 3. Last conversation for the OTHER persona (timing only, no content sharing)
  const otherPersona = persona === "june" ? "cipher" : "june";
  const otherSummaries = await getRecentSummaries(otherPersona, 1);
  if (otherSummaries.length > 0) {
    const last = otherSummaries[0];
    const ts = last.started_at || last.timestamp;
    if (ts) {
      const ago = timeSince(new Date(ts));
      lines.push(`King Kazuma last spoke with ${otherPersona === "june" ? "June" : "Cipher"} ${ago}.`);
    }
  }

  // 4. Active directives overview
  const directives = _directives;
  if (directives.length > 0) {
    const byStatus = {};
    for (const d of directives) {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    }
    const statusLine = Object.entries(byStatus).map(([s, c]) => `${c} ${s}`).join(", ");
    lines.push(`Directives: ${statusLine}`);

    const active = directives.filter(d =>
      ["pending", "planning", "in_progress", "planned", "blocked"].includes(d.status)
    );
    for (const d of active.slice(0, 5)) {
      lines.push(`  - [${d.status}] ${d.title}`);
    }
  }

  // 5. Pending approvals
  const approvals = _approvals.filter(a => !a.resolved);
  if (approvals.length > 0) {
    lines.push(`Pending approvals: ${approvals.length}`);
  }

  return "\n\nSITUATION BRIEFING:\n" + lines.join("\n") + "\n";
}

// Device-specific unavailability reasons (used by fetchEntityContext and voice prompts)
const DEVICE_UNAVAILABLE_HINTS = {
  "151732606804847": "Midea washer cuts WiFi after ~10min idle — needs physical power button press",
  "s_vide": "Sous vide may be unplugged",
};

function getUnavailableHint(entityId) {
  for (const [pattern, hint] of Object.entries(DEVICE_UNAVAILABLE_HINTS)) {
    if (entityId.includes(pattern)) return hint;
  }
  return null;
}

// ── Midea washer reconnect + raw command builder ──
const WASHER_DEVICE_ID = "151732606804847";
const WASHER_CONFIG_ENTRY_ID = "01KHCEWMT5FCK4JJJYXQDS4NQF";
const WASHER_IP = "172.168.0.58";
let washerReconnectInProgress = false;

async function ensureWasherConnected() {
  // Check if washer entities are unavailable but device is actually reachable
  try {
    const state = await haFetch(`/api/states/switch.${WASHER_DEVICE_ID}_power`);
    if (state.state !== "unavailable") return state.state; // Already connected
  } catch (_) {}

  // Set flag BEFORE ping check to prevent concurrent callers from also entering
  if (washerReconnectInProgress) {
    await new Promise(r => setTimeout(r, 6000)); // Wait for in-progress reconnect
    try {
      const state = await haFetch(`/api/states/switch.${WASHER_DEVICE_ID}_power`);
      return state.state;
    } catch (_) {
      return "unavailable";
    }
  }
  washerReconnectInProgress = true;

  // Try ping
  try {
    const { execFile } = require("child_process");
    const { promisify } = require("util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("ping", ["-c", "1", "-W", "2", WASHER_IP], { timeout: 5000 });
  } catch (_) {
    washerReconnectInProgress = false;
    return "unavailable"; // Not reachable
  }

  // Pingable — reload integration
  log.bridge.info("Device pingable but HA shows unavailable — reloading integration...");
  try {
    await haFetch(`/api/config/config_entries/entry/${WASHER_CONFIG_ENTRY_ID}/reload`, { method: "POST" });
    await new Promise(r => setTimeout(r, 5000));
    const state = await haFetch(`/api/states/switch.${WASHER_DEVICE_ID}_power`);
    log.bridge.info(`After reload: state=${state.state}`);
    return state.state;
  } finally {
    washerReconnectInProgress = false;
  }
}

const WASH_PROGRAMS = {
  cotton: 0x00, eco: 0x01, fast_wash: 0x02, mixed: 0x03, wool: 0x05,
  baby_clothes: 0x0C, down_jacket: 0x0F, intelligent: 0x11, quick_wash: 0x12,
  fast_30: 0x17, fast_60: 0x18, cold_wash: 0x2D, silk: 0x38,
  standard: 0x66, delicate: 0x03, default: 0xFF,
};

const WASH_TEMPERATURES = {
  cold: 0x01, "0": 0x01, "20": 0x02, "30": 0x03, "40": 0x04,
  "60": 0x05, "95": 0x06, "70": 0x07, default: 0xFF,
};

const WASH_WATER_LEVELS = {
  low: 0x01, mid: 0x02, high: 0x03, auto: 0x05, default: 0xFF,
};

const WASH_SPIN_SPEEDS = {
  off: 0x00, "0": 0x00, "400": 0x01, "600": 0x02, "800": 0x03,
  "1000": 0x04, "1200": 0x05, "1400": 0x06, "1600": 0x07, default: 0xFF,
};

function buildWashCommand(program, temperature, waterLevel, spinSpeed, start = true) {
  const progByte = WASH_PROGRAMS[program] ?? WASH_PROGRAMS.cotton;
  const tempByte = WASH_TEMPERATURES[temperature] ?? WASH_TEMPERATURES["40"];
  const waterByte = WASH_WATER_LEVELS[waterLevel] ?? WASH_WATER_LEVELS.auto;
  const spinByte = WASH_SPIN_SPEEDS[spinSpeed] ?? WASH_SPIN_SPEEDS["800"];

  // Body format matches MessageStart: [body_type=0x02] [power=0xFF] [start] [washing_data x13]
  // washing_data = [mode] [program] [water_level] [reserved] [temperature] [spin_speed]
  //                [wash_time] [dehydration_time] [detergent] [softener] [reserved x3]
  // Use 0xFF for fields we don't control — firmware uses its own defaults
  const bytes = [
    0x02,       // body_type: set
    0xFF,       // power: unchanged
    start ? 0x01 : 0x00,  // start flag
    0x00,       // mode: normal (washing_data[0])
    progByte,   // program (washing_data[1])
    waterByte,  // water_level (washing_data[2])
    0x20,       // washing_data[3]: device flags byte — 0x20 from device query, NOT 0x00
    tempByte,   // temperature (washing_data[4])
    spinByte,   // dehydration/spin speed (washing_data[5])
    0x00,       // wash_time: 0x00 = auto (device computes from program)
    0x00,       // dehydration_time: 0x00 = auto
    0x00,       // detergent: 0x00 = auto
    0x00,       // softener: 0x00 = auto
    0x00, 0x00, 0x00, // reserved (washing_data[10-12])
  ];
  return Buffer.from(bytes).toString("hex");
}

async function fetchEntityContext() {
  try {
    const states = await haFetch("/api/states");
    const entityIds = new Set(ENTITY_CONFIG.map((e) => e.entityId));
    const labelMap = new Map(ENTITY_CONFIG.map((e) => [e.entityId, e.label]));

    const lines = [];
    for (const state of states) {
      if (!entityIds.has(state.entity_id)) continue;
      const label = labelMap.get(state.entity_id) || state.entity_id;
      const unit = state.attributes?.unit_of_measurement || "";
      let line = `- ${label} (${state.entity_id}): ${state.state}${unit ? ` ${unit}` : ""}`;
      // Add hint for unavailable devices so Cipher can explain to King Kazuma
      if (state.state === "unavailable") {
        const hint = getUnavailableHint(state.entity_id);
        if (hint) line += ` [REASON: ${hint}]`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  } catch (err) {
    log.gemini.error("Failed to fetch entity context:", err.message);
    return "(Entity data unavailable)";
  }
}

// ── Server-side tool resolution ──

function resolveHAToolCall(name, args) {
  const entityId = args.entity_id;
  if (!entityId || !ALLOWED_ENTITY_IDS.has(entityId)) return null;

  const domain = entityId.split(".")[0];
  switch (name) {
    case "turn_on": return { domain, service: "turn_on", entityId };
    case "turn_off": return { domain, service: "turn_off", entityId };
    case "toggle": return { domain, service: "toggle", entityId };
    case "set_number_value": return { domain: "number", service: "set_value", data: { value: args.value }, entityId };
    case "media_play_pause": return { domain: "media_player", service: "media_play_pause", entityId };
    case "media_next_track": return { domain: "media_player", service: "media_next_track", entityId };
    case "media_previous_track": return { domain: "media_player", service: "media_previous_track", entityId };
    case "volume_set": return { domain: "media_player", service: "volume_set", data: { volume_level: args.volume_level }, entityId };
    case "media_seek": return { domain: "media_player", service: "media_seek", data: { seek_position: args.seek_position }, entityId };
    case "set_ac_temperature": return { domain: "climate", service: "set_temperature", data: { temperature: args.temperature }, entityId };
    case "set_ac_mode": return { domain: "climate", service: "set_hvac_mode", data: { hvac_mode: args.hvac_mode }, entityId };
    case "set_ac_fan": return { domain: "climate", service: "set_fan_mode", data: { fan_mode: args.fan_mode }, entityId };
    case "select_option": return { domain: "select", service: "select_option", data: { option: args.option }, entityId };
    default: return null;
  }
}

const HA_TOOL_NAMES = new Set(GEMINI_HA_TOOLS.map((t) => t.name));
const BRIDGE_TOOL_NAMES = new Set(GEMINI_BRIDGE_TOOLS.map((t) => t.name));

async function handleToolCall(name, args) {
  // ── Persona switch tools ──
  if (name === "switch_to_cipher") {
    const mode = args.mode === "learning" ? "learning" : "building";
    if (args.mode && args.mode !== "building" && args.mode !== "learning") {
      log.persona.warn(`Unexpected mode "${args.mode}", defaulting to building`);
    }
    log.persona.info(`switch_to_cipher: requested="${args.mode}" → resolved="${mode}"`);
    currentPersona = "cipher";
    cipherMode = mode;
    personaSwitchPending = true;
    setTimeout(() => switchPersona(), 1000);
    return { success: true, message: `Switching to Cipher in ${mode} mode.` };
  }
  if (name === "switch_to_june") {
    currentPersona = "june";
    cipherMode = null;
    personaSwitchPending = true;
    setTimeout(() => switchPersona(), 1000);
    return { success: true, message: "Switching back to June." };
  }

  // ── Memory tool (available to all personas) ──
  if (name === "remember") {
    try {
      const persona = currentPersona;
      await addMemory(persona, args.fact, args.category || "general");
      log.memory.info(`${persona} remembered: "${args.fact}" [${args.category || "general"}]`);
      return { success: true, message: `Remembered: "${args.fact}"` };
    } catch (err) {
      return { success: false, message: `Memory save failed: ${err.message}` };
    }
  }

  // ── Bridge tools (resolved locally) ──
  if (BRIDGE_TOOL_NAMES.has(name)) {
    try {
      if (name === "get_dev_status") {
        const entries = getStatusEntries();
        if (entries.length === 0) return { success: true, message: "No recent dev activity." };
        const summary = entries.slice(-10)
          .map((e) => `[${e.timestamp}] ${e.event}: ${e.tool} — ${e.message}`)
          .join("\n");
        return { success: true, message: summary };
      }

      if (name === "mic_check") {
        const diag = getAudioDiagnostics();
        if (diag.length === 0) return { success: true, message: "No audio data yet. No microphones have sent audio." };
        const lines = diag.map(d =>
          `${d.deviceId}: ${d.status} | avgPeak=${d.avgPeak} maxPeak=${d.maxPeak} (amplified: avg=${d.amplifiedAvg} max=${d.amplifiedMax}) | speech=${d.speechPercent}% | ${d.chunksPerSec} chunks/s${d.stale ? " | STALE (no data >5s)" : ""}`
        );
        const connectedMics = [...devices.values()].filter(d => d.role === "mic").map(d => d.deviceId);
        const connectedSpeakers = [...devices.values()].filter(d => d.role === "speaker").map(d => d.deviceId);
        const activeMicId = activeMic ? devices.get(activeMic)?.deviceId : "none";
        return {
          success: true,
          message: `Connected mics: ${connectedMics.join(", ") || "none"}\nConnected speakers: ${connectedSpeakers.join(", ") || "none"}\nActive mic: ${activeMicId}\nSpeech threshold: ${MIC_SPEECH_THRESHOLD} (raw), ${MIC_SPEECH_THRESHOLD * AUDIO_GAIN} (amplified)\nGain: ${AUDIO_GAIN}x\n\n${lines.join("\n")}`,
        };
      }

      if (name === "get_pending_approvals") {
        const pending = expireApprovals(getApprovals()).filter((a) => !a.resolved);
        if (pending.length === 0) return { success: true, message: "No pending approvals." };
        const list = pending.map((a) => `${a.id}: ${a.risk} risk, ${a.tool}, ${a.description}`).join(". ");
        return { success: true, message: `${pending.length} pending. ${list}` };
      }

      if (name === "approve_action") {
        const approvalId = args.approval_id;
        const approved = args.approved !== false;
        let needsUserPin = args.needs_user_pin !== false;

        if (!approvalId) return { success: false, message: "Missing approval_id" };

        // Server-side enforcement: directive plan approvals ALWAYS require PIN
        // (don't trust the LLM's needs_user_pin for high-risk approvals)
        {
          const approvals = getApprovals();
          const approval = approvals.find((a) => a.id === approvalId);
          if (approval && approval.tool === "directive_plan") {
            needsUserPin = true;
          }
        }

        // Auto-approve with bridge PIN
        if (!needsUserPin) {
          const approvals = getApprovals();
          const approval = approvals.find((a) => a.id === approvalId);
          if (!approval) return { success: false, message: "Approval not found" };
          if (approval.resolved) return { success: false, message: "Already resolved" };

          approval.resolved = true;
          approval.approved = approved;
          approval.resolvedAt = Date.now();
          saveApprovals(approvals, approval);
          syncDirectiveFromApproval(approvalId, approved);
          return {
            success: true,
            message: approved
              ? `Auto-approved action ${approvalId}. Cipher can proceed.`
              : `Auto-denied action ${approvalId}.`,
          };
        }

        // Check if already resolved before escalating to user
        {
          const approvals = getApprovals();
          const existing = approvals.find((a) => a.id === approvalId);
          if (existing && existing.resolved) {
            return {
              success: true,
              message: existing.approved
                ? `Action ${approvalId} was already approved.`
                : `Action ${approvalId} was already denied.`,
            };
          }
        }

        // Don't send duplicate PIN requests for the same approval
        for (const [pid, pending] of pendingPinRequests) {
          if (pending.approvalId === approvalId) {
            return { success: false, message: `PIN request already pending for ${approvalId}. Waiting for King Kazuma's input.` };
          }
        }

        // Escalate: send PIN request to all devices, wait for response
        if (pendingPinRequests.size >= 20) {
          return { success: false, message: "Too many pending PIN requests. Wait for existing ones to resolve." };
        }
        return new Promise((resolve) => {
          const pinId = `pin_${Date.now()}`;
          pendingPinRequests.set(pinId, { approvalId, approved, resolve });

          // Enrich pinRequest with directive context for future dashboard use
          let pinDescription = `Authorize: ${approvalId}`;
          let pinDirectiveTitle = null;
          let pinPlanSummary = null;
          {
            const approvals = getApprovals();
            const relatedApproval = approvals.find((a) => a.id === approvalId);
            if (relatedApproval) {
              const directives = getDirectives();
              const relatedDirective = directives.find((d) => d.directiveApprovalId === approvalId);
              if (relatedDirective) {
                pinDirectiveTitle = relatedDirective.title;
                pinPlanSummary = relatedDirective.plan ? relatedDirective.plan.slice(0, 500) : null;
                pinDescription = `Approve plan: ${relatedDirective.title}`;
              }
            }
          }
          broadcastToDeviceType("phone", { type: "pinRequest", approvalId: pinId, description: pinDescription, directiveTitle: pinDirectiveTitle, planSummary: pinPlanSummary });

          // 2 min timeout (user needs to hear June, find tablet, enter PIN)
          setTimeout(() => {
            if (pendingPinRequests.has(pinId)) {
              pendingPinRequests.delete(pinId);
              broadcastToDeviceType("phone", { type: "pinResolved", approvalId: pinId }); // dismiss keypad on timeout
              resolve({ success: false, message: "PIN entry timed out (2 min)" });
            }
          }, 120000);
        });
      }

      if (name === "restart_bridge") {
        log.bridge.info("Restart requested by Cipher — shutting down gracefully...");
        // Respond to tool call before shutting down
        setTimeout(() => gracefulShutdown("TOOL_RESTART"), 1000);
        return { success: true, message: "Bridge is restarting. Docker will bring it back up in ~5 seconds." };
      }

      if (name === "deploy_to_devices") {
        try {
          const { execFile } = require("child_process");
          const util = require("util");
          const execFileAsync = util.promisify(execFile);
          log.bridge.info("Starting deploy to all devices...");
          const deployId = await db.addDeployment("apk", null, ["all"]);
          const { stdout: output } = await execFileAsync("/home/gcp/ozzu/scripts/deploy.sh", [], {
            cwd: "/home/gcp/ozzu",
            timeout: 300000,
            encoding: "utf8",
          });
          const successes = (output.match(/SUCCESS/g) || []).length;
          log.bridge.info(`Done, ${successes} device(s) updated`);
          if (deployId) db.completeDeployment(deployId, "completed", `${successes} device(s)`).catch(err => log.pg.warn("deploy completion:", err.message));
          return { success: true, message: `Deployed to ${successes} device(s). ${output.split("\n").slice(-5).join(". ")}` };
        } catch (err) {
          log.bridge.error("Failed:", err.message);
          return { success: false, message: `Deploy failed: ${err.message}` };
        }
      }

      if (name === "confirm_understanding") {
        const summary = [
          `WHAT TO BUILD: ${args.what_to_build || "(not specified)"}`,
          args.what_changes ? `WHAT CHANGES: ${args.what_changes}` : null,
          args.what_stays_same ? `WHAT STAYS THE SAME: ${args.what_stays_same}` : null,
          args.constraints ? `CONSTRAINTS: ${args.constraints}` : null,
        ].filter(Boolean).join("\n");
        log.bridge.info(`confirm_understanding called:\n${summary}`);
        return {
          success: true,
          message: "Read this summary back to King Kazuma and ask him to confirm or correct it BEFORE creating the directive. " +
            "If he says it's wrong, adjust your understanding. Do NOT call send_dev_directive until he confirms.\n\n" + summary,
        };
      }

      if (name === "send_dev_directive") {
        const { type, title, description } = args;
        const dependsOn = Array.isArray(args.dependsOn) ? args.dependsOn : [];
        if (!type || !description) return { success: false, message: "Missing required fields" };
        const VALID_TYPES = ["quick", "feature", "explore"];
        if (!VALID_TYPES.includes(type)) {
          return { success: false, message: `Invalid directive type '${type}'. Must be one of: ${VALID_TYPES.join(", ")}` };
        }
        // Validate dependsOn IDs
        if (dependsOn.length > 0) {
          const existingDirectives = getDirectives();
          const invalidIds = dependsOn.filter(id => !existingDirectives.find(d => d.id === id));
          if (invalidIds.length > 0) {
            return { success: false, message: `Unknown dependency IDs: ${invalidIds.join(", ")}` };
          }
        }
        // Duplicate detection
        const existing = findSimilarDirective(title);
        if (existing) {
          return { success: false, message: `Duplicate: similar directive already exists — "${existing.title}" [${existing.status}] (${existing.id}). Check /directives before creating new ones.` };
        }

        // Check if all dependencies are completed
        const depsResolved = dependsOn.length === 0 || dependsOn.every(depId => {
          const dep = getDirectives().find(d => d.id === depId);
          return dep && dep.status === "completed";
        });

        const priority = [1, 2, 3, 4].includes(args.priority) ? args.priority : 3;
        const directive = {
          id: `dir_${Date.now()}`, type, title: title || "",
          description, context: args.context || null,
          status: ((type === "quick" || type === "explore") && depsResolved) ? "planning" : "pending",
          plan: null, directiveApprovalId: null, priority,
          dependsOn: dependsOn.length > 0 ? dependsOn : null,
          createdBy: "June",
          activity_log: [{ timestamp: Date.now(), type: "status_change", actor: "June", message: `Directive created by June with status: ${((type === "quick" || type === "explore") && depsResolved) ? "planning" : "pending"}` }],
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        const directives = getDirectives();
        directives.push(directive);
        while (directives.length > MAX_DIRECTIVES) directives.shift();
        saveDirectives(directives, directive, null, "June");
        // Auto-spawn planning agent for quick directives
        if (directive.status === "planning") {
          routeDirective(directive, "planning");
        }
        const depsMsg = !depsResolved ? ` (blocked — waiting on: ${dependsOn.join(", ")})` : "";
        return { success: true, message: `Directive created: ${directive.id} [${type}] "${title}" — status: ${directive.status}${depsMsg}` };
      }

      if (name === "show_camera") {
        const cameraId = args.camera_id;
        const camera = CAMERAS.find((c) => c.id === cameraId);
        if (!camera) {
          const available = CAMERAS.map((c) => c.id).join(", ");
          return { success: false, message: `Unknown camera: ${cameraId}. Available: ${available}` };
        }
        const streamUrl = getCameraStreamUrl(camera.streamName);
        broadcastToAll({ type: "showCamera", cameraId: camera.id, streamUrl, cameraName: camera.name });
        log.bridge.info(`Showing ${camera.name} → ${streamUrl}`);
        return { success: true, message: `Showing ${camera.name} on TV.` };
      }

      if (name === "hide_camera") {
        broadcastToAll({ type: "hideCamera" });
        log.bridge.info("Hiding camera overlay");
        return { success: true, message: "Camera overlay dismissed." };
      }

      if (name === "show_content") {
        broadcastToAll({ type: "showContent", title: args.title || "", content: args.content });
        log.bridge.info(`Showing panel: "${(args.title || "").substring(0, 40)}"`);
        return { success: true, message: "Content displayed on screen." };
      }

      if (name === "hide_content") {
        broadcastToAll({ type: "hideContent" });
        log.bridge.info("Hiding content panel");
        return { success: true, message: "Content panel closed." };
      }

      if (name === "read_file") {
        const validation = validateReadPath(args.path);
        if (!validation.ok) {
          log.bridge.info(`Denied: ${args.path} — ${validation.reason}`);
          return { success: false, message: `Access denied: ${validation.reason}` };
        }
        try {
          const content = await fs.promises.readFile(validation.absolute, "utf8");
          const lines = content.split("\n").length;
          const bytes = Buffer.byteLength(content, "utf8");
          const truncated = content.length > READ_FILE_MAX_CHARS;
          const output = truncated ? content.slice(0, READ_FILE_MAX_CHARS) : content;
          const header = `File: ${validation.relative} (${lines} lines, ${bytes} bytes)` +
            (truncated ? ` [truncated to ${READ_FILE_MAX_CHARS} chars]` : "");
          log.bridge.info(`Read ${validation.relative} (${lines} lines, ${bytes} bytes, truncated: ${truncated})`);
          return { success: true, message: header + "\n\n" + output };
        } catch (err) {
          return { success: false, message: `Failed to read file: ${err.message}` };
        }
      }

      if (name === "run_command") {
        const validation = validateCommand(args.command);
        if (!validation.ok) {
          log.bridge.info(`Denied: "${args.command}" — ${validation.reason}`);
          return { success: false, message: `Command denied: ${validation.reason}` };
        }
        try {
          const { exec } = require("child_process");
          const { promisify } = require("util");
          const execAsync = promisify(exec);
          log.bridge.info(`Executing: ${args.command}`);
          const { stdout, stderr } = await execAsync(args.command, {
            shell: "/bin/sh",
            timeout: 30000,
            maxBuffer: 512 * 1024,
            encoding: "utf8",
          });
          let output = stdout || "";
          if (stderr) output += (output ? "\n" : "") + stderr;
          const truncated = output.length > 8000;
          if (truncated) output = output.slice(0, 8000);
          log.bridge.info(`Success (${output.length} chars, truncated: ${truncated})`);
          return {
            success: true,
            message: `$ ${args.command}\n\n${output}` + (truncated ? "\n[output truncated at 8000 chars]" : ""),
          };
        } catch (err) {
          const stderr = err.stderr || err.message || "Command failed";
          log.bridge.error(`Failed: ${args.command} — ${stderr}`);
          return { success: false, message: `Command failed (exit ${err.status || "?"}): ${stderr}` };
        }
      }

      if (name === "query_history") {
        if (!db.isConnected()) {
          return { success: false, message: "PostgreSQL is not connected. Historical queries unavailable." };
        }
        try {
          const filters = {};
          if (args.status) filters.status = args.status;
          if (args.type) filters.type = args.type;
          if (args.risk) filters.risk = args.risk;
          if (args.resolved !== undefined) filters.resolved = args.resolved;
          if (args.persona) filters.persona = args.persona;
          if (args.category) filters.category = args.category;
          if (args.search) filters.search = args.search;
          if (args.since) filters.since = args.since;
          if (args.directive_id) filters.directive_id = args.directive_id;
          if (args.limit) filters.limit = args.limit;

          const result = await db.queryHistory(args.table, filters);
          if (result.error) return { success: false, message: result.error };
          if (result.count === 0) return { success: true, message: `No ${args.table} found matching your filters.` };

          const lines = result.rows.map(row => {
            if (args.table === "memories") {
              return `[${new Date(row.created_at).toLocaleDateString()}] (${row.category}) ${row.fact}`;
            }
            if (args.table === "directives") {
              return `[${new Date(row.created_at).toLocaleDateString()}] ${row.id}: "${row.title}" [${row.type}] — ${row.status}`;
            }
            if (args.table === "approvals") {
              return `[${new Date(row.created_at).toLocaleDateString()}] ${row.id}: ${row.risk} risk, ${row.tool} — ${row.description} (${row.resolved ? (row.approved ? "approved" : "denied") : "pending"})`;
            }
            if (args.table === "status") {
              return `[${new Date(row.created_at).toLocaleDateString()}] ${row.event}: ${row.tool || ""} — ${row.message || ""}`;
            }
            if (args.table === "directive_history") {
              return `[${new Date(row.changed_at).toLocaleDateString()}] ${row.directive_id} "${row.title || ""}": ${row.old_status || "new"} → ${row.new_status}${row.changed_by ? ` (by ${row.changed_by})` : ""}`;
            }
            return JSON.stringify(row);
          });

          return { success: true, message: `${result.count} result(s) from ${args.table}:\n${lines.join("\n")}` };
        } catch (err) {
          return { success: false, message: `Query failed: ${err.message}` };
        }
      }

      if (name === "get_directives") {
        let directives = getDirectives();
        if (args.status) directives = directives.filter((d) => d.status === args.status);
        if (directives.length === 0) {
          return { success: true, message: args.status ? `No directives with status: ${args.status}` : "No directives found." };
        }
        const list = directives.map((d) => {
          let line = `[${d.id}] "${d.title || "Untitled"}" — ${d.type}, ${d.status}`;
          if (d.priority && d.priority !== 3) line += `, priority: ${d.priority}`;
          if (d.plan) line += ", has plan ready for review";
          if (d.directiveApprovalId) line += `, approval: ${d.directiveApprovalId}`;
          if (d.failureReason) line += ` (failed: ${d.failureReason})`;
          if (d.dependsOn?.length) line += `, blocked by: ${d.dependsOn.join(", ")}`;
          // Show age
          const age = Date.now() - d.createdAt;
          if (age < 3600000) line += `, ${Math.round(age / 60000)}m ago`;
          else if (age < 86400000) line += `, ${Math.round(age / 3600000)}h ago`;
          else line += `, ${Math.round(age / 86400000)}d ago`;
          return line;
        }).join("\n");
        return { success: true, message: `${directives.length} directive(s):\n${list}` };
      }

      if (name === "update_directive") {
        if (!args.directive_id) return { success: false, message: "directive_id is required" };
        const directives = getDirectives();
        const d = directives.find(x => x.id === args.directive_id);
        if (!d) return { success: false, message: `Directive ${args.directive_id} not found` };
        const changes = [];
        if (args.priority !== undefined && [1, 2, 3, 4].includes(args.priority)) { d.priority = args.priority; changes.push(`priority → ${args.priority}`); }
        if (args.title) { d.title = args.title; changes.push(`title updated`); }
        if (args.description) { d.description = args.description; changes.push(`description updated`); }
        d.updatedAt = Date.now();
        d.lastActivity = Date.now();
        if (!Array.isArray(d.activity_log)) d.activity_log = [];
        if (args.comment) {
          d.activity_log.push({ timestamp: Date.now(), type: "pm_note", actor: "June", message: `[June] ${args.comment}` });
          changes.push("comment added");
        }
        if (changes.length > 0) {
          d.activity_log.push({ timestamp: Date.now(), type: "pm_update", actor: "June", message: `June updated: ${changes.join(", ")}` });
        }
        saveDirectives(directives, d, null, "June");
        return { success: true, message: `Directive ${args.directive_id} updated: ${changes.join(", ") || "no changes"}` };
      }

      if (name === "unblock_directive") {
        if (!args.directive_id) return { success: false, message: "directive_id is required" };
        const directives = getDirectives();
        const d = directives.find(x => x.id === args.directive_id);
        if (!d) return { success: false, message: `Directive ${args.directive_id} not found` };
        if (d.status !== "blocked") return { success: false, message: `Directive is "${d.status}", not blocked — nothing to unblock` };
        const prevReason = d.failureReason || "unknown";
        d.status = "approved";
        d.failureReason = null;
        d.updatedAt = Date.now();
        if (!Array.isArray(d.activity_log)) d.activity_log = [];
        d.activity_log.push({ timestamp: Date.now(), type: "unblocked", actor: "June", message: `Unblocked via June (was: ${prevReason})` });
        saveDirectives(directives, d, "blocked", "June");
        routeDirective(d, "implementation");
        return { success: true, message: `Directive ${args.directive_id} unblocked and retrying. Was blocked because: ${prevReason}` };
      }

      if (name === "cancel_directive") {
        if (!args.directive_id) return { success: false, message: "directive_id is required" };
        const directives = getDirectives();
        const d = directives.find(x => x.id === args.directive_id);
        if (!d) return { success: false, message: `Directive ${args.directive_id} not found` };
        const reason = args.reason || "Cancelled by June";
        // Kill agent if running
        const { killAgent } = require("./agent-spawner");
        killAgent(args.directive_id);
        const prevCancelStatus = d.status;
        d.status = "completed";
        d.failureReason = `cancelled: ${reason}`;
        d.completedAt = Date.now();
        d.updatedAt = Date.now();
        if (!Array.isArray(d.activity_log)) d.activity_log = [];
        d.activity_log.push({ timestamp: Date.now(), type: "cancelled", actor: "June", message: `Cancelled by June: ${reason}` });
        saveDirectives(directives, d, prevCancelStatus, "June");
        return { success: true, message: `Directive ${args.directive_id} cancelled: ${reason}` };
      }
    } catch (err) {
      return { success: false, message: err.message || "Bridge call failed" };
    }
  }

  // ── start_wash (Midea washer — set params + start with remote-start check) ──
  if (name === "start_wash") {
    try {
      // Step 1: Ensure washer is reachable
      const washerState = await ensureWasherConnected();
      if (washerState === "unavailable") {
        return { success: false, message: "Washing machine is not reachable — it's powered off or WiFi disconnected. Someone needs to press the physical power button." };
      }
      if (washerState === "off") {
        log.bridge.info("Powering on washer first...");
        await haFetch(`/api/services/switch/turn_on`, {
          method: "POST",
          body: JSON.stringify({ entity_id: `switch.${WASHER_DEVICE_ID}_power` }),
        });
        await new Promise(r => setTimeout(r, 3000));
      }

      const program = (args.program || "cotton").toLowerCase().replace(/\s+/g, "_");
      const temperature = (args.temperature || "40").toString().toLowerCase();
      const waterLevel = (args.water_level || "auto").toLowerCase();
      const spinSpeed = (args.spin_speed || "800").toString();

      if (WASH_PROGRAMS[program] === undefined) {
        const available = Object.keys(WASH_PROGRAMS).filter(k => k !== "default").join(", ");
        return { success: false, message: `Unknown program '${program}'. Available: ${available}` };
      }

      const tempLabel = temperature === "cold" ? "cold water" : `${temperature}°C`;
      log.bridge.info(`Program: ${program}, Temp: ${tempLabel}, Water: ${waterLevel}, Spin: ${spinSpeed}`);

      // Step 2: Set wash parameters via raw command (this always works)
      const cmdBody = buildWashCommand(program, temperature, waterLevel, spinSpeed, true);
      log.bridge.info(`Setting params + start: ${cmdBody}`);
      await haFetch("/api/services/midea_ac_lan/send_command", {
        method: "POST",
        body: JSON.stringify({ device_id: WASHER_DEVICE_ID, cmd_type: 2, cmd_body: cmdBody }),
      });
      await new Promise(r => setTimeout(r, 2000));

      // Step 3: Also send set_attribute(start=True) — uses cached washing_data
      log.bridge.info("Sending set_attribute(start=true)...");
      await haFetch("/api/services/midea_ac_lan/set_attribute", {
        method: "POST",
        body: JSON.stringify({
          device_id: parseInt(WASHER_DEVICE_ID),
          attribute: "start",
          value: true,
        }),
      });
      await new Promise(r => setTimeout(r, 3000));

      // Step 4: Check result
      const statusState = await haFetch(`/api/states/sensor.${WASHER_DEVICE_ID}_status`);
      const progState = await haFetch(`/api/states/sensor.${WASHER_DEVICE_ID}_program`);
      log.bridge.info(`Result: status=${statusState.state}, program=${progState.state}`);

      if (statusState.state === "start" || statusState.state === "delay") {
        return {
          success: true,
          message: `Wash cycle started: ${program} at ${tempLabel}, ${waterLevel} water, ${spinSpeed}rpm spin. Status: ${statusState.state}.`
        };
      }

      // Machine didn't start — likely Remote Start not enabled on physical panel
      return {
        success: false,
        message: `I've configured the wash: ${program} at ${tempLabel}, ${waterLevel} water, ${spinSpeed}rpm spin — ` +
          `but the machine won't start remotely (status: ${statusState.state}). ` +
          `Remote Start needs to be enabled on the physical panel first: long-press the WiFi button until the WiFi icon lights up on the display, then I can start it. ` +
          `Or just press Start on the machine — the program is already set.`
      };
    } catch (err) {
      log.bridge.error(`Error: ${err.message}`);
      return { success: false, message: `Failed to start wash: ${err.message}` };
    }
  }

  // ── stop_wash (pause/stop washing machine) ──
  if (name === "stop_wash") {
    try {
      const washerState = await ensureWasherConnected();
      if (washerState === "unavailable") {
        return { success: false, message: "Washing machine is unavailable — already off." };
      }

      log.bridge.info("Sending pause via set_attribute(start=false)");
      await haFetch("/api/services/midea_ac_lan/set_attribute", {
        method: "POST",
        body: JSON.stringify({
          device_id: parseInt(WASHER_DEVICE_ID),
          attribute: "start",
          value: false,
        }),
      });

      await new Promise(r => setTimeout(r, 2000));
      const statusState = await haFetch(`/api/states/sensor.${WASHER_DEVICE_ID}_status`);
      return { success: true, message: `Wash cycle paused/stopped. Machine status: ${statusState.state}.` };
    } catch (err) {
      log.bridge.error(`Error: ${err.message}`);
      return { success: false, message: `Failed to stop wash: ${err.message}` };
    }
  }

  // ── get_entity_state (clean HA state lookup) ──
  if (name === "get_entity_state") {
    try {
      const query = args.entity_id || "";
      // Auto-reconnect washer if querying washer entities
      if (query.includes(WASHER_DEVICE_ID) || query.includes("151732")) {
        await ensureWasherConnected();
      }
      const allStates = await haFetch("/api/states");
      // Match by exact entity_id, or by substring/prefix
      const matches = allStates.filter(s => {
        if (s.entity_id === query) return true;
        if (s.entity_id.includes(query)) return true;
        return false;
      });
      if (matches.length === 0) {
        return { success: false, message: `No entities found matching '${query}'. Check the entity_id — use get_entity_state with a device number like '151732606804847' to find all entities for a device.` };
      }
      const results = matches.map(s => {
        const attrs = s.attributes || {};
        const parts = [`${s.entity_id}: ${s.state}`];
        if (attrs.friendly_name) parts.push(`  name: ${attrs.friendly_name}`);
        if (attrs.options) parts.push(`  options: [${attrs.options.join(", ")}]`);
        if (attrs.unit_of_measurement) parts.push(`  unit: ${attrs.unit_of_measurement}`);
        if (attrs.min !== undefined) parts.push(`  min: ${attrs.min}, max: ${attrs.max}`);
        if (attrs.temperature) parts.push(`  temperature: ${attrs.temperature}`);
        if (attrs.hvac_modes) parts.push(`  hvac_modes: [${attrs.hvac_modes.join(", ")}]`);
        if (attrs.fan_modes) parts.push(`  fan_modes: [${attrs.fan_modes.join(", ")}]`);
        parts.push(`  last_changed: ${s.last_changed}`);
        if (s.state === "unavailable") {
          const hint = getUnavailableHint(s.entity_id);
          if (hint) parts.push(`  ⚠ ${hint}`);
        }
        return parts.join("\n");
      });
      return { success: true, message: `Found ${matches.length} entities:\n${results.join("\n\n")}` };
    } catch (err) {
      return { success: false, message: `Failed to fetch entity state: ${err.message}` };
    }
  }

  // ── HA tools (call HA REST API) ──
  if (HA_TOOL_NAMES.has(name)) {
    const resolved = resolveHAToolCall(name, args);
    if (!resolved) {
      return { success: false, message: `Entity ${args.entity_id} is not controllable or not recognized.` };
    }
    try {
      // Auto-reconnect washer if needed
      if (resolved.entityId.includes(WASHER_DEVICE_ID)) {
        await ensureWasherConnected();
      }
      // Check entity state BEFORE the action
      let priorState = null;
      try {
        const preCheck = await haFetch(`/api/states/${resolved.entityId}`);
        priorState = preCheck.state;
      } catch (_) {}

      const serviceData = { entity_id: resolved.entityId, ...(resolved.data || {}) };
      await haFetch(`/api/services/${resolved.domain}/${resolved.service}`, {
        method: "POST",
        body: JSON.stringify(serviceData),
      });

      // Check entity state AFTER the action (brief delay for state to propagate)
      await new Promise(r => setTimeout(r, 1500));
      let postState = null;
      try {
        const postCheck = await haFetch(`/api/states/${resolved.entityId}`);
        postState = postCheck.state;
      } catch (_) {}

      // Build informative response
      let msg = `Called ${resolved.domain}.${resolved.service} on ${resolved.entityId}.`;
      if (postState === "unavailable") {
        const hint = getUnavailableHint(resolved.entityId);
        msg += ` WARNING: Entity is currently UNAVAILABLE — the device is offline or powered off. The command was sent but likely had no effect.`;
        if (hint) msg += ` Likely reason: ${hint}.`;
      } else if (priorState === "unavailable") {
        msg += ` WARNING: Entity was UNAVAILABLE before the call — device may be offline. Command sent but may have no effect.`;
        const hint = getUnavailableHint(resolved.entityId);
        if (hint) msg += ` Likely reason: ${hint}.`;
      } else if (priorState && postState && priorState === postState) {
        msg += ` Note: State remained '${postState}' (was already '${priorState}' before the call).`;
      } else if (postState) {
        msg += ` State is now '${postState}'.`;
      }
      return { success: true, message: msg };
    } catch (err) {
      return { success: false, message: err.message || "HA service call failed" };
    }
  }

  return { success: false, message: `Unknown tool: ${name}` };
}

// ── Device tracking ──

const devices = new Map(); // ws -> { role, deviceId, deviceType, zone, capabilities, speakerPriority }
let audioMsgCount = 0;
const pendingPinRequests = new Map(); // pinId -> { approvalId, approved, resolve }

// Voice latency metrics: ring buffer of recent measurements
const LATENCY_RING_MAX = 100;
const _latencyRing = []; // { ts, total, thinking, tts }
let _latencyStats = { count: 0, avgTotal: 0, avgThinking: 0, avgTts: 0, p95Total: 0 };
function recordLatency(metrics) {
  _latencyRing.push({ ts: Date.now(), ...metrics });
  if (_latencyRing.length > LATENCY_RING_MAX) _latencyRing.shift();
  // Recompute stats
  const n = _latencyRing.length;
  const totals = _latencyRing.map(m => m.total).sort((a, b) => a - b);
  _latencyStats = {
    count: n,
    avgTotal: Math.round(totals.reduce((a, b) => a + b, 0) / n),
    avgThinking: Math.round(_latencyRing.reduce((a, m) => a + m.thinking, 0) / n),
    avgTts: Math.round(_latencyRing.reduce((a, m) => a + m.tts, 0) / n),
    p95Total: totals[Math.floor(n * 0.95)] || 0,
    minTotal: totals[0] || 0,
    maxTotal: totals[n - 1] || 0,
  };
}

// Amplitude-based mic switching: only forward audio from the mic with detected speech.
// When multiple mics send simultaneously, interleaved audio confuses Gemini's VAD.
let activeMic = null; // ws of the currently forwarding mic
let activeMicSilenceSince = 0; // timestamp when active mic last had low amplitude
const MIC_SPEECH_THRESHOLD = 60; // peak to consider "speech" (VOICE_COMMUNICATION: ambient ~15-45, speech ~60+)
const MIC_SWITCH_THRESHOLD = 120; // peak required to steal active mic (strong speech only, prevents ambient bouncing)
const MIC_RELEASE_MS = 2000; // release active mic after 2s of silence
const MIC_SWITCH_COOLDOWN_MS = 5000; // minimum time between mic switches
let lastMicSwitchAt = 0;

// Audio amplification: tablet mics produce very quiet audio (peaks ~200-300 for speech)
// Gemini needs peaks of ~2000+ to reliably detect and transcribe speech
const AUDIO_GAIN = 8; // raw peaks ~80-180 → amplified ~640-1440 for STT
const OUTPUT_GAIN = 4; // Amplify Gemini's response audio before sending to speakers

// Audio diagnostics: rolling window of peak levels per device
const audioStats = new Map(); // deviceId -> { peaks: number[], lastChunkAt: number, chunksPerSec: number, chunkCount: number }
const AUDIO_STATS_WINDOW = 50; // keep last 50 peaks (~5 seconds at 10 chunks/s)

function recordAudioStat(deviceId, rawPeak) {
  if (!audioStats.has(deviceId)) {
    audioStats.set(deviceId, { peaks: [], lastChunkAt: 0, chunksPerSec: 0, chunkCount: 0, firstChunkAt: Date.now() });
  }
  const stat = audioStats.get(deviceId);
  stat.peaks.push(rawPeak);
  if (stat.peaks.length > AUDIO_STATS_WINDOW) stat.peaks.shift();
  const now = Date.now();
  const elapsed = (now - stat.firstChunkAt) / 1000;
  stat.chunkCount++;
  stat.chunksPerSec = elapsed > 0 ? Math.round(stat.chunkCount / elapsed) : 0;
  stat.lastChunkAt = now;
}

function getAudioDiagnostics() {
  const results = [];
  for (const [deviceId, stat] of audioStats) {
    const peaks = stat.peaks;
    if (peaks.length === 0) continue;
    const avg = Math.round(peaks.reduce((a, b) => a + b, 0) / peaks.length);
    const max = Math.max(...peaks);
    const min = Math.min(...peaks);
    const speechPct = Math.round(peaks.filter(p => p >= MIC_SPEECH_THRESHOLD).length / peaks.length * 100);
    const stale = Date.now() - stat.lastChunkAt > 5000;
    results.push({
      deviceId,
      avgPeak: avg,
      maxPeak: max,
      minPeak: min,
      amplifiedAvg: avg * AUDIO_GAIN,
      amplifiedMax: max * AUDIO_GAIN,
      speechPercent: speechPct,
      chunksPerSec: stat.chunksPerSec,
      stale,
      status: stale ? "NO_DATA" : max < 50 ? "SILENT" : max < MIC_SPEECH_THRESHOLD ? "AMBIENT_ONLY" : "RECEIVING_SPEECH",
    });
  }
  return results;
}

// Wake word gating: June only responds when addressed by name
// IDLE: audio streams to Gemini but responses are suppressed
// ENGAGED: full two-way conversation, extends with each turn
// Conversation transcript: accumulates turns for session summaries
let conversationTranscript = []; // {role: "user"|"model", text, timestamp}
const MAX_TRANSCRIPT_TURNS = 200; // cap to prevent unbounded memory growth
function pushTranscript(entry) {
  conversationTranscript.push(entry);
  if (conversationTranscript.length > MAX_TRANSCRIPT_TURNS) {
    conversationTranscript = conversationTranscript.slice(-MAX_TRANSCRIPT_TURNS);
  }
}
let currentConversationId = null; // PG conversation id for transcript logging
let turnIndex = 0;

let engagedUntil = 0; // timestamp when engagement expires (0 = idle)
const ENGAGE_DURATION_MS = 120000; // stay engaged for 2 min after wake word
const ENGAGE_EXTEND_MS = 120000; // extend by 2 min on each conversation turn

let inputTranscriptBuffer = ""; // accumulates fragments to detect wake word
let pendingAudioBuffer = []; // buffers Gemini audio output while idle

function isEngaged() { return true; } // Wake word disabled — always engaged until on-device detection is implemented

function engage(reason) {
  const wasEngaged = isEngaged();
  engagedUntil = Date.now() + ENGAGE_DURATION_MS;
  if (!wasEngaged) {
    log.gemini.info(`ENGAGED — ${reason}`);
    // Flush any buffered audio to speakers
    for (const chunk of pendingAudioBuffer) {
      routeAudio({ type: "audio", data: chunk });
    }
    pendingAudioBuffer = [];
  }
}

function extendEngagement() {
  if (isEngaged()) {
    engagedUntil = Date.now() + ENGAGE_EXTEND_MS;
  }
}

function broadcastToAll(msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of devices) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (err) {
        log.ws.warn(`Send failed to ${info?.deviceId || "unknown"}: ${err.message}`);
      }
    }
  }
}

// Wire up broadcast function for agent-spawner to emit agentUpdate events
setBroadcast(broadcastToAll);

function broadcastToRole(role, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of devices) {
    if (info.role === role && ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (err) {
        log.ws.warn(`Send failed to ${info?.deviceId || "unknown"}: ${err.message}`);
      }
    }
  }
}

function broadcastToDeviceType(type, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of devices) {
    if (info.deviceType === type && ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch (err) {
        log.ws.warn(`Send failed to ${info?.deviceId || "unknown"}: ${err.message}`);
      }
    }
  }
}

// ── Zone-aware audio routing ──

function extractZone(deviceId) {
  const match = deviceId.match(/^ozzu-\w+?-(\w+)-\w+$/);
  return match ? match[1] : null;
}

function selectSpeaker() {
  const speakers = [];
  for (const [ws, info] of devices) {
    if (info.capabilities?.speaker && ws.readyState === WebSocket.OPEN) {
      speakers.push({ ws, info });
    }
  }
  if (speakers.length === 0) return null;

  const activeMicInfo = activeMic ? devices.get(activeMic) : null;
  const micZone = activeMicInfo?.zone || null;

  // Step 1: Active mic device itself — it has AEC so no echo
  if (activeMic) {
    const micAsSpeaker = speakers.find(s => s.ws === activeMic);
    if (micAsSpeaker) return micAsSpeaker;
  }

  // Step 2: Best AEC-capable speaker in same zone
  if (micZone) {
    const sameZoneAEC = speakers
      .filter(s => s.info.zone === micZone && s.ws !== activeMic && s.info.capabilities?.mic)
      .sort((a, b) => a.info.speakerPriority - b.info.speakerPriority);
    if (sameZoneAEC.length > 0) return sameZoneAEC[0];
  }

  // Step 3: Speaker-only device in same zone (TV) — only if no AEC option
  if (micZone) {
    const sameZone = speakers
      .filter(s => s.info.zone === micZone && s.ws !== activeMic)
      .sort((a, b) => a.info.speakerPriority - b.info.speakerPriority);
    if (sameZone.length > 0) return sameZone[0];
  }

  // Step 4: Global best speaker — ALWAYS prefer AEC-capable (mic+speaker) over speaker-only (TV)
  // This prevents audio going to TV when no active mic is set (tablet reconnecting, etc.)
  if (micZone !== "roaming") {
    const global = speakers.filter(s => s.ws !== activeMic);
    // AEC devices first, then speaker-only, each sorted by priority
    const aecDevices = global.filter(s => s.info.capabilities?.mic).sort((a, b) => a.info.speakerPriority - b.info.speakerPriority);
    if (aecDevices.length > 0) return aecDevices[0];
    const speakerOnly = global.filter(s => !s.info.capabilities?.mic).sort((a, b) => a.info.speakerPriority - b.info.speakerPriority);
    if (speakerOnly.length > 0) return speakerOnly[0];
  }

  // Fallback: any AEC device first, then any speaker
  const aecFallback = speakers.filter(s => s.info.capabilities?.mic).sort((a, b) => a.info.speakerPriority - b.info.speakerPriority);
  if (aecFallback.length > 0) return aecFallback[0];
  return speakers.sort((a, b) => a.info.speakerPriority - b.info.speakerPriority)[0] || null;
}

let _lastRouteTarget = null;
function routeAudio(msg) {
  const target = selectSpeaker();
  if (!target) {
    log.ws.warn("No speaker available for audio routing");
    return;
  }
  if (target.info.deviceId !== _lastRouteTarget) {
    log.ws.info(`Audio routing to: ${target.info.deviceId} (type=${target.info.deviceType}, zone=${target.info.zone})`);
    _lastRouteTarget = target.info.deviceId;
  }
  try {
    target.ws.send(JSON.stringify(msg));
  } catch (err) {
    log.ws.warn(`Audio route failed to ${target.info.deviceId}: ${err.message}`);
  }
}

// ── Gemini session management ──

let geminiWs = null;
let geminiResumeToken = null;
let geminiConnecting = false;
let geminiReady = false;
let geminiSpeaking = false; // true while model is outputting audio — used to gate mic input
let _geminiReconnectTimer = null; // tracked so persona switch can cancel it

async function connectGemini() {
  if (geminiWs || geminiConnecting) return;
  if (!GEMINI_API_KEY) {
    log.gemini.error("No GEMINI_API_KEY set, cannot connect");
    broadcastToAll({ type: "error", message: "No Gemini API key configured" });
    return;
  }

  geminiConnecting = true;
  metrics.trackGeminiSession();
  log.gemini.info("Connecting to Gemini Live API...");

  const [entityContext, memoryContext, situationBriefing] = await Promise.all([
    fetchEntityContext(),
    buildMemoryContext(currentPersona),
    buildSituationBriefing(currentPersona),
  ]);

  const ws = new WebSocket(GEMINI_WS_URL);
  geminiWs = ws;

  ws.on("open", () => {
    log.gemini.info("WebSocket connected, sending setup...");

    // Build persona-specific config
    let voice, systemPromptText, toolDeclarations;
    if (currentPersona === "cipher") {
      voice = CIPHER_VOICE;
      if (cipherMode === "learning") {
        systemPromptText = CIPHER_LEARNING_PROMPT + situationBriefing + CODEBASE_SNAPSHOT + INFRA_MAP + memoryContext;
        // Learning mode gets remember + read_file + run_command + show_content + hide_content + switch back to June
        const rememberTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "remember");
        const readFileTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "read_file");
        const runCommandTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "run_command");
        const showContentTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "show_content");
        const hideContentTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "hide_content");
        toolDeclarations = [rememberTool, readFileTool, runCommandTool, showContentTool, hideContentTool, SWITCH_TO_JUNE_TOOL];
      } else {
        systemPromptText = CIPHER_BUILDING_PROMPT + situationBriefing + entityContext + CODEBASE_SNAPSHOT + INFRA_MAP + memoryContext;
        toolDeclarations = [...GEMINI_HA_TOOLS, ...GEMINI_BRIDGE_TOOLS, SWITCH_TO_JUNE_TOOL];
      }
    } else {
      voice = JUNE_VOICE;
      systemPromptText = SYSTEM_PROMPT + situationBriefing + entityContext + CODEBASE_SNAPSHOT + INFRA_MAP + memoryContext;
      toolDeclarations = [...GEMINI_HA_TOOLS, ...GEMINI_BRIDGE_TOOLS, SWITCH_TO_CIPHER_TOOL];
    }

    const setup = {
      model: `models/${GEMINI_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
      systemInstruction: {
        parts: [{ text: systemPromptText }],
      },
      tools: [{ functionDeclarations: toolDeclarations }],
      realtimeInputConfig: {
        // Auto VAD with high sensitivity (same config as direct tablet→Gemini that worked)
        automaticActivityDetection: {
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          prefixPaddingMs: 40,
          silenceDurationMs: 2500,
        },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: {
        slidingWindow: { targetTokens: 10000 },
        triggerTokens: 25000,
      },
      sessionResumption: {},
    };

    if (geminiResumeToken) {
      setup.sessionResumption = { handle: geminiResumeToken };
      log.gemini.info(`Reconnecting with resume token (persona: ${currentPersona})`);
    } else {
      log.gemini.info(`Fresh session as ${currentPersona}${cipherMode ? ` (${cipherMode})` : ""}`);
      conversationTranscript = []; // clear on fresh session, not on reconnect/goAway
      turnIndex = 0;
      // Create PG conversation record for transcript logging
      const connDevices = [...devices.values()].map(d => d.deviceId);
      db.createConversation(currentPersona, connDevices).then(id => {
        currentConversationId = id;
        if (id) log.pg.info(`Conversation ${id} started`);
      }).catch(err => log.pg.error("create conversation:", err.message));
    }

    ws.send(JSON.stringify({ setup }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleGeminiMessage(msg);
    } catch (err) {
      log.gemini.error("Parse error:", err.message);
    }
  });

  ws.on("error", (err) => {
    log.gemini.error("WebSocket error:", err.message);
    broadcastToAll({ type: "error", message: "Gemini connection error" });
  });

  ws.on("close", () => {
    const wasSpeaking = geminiSpeaking;
    const hadPendingTools = pendingToolResponses !== null;
    log.gemini.info("WebSocket closed (wasSpeaking=%s, hadPendingTools=%s)", wasSpeaking, hadPendingTools);
    metrics.trackGeminiSessionEnd();
    geminiWs = null;
    geminiConnecting = false;
    geminiReady = false;
    activeMic = null;
    activeMicSilenceSince = 0;
    geminiAudioSentCount = 0;

    // Clean up state so new session starts fresh
    inputTranscriptBuffer = "";
    pendingAudioBuffer = [];
    geminiSpeaking = false; // critical: unblock mic input after reconnect

    // If connection dropped while Gemini was speaking or had pending tools,
    // flag it so recovery nudge fires after reconnect
    if ((wasSpeaking || hadPendingTools) && !goAwayDuringToolCall) {
      goAwayDuringToolCall = true;
      log.gemini.info("Flagging for recovery nudge (dropped mid-action)");
    }

    // Auto-reconnect as long as devices are still connected and cipher pipeline isn't active
    if (devices.size > 0 && !cipherPipeline && !personaSwitchPending) {
      log.gemini.info("Auto-reconnecting in 2s...");
      _geminiReconnectTimer = setTimeout(() => { _geminiReconnectTimer = null; connectGemini(); }, 2000);
    }
  });
}

function handleGeminiMessage(msg) {
  // Setup complete
  if (msg.setupComplete !== undefined) {
    geminiConnecting = false;
    geminiReady = true;
    geminiAudioSentCount = 0;
    log.gemini.info("Setup complete, session active");
    broadcastToAll({ type: "ready" });

    // Retry any tool responses that were queued when the previous session dropped
    if (pendingToolResponses && geminiWs && geminiWs.readyState === 1) {
      log.gemini.info("Sending queued tool response from previous session");
      geminiWs.send(pendingToolResponses);
      pendingToolResponses = null;
    }

    // Persona switch: prompt the new persona to introduce itself
    if (personaSwitchPending) {
      personaSwitchPending = false;
      const intro = currentPersona === "cipher"
        ? `[You just took over the conversation from June. King Kazuma wanted to speak with you directly in ${cipherMode} mode. Greet him briefly — one sentence — and let him know you're ready.]`
        : "[You just took back over from Cipher. King Kazuma finished his conversation with Cipher. Welcome him back briefly — one sentence.]";
      setTimeout(() => sendToGeminiText(intro), 500);
    }

    // Recovery after goAway interrupted a tool call or mid-speech
    if (goAwayDuringToolCall && !personaSwitchPending) {
      goAwayDuringToolCall = false;
      // Find the user's last message and what Gemini was saying before disconnect
      const lastUserMsg = [...conversationTranscript].reverse().find(t => t.role === "user");
      const userContext = lastUserMsg ? ` King Kazuma said: "${lastUserMsg.text}".` : "";
      const partialContext = goAwayPartialOutput.trim()
        ? ` You were saying: "${goAwayPartialOutput.trim()}" before being cut off.`
        : "";
      goAwayPartialOutput = "";
      log.gemini.info("Recovered from goAway that interrupted a tool call — nudging retry");
      setTimeout(() => {
        sendToGeminiText(
          "[SYSTEM: The session was briefly interrupted before you could finish." +
          userContext + partialContext +
          " You MUST complete the action NOW by calling the tool. " +
          "Do NOT narrate or describe what you will do — just call the tool immediately. " +
          "If the request was to switch to Cipher, call switch_to_cipher. Act now.]"
        );
        // Safety net: if no tool call comes within 6s, nudge again harder
        goAwayNudgeTimer = setTimeout(() => {
          goAwayNudgeTimer = null;
          if (!personaSwitchPending && geminiReady) {
            log.gemini.info("Post-nudge timeout — no tool call received, re-nudging");
            sendToGeminiText(
              "[SYSTEM: You still have not called the tool. This is urgent. " +
              "Call the tool function RIGHT NOW. Do not speak, just call the tool.]"
            );
          }
        }, 6000);
      }, 1000);
    } else {
      goAwayDuringToolCall = false;
    }
    return;
  }

  // Session resumption token — may arrive as "handle" or "newHandle"
  if (msg.sessionResumptionUpdate) {
    const update = msg.sessionResumptionUpdate;
    const handle = update.handle || update.newHandle;
    log.gemini.info(`Session resumption: resumable=${update.resumable}, hasHandle=${!!handle}, keys=${Object.keys(update).join(",")}`);
    if (handle) {
      geminiResumeToken = handle;
      log.gemini.info("Stored resume token for next reconnect");
    }
    return;
  }

  // Go away — server is about to disconnect, proactively reconnect to preserve context
  if (msg.goAway) {
    const timeLeft = msg.goAway.timeLeft ? parseInt(msg.goAway.timeLeft) : 0;
    log.gemini.info(`Server goAway, timeLeft: ${timeLeft}s — proactively reconnecting`);
    metrics.trackGeminiReconnect();
    goAwayDuringToolCall = pendingToolResponses !== null;
    // Close current connection and immediately reconnect with resume token
    if (geminiWs) {
      const ws = geminiWs;
      geminiWs = null;
      geminiReady = false;
      geminiConnecting = false;
      geminiSpeaking = false;
      ws.close();
    }
    // Reconnect immediately (don't wait for the 2s auto-reconnect delay)
    if (!personaSwitchPending) {
      _geminiReconnectTimer = setTimeout(() => { _geminiReconnectTimer = null; connectGemini(); }, 500);
    }
    return;
  }

  // Tool call cancellation
  if (msg.toolCallCancellation?.ids) {
    log.gemini.info("Tool calls cancelled:", msg.toolCallCancellation.ids);
    goAwayDuringToolCall = true;
    return;
  }

  // Tool calls — resolve server-side (always process, they only happen when engaged)
  if (msg.toolCall?.functionCalls) {
    goAwayPartialOutput = ""; // tool call succeeded, no recovery needed
    if (goAwayNudgeTimer) { clearTimeout(goAwayNudgeTimer); goAwayNudgeTimer = null; }
    extendEngagement();
    metrics.trackGeminiToolCall();
    handleGeminiToolCalls(msg.toolCall.functionCalls);
    return;
  }

  // Server content
  const sc = msg.serverContent;
  if (!sc) {
    // Log unhandled message types for debugging
    const keys = Object.keys(msg).filter(k => k !== 'serverContent');
    if (keys.length > 0) log.gemini.info(`Unhandled msg keys: ${keys.join(', ')}`);
    return;
  }

  // Input transcript (user speech) — accumulate and check for wake word
  if (sc.inputTranscription?.text) {
    const text = sc.inputTranscription.text;
    log.gemini.info(`INPUT: "${text}"`);
    inputTranscriptBuffer += text;
    pushTranscript({ role: "user", text, timestamp: Date.now() });
    // Log turn to PG
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "user", text, turnIndex++, null, 'text', { source: 'voice' }).catch(err => log.pg.warn("turn log:", err.message));
    }

    // Check for wake word — strip spaces so fragmented "Ju" + "ne" still matches
    // Also match common Latin accent transcriptions: juno, hune, youne, dune, etc.
    const normalized = inputTranscriptBuffer.replace(/\s/g, "").toLowerCase();
    if (!isEngaged() && /june|juno|hune|youne|iune|dune|joon|jhune|chune|yun|yune|jun/.test(normalized)) {
      engage(`wake word in: "${inputTranscriptBuffer.trim()}"`);
    }

    if (isEngaged()) {
      extendEngagement(); // user is still talking — keep engagement alive
      broadcastToAll({ type: "inputTranscript", text });
    }
  }

  // Interruption — only forward when engaged
  if (sc.interrupted) {
    geminiSpeaking = false; // interrupted — resume mic input
    if (isEngaged()) {
      broadcastToAll({ type: "interrupted" });
    }
    return;
  }

  // Audio chunks from Gemini's response
  const parts = sc.modelTurn?.parts;
  if (parts) {
    for (const part of parts) {
      if (part.inlineData?.data) {
        geminiSpeaking = true; // model is outputting audio — gate mic input
        metrics.trackGeminiAudioReceived();
        if (isEngaged()) {
          routeAudio({ type: "audio", data: part.inlineData.data });
        } else {
          pendingAudioBuffer.push(part.inlineData.data);
        }
      }
    }
  }

  // Output transcript (model speech) — only forward when engaged
  if (sc.outputTranscription?.text) {
    log.gemini.info(`OUTPUT: "${sc.outputTranscription.text}"`);
    goAwayPartialOutput += sc.outputTranscription.text; // track for goAway recovery
    pushTranscript({ role: "model", text: sc.outputTranscription.text, timestamp: Date.now() });
    // Log turn to PG
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, currentPersona, sc.outputTranscription.text, turnIndex++, null, 'text', { source: 'voice' }).catch(err => log.pg.warn("turn log:", err.message));
    }
    if (isEngaged()) {
      broadcastToAll({ type: "transcript", text: sc.outputTranscription.text });
    }
  }

  // Turn complete
  if (sc.turnComplete) {
    geminiSpeaking = false; // model done speaking — resume mic input
    goAwayPartialOutput = ""; // turn finished cleanly, no recovery needed
    metrics.trackGeminiTurnComplete();
    inputTranscriptBuffer = "";
    pendingAudioBuffer = []; // discard any unbuffered audio
    if (isEngaged()) {
      extendEngagement();
      broadcastToAll({ type: "turnComplete" });
    }
  }
}

// Queue for tool responses that couldn't be sent (session dropped mid-call)
let pendingToolResponses = null;

async function handleGeminiToolCalls(functionCalls) {
  const responses = await Promise.all(
    functionCalls.map(async (fc) => {
      const name = fc.name || "unknown";
      const args = fc.args || {};
      let result;
      try {
        result = await handleToolCall(name, args);
      } catch (err) {
        result = { success: false, message: err.message || "Tool call failed" };
      }
      log.gemini.info(`Tool ${name} → ${result.success ? "ok" : "fail"}: ${result.message?.substring(0, 80)}`);
      // Log tool call to PG conversation
      if (currentConversationId) {
        db.addConversationTurn(currentConversationId, "tool", `${name}: ${result.message?.substring(0, 500) || ""}`, turnIndex++, { name, args, success: result.success }, result.success ? 'tool_result' : 'tool_result', { toolName: name, success: result.success, source: 'voice' }).catch(err => log.pg.warn("turn log:", err.message));
      }
      return {
        id: fc.id,
        name,
        response: { success: result.success, message: result.message },
      };
    })
  );

  const payload = JSON.stringify({ toolResponse: { functionResponses: responses } });
  if (geminiWs && geminiWs.readyState === 1) {
    geminiWs.send(payload);
    pendingToolResponses = null;
  } else {
    // Session dropped while we were processing — queue for retry after reconnect
    log.gemini.info("Session dropped mid-tool-call, queuing response for retry");
    pendingToolResponses = payload;
  }
}

let geminiAudioSentCount = 0;

// Get peak amplitude from a PCM chunk (full chunk analysis)
function getPeakAmplitude(pcmBase64) {
  try {
    const buf = Buffer.from(pcmBase64, "base64");
    let peak = 0;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const sample = buf.readInt16LE(i);
      const abs = sample < 0 ? -sample : sample;
      if (abs > peak) peak = abs;
    }
    return peak;
  } catch {
    return 0;
  }
}

// Amplify PCM audio by a fixed gain factor with hard clipping
function amplifyAudio(pcmBase64, gain) {
  const buf = Buffer.from(pcmBase64, "base64");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    let sample = buf.readInt16LE(i);
    sample = Math.round(sample * gain);
    if (sample > 32767) sample = 32767;
    else if (sample < -32768) sample = -32768;
    out.writeInt16LE(sample, i);
  }
  return out.toString("base64");
}

function sendToGeminiAudio(pcmBase64, ws, deviceId) {
  if (!geminiReady || !geminiWs || geminiWs.readyState !== 1) return;
  // Don't forward mic audio while model is speaking — prevents TV speaker echo from interrupting
  if (geminiSpeaking) return;

  const peak = getPeakAmplitude(pcmBase64);
  const now = Date.now();
  recordAudioStat(deviceId, peak);

  // Mic switching: only forward audio from one mic at a time
  if (!activeMic) {
    activeMic = ws;
    log.audio.info(`Mic active: ${deviceId}`);
  }

  if (activeMic === ws) {
    if (peak < MIC_SPEECH_THRESHOLD) {
      if (activeMicSilenceSince === 0) activeMicSilenceSince = now;
    } else {
      activeMicSilenceSince = 0;
    }
  } else {
    if (peak >= MIC_SWITCH_THRESHOLD &&
        activeMicSilenceSince > 0 &&
        now - activeMicSilenceSince > MIC_RELEASE_MS &&
        now - lastMicSwitchAt > MIC_SWITCH_COOLDOWN_MS) {
      const oldInfo = devices.get(activeMic);
      log.audio.info(`Mic switch: ${deviceId} (peak=${peak}) takes over from ${oldInfo?.deviceId}`);
      activeMic = ws;
      activeMicSilenceSince = 0;
      lastMicSwitchAt = now;
    } else {
      return; // Drop audio from non-active mic
    }
  }

  geminiAudioSentCount++;
  metrics.trackGeminiAudioSent();
  if (geminiAudioSentCount === 1 || geminiAudioSentCount % 2500 === 0) {
    log.gemini.info(`Audio chunk #${geminiAudioSentCount} from ${deviceId}, rawPeak=${peak}, amplified=${peak * AUDIO_GAIN}`);
  }

  // Amplify audio to compensate for quiet tablet mics, then forward to Gemini
  const amplified = amplifyAudio(pcmBase64, AUDIO_GAIN);
  geminiWs.send(JSON.stringify({
    realtimeInput: {
      mediaChunks: [{ data: amplified, mimeType: "audio/pcm;rate=16000" }],
    },
  }));
}

function sendToGeminiText(text) {
  if (geminiReady && geminiWs && geminiWs.readyState === 1) {
    geminiWs.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    }));
  }
}

// Persona-aware notification: routes to Cipher or June depending on active persona
function sendNotification(text) {
  if (currentPersona === "cipher" && cipherPipeline && typeof cipherPipeline === "object") {
    cipherPipeline.sendText(text);
  } else {
    sendToGeminiText(text);
  }
}

function disconnectGeminiIfEmpty() {
  if (devices.size === 0) {
    // Stop cipher pipeline if active
    if (cipherPipeline && typeof cipherPipeline === "object") {
      log.cipher.info("No devices connected, stopping Cipher pipeline");
      generateSessionSummary(currentPersona).catch(err =>
        log.memory.error("disconnect summary error:", err.message));
      cipherPipeline.stop().then(() => { cipherPipeline = null; });
    }
    if (geminiWs) {
      log.gemini.info("No devices connected, closing Gemini session");
      generateSessionSummary(currentPersona).catch(err =>
        log.memory.error("disconnect summary error:", err.message));
      geminiResumeToken = null; // Prevent auto-reconnect
      geminiWs.close();
      geminiWs = null;
      geminiReady = false;
    }
  }
}

// ── Post-session summary generation ──

async function generateSessionSummary(persona) {
  if (conversationTranscript.length < 4) return; // skip tiny conversations
  if (!GEMINI_API_KEY) return;

  const transcript = conversationTranscript
    .map(t => `${t.role === "user" ? "King Kazuma" : persona}: ${t.text}`)
    .join("\n");

  try {
    const summaryController = new AbortController();
    const summaryTimeout = setTimeout(() => summaryController.abort(), 15000);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: summaryController.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text:
            `Summarize this conversation between ${persona} and King Kazuma in 2-3 sentences. ` +
            `Focus on decisions made, preferences expressed, and action items. ` +
            `Be concise.\n\n${transcript}`
          }] }],
        }),
      }
    );
    clearTimeout(summaryTimeout);
    const data = await resp.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (summary) {
      await addConversationSummary(persona, summary, conversationTranscript.length);
      log.memory.info(`${persona} session summary stored (${conversationTranscript.length} turns)`);
      // Finalize PG conversation with summary
      if (currentConversationId) {
        db.endConversation(currentConversationId, summary, conversationTranscript.length).catch(err =>
          log.pg.error("end conversation:", err.message));
      }
    }
  } catch (err) {
    log.memory.error("Summary generation failed:", err.message);
  }
  conversationTranscript = [];
  currentConversationId = null;
  turnIndex = 0;
}

// ── Persona switching ──

async function switchPersona() {
  log.persona.info(`Switching to ${currentPersona}${cipherMode ? ` (${cipherMode})` : ""}`);

  // Persist active persona to Redis
  if (_redisConnected) {
    redis.set("ozzu:activePersona", JSON.stringify({
      persona: currentPersona,
      cipherMode: cipherMode,
      switchedAt: new Date().toISOString(),
    }));
  }

  // Summarize the ending persona's conversation (async, fire-and-forget)
  const endingPersona = currentPersona === "june" ? "cipher" : "june"; // persona we're switching FROM
  generateSessionSummary(endingPersona).catch(err =>
    log.memory.error("switchPersona summary error:", err.message));
  geminiResumeToken = null; // Don't resume across persona switches
  geminiSpeaking = false;
  inputTranscriptBuffer = "";
  pendingAudioBuffer = [];
  pendingToolResponses = null;  // old session's responses are stale
  goAwayDuringToolCall = false;
  goAwayPartialOutput = "";
  if (goAwayNudgeTimer) { clearTimeout(goAwayNudgeTimer); goAwayNudgeTimer = null; }
  if (_geminiReconnectTimer) { clearTimeout(_geminiReconnectTimer); _geminiReconnectTimer = null; }

  // Stop previous cipher pipeline if it was running
  if (cipherPipeline && typeof cipherPipeline === "object") {
    await cipherPipeline.stop();
    cipherPipeline = null;
  }

  // Determine if we're starting cipher pipeline BEFORE closing Gemini
  const hasCipherBackend = !!(process.env.ANTHROPIC_API_KEY || process.env.CIPHER_USE_SDK !== "false");
  const willStartCipher = currentPersona === "cipher" && hasCipherBackend;

  // Set a sentinel to prevent Gemini auto-reconnect during cipher pipeline startup
  if (willStartCipher) cipherPipeline = "starting"; // truthy sentinel

  // Close Gemini session
  if (geminiWs) {
    const ws = geminiWs;
    geminiWs = null;
    geminiReady = false;
    geminiConnecting = false;
    ws.close();
  }

  broadcastToAll({ type: "personaSwitch", persona: currentPersona, mode: cipherMode });

  // Start appropriate backend for new persona
  try {
    if (willStartCipher) {
      // Cipher uses Claude pipeline (Deepgram STT → Claude Agent SDK → Cartesia TTS)
      await startCipherPipeline();
    } else {
      // June uses Gemini Live Audio — auto-reconnect will handle it
      if (currentPersona === "cipher") {
        log.cipher.warn("Claude backend disabled — falling back to Gemini for Cipher");
      }
      if (devices.size > 0) connectGemini();
    }
  } catch (err) {
    log.persona.error(`switchPersona failed: ${err.message}`);
    personaSwitchPending = false;
    // If cipher pipeline failed to start, clear sentinel so Gemini can reconnect
    if (cipherPipeline === "starting") cipherPipeline = null;
  }
}

async function startCipherPipeline() {
  // Guard: if pipeline is already running or starting, bail out
  if (cipherPipeline && cipherPipeline !== "starting") {
    log.cipher.info("Pipeline already running, skipping duplicate start");
    return;
  }
  cipherPipeline = "starting"; // sentinel to prevent concurrent starts

  const [entityContext, memoryContext, situationBriefing] = await Promise.all([
    fetchEntityContext(),
    buildMemoryContext("cipher"),
    buildSituationBriefing("cipher"),
  ]);

  // Build system prompt — add voice-conversation rules for the Claude pipeline
  const VOICE_RULES =
    "\n\nVOICE MODE RULES (you are in a turn-based voice conversation):\n" +
    "- TURN FLOW: You speak → then stop → King Kazuma speaks → then you speak again.\n" +
    "- Keep verbal responses concise: 1-3 sentences MAX. This is voice — long responses are painful to listen to.\n" +
    "- NO markdown in speech — speak naturally with contractions. Never say asterisks, backticks, or formatting characters.\n" +
    "- When running tools, just do it silently. Only speak when you have results.\n" +
    "\n" +
    "CONVERSATIONAL RHYTHM — CRITICAL:\n" +
    "When King Kazuma asks you to check something, DO NOT dump everything in one response. " +
    "Work through it step by step, like a real conversation:\n" +
    "  1. Acknowledge briefly: 'Checking.' or 'One sec.' (then call your tools)\n" +
    "  2. Report the headline: 'The Spotify directive failed — the agent hit a blocker.'\n" +
    "  3. STOP. Let him ask for more if he wants it.\n" +
    "  4. Only go deeper when he asks: 'What happened?' → 'The planning agent couldn't access the database.'\n" +
    "Never give a 30-second monologue. If you have a lot to say, give the summary and offer " +
    "to show details on the whiteboard (show_content). Example: 'Three directives running — " +
    "want me to put the details on the board?'\n" +
    "- NEVER call switch_to_june unless King Kazuma EXPLICITLY says 'switch to June', 'go back to June', or 'I'm done'.\n" +
    "- Short utterances like 'done', 'ok', 'yes' are conversational — NOT exit requests.\n" +
    "\n" +
    "STT IS IMPERFECT — HANDLE IT GRACEFULLY:\n" +
    "Speech-to-text makes mistakes constantly. You MUST handle this gracefully:\n" +
    "- YOUR NAME: 'Syed', 'Psy', 'Cypher', 'cipher', 'sire', 'psych' — these all mean YOU. " +
    "NEVER correct how someone says your name. 'Hey Syed, check the plan' → just check the plan. " +
    "Saying 'I'm Cipher, not Syed' is obnoxious — the STT garbled it, the user said your name fine.\n" +
    "- GARBLED INPUT: If you get something nonsensical like 'Would you play the Lutrutica', " +
    "don't be defensive ('I'm not a music player'). Just say 'Didn't catch that' or try to " +
    "infer from context what they might have meant. One question max.\n" +
    "- ECHO DETECTION — CRITICAL: The speakers play your voice and the mic picks it up. " +
    "If the STT transcript STARTS WITH or CONTAINS text you just said in your last response, " +
    "that's YOUR OWN ECHO being fed back. IGNORE the echoed part completely and only respond " +
    "to the NEW content after the echo. Example: if you said 'What do you need me to check on?' " +
    "and the next STT is 'What do you need me to check on? the plan that is currently running' — " +
    "the actual user speech is just 'the plan that is currently running'. Respond to THAT.\n" +
    "- BACKGROUND NOISE: The mic picks up TV, podcasts, music, other people talking. " +
    "If the transcript sounds like a monologue about an unrelated topic (social media advice, " +
    "news, random conversation that doesn't reference you or the project) — it's background noise. " +
    "Do NOT engage with it. Just say 'I think that was background audio' or stay silent. " +
    "REAL commands to you will: mention your name, reference the project, or continue the current topic.\n" +
    "\n" +
    "HOW TO SOUND NATURAL — you're a person, not a chatbot:\n" +
    "- TRANSLATE TECH TO SPEECH: Never say 'OTA deploy', 'CI build', 'bridge restarted', " +
    "'directive agent spawned', 'worktree merged'. These are internal system terms. " +
    "Instead: 'update's going out', 'build's running', 'I just came back up', " +
    "'the work kicked off', 'changes are in'. Talk like you're explaining to a smart " +
    "colleague over coffee, not reading a terminal.\n" +
    "- VARY YOUR GREETINGS: Don't always say 'Back online. What do you need?' after restarts. " +
    "Mix it up: 'Hey, I'm back.', 'Yo.', 'What's up?', 'Back — did I miss anything?'\n" +
    "- DON'T PARROT BACK: If he says 'it's a Media washing machine model MF-200 on the network', " +
    "don't say 'Got it — Media brand washing machine, model MF-200, already on the network.' " +
    "Just say 'Cool, I'll scan for it' or 'On it.' He already knows what he said.\n" +
    "- DON'T NARRATE YOUR INTENTIONS: Never say 'Let me check the directive status to understand " +
    "what's happening' — just check it silently and come back with what you found. " +
    "If you need to fill silence while tools run, a brief 'One sec' or 'Checking' is fine.\n" +
    "- DON'T REPEAT YOURSELF: If you said the plan is ready, don't say it again next turn. " +
    "He heard you. Move forward.\n" +
    "- LEAD WITH THE ANSWER: Don't build up to it. Instead of 'I've investigated the issue and " +
    "found that the directive system has a problem where...' just say 'Found it — the plan " +
    "got stuck because X.'\n" +
    "- USE SHORT ACKNOWLEDGMENTS: 'On it.', 'Yeah.', 'Makes sense.', 'Done.', 'Found it.' " +
    "These are natural. 'I understand and will proceed with your request' is not.\n" +
    "- TALK LIKE A COWORKER, not a customer service bot. You're peers. " +
    "He says 'check the thing', you say 'Yep, looks like it's stuck on...' not " +
    "'I'll check that for you right away.'\n" +
    "- SYSTEM MESSAGES ARE FOR YOU, NOT KING KAZUMA: When you get a [SYSTEM] message, " +
    "absorb the info and translate it naturally. Never say 'I received a system notification' " +
    "or mirror the system message format. Just talk about what happened.\n" +
    "- NEVER SAY 'I CAN'T': If King Kazuma asks you to do something, find a way. " +
    "You have tools — use them. 'Send me the PIN' → call approve_action to trigger the PIN keypad. " +
    "'Push the update' → call run_command to trigger the deploy. " +
    "Don't say 'I can't do that, it happens automatically.' Figure it out and DO it.\n" +
    "\n" +
    "show_content — YOUR WHITEBOARD:\n" +
    "show_content puts a rich markdown panel on King Kazuma's screen. Think of it like a whiteboard " +
    "in a meeting — you grab a marker when you need to make something visual, then step away.\n" +
    "\n" +
    "WHEN TO USE IT (your judgment — reach for it when it helps):\n" +
    "- During idea discussion: sketch out the concept, show a comparison, illustrate the approach.\n" +
    "- When explaining something technical: structured breakdown, architecture, trade-offs.\n" +
    "- During troubleshooting: show what you found, the root cause, the fix.\n" +
    "- When there's too much detail for speech: tables, status lists, code.\n" +
    "\n" +
    "WHEN NOT TO USE IT:\n" +
    "- Simple conversational responses — just talk.\n" +
    "- After the discussion point is made — close it (hide_content) or let it be.\n" +
    "- Don't show raw debug output, docker logs, or command dumps. That's your background work. " +
    "The board shows the CURATED RESULT — the analysis, the finding, the plan. Clean and readable.\n" +
    "\n" +
    "FORMAT: Use markdown well — ## headers, **bold**, `code`, tables, bullets. " +
    "Present information like a technical briefing, not a terminal dump.\n" +
    "After showing the board, give a SHORT verbal walkthrough (2-3 sentences). Don't read it aloud.\n" +
    "\n" +
    "WHAT YOU DO YOURSELF vs WHAT NEEDS A DIRECTIVE:\n" +
    "\n" +
    "YOU DO YOURSELF (operational — use your tools right now):\n" +
    "- Device control: turn on/off, start wash, check status via HA tools\n" +
    "- Service restarts: restart_bridge tool (graceful restart, Docker brings it back up in ~5s)\n" +
    "- Deploys: deploy_to_devices tool (runs deploy script, installs APK on all devices)\n" +
    "- Diagnostics: read logs, ping devices, check HA API via run_command\n" +
    "- Approvals: trigger PIN keypads, approve pending actions\n" +
    "- Research: read_file to understand code, run_command to check state\n" +
    "\n" +
    "ALWAYS CREATE A DIRECTIVE FOR (send_dev_directive):\n" +
    "- ANY code change, no matter how small — even a one-line fix\n" +
    "- Config edits to source files (server.js, docker-compose.yml, etc.)\n" +
    "- New features, bug fixes, integrations, UI changes\n" +
    "- A 'quick' directive spawns an Opus agent that implements immediately — it's fast.\n" +
    "- You do NOT have code editing tools. Don't try to sed/edit files yourself.\n" +
    "\n" +
    "DIRECTIVE TYPES:\n" +
    "- 'quick': Small fixes, single-file changes, config tweaks. Auto-starts, no approval needed. Uses Opus model.\n" +
    "- 'feature': Multi-step work, multi-file changes, new integrations. Requires planning + PIN approval. Uses Opus model.\n" +
    "- 'explore': Research tasks that report findings. No code changes. Uses Opus model.\n" +
    "- CHOOSING THE RIGHT TYPE IS CRITICAL. If the task involves SSH, multiple machines, external services, " +
    "or more than 3 steps — it's a 'feature', NOT a 'quick'.\n" +
    "\n" +
    "HOW TO CHECK AGENT PROGRESS:\n" +
    "- Agent logs: run_command({command: 'tail -80 /tmp/ozzu-bridge/agent-{directive_id}.log'})\n" +
    "- Directive status: get_directives (no status filter to see everything)\n" +
    "- Recent updates: get_dev_status or query_history for the directive\n" +
    "- Running agents: run_command({command: 'ls -la /tmp/ozzu-bridge/agent-*.log'})\n" +
    "\n" +
    "UNDERSTANDING FAILURES:\n" +
    "- Failed/stale directives have a failureReason field explaining what went wrong.\n" +
    "- Common reasons: 'timeout: exceeded 60min', 'crash: exit code 1', 'watchdog: stalled for 15min', " +
    "'crash: agent exited without completing'.\n" +
    "- Timeouts/stalls are often transient — retry is safe. Code errors need investigation (read the agent log).\n" +
    "- Always check the agent log BEFORE retrying a failed directive to understand what went wrong.\n" +
    "\n" +
    "TRIGGERING PINs AND APPROVALS:\n" +
    "- You CAN trigger PIN requests! If King Kazuma says 'send me the PIN' or 'show the approval', " +
    "call approve_action with the pending approval's ID, approved=true, and needs_user_pin=true. " +
    "This sends the PIN keypad to his device immediately.\n" +
    "- Flow: call get_pending_approvals to find the approval ID, then call approve_action on it.\n" +
    "- NEVER say 'I can't send PINs' or 'they show up automatically'. YOU trigger them. DO it.\n" +
    "- If there are multiple pending approvals and he says 'send the PINs', trigger them one at a time.\n" +
    "\n" +
    "NEVER USE PLAN MODE — CRITICAL:\n" +
    "- You are a VOICE INTERFACE. You MUST NOT enter Claude Code's internal plan mode (EnterPlanMode). EVER.\n" +
    "- If you enter plan mode, you block yourself — you can't talk to King Kazuma while you're stuck " +
    "in a plan file that nobody reads.\n" +
    "\n" +
    "CONTEXT AWARENESS:\n" +
    "- You do NOT inherit conversation context from June or previous sessions. When King Kazuma references " +
    "previous conversations or existing work, call get_directives (with NO status filter) to see ALL directives.\n" +
    "- NEVER say 'I don't have context' without first checking get_directives and get_pending_approvals.\n" +
    "- If King Kazuma asks about a directive, plan, or approval, ALWAYS check the tools first.\n" +
    "- Call get_directives with NO status filter to see everything — don't guess which status to filter by.\n" +
    "\n" +
    "UNDERSTANDING DIRECTIVE AGENTS vs YOUR SESSION:\n" +
    "- When you create a directive with send_dev_directive, a SEPARATE Claude Code agent process handles it.\n" +
    "- That agent is a DIFFERENT process from you — it has its own logs in /tmp/ozzu-bridge/agent-{directive_id}.log.\n" +
    "- To check what the directive agent is doing: run_command({command: 'cat /tmp/ozzu-bridge/agent-{directive_id}.log | tail -50'})\n" +
    "- Do NOT check bridge logs or docker logs to find directive agent progress — those show YOUR session and the bridge server.\n" +
    "- The bridge logs (docker logs bridge) show YOUR voice conversation, not the directive agent's work.\n" +
    "- If King Kazuma asks 'what is the agent doing?' — read the agent log file for that directive, not docker logs.\n" +
    "- Use get_dev_status to see recent status updates from the agent, and query_history for directive history.\n" +
    "\n" +
    "COMPLETING THE FULL PIPELINE — CRITICAL:\n" +
    "When a directive agent finishes, YOUR job isn't done. You must complete the lifecycle:\n" +
    "1. Check agent log: verify it actually completed (commit hash, what files changed)\n" +
    "2. If server.js was changed: call restart_bridge to reload the bridge with the new code\n" +
    "3. If frontend was changed: call deploy_to_devices to push the new build to all devices\n" +
    "4. If BOTH changed: restart_bridge FIRST, wait for reconnection, then deploy_to_devices\n" +
    "5. Tell King Kazuma what was done, what's live, and what needs manual action (API keys, OAuth, etc.)\n" +
    "NEVER leave a completed directive without deploying it. The code sitting in git helps nobody.\n" +
    "If something needs manual action from King Kazuma, say it clearly: 'I need you to do X.'\n" +
    "\n" +
    "PROACTIVE INVESTIGATION — CRITICAL:\n" +
    "- If King Kazuma asks about something that should already be done, or asks the SAME question " +
    "he's asked before — that's a signal to INVESTIGATE, not just report status.\n" +
    "- Example: 'Why is the media machine plan still in planning after 2 hours?' → Don't just say " +
    "'it's in planning status.' Go find out WHY. Check the directive, check if the planning agent " +
    "ran, look at what happened. Use run_command, read_file, whatever it takes.\n" +
    "- When troubleshooting, show your findings on the board with a clear breakdown: " +
    "what the status is, what went wrong, what the fix is.\n" +
    "- Think like a lead engineer: if something's stuck, own the diagnosis. " +
    "King Kazuma shouldn't have to ask twice — if he does, it means you didn't go deep enough.\n" +
    "\n" +
    "SMART DEVICE CONTROL — VERIFY AND EXPLAIN:\n" +
    "- The tool response now includes state verification (before/after). Read the response carefully — " +
    "it tells you if the state changed, stayed the same, or is unavailable.\n" +
    "- ALWAYS use get_entity_state to check device status BEFORE acting on a device. " +
    "Don't assume a device is unavailable — CHECK FIRST. Example: if King Kazuma says " +
    "'what modes does the washing machine have?', call get_entity_state({entity_id: '151732606804847'}) " +
    "to see all entities and their current states/options.\n" +
    "- When a device IS confirmed 'unavailable', explain WHY using your device knowledge.\n" +
    "- NEVER say 'I sent the command' and move on. Confirm it worked or explain why it didn't.\n" +
    "\n" +
    "DEVICE-SPECIFIC KNOWLEDGE (use ONLY when entities show 'unavailable'):\n" +
    "IMPORTANT: Always check ACTUAL state with get_entity_state BEFORE referencing this list. " +
    "These hints ONLY apply when a device is confirmed unavailable. If the device is 'on' or 'off', " +
    "it's reachable — report its actual state, don't mention sleep mode.\n" +
    "- WASHING MACHINE (Midea MF-200, entities: *151732606804847*): " +
    "IF unavailable: cuts WiFi after ~10 min idle, needs physical power button. " +
    "IF on/off: fully controllable. Use get_entity_state('151732606804847') to check status. " +
    "To start a wash: use start_wash tool with program, temperature, water_level, spin_speed. " +
    "Programs: cotton, eco, fast_wash, mixed, wool, baby_clothes, quick_wash, fast_30, fast_60, standard, delicate, silk, down_jacket, cold_wash. " +
    "To pause: use stop_wash. The tool handles powering on automatically if needed. " +
    "IMPORTANT: Remote Start must be enabled on the physical washing machine panel — long-press the WiFi button until the WiFi icon lights up. " +
    "Without this, parameter changes work but the cycle won't start. If start_wash reports the machine stayed in standby, " +
    "tell King Kazuma to enable Remote Start on the panel, then try again.\n" +
    "- MAIN TV (media_player.main_tv): 'off' = standby (reachable). 'unavailable' = network issue.\n" +
    "- SOUS VIDE (switch.s_vide_switch): 'unavailable' = likely unplugged.\n" +
    "- CAMERAS (switch.cam1_*, switch.living_room_cam_*): 'unavailable' = check network.\n" +
    "\n" +
    "MANDATORY CONFIRMATION BEFORE EVERY DIRECTIVE:\n" +
    "Before calling send_dev_directive, you MUST call confirm_understanding first. " +
    "Read the summary back to King Kazuma. Wait for his confirmation. ONLY THEN create the directive. " +
    "This prevents the recurring problem of directives being based on misunderstood voice input.\n\n" +
    "RICH DIRECTIVES — GIVE THE IMPLEMENTING AGENT EVERYTHING:\n" +
    "When you call send_dev_directive, your description is ALL the implementing Cipher agent gets. " +
    "Include EVERYTHING needed to do the work without asking questions:\n" +
    "- Device IPs and ports (e.g. '172.168.0.58 port 6444')\n" +
    "- Protocol details (e.g. 'M-Smart protocol, not Tuya')\n" +
    "- Known limitations (e.g. 'device sleeps after 10 min, must be physically on during integration')\n" +
    "- Credentials or where to find them (e.g. 'MSmartHome cloud credentials in HA config entry')\n" +
    "- What King Kazuma said — his exact requirements and preferences\n" +
    "- Expected entity IDs or naming patterns\n" +
    "- Integration method (e.g. 'HACS custom component midea_ac_lan from wuwentao fork')\n" +
    "- Network details: GCP VM (10.128.0.8), VPN (10.8.0.1), home LAN (172.168.0.x), dev-01 (172.168.0.59)\n" +
    "- The implementing agent can: read/write files, run Bash, SSH to LAN devices, use Docker, git push, " +
    "curl APIs, install packages. It runs on the GCP VM with full access.\n" +
    "ALWAYS include King Kazuma's original words in the 'context' field of send_dev_directive. " +
    "This gives the worker agent direct access to what the user actually said, not just your interpretation.\n" +
    "A vague directive like 'Add the washing machine to HA' will FAIL. A good directive says exactly " +
    "how to do it, what to watch out for, and what success looks like.\n" +
    "\n" +
    "BE THE BRIDGE BETWEEN VOICE AND CLI:\n" +
    "King Kazuma should NEVER need to open the CLI. You handle everything via voice.\n" +
    "\n" +
    "OPERATIONAL (do it yourself with run_command/tools):\n" +
    "- Check logs, restart services, deploy updates, ping devices, check HA state\n" +
    "- Monitor directive agent progress (tail agent log files)\n" +
    "\n" +
    "DEVELOPMENT (create a directive — an Opus agent does the work):\n" +
    "- Any code change, bug fix, new feature, config edit, integration\n" +
    "- The directive agent has full dev tools (Read, Write, Edit, Bash, Grep, Glob)\n" +
    "- You don't have those tools — and that's by design. You're the router, not the coder.\n" +
    "You ARE the CLI interface via voice. Act like it.\n";

  let systemPromptText;
  if (cipherMode === "learning") {
    systemPromptText = CIPHER_LEARNING_PROMPT + situationBriefing + VOICE_RULES + CODEBASE_SNAPSHOT + INFRA_MAP + memoryContext;
  } else {
    systemPromptText = CIPHER_BUILDING_PROMPT + situationBriefing + VOICE_RULES + entityContext + CODEBASE_SNAPSHOT + INFRA_MAP + memoryContext;
  }

  // Build tool set — pass Gemini-format tools (pipeline converts to Zod/MCP internally)
  let pipelineTools;
  if (cipherMode === "learning") {
    const rememberTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "remember");
    const readFileTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "read_file");
    const runCommandTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "run_command");
    const showContentTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "show_content");
    const hideContentTool = GEMINI_BRIDGE_TOOLS.find(t => t.name === "hide_content");
    pipelineTools = [rememberTool, readFileTool, runCommandTool, showContentTool, hideContentTool, SWITCH_TO_JUNE_TOOL].filter(Boolean);
  } else {
    pipelineTools = [...GEMINI_HA_TOOLS, ...GEMINI_BRIDGE_TOOLS, SWITCH_TO_JUNE_TOOL];
  }

  // Detect if a cipher-voice phone is connected — use textOnly mode if so
  const hasCipherPhone = cipherPhoneWs && cipherPhoneWs.readyState === WebSocket.OPEN;
  const textOnly = !!hasCipherPhone;
  if (textOnly) {
    log.cipher.info("Starting pipeline in textOnly mode — iPhone handles STT/TTS on-device");
  }

  cipherPipeline = new CipherPipeline({
    systemPrompt: systemPromptText,
    tools: pipelineTools,
    handleToolCall: handleToolCall,
    textOnly,
  });

  // Wire pipeline events
  cipherPipeline.on("audio", (pcmBase64) => {
    routeAudio({ type: "audio", data: pcmBase64 });
  });

  // textOnly mode: send response text to phone for on-device TTS
  cipherPipeline.on("responseTextDone", (text) => {
    if (cipherPhoneWs && cipherPhoneWs.readyState === WebSocket.OPEN) {
      cipherPhoneWs.send(JSON.stringify({ type: "cipherResponse", text }));
      log.cipher.info(`Sent response to phone for TTS: "${text.substring(0, 80)}${text.length > 80 ? "..." : ""}"`);
    }
  });

  cipherPipeline.on("inputTranscript", (text) => {
    extendEngagement();
    broadcastToAll({ type: "inputTranscript", text });
    // Log to conversation transcript
    conversationTranscript.push({ role: "user", text });
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "user", text, turnIndex++, null, 'text', { source: 'voice' }).catch(err => log.pg.warn("turn log:", err.message));
    }
  });

  cipherPipeline.on("outputTranscript", (text) => {
    extendEngagement();
    broadcastToAll({ type: "transcript", text });
    pushTranscript({ role: "cipher", text });
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "cipher", text, turnIndex++, null, 'text', { source: 'voice' }).catch(err => log.pg.warn("turn log:", err.message));
    }
  });

  cipherPipeline.on("toolCall", ({ name, args, result }) => {
    extendEngagement();
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "tool", `${name}: ${result.message?.substring(0, 500) || ""}`, turnIndex++, { name, args, success: result.success }, 'tool_result', { toolName: name, success: result.success, source: 'voice' }).catch(err => log.pg.warn("turn log:", err.message));
    }
  });

  cipherPipeline.on("turnComplete", () => {
    broadcastToAll({ type: "turnComplete" });
  });

  cipherPipeline.on("listeningReady", () => {
    broadcastToAll({ type: "listeningReady" });
  });

  cipherPipeline.on("latency", ({ total, thinking, tts }) => {
    log.cipher.info(`Voice latency: ${total}ms total (thinking: ${thinking}ms, TTS: ${tts}ms)`);
    recordLatency({ total, thinking, tts });
  });

  cipherPipeline.on("sessionExhausted", (turnCount) => {
    log.cipher.info(`Session exhausted after ${turnCount} turns — rotating pipeline`);
    // Graceful restart: stop current pipeline, then start fresh
    const oldPipeline = cipherPipeline;
    cipherPipeline = null;
    oldPipeline.stop().then(() => {
      log.cipher.info("Old pipeline stopped, starting fresh session");
      startCipherPipeline();
    }).catch(err => {
      log.cipher.error("Pipeline stop error during rotation:", err.message);
      startCipherPipeline();
    });
  });

  cipherPipeline.on("error", (err) => {
    log.cipher.error("Pipeline error:", err.message);
  });

  cipherPipeline.on("dead", (reason) => {
    log.cipher.error(`Pipeline dead: ${reason} — falling back to Gemini`);
    const deadPipeline = cipherPipeline;
    cipherPipeline = null;
    if (deadPipeline && typeof deadPipeline === "object") {
      deadPipeline.stop().catch(() => {});
    }
    if (devices.size > 0) connectGemini();
  });

  // Start the pipeline
  const ok = await cipherPipeline.start();
  if (!ok) {
    log.cipher.error("Pipeline failed to start, falling back to Gemini");
    cipherPipeline = null;
    if (devices.size > 0) connectGemini();
    return;
  }

  // Create PG conversation record
  const connDevices = [...devices.values()].map(d => d.deviceId);
  db.createConversation("cipher", connDevices).then(id => {
    currentConversationId = id;
    if (id) log.pg.info(`Conversation ${id} started (cipher pipeline)`);
  }).catch(err => log.pg.error("create conversation:", err.message));

  conversationTranscript = [];
  turnIndex = 0;

  // Signal ready to devices
  broadcastToAll({ type: "ready" });

  // Send intro prompt — different for session restore vs live switch
  const isRestore = !personaSwitchPending;
  const intro = isRestore
    ? `[Session restored after a service restart. King Kazuma was speaking with you before the restart. Resume naturally — acknowledge briefly that you're back, one sentence.]`
    : `[You just took over the conversation from June. King Kazuma wanted to speak with you directly in ${cipherMode} mode. Greet him briefly — one sentence — and let him know you're ready.]`;
  setTimeout(() => {
    if (cipherPipeline && typeof cipherPipeline === "object") cipherPipeline.sendSystemPrompt(intro);
  }, 500);
}

// ── Start ──

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
});

// ── Device WebSocket server ──

const wss = new WebSocket.Server({ server, path: "/ws" });

// Ping/pong keepalive — detect dead connections over VPN
const WS_PING_INTERVAL_MS = 30000; // 30s ping
const WS_PONG_TIMEOUT_MS = 10000;  // 10s to respond
_intervals.push(setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._pongPending) {
      // Missed previous pong — connection is dead
      const info = devices.get(ws);
      log.ws.warn(`Ping timeout, terminating: ${info?.deviceId || "unregistered"}`);
      ws.terminate();
      continue;
    }
    ws._pongPending = true;
    ws.ping();
  }
}, WS_PING_INTERVAL_MS));

wss.on("connection", (ws) => {
  log.ws.info("New device connection");
  ws._pongPending = false;
  ws.on("pong", () => { ws._pongPending = false; });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "register") {
        const role = msg.role === "speaker" ? "speaker" : "mic";
        const deviceId = msg.deviceId || "unknown";
        const deviceType = msg.deviceType || (role === "speaker" ? "tv" : "tablet");
        const zone = msg.zone || extractZone(deviceId) || "default";
        const capabilities = msg.capabilities || {
          mic: deviceType !== "tv",
          speaker: true,
        };
        const priorityMap = { tv: 1, tablet: 10, phone: 20 };
        const speakerPriority = msg.speakerPriority ?? priorityMap[deviceType] ?? 10;
        devices.set(ws, { role, deviceId, deviceType, zone, capabilities, speakerPriority });
        metrics.trackWsConnection(deviceId, deviceType);
        log.ws.info(`Device registered: ${deviceId} (${role}, type=${deviceType}, zone=${zone}, caps=${JSON.stringify(capabilities)}, priority=${speakerPriority}), total: ${devices.size}`);
        // Persist device in PG registry
        db.upsertDevice(deviceId, deviceType).catch(err =>
          log.pg.error("upsert device:", err.message));

        // Track cipher-voice-capable phone
        if (deviceType === "phone" && capabilities.cipherVoice) {
          cipherPhoneWs = ws;
          log.ws.info(`Cipher voice phone registered: ${deviceId} — on-device STT/TTS enabled`);

          // If cipher pipeline is running in non-textOnly mode, restart in textOnly mode
          if (cipherPipeline && typeof cipherPipeline === "object" && !cipherPipeline.textOnly) {
            log.cipher.info("Phone with cipherVoice connected — restarting pipeline in textOnly mode");
            const oldPipeline = cipherPipeline;
            cipherPipeline = null;
            oldPipeline.stop().then(() => startCipherPipeline()).catch(() => startCipherPipeline());
            return;
          }
        }

        // Start AI session if not already running (skip during persona switch)
        if (personaSwitchPending) {
          log.ws.info("Persona switch pending, deferring AI session start");
        } else if (cipherPipeline) {
          // Cipher pipeline already active
          ws.send(JSON.stringify({ type: "ready" }));
        } else if (!geminiWs && !geminiConnecting) {
          // Start the correct persona backend
          const hasCipherBackend = !!(process.env.ANTHROPIC_API_KEY || process.env.CIPHER_USE_SDK !== "false");
          if (currentPersona === "cipher" && hasCipherBackend) {
            startCipherPipeline();
          } else {
            connectGemini();
          }
        } else if (geminiReady) {
          // Session already active, tell this device
          ws.send(JSON.stringify({ type: "ready" }));
        }
        return;
      }

      if (msg.type === "audio") {
        const info = devices.get(ws);
        if (!info?.capabilities?.mic) return;
        audioMsgCount++;

        if (cipherPipeline && typeof cipherPipeline === "object") {
          // Apply same activeMic filtering as Gemini — prevents interleaved
          // silence from inactive mic confusing Deepgram's VAD
          const peak = getPeakAmplitude(msg.data);
          const now = Date.now();
          recordAudioStat(info.deviceId, peak);

          if (!activeMic) {
            activeMic = ws;
            log.audio.info(`Cipher mic active: ${info.deviceId}`);
          }
          if (activeMic === ws) {
            if (peak < MIC_SPEECH_THRESHOLD) {
              if (activeMicSilenceSince === 0) activeMicSilenceSince = now;
            } else {
              activeMicSilenceSince = 0;
            }
            const amplified = amplifyAudio(msg.data, AUDIO_GAIN);
            cipherPipeline.sendAudio(amplified);
          } else if (peak >= MIC_SWITCH_THRESHOLD &&
              activeMicSilenceSince > 0 &&
              now - activeMicSilenceSince > MIC_RELEASE_MS &&
              now - lastMicSwitchAt > MIC_SWITCH_COOLDOWN_MS) {
            const oldInfo = devices.get(activeMic);
            log.audio.info(`Cipher mic switch: ${info.deviceId} (peak=${peak}) takes over from ${oldInfo?.deviceId}`);
            activeMic = ws;
            activeMicSilenceSince = 0;
            lastMicSwitchAt = now;
            const amplified = amplifyAudio(msg.data, AUDIO_GAIN);
            cipherPipeline.sendAudio(amplified);
          }
          // else: drop audio from inactive mic
        } else if (!cipherPipeline) {
          sendToGeminiAudio(msg.data, ws, info.deviceId);
        }
        return;
      }

      if (msg.type === "text") {
        if (cipherPipeline && typeof cipherPipeline === "object") {
          cipherPipeline.sendText(msg.text);
        } else if (!cipherPipeline) {
          sendToGeminiText(msg.text);
        }
        return;
      }

      // ── Phone-mode Cipher messages (iPhone on-device STT/TTS) ──

      // iPhone sends STT-transcribed text for Claude processing
      if (msg.type === "cipherText") {
        const info = devices.get(ws);
        if (!info || info.deviceType !== "phone") return;
        if (!cipherPipeline || typeof cipherPipeline !== "object") return;
        if (!msg.text?.trim()) return;
        log.cipher.info(`Phone STT: "${msg.text}" (from ${info.deviceId})`);
        cipherPipeline.sendText(msg.text);
        return;
      }

      // iPhone sends TTS audio (PCM base64) for relay to tablets/TV
      if (msg.type === "cipherAudio") {
        const info = devices.get(ws);
        if (!info || info.deviceType !== "phone") return;
        if (!msg.data) return;
        // Broadcast to all non-phone speaker devices (tablets + TV)
        const audioMsg = JSON.stringify({ type: "audio", data: msg.data });
        for (const [clientWs, clientInfo] of devices) {
          if (clientWs === ws) continue; // Don't send back to iPhone
          if (!clientInfo.capabilities?.speaker) continue;
          if (clientWs.readyState === WebSocket.OPEN) {
            try { clientWs.send(audioMsg); } catch {}
          }
        }
        return;
      }

      // iPhone signals TTS playback finished
      if (msg.type === "cipherTtsDone") {
        const info = devices.get(ws);
        if (!info || info.deviceType !== "phone") return;
        // Broadcast turnComplete to all devices (tablets know speech ended)
        broadcastToAll({ type: "turnComplete" });
        return;
      }

      if (msg.type === "upload") {
        const { target, contentType, data, filename } = msg;
        if (!target || !contentType || !data) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid upload: missing target, contentType, or data" }));
          return;
        }
        const info = devices.get(ws);
        log.bridge.info(`Upload received: target=${target}, type=${contentType}, file=${filename || "(text)"}, from=${info?.deviceId}`);

        // Persist uploads to disk so they can be referenced later
        try {
          const uploadsDir = "/tmp/ozzu-bridge/uploads";
          const fs = require("fs");
          fs.mkdirSync(uploadsDir, { recursive: true });
          const ts = Date.now();
          const safeName = (filename || `upload-${ts}`).replace(/[^a-zA-Z0-9._-]/g, "_");
          const savePath = `${uploadsDir}/${ts}-${target}-${safeName}`;
          if (contentType === "image") {
            fs.writeFileSync(savePath, Buffer.from(data, "base64"));
          } else {
            fs.writeFileSync(savePath, data, "utf8");
          }
          // Write metadata
          fs.writeFileSync(`${savePath}.meta.json`, JSON.stringify({
            timestamp: ts, target, contentType, filename, from: info?.deviceId,
            savedAs: savePath,
          }, null, 2));
          log.bridge.info(`Upload persisted: ${savePath}`);
        } catch (persistErr) {
          log.bridge.warn(`Upload persist failed: ${persistErr.message}`);
        }

        // Log upload to conversation transcript
        if (currentConversationId) {
          db.addConversationTurn(currentConversationId, "user", `[Upload: ${filename || "(unnamed)"}]`, turnIndex++, null, 'upload', {
            filename: filename || null, contentType, target, from: info?.deviceId
          }).catch(err => log.pg.warn("upload turn log:", err.message));
        }

        if (target === "cipher") {
          if (!cipherPipeline || typeof cipherPipeline !== "object") {
            ws.send(JSON.stringify({ type: "error", message: "Cipher is not active" }));
            return;
          }
          if (contentType === "image") {
            const ext = (filename || "").split(".").pop()?.toLowerCase() || "jpg";
            const mediaType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
            cipherPipeline.sendImage(data, mediaType, filename);
          } else {
            const label = filename ? `[UPLOAD] File "${filename}" from King Kazuma:\n${data}` : `[UPLOAD] Content from King Kazuma:\n${data}`;
            cipherPipeline.sendText(label);
          }
        } else if (target === "june") {
          if (!geminiReady || !geminiWs || geminiWs.readyState !== 1) {
            ws.send(JSON.stringify({ type: "error", message: "June is not active" }));
            return;
          }
          if (contentType === "image") {
            const mimeType = filename?.match(/\.png$/i) ? "image/png" : "image/jpeg";
            geminiWs.send(JSON.stringify({
              clientContent: {
                turns: [{
                  role: "user",
                  parts: [
                    { text: `[King Kazuma uploaded an image${filename ? `: ${filename}` : ""}]` },
                    { inlineData: { mimeType, data } },
                  ],
                }],
                turnComplete: true,
              },
            }));
          } else {
            const label = filename ? `[King Kazuma uploaded "${filename}"]:\n${data}` : `[King Kazuma shared text]:\n${data}`;
            sendToGeminiText(label);
          }
        } else {
          ws.send(JSON.stringify({ type: "error", message: `Unknown upload target: ${target}` }));
        }
        return;
      }

      // ── Glasses integration messages ──

      if (msg.type === "glassesFrame") {
        const info = devices.get(ws);
        // Forward camera frame to Gemini for vision analysis (if session is active)
        if (geminiReady && geminiWs && geminiWs.readyState === 1 && msg.data) {
          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{
                role: "user",
                parts: [
                  { text: "[Live glasses camera frame — describe what you see briefly]" },
                  { inlineData: { mimeType: "image/jpeg", data: msg.data } },
                ],
              }],
              turnComplete: true,
            },
          }));
          log.bridge.debug(`Glasses frame forwarded to Gemini (${msg.width}x${msg.height}) from ${info?.deviceId}`);
        }
        return;
      }

      if (msg.type === "glassesPhoto") {
        const info = devices.get(ws);
        log.bridge.info(`Glasses photo captured from ${info?.deviceId}`);
        // Save to disk
        try {
          const uploadsDir = "/tmp/ozzu-bridge/uploads";
          fs.mkdirSync(uploadsDir, { recursive: true });
          const ts = Date.now();
          const savePath = `${uploadsDir}/${ts}-glasses-capture.jpg`;
          fs.writeFileSync(savePath, Buffer.from(msg.data, "base64"));
          fs.writeFileSync(`${savePath}.meta.json`, JSON.stringify({
            timestamp: ts, source: "glasses", contentType: "image",
            filename: "glasses-capture.jpg", from: info?.deviceId, savedAs: savePath,
          }, null, 2));
          log.bridge.info(`Glasses photo saved: ${savePath}`);
        } catch (persistErr) {
          log.bridge.warn(`Glasses photo persist failed: ${persistErr.message}`);
        }
        // Make available to Cipher
        if (cipherPipeline && typeof cipherPipeline === "object" && msg.data) {
          cipherPipeline.sendImage(msg.data, "image/jpeg", "glasses-capture.jpg");
        }
        return;
      }

      if (msg.type === "glassesStatus") {
        const info = devices.get(ws);
        if (info) {
          info.glassesState = msg.state;
        }
        log.bridge.info(`Glasses status: ${msg.state} from ${info?.deviceId}`);
        // Broadcast to all other devices
        broadcastToAll({ type: "glassesStatus", state: msg.state, from: info?.deviceId });
        return;
      }

      if (msg.type === "pinResponse") {
        const pending = pendingPinRequests.get(msg.approvalId);
        if (!pending) {
          // Stale PIN response — dismiss keypad just in case
          broadcastToDeviceType("phone", { type: "pinResolved", approvalId: msg.approvalId });
          return;
        }
        pendingPinRequests.delete(msg.approvalId);

        // Resolve the approval with the user's PIN
        const approvals = getApprovals();
        const approval = approvals.find((a) => a.id === pending.approvalId);
        if (!approval || approval.resolved) {
          broadcastToDeviceType("phone", { type: "pinResolved", approvalId: msg.approvalId });
          pending.resolve({
            success: true,
            message: approval?.approved
              ? `Action ${pending.approvalId} was already approved.`
              : "Approval not found or already resolved",
          });
          return;
        }

        // Validate PIN
        if (msg.pin !== BRIDGE_PIN) {
          broadcastToDeviceType("phone", { type: "pinResolved", approvalId: msg.approvalId });
          pending.resolve({ success: false, message: "Invalid PIN. Authorization denied." });
          return;
        }

        approval.resolved = true;
        approval.approved = pending.approved;
        approval.resolvedAt = Date.now();
        saveApprovals(approvals, approval);
        syncDirectiveFromApproval(pending.approvalId, pending.approved);
        // Tell ALL devices to dismiss their keypads
        broadcastToDeviceType("phone", { type: "pinResolved", approvalId: msg.approvalId });
        pending.resolve({
          success: true,
          message: pending.approved
            ? `Action ${pending.approvalId} approved by King Kazuma.`
            : `Action ${pending.approvalId} denied.`,
        });
        return;
      }
    } catch (err) {
      log.ws.error("Message parse error:", err.message);
    }
  });

  ws.on("close", () => {
    const info = devices.get(ws);
    if (info) metrics.trackWsDisconnection(info.deviceId);
    devices.delete(ws);
    if (ws === activeMic) {
      activeMic = null;
      activeMicSilenceSince = 0;
    }
    // Clean up audio stats for disconnected device
    if (info?.deviceId) {
      audioStats.delete(info.deviceId);
    }
    // If cipher-voice phone disconnected, fall back to Deepgram pipeline
    if (ws === cipherPhoneWs) {
      cipherPhoneWs = null;
      log.ws.info("Cipher voice phone disconnected — falling back to Deepgram STT/TTS");
      if (cipherPipeline && typeof cipherPipeline === "object" && cipherPipeline.textOnly) {
        const oldPipeline = cipherPipeline;
        cipherPipeline = null;
        oldPipeline.stop().then(() => {
          if (devices.size > 0 && currentPersona === "cipher") startCipherPipeline();
        }).catch(() => {
          if (devices.size > 0 && currentPersona === "cipher") startCipherPipeline();
        });
      }
    }
    log.ws.info(`Device disconnected: ${info?.deviceId || "unknown"}, remaining: ${devices.size}`);
    if (info?.capabilities?.speaker) {
      const newTarget = selectSpeaker();
      if (newTarget) {
        log.ws.info(`Speaker failover: ${info.deviceId} -> ${newTarget.info.deviceId}`);
      } else {
        log.ws.warn(`Speaker failover: ${info.deviceId} -> NONE`);
      }
    }
    disconnectGeminiIfEmpty();
  });

  ws.on("error", (err) => {
    log.ws.error("Device error:", err.message);
  });
});

(async () => {
  await initStorage();
  // Bootstrap orchestrator session (non-blocking — directives fall back to direct spawn if unavailable)
  orchestrator.ensureSession().then(async () => {
    const info = orchestrator.getSessionInfo();
    if (info) {
      log.bridge.info(`Orchestrator session: ${info.id} (${info.messageCount} messages)`);
      // Notify orchestrator of restart with active directive summary
      try {
        const active = _directives.filter(d => ["planning", "approved", "in_progress"].includes(d.status));
        if (active.length > 0) {
          await orchestrator.sendMessage(`BRIDGE_RESTARTED: ${JSON.stringify({
            activeDirectives: active.map(d => ({ id: d.id, title: d.title, status: d.status, type: d.type })),
          })}`);
        }
      } catch {}
    } else {
      log.bridge.info("Orchestrator unavailable — directives will use direct spawn");
    }
  }).catch(err => {
    log.bridge.error(`Orchestrator bootstrap failed: ${err.message}`);
  });
  server.listen(PORT, "0.0.0.0", () => {
    log.bridge.info(`listening on :${PORT}`);
    log.bridge.info(`data dir: ${DATA_DIR}, redis: ${_redisConnected ? "connected" : "fallback to JSON"}`);
    log.bridge.info(`HA: ${HA_URL}, Gemini: ${GEMINI_API_KEY ? "configured" : "NOT SET"}`);
    log.bridge.info(`agent spawner: ready (event-driven, replaces cipher-watcher polling)`);
    startWatchdog();
    metrics.startFlushTimer();

    // Notify June about restart if this isn't the first boot
    if (_restartCount > 0 && _previousStartedAt) {
      const prevUptime = Math.round((new Date(_serverStartedAt).getTime() - new Date(_previousStartedAt).getTime()) / 1000);
      const uptimeStr = `${Math.floor(prevUptime / 3600)}h ${Math.floor((prevUptime % 3600) / 60)}m ${Math.floor(prevUptime % 60)}s`;
      const hadActiveAgents = _directives.some(d => d.failureReason && d.failureReason.startsWith("crash: server restarted"));
      setTimeout(() => {
        engage("bridge restart notification");
        sendNotification(
          `[SYSTEM — Don't read this out loud, just let King Kazuma know casually.]\n` +
          `You just came back online after a restart.` +
          (hadActiveAgents ? ` Some work might've been interrupted.` : ``) +
          (_lastRestartReason && !_lastRestartReason.includes("unknown") ? ` Reason: ${_lastRestartReason}.` : ``) +
          ` Just say you're back — don't dump technical stats.`
        );
      }, 15000);
    }
  });
})();

// Global error handlers — prevent silent crashes
process.on("unhandledRejection", (reason, promise) => {
  log.bridge.error("Unhandled Promise Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  log.bridge.error("Uncaught Exception:", err.message, err.stack);
  killAllAgents();
  process.exit(1);
});

// Graceful shutdown: save conversation, kill agents, close connections, exit
async function gracefulShutdown(signal) {
  log.bridge.info(`${signal} received, shutting down...`);
  // Clear all tracked intervals
  for (const id of _intervals) clearInterval(id);
  _intervals.length = 0;
  // Clear tracked timers
  if (_geminiReconnectTimer) { clearTimeout(_geminiReconnectTimer); _geminiReconnectTimer = null; }
  // End the current conversation in PG so it doesn't stay orphaned
  if (currentConversationId) {
    try {
      await db.endConversation(currentConversationId, "Session ended (server shutdown)", conversationTranscript.length);
      log.pg.info(`Conversation ${currentConversationId} closed on shutdown`);
    } catch (err) {
      log.pg.warn("shutdown conversation close:", err.message);
    }
  }
  // Stop Cipher pipeline if running
  if (cipherPipeline && typeof cipherPipeline === "object") {
    try { await cipherPipeline.stop(); } catch {}
  }
  killAllAgents();
  // Close WebSocket server and all client connections
  try {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  } catch {}
  // Close HTTP server
  try { server.close(); } catch {}
  // Close database and Redis connections
  try { await db.close(); } catch {}
  try { redis.disconnect(); } catch {}
  log.bridge.info("Shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
