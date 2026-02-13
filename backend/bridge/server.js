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

const PORT = 3333;
const DATA_DIR = "/tmp/ozzu-bridge";
const UPDATES_DIR = path.join(DATA_DIR, "updates");
const STATUS_FILE = path.join(DATA_DIR, "status.json");
const APPROVALS_FILE = path.join(DATA_DIR, "approvals.json");
const DIRECTIVES_FILE = path.join(DATA_DIR, "directives.json");
const MAX_STATUS_ENTRIES = 20;
const MAX_DIRECTIVES = 20;
const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours (plan reviews need time)

const BRIDGE_PIN = process.env.BRIDGE_PIN || "1234";
const HA_URL = process.env.HA_URL || "http://localhost:8123";
const HA_TOKEN = process.env.HA_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
// ── Persona system ──
let currentPersona = "june"; // "june" or "cipher"
let cipherMode = null; // "building" or "learning"
let personaSwitchPending = false;
let goAwayDuringToolCall = false;
let goAwayPartialOutput = ""; // tracks what Gemini was saying before disconnect
let goAwayNudgeTimer = null;  // retry timer for recovery nudge
let cipherPipeline = null; // CipherPipeline instance when Cipher is active (Deepgram STT → Claude → Cartesia TTS)
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
  { entityId: "switch.media_washer_power", label: "Washing Machine — Power" },
  { entityId: "sensor.media_washer_status", label: "Washing Machine — Status" },
  { entityId: "sensor.media_washer_remaining_time", label: "Washing Machine — Time Remaining" },
  { entityId: "select.media_washer_mode", label: "Washing Machine — Cycle" },
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
  "grep", "nmap",
]);

const CMD_BLOCKED_PATTERNS = [
  /\brm\b/, /\brmdir\b/, /\bdd\b/, /\bmkfs\b/, /\bchmod\b/, /\bchown\b/,
  /\bkill\b/, /\bkillall\b/,
  /\.env/, /secrets\.yaml/, /openvpn\/config/, /\/etc\/shadow/, /\/etc\/passwd/,
];

const CMD_BLOCKED_OPERATORS = [";", "&&", "||", "&", ">", ">>", "$(", "`", "\n"];

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

  // Split on pipes — each segment's first token must be whitelisted
  const segments = trimmed.split("|").map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const firstToken = seg.split(/\s+/)[0];
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

function getStatusEntries() { return _statusEntries; }
function saveStatusEntries(entries, latestEntry = null) {
  _statusEntries = entries;
  writeJSON(STATUS_FILE, entries);
  if (_redisConnected) redis.set("ozzu:status", JSON.stringify(entries)).catch(err =>
    console.error("[redis] save status failed:", err.message));
  // Write to PG (uncapped history)
  if (latestEntry) {
    db.addStatusEntry(latestEntry, currentPersona).catch(err =>
      console.error("[pg] save status failed:", err.message));
  }
}

function getApprovals() { return _approvals; }
function saveApprovals(approvals, changedApproval = null) {
  _approvals = approvals;
  writeJSON(APPROVALS_FILE, approvals);
  if (_redisConnected) redis.set("ozzu:approvals", JSON.stringify(approvals)).catch(err =>
    console.error("[redis] save approvals failed:", err.message));
  // Write changed approval to PG
  if (changedApproval) {
    db.saveApproval(changedApproval).catch(err =>
      console.error("[pg] save approval failed:", err.message));
  }
}

function getDirectives() { return _directives; }
function saveDirectives(directives, changedDirective = null, oldStatus = null) {
  _directives = directives;
  writeJSON(DIRECTIVES_FILE, directives);
  if (_redisConnected) redis.set("ozzu:directives", JSON.stringify(directives)).catch(err =>
    console.error("[redis] save directives failed:", err.message));
  // Write changed directive to PG + history
  if (changedDirective) {
    db.saveDirective(changedDirective).catch(err =>
      console.error("[pg] save directive failed:", err.message));
    if (oldStatus !== null && oldStatus !== changedDirective.status) {
      db.addDirectiveHistory(changedDirective.id, oldStatus, changedDirective.status, "system").catch(err =>
        console.error("[pg] save directive history failed:", err.message));
    }
  }
}

async function initStorage() {
  ensureDataDir();

  // Connect to Redis
  try {
    await redis.connect();
    _redisConnected = true;
    console.log("[redis] Connected");

    // Restore active persona from Redis
    const savedPersona = await redis.get("ozzu:activePersona");
    if (savedPersona) {
      const { persona, cipherMode: mode } = JSON.parse(savedPersona);
      currentPersona = persona;
      cipherMode = mode;
      console.log(`[startup] Restored persona: ${persona}${mode ? ` (${mode})` : ""}`);
    }

    // Load from Redis, or migrate from JSON files
    const storedDirectives = await redis.get("ozzu:directives");
    if (storedDirectives) {
      _directives = JSON.parse(storedDirectives);
    } else if (fs.existsSync(DIRECTIVES_FILE)) {
      _directives = readJSON(DIRECTIVES_FILE, []);
      await redis.set("ozzu:directives", JSON.stringify(_directives));
      console.log("[redis] Migrated directives from JSON");
    }

    const storedApprovals = await redis.get("ozzu:approvals");
    if (storedApprovals) {
      _approvals = JSON.parse(storedApprovals);
    } else if (fs.existsSync(APPROVALS_FILE)) {
      _approvals = readJSON(APPROVALS_FILE, []);
      await redis.set("ozzu:approvals", JSON.stringify(_approvals));
      console.log("[redis] Migrated approvals from JSON");
    }

    const storedStatus = await redis.get("ozzu:status");
    if (storedStatus) {
      _statusEntries = JSON.parse(storedStatus);
    } else if (fs.existsSync(STATUS_FILE)) {
      _statusEntries = readJSON(STATUS_FILE, []);
      await redis.set("ozzu:status", JSON.stringify(_statusEntries));
      console.log("[redis] Migrated status from JSON");
    }
  } catch (err) {
    console.error("[redis] Connection failed, falling back to JSON files:", err.message);
    _directives = readJSON(DIRECTIVES_FILE, []);
    _approvals = readJSON(APPROVALS_FILE, []);
    _statusEntries = readJSON(STATUS_FILE, []);
  }

  // Clean up stale directives on startup — anything stuck in transient states
  // (planning, in_progress) for over 1 hour is likely from a crashed session
  const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
  const now = Date.now();
  let staleCount = 0;
  for (const d of _directives) {
    if ((d.status === "planning" || d.status === "in_progress") && d.updatedAt) {
      const age = now - new Date(d.updatedAt).getTime();
      if (age > STALE_THRESHOLD_MS) {
        const oldStatus = d.status;
        d.status = d.status === "planning" ? "pending" : "stale";
        d.updatedAt = new Date().toISOString();
        staleCount++;
        console.log(`[directive] Cleaned stale: ${d.id} "${d.title}" (${oldStatus} → ${d.status}, age: ${Math.round(age / 60000)}min)`);
      }
    }
  }
  if (staleCount > 0) {
    saveDirectives(_directives);
    console.log(`[directive] Cleaned ${staleCount} stale directive(s) on startup`);
  }

  // Clean up expired approvals (older than 1 hour and still pending)
  const freshApprovals = _approvals.filter(a => {
    if (a.status !== "pending") return true;
    const age = now - new Date(a.createdAt || 0).getTime();
    if (age > STALE_THRESHOLD_MS) {
      console.log(`[approval] Expired stale: ${a.id} (age: ${Math.round(age / 60000)}min)`);
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
    setInterval(() => captureEntitySnapshots().catch(err =>
      console.error("[pg] snapshot error:", err.message)), 5 * 60 * 1000);
    // Prune old snapshots daily
    setInterval(() => db.pruneEntitySnapshots(7).catch(err =>
      console.error("[pg] prune error:", err.message)), 24 * 60 * 60 * 1000);
  }
}

async function migrateRedisToPostgres() {
  try {
    // Check if migration already done
    const existing = await db.query("SELECT COUNT(*) as count FROM memories");
    if (existing.rows[0].count > 0) {
      console.log("[pg] Data already present, skipping migration");
      return;
    }

    console.log("[pg] Starting Redis → PostgreSQL migration...");

    // Migrate memories
    if (_redisConnected) {
      for (const persona of ["june", "cipher"]) {
        const raw = await redis.zrevrange(`${persona}:facts`, 0, -1);
        const memories = raw.map(r => JSON.parse(r));
        const count = await db.migrateMemoriesFromRedis(persona, memories);
        if (count > 0) console.log(`[pg] Migrated ${count} ${persona} memories`);
      }

      // Migrate summaries
      for (const persona of ["june", "cipher"]) {
        const raw = await redis.lrange(`${persona}:summaries`, 0, -1);
        const summaries = raw.map(r => JSON.parse(r));
        const count = await db.migrateSummariesFromRedis(persona, summaries);
        if (count > 0) console.log(`[pg] Migrated ${count} ${persona} summaries`);
      }
    }

    // Migrate directives
    if (_directives.length > 0) {
      const count = await db.migrateDirectivesFromRedis(_directives);
      console.log(`[pg] Migrated ${count} directives`);
    }

    // Migrate approvals
    if (_approvals.length > 0) {
      const count = await db.migrateApprovalsFromRedis(_approvals);
      console.log(`[pg] Migrated ${count} approvals`);
    }

    // Migrate status entries
    if (_statusEntries.length > 0) {
      const count = await db.migrateStatusFromRedis(_statusEntries);
      console.log(`[pg] Migrated ${count} status entries`);
    }

    console.log("[pg] Migration complete");
  } catch (err) {
    console.error("[pg] Migration error:", err.message);
  }
}

async function captureEntitySnapshots() {
  if (!db.isConnected()) return;
  try {
    const states = await haFetch("/api/states");
    const entityIds = new Set(ENTITY_CONFIG.map((e) => e.entityId));
    for (const state of states) {
      if (!entityIds.has(state.entity_id)) continue;
      await db.addEntitySnapshot(state.entity_id, state.state, state.attributes || null);
    }
  } catch (err) {
    console.error("[pg] Entity snapshot capture failed:", err.message);
  }
}

// ── Per-persona memory system (Redis ZSETs + LISTs) ──

async function addMemory(persona, fact, category = "general") {
  // Write to PG (primary)
  db.addMemory(persona, fact, category, "voice").catch(err =>
    console.error("[pg] addMemory failed:", err.message));
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
      console.error("[pg] getMemories failed, falling back to Redis:", err.message);
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
      console.error("[pg] addConversationSummary failed:", err.message);
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
      console.error("[pg] getRecentSummaries failed, falling back to Redis:", err.message);
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

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
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

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

// ── Route handlers ──

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    sendJSON(res, 204, null);
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

    // Notify June about blocker/error events from Cipher
    const evt = (entry.event || "").toLowerCase();
    if (evt === "blocker" || evt === "error" || evt === "blocked") {
      setTimeout(() => {
        engage("cipher status notification");
        sendToGeminiText(
          `[SYSTEM NOTIFICATION — Summarize naturally to King Kazuma.]\n` +
          `Cipher reported a ${entry.event}: ${entry.message}\n` +
          `Let King Kazuma know so he can help resolve it.`
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

  // POST /notify — Push a notification to June (used by cipher-watcher, deploy scripts, etc.)
  if (req.method === "POST" && pathname === "/notify") {
    const data = await parseBody(req);
    if (data.message) {
      setTimeout(() => {
        engage("system notification");
        sendToGeminiText(
          `[SYSTEM NOTIFICATION — Summarize naturally to King Kazuma.]\n${data.message}`
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
      console.log(`[approvals] Auto-approved (${approval.risk}): ${approval.description}`);
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
      sendToGeminiText(
        `[SYSTEM NOTIFICATION — Summarize naturally to King Kazuma.]\n` +
        `Cipher needs approval for something important: ${approval.description}\n` +
        `This is a high-risk action that requires King Kazuma's authorization.\n` +
        `Approval ID: ${approval.id}\n\n` +
        `Ask King Kazuma if he wants to approve this. ` +
        `If yes, use the approve_action tool with approval ID "${approval.id}" and needs_user_pin: true.`
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
    const directive = {
      id: `dir_${Date.now()}`,
      type: data.type,
      title: data.title || "",
      description: data.description,
      status: "pending",
      plan: null,
      directiveApprovalId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const directives = getDirectives();
    directives.push(directive);
    while (directives.length > MAX_DIRECTIVES) directives.shift();
    saveDirectives(directives, directive, null);
    sendJSON(res, 200, { ok: true, directive });
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

  // PATCH /directives/:id — Update directive (status, plan, title)
  const directivePatchMatch = pathname.match(/^\/directives\/([^/]+)$/);
  if (req.method === "PATCH" && directivePatchMatch) {
    const id = directivePatchMatch[1];
    const data = await parseBody(req);
    const directives = getDirectives();
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      sendJSON(res, 404, { error: "Directive not found" });
      return;
    }

    // Apply updates
    const prevStatus = directive.status;
    if (data.status) directive.status = data.status;
    if (data.plan !== undefined) directive.plan = data.plan;
    if (data.title) directive.title = data.title;
    directive.updatedAt = Date.now();

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
        sendToGeminiText(
          `[SYSTEM NOTIFICATION — Do NOT read this verbatim. Summarize naturally to King Kazuma.]\n` +
          `Cipher just finished planning the directive "${directive.title}". ` +
          `The plan needs King Kazuma's approval before implementation can begin. ` +
          `Here's the plan summary:\n${planSummary}\n\n` +
          `Tell King Kazuma the plan is ready and ask if he'd like to approve it. ` +
          `If he says yes, use the approve_action tool with approval ID "${approvalId}" and needs_user_pin: true.`
        );
      }, 500);
    }

    // Notify June about other lifecycle transitions
    if (data.status && data.status !== prevStatus) {
      const title = directive.title;
      const notifyJune = (msg) => setTimeout(() => {
        engage("directive lifecycle notification");
        sendToGeminiText(msg);
      }, 500);

      if (directive.status === "in_progress" && prevStatus === "approved") {
        notifyJune(
          `[SYSTEM NOTIFICATION — Summarize naturally to King Kazuma.]\n` +
          `Cipher has started implementing "${title}". ` +
          `Let King Kazuma know that the work is now in progress. ` +
          `He can ask you for status updates anytime.`
        );
      } else if (directive.status === "completed" && prevStatus === "in_progress") {
        notifyJune(
          `[SYSTEM NOTIFICATION — Summarize naturally to King Kazuma.]\n` +
          `Cipher has finished implementing "${title}". ` +
          `The code has been committed and pushed. A CI build is running now — ` +
          `once it passes, the update will be deployed to all devices automatically. ` +
          `Let King Kazuma know it's done and the build is on its way.`
        );
      }
    }

    saveDirectives(directives, directive, prevStatus);
    sendJSON(res, 200, { ok: true, directive });
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

    if (!fs.existsSync(metadataPath)) {
      // No update available — return directive
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        "Access-Control-Allow-Origin": "*",
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

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const platformMeta = metadata.fileMetadata?.[platform];
    if (!platformMeta) {
      sendJSON(res, 404, { error: `No ${platform} update found` });
      return;
    }

    // Compute update ID from metadata
    const metaHash = crypto.createHash("sha256").update(fs.readFileSync(metadataPath)).digest("hex");
    const updateId = `${metaHash.slice(0,8)}-${metaHash.slice(8,12)}-${metaHash.slice(12,16)}-${metaHash.slice(16,20)}-${metaHash.slice(20,32)}`;

    // If client already has this update, return no-update
    if (currentUpdateId === updateId) {
      const boundary = "ota-boundary";
      res.writeHead(200, {
        "expo-protocol-version": "1",
        "expo-sfv-version": "0",
        "cache-control": "private, max-age=0",
        "content-type": `multipart/mixed; boundary=${boundary}`,
        "Access-Control-Allow-Origin": "*",
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

    // Build launch asset info
    const bundlePath = path.join(updateDir, platformMeta.bundle);
    const bundleData = fs.readFileSync(bundlePath);
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

    // Build assets list
    const assets = (platformMeta.assets || []).map((a) => {
      const assetPath = path.join(updateDir, a.path);
      const assetData = fs.readFileSync(assetPath);
      return {
        hash: crypto.createHash("sha256").update(assetData).digest("base64url"),
        key: crypto.createHash("md5").update(assetData).digest("hex"),
        fileExtension: `.${a.ext}`,
        contentType: a.ext === "png" ? "image/png" : a.ext === "jpg" ? "image/jpeg" : "application/octet-stream",
        url: `${baseUrl}&asset=${encodeURIComponent(a.path)}`,
      };
    });

    // Load expoConfig if available
    const expoConfigPath = path.join(updateDir, "expoConfig.json");
    const expoClient = fs.existsSync(expoConfigPath) ? JSON.parse(fs.readFileSync(expoConfigPath, "utf8")) : {};

    const createdAt = fs.statSync(metadataPath).mtime.toISOString();

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
      "Access-Control-Allow-Origin": "*",
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

    const filePath = path.join(UPDATES_DIR, runtimeVersion, assetPath);
    // Prevent directory traversal
    if (!filePath.startsWith(path.join(UPDATES_DIR, runtimeVersion))) {
      sendJSON(res, 403, { error: "Forbidden" });
      return;
    }

    if (!fs.existsSync(filePath)) {
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
      "Access-Control-Allow-Origin": "*",
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

  // Full health check endpoint
  if (req.method === "GET" && pathname === "/health") {
    const pgHealth = await db.healthCheck();
    sendJSON(res, 200, {
      service: "ozzu-bridge",
      uptime: process.uptime(),
      redis: _redisConnected,
      postgres: pgHealth,
      gemini: { connected: !!geminiReady, model: GEMINI_MODEL },
      devices: [...devices.values()].map(d => ({ deviceId: d.deviceId, role: d.role })),
      persona: currentPersona,
      cipherMode,
    });
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
  "DEVELOPMENT BRIDGE: You are the communication layer between King Kazuma and Cipher. " +
  "You do NOT write code or create technical plans — that is Cipher's job. Cipher knows the codebase, you don't. " +
  "Your role is to LISTEN to Kazuma's ideas, make sure you fully understand what he wants, " +
  "ask clarifying questions about intent and desired outcome (NOT technical implementation), " +
  "then send a faithful description to Cipher via send_dev_directive. " +
  "Use Kazuma's own words and intent — do NOT add your own technical interpretation or solution guesses. " +
  "When asked what Cipher is working on, what's being built, or dev status, call get_dev_status. " +
  "For pending approvals or authorization requests, call get_pending_approvals. " +
  "\n\n" +
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
  "DIRECTIVE SYSTEM — Project Management: " +
  "You manage development directives between King Kazuma and Cipher. " +
  "When Kazuma has an idea, request, or task, translate it into a structured directive using send_dev_directive. " +
  "\n" +
  "Three directive types: " +
  "\n" +
  "1. QUICK — Small fixes, tweaks, minor tasks. Cipher executes immediately, no plan needed. " +
  "Example: 'fix that typo', 'update the color to blue', 'add a log statement'. " +
  "\n" +
  "2. FEATURE — New features or significant changes. Requires a plan that King Kazuma must PIN-approve. " +
  "Example: 'build a cooking mode', 'add user profiles', 'redesign the dashboard'. " +
  "\n" +
  "3. EXPLORE — Research or investigation. Cipher researches and reports back, no plan needed. " +
  "Example: 'look into WebRTC options', 'what would it take to add offline mode'. " +
  "\n\n" +
  "FEATURE DIRECTIVE WORKFLOW (critical — follow these steps): " +
  "\n" +
  "1. Kazuma describes a feature → FIRST, summarize back what you understood and ask if you got it right. " +
  "Once confirmed, call send_dev_directive with type 'feature', a clear title, and a description that " +
  "captures Kazuma's intent and desired outcome in his own words. Do NOT add implementation details — Cipher will figure those out. " +
  "\n" +
  "2. Cipher picks up the directive and creates a plan (status goes: pending → planning → planned). " +
  "\n" +
  "3. When status is 'planned', a plan-approval is auto-created (high risk, needs PIN). " +
  "Periodically call get_directives with status 'planned' to check for directives needing review. " +
  "\n" +
  "4. Present the plan to King Kazuma clearly and ask him to approve it. " +
  "Use approve_action with the directive's directiveApprovalId and needs_user_pin=true. " +
  "\n" +
  "5. After PIN-approval, the directive status moves to 'approved' → 'in_progress'. " +
  "From this point, AUTO-APPROVE all routine Cipher actions (needs_user_pin=false) — " +
  "Cipher is executing the approved plan, so routine operations don't need Kazuma's input. " +
  "\n" +
  "6. Cipher completes work → status: 'completed'. Report the result to Kazuma. " +
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
  "CONVERSATION FLOW — how you and King Kazuma work together:\n" +
  "1. DISCUSS — He brings up a topic or idea. You talk it through like peers. " +
  "Use the board (show_content) when it helps explain something — then put it away.\n" +
  "2. DECIDE — When the idea is solid, send it to the pipeline (send_dev_directive). " +
  "It gets planned, tested, deployed by the Cipher agent.\n" +
  "3. MONITOR — If he asks about something that should be done, or asks the same thing twice, " +
  "that means investigate. Check what's stuck, find the blocker, show findings on the board.\n" +
  "\n" +
  "BUILDING MODE: Help King Kazuma refine ideas and create directives. " +
  "When a feature is ready to build, create it using send_dev_directive. " +
  "Your tools: send_dev_directive, get_directives, get_dev_status, get_pending_approvals, " +
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
  "POST /approvals, GET /approvals, POST /directives, GET /directives, PATCH /directives/:id\n\n" +
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
    description: "Select an option on a select entity (e.g. washing machine cycle). Use select.media_washer_mode as entity_id.",
    parameters: {
      type: "OBJECT",
      properties: {
        entity_id: { type: "STRING", description: "The select entity_id" },
        option: { type: "STRING", description: "The option to select" },
      },
      required: ["entity_id", "option"],
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
    name: "send_dev_directive",
    description: "Send a development directive to Cipher.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: { type: "STRING", description: "quick, feature, or explore" },
        title: { type: "STRING", description: "Short title" },
        description: { type: "STRING", description: "Detailed description" },
      },
      required: ["type", "title", "description"],
    },
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
    description: "Get development directives and their status.",
    parameters: {
      type: "OBJECT",
      properties: {
        status: { type: "STRING", description: "Optional filter: pending, planning, planned, approved, in_progress, completed" },
      },
      required: [],
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
    description: "Execute a shell command on the GCP server for infrastructure operations. " +
      "Available: docker (ps/logs/restart/stats/compose), ping, traceroute, curl, " +
      "ip, nslookup, df, free, uptime, top, ps, cat, ls, grep. " +
      "Pipes allowed. No destructive commands (rm, kill, etc.).",
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
        status: { type: "STRING", description: "Filter by status (directives: pending/planning/planned/approved/in_progress/completed)" },
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
  saveDirectives(directives, directive, prevStatus);
  console.log(`[directive] ${directive.id} → ${directive.status} (approval ${approvalId} ${approved ? "approved" : "denied"})`);
}

// ── HA REST API helper ──

async function haFetch(urlPath, options = {}) {
  const res = await fetch(`${HA_URL}${urlPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${HA_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`HA API ${res.status}: ${await res.text()}`);
  return res.json();
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
      ["pending", "planning", "in_progress", "planned"].includes(d.status)
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
      lines.push(`- ${label} (${state.entity_id}): ${state.state}${unit ? ` ${unit}` : ""}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.error("[gemini] Failed to fetch entity context:", err.message);
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
      console.warn(`[persona] Unexpected mode "${args.mode}", defaulting to building`);
    }
    console.log(`[persona] switch_to_cipher: requested="${args.mode}" → resolved="${mode}"`);
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
      console.log(`[memory] ${persona} remembered: "${args.fact}" [${args.category || "general"}]`);
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
        return new Promise((resolve) => {
          const pinId = `pin_${Date.now()}`;
          pendingPinRequests.set(pinId, { approvalId, approved, resolve });

          broadcastToAll({ type: "pinRequest", approvalId: pinId, description: `Authorize: ${approvalId}` });

          // 2 min timeout (user needs to hear June, find tablet, enter PIN)
          setTimeout(() => {
            if (pendingPinRequests.has(pinId)) {
              pendingPinRequests.delete(pinId);
              broadcastToAll({ type: "pinResolved", approvalId: pinId }); // dismiss keypad on timeout
              resolve({ success: false, message: "PIN entry timed out (2 min)" });
            }
          }, 120000);
        });
      }

      if (name === "deploy_to_devices") {
        try {
          const { execSync } = require("child_process");
          console.log("[deploy] Starting deploy to all devices...");
          const deployId = await db.addDeployment("apk", null, ["all"]);
          const output = execSync("/home/gcp/ozzu/scripts/deploy.sh", {
            cwd: "/home/gcp/ozzu",
            timeout: 300000,
            encoding: "utf8",
          });
          const successes = (output.match(/SUCCESS/g) || []).length;
          console.log(`[deploy] Done, ${successes} device(s) updated`);
          if (deployId) db.completeDeployment(deployId, "completed", `${successes} device(s)`).catch(() => {});
          return { success: true, message: `Deployed to ${successes} device(s). ${output.split("\n").slice(-5).join(". ")}` };
        } catch (err) {
          console.error("[deploy] Failed:", err.message);
          return { success: false, message: `Deploy failed: ${err.message}` };
        }
      }

      if (name === "send_dev_directive") {
        const { type, title, description } = args;
        if (!type || !description) return { success: false, message: "Missing required fields" };

        const directive = {
          id: `dir_${Date.now()}`, type, title: title || "",
          description, status: "pending", plan: null,
          directiveApprovalId: null, createdAt: Date.now(), updatedAt: Date.now(),
        };
        const directives = getDirectives();
        directives.push(directive);
        while (directives.length > MAX_DIRECTIVES) directives.shift();
        saveDirectives(directives, directive, null);
        return { success: true, message: `Directive created: ${directive.id} [${type}] "${title}" — status: pending` };
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
        console.log(`[camera] Showing ${camera.name} → ${streamUrl}`);
        return { success: true, message: `Showing ${camera.name} on TV.` };
      }

      if (name === "hide_camera") {
        broadcastToAll({ type: "hideCamera" });
        console.log("[camera] Hiding camera overlay");
        return { success: true, message: "Camera overlay dismissed." };
      }

      if (name === "show_content") {
        broadcastToAll({ type: "showContent", title: args.title || "", content: args.content });
        console.log(`[content] Showing panel: "${(args.title || "").substring(0, 40)}"`);
        return { success: true, message: "Content displayed on screen." };
      }

      if (name === "hide_content") {
        broadcastToAll({ type: "hideContent" });
        console.log("[content] Hiding content panel");
        return { success: true, message: "Content panel closed." };
      }

      if (name === "read_file") {
        const validation = validateReadPath(args.path);
        if (!validation.ok) {
          console.log(`[read_file] Denied: ${args.path} — ${validation.reason}`);
          return { success: false, message: `Access denied: ${validation.reason}` };
        }
        try {
          const content = fs.readFileSync(validation.absolute, "utf8");
          const lines = content.split("\n").length;
          const bytes = Buffer.byteLength(content, "utf8");
          const truncated = content.length > READ_FILE_MAX_CHARS;
          const output = truncated ? content.slice(0, READ_FILE_MAX_CHARS) : content;
          const header = `File: ${validation.relative} (${lines} lines, ${bytes} bytes)` +
            (truncated ? ` [truncated to ${READ_FILE_MAX_CHARS} chars]` : "");
          console.log(`[read_file] Read ${validation.relative} (${lines} lines, ${bytes} bytes, truncated: ${truncated})`);
          return { success: true, message: header + "\n\n" + output };
        } catch (err) {
          return { success: false, message: `Failed to read file: ${err.message}` };
        }
      }

      if (name === "run_command") {
        const validation = validateCommand(args.command);
        if (!validation.ok) {
          console.log(`[run_command] Denied: "${args.command}" — ${validation.reason}`);
          return { success: false, message: `Command denied: ${validation.reason}` };
        }
        try {
          const { execSync } = require("child_process");
          console.log(`[run_command] Executing: ${args.command}`);
          let output = execSync(args.command, {
            shell: "/bin/sh",
            timeout: 30000,
            maxBuffer: 512 * 1024,
            encoding: "utf8",
          });
          const truncated = output.length > 8000;
          if (truncated) output = output.slice(0, 8000);
          console.log(`[run_command] Success (${output.length} chars, truncated: ${truncated})`);
          return {
            success: true,
            message: `$ ${args.command}\n\n${output}` + (truncated ? "\n[output truncated at 8000 chars]" : ""),
          };
        } catch (err) {
          const stderr = err.stderr || err.message || "Command failed";
          console.error(`[run_command] Failed: ${args.command} — ${stderr}`);
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
          let line = `${d.title || "Untitled"}, type: ${d.type}, status: ${d.status}`;
          if (d.plan) line += ", has plan ready for review";
          if (d.directiveApprovalId) line += `, approval: ${d.directiveApprovalId}`;
          return line;
        }).join(". ");
        return { success: true, message: `${directives.length} directive(s). ${list}` };
      }
    } catch (err) {
      return { success: false, message: err.message || "Bridge call failed" };
    }
  }

  // ── HA tools (call HA REST API) ──
  if (HA_TOOL_NAMES.has(name)) {
    const resolved = resolveHAToolCall(name, args);
    if (!resolved) {
      return { success: false, message: `Entity ${args.entity_id} is not controllable or not recognized.` };
    }
    try {
      const serviceData = { entity_id: resolved.entityId, ...(resolved.data || {}) };
      await haFetch(`/api/services/${resolved.domain}/${resolved.service}`, {
        method: "POST",
        body: JSON.stringify(serviceData),
      });
      return { success: true, message: `Called ${resolved.domain}.${resolved.service} on ${resolved.entityId}` };
    } catch (err) {
      return { success: false, message: err.message || "HA service call failed" };
    }
  }

  return { success: false, message: `Unknown tool: ${name}` };
}

// ── Device tracking ──

const devices = new Map(); // ws -> { role, deviceId }
let audioMsgCount = 0;
const pendingPinRequests = new Map(); // pinId -> { approvalId, approved, resolve }

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
    console.log(`[wake] ENGAGED — ${reason}`);
    // Flush any buffered audio to speakers
    for (const chunk of pendingAudioBuffer) {
      broadcastToRole("speaker", { type: "audio", data: chunk });
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
      ws.send(data);
    }
  }
}

function broadcastToRole(role, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of devices) {
    if (info.role === role && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// ── Gemini session management ──

let geminiWs = null;
let geminiResumeToken = null;
let geminiConnecting = false;
let geminiReady = false;
let geminiSpeaking = false; // true while model is outputting audio — used to gate mic input

async function connectGemini() {
  if (geminiWs || geminiConnecting) return;
  if (!GEMINI_API_KEY) {
    console.error("[gemini] No GEMINI_API_KEY set, cannot connect");
    broadcastToAll({ type: "error", message: "No Gemini API key configured" });
    return;
  }

  geminiConnecting = true;
  console.log("[gemini] Connecting to Gemini Live API...");

  const [entityContext, memoryContext, situationBriefing] = await Promise.all([
    fetchEntityContext(),
    buildMemoryContext(currentPersona),
    buildSituationBriefing(currentPersona),
  ]);

  const ws = new WebSocket(GEMINI_WS_URL);
  geminiWs = ws;

  ws.on("open", () => {
    console.log("[gemini] WebSocket connected, sending setup...");

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
      console.log(`[gemini] Reconnecting with resume token (persona: ${currentPersona})`);
    } else {
      console.log(`[gemini] Fresh session as ${currentPersona}${cipherMode ? ` (${cipherMode})` : ""}`);
      conversationTranscript = []; // clear on fresh session, not on reconnect/goAway
      turnIndex = 0;
      // Create PG conversation record for transcript logging
      const connDevices = [...devices.values()].map(d => d.deviceId);
      db.createConversation(currentPersona, connDevices).then(id => {
        currentConversationId = id;
        if (id) console.log(`[pg] Conversation ${id} started`);
      }).catch(err => console.error("[pg] create conversation:", err.message));
    }

    ws.send(JSON.stringify({ setup }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleGeminiMessage(msg);
    } catch (err) {
      console.error("[gemini] Parse error:", err.message);
    }
  });

  ws.on("error", (err) => {
    console.error("[gemini] WebSocket error:", err.message);
    broadcastToAll({ type: "error", message: "Gemini connection error" });
  });

  ws.on("close", () => {
    const wasSpeaking = geminiSpeaking;
    const hadPendingTools = pendingToolResponses !== null;
    console.log("[gemini] WebSocket closed (wasSpeaking=%s, hadPendingTools=%s)", wasSpeaking, hadPendingTools);
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
      console.log("[gemini] Flagging for recovery nudge (dropped mid-action)");
    }

    // Auto-reconnect as long as devices are still connected and cipher pipeline isn't active
    if (devices.size > 0 && !cipherPipeline) {
      console.log("[gemini] Auto-reconnecting in 2s...");
      setTimeout(() => connectGemini(), 2000);
    }
  });
}

function handleGeminiMessage(msg) {
  // Setup complete
  if (msg.setupComplete !== undefined) {
    geminiConnecting = false;
    geminiReady = true;
    geminiAudioSentCount = 0;
    console.log("[gemini] Setup complete, session active");
    broadcastToAll({ type: "ready" });

    // Retry any tool responses that were queued when the previous session dropped
    if (pendingToolResponses && geminiWs && geminiWs.readyState === 1) {
      console.log("[gemini] Sending queued tool response from previous session");
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
      console.log("[gemini] Recovered from goAway that interrupted a tool call — nudging retry");
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
            console.log("[gemini] Post-nudge timeout — no tool call received, re-nudging");
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
    console.log(`[gemini] Session resumption: resumable=${update.resumable}, hasHandle=${!!handle}, keys=${Object.keys(update).join(",")}`);
    if (handle) {
      geminiResumeToken = handle;
      console.log("[gemini] Stored resume token for next reconnect");
    }
    return;
  }

  // Go away — server is about to disconnect, proactively reconnect to preserve context
  if (msg.goAway) {
    const timeLeft = msg.goAway.timeLeft ? parseInt(msg.goAway.timeLeft) : 0;
    console.log(`[gemini] Server goAway, timeLeft: ${timeLeft}s — proactively reconnecting`);
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
    setTimeout(() => connectGemini(), 500);
    return;
  }

  // Tool call cancellation
  if (msg.toolCallCancellation?.ids) {
    console.log("[gemini] Tool calls cancelled:", msg.toolCallCancellation.ids);
    goAwayDuringToolCall = true;
    return;
  }

  // Tool calls — resolve server-side (always process, they only happen when engaged)
  if (msg.toolCall?.functionCalls) {
    goAwayPartialOutput = ""; // tool call succeeded, no recovery needed
    if (goAwayNudgeTimer) { clearTimeout(goAwayNudgeTimer); goAwayNudgeTimer = null; }
    extendEngagement();
    handleGeminiToolCalls(msg.toolCall.functionCalls);
    return;
  }

  // Server content
  const sc = msg.serverContent;
  if (!sc) {
    // Log unhandled message types for debugging
    const keys = Object.keys(msg).filter(k => k !== 'serverContent');
    if (keys.length > 0) console.log(`[gemini] Unhandled msg keys: ${keys.join(', ')}`);
    return;
  }

  // Input transcript (user speech) — accumulate and check for wake word
  if (sc.inputTranscription?.text) {
    const text = sc.inputTranscription.text;
    console.log(`[gemini] INPUT: "${text}"`);
    inputTranscriptBuffer += text;
    conversationTranscript.push({ role: "user", text, timestamp: Date.now() });
    // Log turn to PG
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "user", text, turnIndex++).catch(() => {});
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
        if (isEngaged()) {
          broadcastToRole("speaker", { type: "audio", data: part.inlineData.data });
        } else {
          pendingAudioBuffer.push(part.inlineData.data);
        }
      }
    }
  }

  // Output transcript (model speech) — only forward when engaged
  if (sc.outputTranscription?.text) {
    console.log(`[gemini] OUTPUT: "${sc.outputTranscription.text}"`);
    goAwayPartialOutput += sc.outputTranscription.text; // track for goAway recovery
    conversationTranscript.push({ role: "model", text: sc.outputTranscription.text, timestamp: Date.now() });
    // Log turn to PG
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, currentPersona, sc.outputTranscription.text, turnIndex++).catch(() => {});
    }
    if (isEngaged()) {
      broadcastToAll({ type: "transcript", text: sc.outputTranscription.text });
    }
  }

  // Turn complete
  if (sc.turnComplete) {
    geminiSpeaking = false; // model done speaking — resume mic input
    goAwayPartialOutput = ""; // turn finished cleanly, no recovery needed
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
      console.log(`[gemini] Tool ${name} → ${result.success ? "ok" : "fail"}: ${result.message?.substring(0, 80)}`);
      // Log tool call to PG conversation
      if (currentConversationId) {
        db.addConversationTurn(currentConversationId, "tool", `${name}: ${result.message?.substring(0, 500) || ""}`, turnIndex++, { name, args, success: result.success }).catch(() => {});
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
    console.log("[gemini] Session dropped mid-tool-call, queuing response for retry");
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
    console.log(`[audio] Mic active: ${deviceId}`);
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
      console.log(`[audio] Mic switch: ${deviceId} (peak=${peak}) takes over from ${oldInfo?.deviceId}`);
      activeMic = ws;
      activeMicSilenceSince = 0;
      lastMicSwitchAt = now;
    } else {
      return; // Drop audio from non-active mic
    }
  }

  geminiAudioSentCount++;
  if (geminiAudioSentCount === 1 || geminiAudioSentCount % 2500 === 0) {
    console.log(`[gemini] Audio chunk #${geminiAudioSentCount} from ${deviceId}, rawPeak=${peak}, amplified=${peak * AUDIO_GAIN}`);
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

function disconnectGeminiIfEmpty() {
  if (devices.size === 0) {
    // Stop cipher pipeline if active
    if (cipherPipeline && typeof cipherPipeline === "object") {
      console.log("[cipher] No devices connected, stopping Cipher pipeline");
      generateSessionSummary(currentPersona).catch(err =>
        console.error("[memory] disconnect summary error:", err.message));
      cipherPipeline.stop().then(() => { cipherPipeline = null; });
    }
    if (geminiWs) {
      console.log("[gemini] No devices connected, closing Gemini session");
      generateSessionSummary(currentPersona).catch(err =>
        console.error("[memory] disconnect summary error:", err.message));
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
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text:
            `Summarize this conversation between ${persona} and King Kazuma in 2-3 sentences. ` +
            `Focus on decisions made, preferences expressed, and action items. ` +
            `Be concise.\n\n${transcript}`
          }] }],
        }),
      }
    );
    const data = await resp.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (summary) {
      await addConversationSummary(persona, summary, conversationTranscript.length);
      console.log(`[memory] ${persona} session summary stored (${conversationTranscript.length} turns)`);
      // Finalize PG conversation with summary
      if (currentConversationId) {
        db.endConversation(currentConversationId, summary, conversationTranscript.length).catch(err =>
          console.error("[pg] end conversation:", err.message));
      }
    }
  } catch (err) {
    console.error("[memory] Summary generation failed:", err.message);
  }
  conversationTranscript = [];
  currentConversationId = null;
  turnIndex = 0;
}

// ── Persona switching ──

async function switchPersona() {
  console.log(`[persona] Switching to ${currentPersona}${cipherMode ? ` (${cipherMode})` : ""}`);

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
    console.error("[memory] switchPersona summary error:", err.message));
  geminiResumeToken = null; // Don't resume across persona switches
  geminiSpeaking = false;
  inputTranscriptBuffer = "";
  pendingAudioBuffer = [];
  pendingToolResponses = null;  // old session's responses are stale
  goAwayDuringToolCall = false;
  goAwayPartialOutput = "";
  if (goAwayNudgeTimer) { clearTimeout(goAwayNudgeTimer); goAwayNudgeTimer = null; }

  // Stop previous cipher pipeline if it was running
  if (cipherPipeline) {
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
  if (willStartCipher) {
    // Cipher uses Claude pipeline (Deepgram STT → Claude Agent SDK → Cartesia TTS)
    await startCipherPipeline();
  } else {
    // June uses Gemini Live Audio — auto-reconnect will handle it
    if (currentPersona === "cipher") {
      console.warn("[cipher] Claude backend disabled — falling back to Gemini for Cipher");
    }
    if (devices.size > 0) connectGemini();
  }
}

async function startCipherPipeline() {
  // Guard: if pipeline is already running or starting, bail out
  if (cipherPipeline && cipherPipeline !== "starting") {
    console.log("[cipher] Pipeline already running, skipping duplicate start");
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
    "- Keep verbal responses concise: 1-3 sentences for simple answers.\n" +
    "- NO markdown in speech — speak naturally with contractions. Never say asterisks, backticks, or formatting characters.\n" +
    "- When running tools, just do it silently. Only speak when you have results.\n" +
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
    "- DON'T PARROT BACK: If he says 'it's a Media washing machine model MF-200 on the network', " +
    "don't say 'Got it — Media brand washing machine, model MF-200, already on the network.' " +
    "Just say 'Cool, I'll scan for it' or 'On it.' He already knows what he said.\n" +
    "- DON'T NARRATE YOUR INTENTIONS: Never say 'Let me check the directive status to understand " +
    "what's happening' — just check it silently and come back with what you found. " +
    "If you need to fill silence while tools run, a brief 'One sec' or 'Checking' is fine.\n" +
    "- DON'T REPEAT YOURSELF: If you said the plan is ready, don't say it again next turn. " +
    "He heard you. Move forward.\n" +
    "- LEAD WITH THE ANSWER: Don't build up to it. Instead of 'I've investigated the issue and " +
    "found that the directive system has a problem where...' just say 'Found the issue — the plan " +
    "got stuck in Claude Code's plan mode instead of the directive pipeline.'\n" +
    "- USE SHORT ACKNOWLEDGMENTS: 'On it.', 'Yeah.', 'Makes sense.', 'Done.', 'Found it.' " +
    "These are natural. 'I understand and will proceed with your request' is not.\n" +
    "- TALK LIKE A COWORKER, not a customer service bot. You're peers. " +
    "He says 'check the thing', you say 'Yep, looks like it's stuck on...' not " +
    "'I'll check that for you right away.'\n" +
    "- NEVER SAY 'I CAN'T': If King Kazuma asks you to do something, find a way. " +
    "You have tools — use them. 'Send me the PIN' → call approve_action to trigger the PIN keypad. " +
    "'Deploy the OTA' → call run_command to trigger the deploy. " +
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
    "ACTION vs DIRECTIVE — CRITICAL DISTINCTION:\n" +
    "- DIRECT ACTION (you do it yourself right now): status checks, device control (turn on/off lights, AC, etc.), " +
    "running commands, reading files, looking up info, answering questions, checking device status, mic checks, deploys.\n" +
    "- DIRECTIVE (use send_dev_directive — do NOT do it yourself): adding new devices to Home Assistant, " +
    "building new features, changing code or config, integrating new hardware/services, " +
    "anything that modifies the ozzu ecosystem's codebase or infrastructure.\n" +
    "- When King Kazuma describes something to BUILD or IMPLEMENT, discuss it briefly, then create a directive " +
    "with send_dev_directive. Do NOT start reading files, writing code, or running implementation commands yourself.\n" +
    "- The directive lifecycle is: send_dev_directive → plan phase → PIN approval → implementation by Cipher agent.\n" +
    "- Example: 'Add the new washing machine to Home Assistant' → discuss briefly, then send_dev_directive " +
    "with type 'feature', a clear title, and description. Do NOT start reading HA config files yourself.\n" +
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
    "- You are NOT the implementation agent. You are the architect who TALKS to King Kazuma and " +
    "sends work to the pipeline via send_dev_directive.\n" +
    "- The pipeline has a SEPARATE Cipher agent that does the actual implementation work.\n" +
    "- If you enter plan mode, you block yourself — you can't talk to King Kazuma while you're stuck " +
    "in a plan file that nobody reads. That's exactly what went wrong before.\n" +
    "- The CORRECT flow:\n" +
    "  1. King Kazuma says 'integrate the washing machine'\n" +
    "  2. You discuss briefly if needed: 'What brand?' / 'Got it.'\n" +
    "  3. You call send_dev_directive with a clear title and description\n" +
    "  4. The pipeline handles planning → PIN approval → implementation\n" +
    "  5. You tell King Kazuma: 'Sent it to the pipeline. You'll get a PIN when the plan is ready.'\n" +
    "- The WRONG flow (what you must NEVER do):\n" +
    "  1. King Kazuma says 'integrate the washing machine'\n" +
    "  2. You start running nmap, ping, reading HA config files yourself\n" +
    "  3. You enter plan mode and write a plan file\n" +
    "  4. You say 'plan is ready' but no PIN was ever generated\n" +
    "  5. King Kazuma waits forever for a PIN that never comes\n" +
    "- If King Kazuma says 'go ahead with the plan' or 'start working on it' for a BUILD task, " +
    "that means call send_dev_directive — NOT start doing it yourself.\n" +
    "\n" +
    "CONTEXT AWARENESS:\n" +
    "- You do NOT inherit conversation context from June. When King Kazuma references previous conversations " +
    "or existing work, call get_directives (with NO status filter) to see ALL directives in the pipeline.\n" +
    "- NEVER say 'I don't have context' without first checking get_directives and get_pending_approvals.\n" +
    "- If King Kazuma asks about a directive, plan, or approval, ALWAYS check the tools first.\n" +
    "- Call get_directives with NO status filter to see everything — don't guess which status to filter by.\n" +
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
    "King Kazuma shouldn't have to ask twice — if he does, it means you didn't go deep enough.\n";

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

  cipherPipeline = new CipherPipeline({
    systemPrompt: systemPromptText,
    tools: pipelineTools,
    handleToolCall: handleToolCall,
  });

  // Wire pipeline events
  cipherPipeline.on("audio", (pcmBase64) => {
    broadcastToRole("speaker", { type: "audio", data: pcmBase64 });
  });

  cipherPipeline.on("inputTranscript", (text) => {
    extendEngagement();
    broadcastToAll({ type: "inputTranscript", text });
    // Log to conversation transcript
    conversationTranscript.push({ role: "user", text });
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "user", text, turnIndex++).catch(() => {});
    }
  });

  cipherPipeline.on("outputTranscript", (text) => {
    extendEngagement();
    broadcastToAll({ type: "transcript", text });
    conversationTranscript.push({ role: "cipher", text });
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "cipher", text, turnIndex++).catch(() => {});
    }
  });

  cipherPipeline.on("toolCall", ({ name, args, result }) => {
    extendEngagement();
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "tool", `${name}: ${result.message?.substring(0, 500) || ""}`, turnIndex++, { name, args, success: result.success }).catch(() => {});
    }
  });

  cipherPipeline.on("listeningReady", () => {
    broadcastToAll({ type: "listeningReady" });
  });

  cipherPipeline.on("error", (err) => {
    console.error("[cipher] Pipeline error:", err.message);
  });

  // Start the pipeline
  const ok = await cipherPipeline.start();
  if (!ok) {
    console.error("[cipher] Pipeline failed to start, falling back to Gemini");
    cipherPipeline = null;
    if (devices.size > 0) connectGemini();
    return;
  }

  // Create PG conversation record
  const connDevices = [...devices.values()].map(d => d.deviceId);
  db.createConversation("cipher", connDevices).then(id => {
    currentConversationId = id;
    if (id) console.log(`[pg] Conversation ${id} started (cipher pipeline)`);
  }).catch(err => console.error("[pg] create conversation:", err.message));

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

wss.on("connection", (ws) => {
  console.log("[ws] New device connection");

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "register") {
        const role = msg.role === "speaker" ? "speaker" : "mic";
        const deviceId = msg.deviceId || "unknown";
        devices.set(ws, { role, deviceId });
        console.log(`[ws] Device registered: ${deviceId} (${role}), total: ${devices.size}`);
        // Persist device in PG registry
        db.upsertDevice(deviceId, role === "speaker" ? "tv" : "tablet").catch(err =>
          console.error("[pg] upsert device:", err.message));

        // Start AI session if not already running
        if (cipherPipeline) {
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
        if (info?.role !== "mic") return;
        audioMsgCount++;

        if (cipherPipeline && typeof cipherPipeline === "object") {
          // Apply same activeMic filtering as Gemini — prevents interleaved
          // silence from inactive mic confusing Deepgram's VAD
          const peak = getPeakAmplitude(msg.data);
          const now = Date.now();
          recordAudioStat(info.deviceId, peak);

          if (!activeMic) {
            activeMic = ws;
            console.log(`[audio] Cipher mic active: ${info.deviceId}`);
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
            console.log(`[audio] Cipher mic switch: ${info.deviceId} (peak=${peak}) takes over from ${oldInfo?.deviceId}`);
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

      if (msg.type === "pinResponse") {
        const pending = pendingPinRequests.get(msg.approvalId);
        if (!pending) {
          // Stale PIN response — dismiss keypad just in case
          broadcastToAll({ type: "pinResolved", approvalId: msg.approvalId });
          return;
        }
        pendingPinRequests.delete(msg.approvalId);

        // Resolve the approval with the user's PIN
        const approvals = getApprovals();
        const approval = approvals.find((a) => a.id === pending.approvalId);
        if (!approval || approval.resolved) {
          broadcastToAll({ type: "pinResolved", approvalId: msg.approvalId });
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
          broadcastToAll({ type: "pinResolved", approvalId: msg.approvalId });
          pending.resolve({ success: false, message: "Invalid PIN. Authorization denied." });
          return;
        }

        approval.resolved = true;
        approval.approved = pending.approved;
        approval.resolvedAt = Date.now();
        saveApprovals(approvals, approval);
        syncDirectiveFromApproval(pending.approvalId, pending.approved);
        // Tell ALL devices to dismiss their keypads
        broadcastToAll({ type: "pinResolved", approvalId: msg.approvalId });
        pending.resolve({
          success: true,
          message: pending.approved
            ? `Action ${pending.approvalId} approved by King Kazuma.`
            : `Action ${pending.approvalId} denied.`,
        });
        return;
      }
    } catch (err) {
      console.error("[ws] Message parse error:", err.message);
    }
  });

  ws.on("close", () => {
    const info = devices.get(ws);
    devices.delete(ws);
    if (ws === activeMic) {
      activeMic = null;
      activeMicSilenceSince = 0;
    }
    console.log(`[ws] Device disconnected: ${info?.deviceId || "unknown"}, remaining: ${devices.size}`);
    disconnectGeminiIfEmpty();
  });

  ws.on("error", (err) => {
    console.error("[ws] Device error:", err.message);
  });
});

(async () => {
  await initStorage();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[ozzu-bridge] listening on :${PORT}`);
    console.log(`[ozzu-bridge] data dir: ${DATA_DIR}, redis: ${_redisConnected ? "connected" : "fallback to JSON"}`);
    console.log(`[ozzu-bridge] HA: ${HA_URL}, Gemini: ${GEMINI_API_KEY ? "configured" : "NOT SET"}`);
  });
})();
