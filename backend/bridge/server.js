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
const { spawnPlanningAgent, spawnImplementationAgent, spawnWorkerWithPrompt, getRunningAgents, killAgent, killAllAgents, startWatchdog, setBroadcast, getConfig, setConfig, mergeWorktreeToMain, cleanupWorktree, smartDeploy } = require("./agent-spawner");
const orchestrator = require("./orchestrator");
const buildVerifier = require("./build-verifier");
const createLogger = require("./logger");
const metrics = require("./metrics-tracker");
const anthropicUsage = require("./anthropic-usage");
const osintEngine = require("./osint-engine");
osintEngine.registerModule(require("./osint-modules/hibp-password"));
osintEngine.registerModule(require("./osint-modules/username-enum"));
osintEngine.registerModule(require("./osint-modules/email-domain"));
osintEngine.registerModule(require("./osint-modules/gravatar-lookup"));
osintEngine.registerModule(require("./osint-modules/hibp-email"));
osintEngine.registerModule(require("./osint-modules/data-broker"));
osintEngine.registerModule(require("./osint-modules/paste-monitor"));
osintEngine.registerModule(require("./osint-modules/phone-lookup"));
osintEngine.registerModule(require("./osint-modules/domain-recon"));
osintEngine.registerModule(require("./osint-modules/social-deep"));
osintEngine.registerModule(require("./osint-modules/image-search"));
osintEngine.registerModule(require("./osint-modules/document-meta"));
osintEngine.registerModule(require("./osint-modules/shodan-lookup"));
osintEngine.registerModule(require("./osint-modules/web-crawler"));
osintEngine.registerModule(require("./osint-modules/secret-scanner"));
osintEngine.registerModule(require("./osint-modules/exif-extract"));
osintEngine.registerModule(require("./osint-modules/reverse-image"));
osintEngine.registerModule(require("./osint-modules/avatar-compare"));
osintEngine.registerModule(require("./osint-modules/face-match"));
// CLI-based modules (Epic 6) — run in osint-tools Docker container
osintEngine.registerModule(require("./osint-modules/sherlock-cli"));
osintEngine.registerModule(require("./osint-modules/maigret-cli"));
osintEngine.registerModule(require("./osint-modules/holehe-cli"));
osintEngine.registerModule(require("./osint-modules/phoneinfoga-cli"));
osintEngine.registerModule(require("./osint-modules/amass-cli"));
osintEngine.registerModule(require("./osint-modules/nuclei-cli"));
osintEngine.registerModule(require("./osint-modules/exiftool-cli"));
osintEngine.registerModule(require("./osint-modules/h8mail-cli"));
osintEngine.registerModule(require("./osint-modules/theharvester-cli"));
// Threat intel feeds (Epic 6)
osintEngine.registerModule(require("./osint-modules/virustotal-lookup"));
osintEngine.registerModule(require("./osint-modules/abuseipdb-lookup"));
osintEngine.registerModule(require("./osint-modules/otx-lookup"));
osintEngine.registerModule(require("./osint-modules/urlhaus-check"));
// Defensive intelligence (Epic 7)
osintEngine.registerModule(require("./osint-modules/ghunt-email"));
osintEngine.registerModule(require("./osint-modules/dnstwist-scan"));
osintEngine.registerModule(require("./osint-modules/crtsh-monitor"));
osintEngine.registerModule(require("./osint-modules/darkweb-search"));
osintEngine.registerModule(require("./osint-modules/leak-search"));
// Colombian OSINT modules (CO Epic)
osintEngine.registerModule(require("./osint-modules/co-secop"));
osintEngine.registerModule(require("./osint-modules/co-adres"));
osintEngine.registerModule(require("./osint-modules/co-simit"));
osintEngine.registerModule(require("./osint-modules/co-rues"));
osintEngine.registerModule(require("./osint-modules/co-sigep"));
osintEngine.registerModule(require("./osint-modules/co-dian"));
osintEngine.registerModule(require("./osint-modules/co-registraduria"));
osintEngine.registerModule(require("./osint-modules/co-redam"));
osintEngine.registerModule(require("./osint-modules/co-procuraduria"));
osintEngine.registerModule(require("./osint-modules/co-contraloria"));
osintEngine.registerModule(require("./osint-modules/co-policia"));
osintEngine.registerModule(require("./osint-modules/co-rama-judicial"));
osintEngine.registerModule(require("./osint-modules/co-fiscalia"));
osintEngine.registerModule(require("./osint-modules/co-libreta-militar"));
osintEngine.registerModule(require("./osint-modules/co-risk-score"));
// Social media intelligence modules (Intelligence Tab Epic)
osintEngine.registerModule(require("./osint-modules/bluesky-intel"));
osintEngine.registerModule(require("./osint-modules/youtube-intel"));
osintEngine.registerModule(require("./osint-modules/reddit-intel"));
osintEngine.registerModule(require("./osint-modules/mastodon-intel"));
osintEngine.registerModule(require("./osint-modules/telegram-intel"));
osintEngine.registerModule(require("./osint-modules/instagram-intel"));
osintEngine.registerModule(require("./osint-modules/tiktok-intel"));
osintEngine.registerModule(require("./osint-modules/facebook-intel"));
osintEngine.registerModule(require("./osint-modules/linkedin-intel"));
osintEngine.registerModule(require("./osint-modules/twitter-intel"));
// Deep intelligence modules (name-based + username)
osintEngine.registerModule(require("./osint-modules/wikipedia-intel"));
osintEngine.registerModule(require("./osint-modules/news-intel"));
osintEngine.registerModule(require("./osint-modules/github-intel"));
// Photo intelligence pipeline modules
osintEngine.registerModule(require("./osint-modules/face-search"));
osintEngine.registerModule(require("./osint-modules/scene-analysis"));
osintEngine.registerModule(require("./osint-modules/identity-resolver"));
osintEngine.registerModule(require("./osint-modules/social-network-mapper"));
osintEngine.registerModule(require("./osint-modules/fullcontact-lookup"));
osintEngine.registerModule(require("./osint-modules/hunter-lookup"));
osintEngine.registerModule(require("./osint-modules/pimeyes-search"));
// GEOINT — runs last to harvest location signals from all other modules
osintEngine.registerModule(require("./osint-modules/photo-forensics"));
osintEngine.registerModule(require("./osint-modules/movement-intel"));
osintEngine.registerModule(require("./osint-modules/satellite-intel"));
osintEngine.registerModule(require("./osint-modules/surveillance-intel"));
osintEngine.registerModule(require("./osint-modules/geoint-collector"));
// OSINT monitoring + CLI runner
const osintMonitor = require("./osint-monitor");
const cliRunner = require("./osint-cli-runner");

// ── Extracted route modules ──
const dashboardRoutes = require("./routes/dashboard");
const directiveRoutes = require("./routes/directives");
const spotifyRoutes = require("./routes/spotify");
const osintRoutes = require("./routes/osint");
const knowledgeGraphRoutes = require("./routes/knowledge-graph");
const pipelineRoutes = require("./routes/pipeline");
const epicRoutes = require("./routes/epics");
const cedulaRoutes = require("./routes/cedula");
const cipherRoutes = require("./routes/cipher");
const businessRoutes = require("./routes/business");
const businessContactRoutes = require("./routes/business-contacts");
const businessShipmentRoutes = require("./routes/business-shipments");
const businessInvoiceRoutes = require("./routes/business-invoices");
const businessInvestmentRoutes = require("./routes/business-investments");
const backupRoutes = require("./routes/backup");
const ozzuSourceRoutes = require("./routes/ozzu-source");
const designerRoutes = require("./routes/designer");
const fileRoutes = require("./routes/files");
const scheduleRoutes = require("./routes/schedules");
const profileRoutes = require("./routes/profile");
const identityRoutes = require("./routes/identity");
const opsRoutes = require("./routes/ops");
const positioningRoutes = require("./routes/positioning");
const mcpRoutes = require("./routes/mcp");
const infraRoutes = require("./routes/infra");
const businessEmailRoutes = require("./routes/business-email");
const agrovisionRoutes = require("./routes/agrovision");
const vaultRoutes = require("./routes/vault");
const financeRoutes = require("./routes/finance");
const whatsappRoutes = require("./routes/whatsapp");
const influenceRoutes = require("./routes/influence");
const fleetRoutes = require("./routes/fleet");
const octoprintRoutes = require("./routes/octoprint");
const devDashboardRoutes = require("./routes/dev-dashboard");
const socRoutes = require("./routes/soc");
const watchdog = require("./watchdog");
const recoveryEngine = require("./recovery-engine");
const cipherDaemon = require("./cipher-agent");
const kairosService = require("./cipher-daemon");
const actionQueue = require("./action-queue");
const proactiveReporter = require("./proactive-reporter");

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
let _buildStatusCache = null;
let _buildStatusCacheTime = 0;
const BUILD_STATUS_CACHE_TTL = 30000; // 30s

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
      client_id: process.env.SPOTIFY_CLIENT_ID || "62ee533a9f2444dfb854cb1293c32cd9",
      client_secret: process.env.SPOTIFY_CLIENT_SECRET || "",
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

// ── Directive status transition logging (Cipher handles work directly) ──
// Workers removed — Cipher (CLI session) picks up directives directly with full context.
// This function is kept as a no-op to avoid breaking call sites during transition.
function routeDirective(directive, type) {
  log.directive.info(`Directive ${directive.id} "${directive.title}" → ${type} — awaiting Cipher (no worker spawn)`);
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

// Cameras live behind go2rtc on dev-01. Dev-01 is reachable on two paths:
//   - 192.168.1.14 (home LAN — direct, no GCP hop, no egress)
//   - 10.9.0.5     (WG VPN  — works from anywhere on the WG mesh, but bytes relay through GCP)
// We expose BOTH to clients; the app races them and uses the first reachable one.
// See backend/docker-compose.yml comment block for the full deployment story.
const WYZE_BRIDGE_HOST = "10.9.0.5";
const WYZE_BRIDGE_LAN_HOST = "192.168.1.14";
const CAMERAS = [
  { id: 'cam_loving', name: 'Loving Cam',         streamName: 'ozzu-cam-loving' },
  { id: 'cam_lroom',  name: 'Living Room Camera', streamName: 'ozzu-lroom-cam-01' },
];

// go2rtc exposes two stream variants per cam:
//   <streamName>       — main/HD (2560x1440 on V4)
//   <streamName>-lo    — sub/SD (~640x360) — for thumbnails / small overlays
function getCameraStreamPath(streamName, quality = "hi") {
  const src = quality === "lo" ? `${streamName}-lo` : streamName;
  return `/api/stream.m3u8?src=${src}`;
}

function getCameraStreamHosts() {
  return [
    `http://${WYZE_BRIDGE_LAN_HOST}:1984`,  // home-LAN-direct (preferred)
    `http://${WYZE_BRIDGE_HOST}:1984`,      // WG fallback (works remote via WG mesh)
  ];
}

// Backward-compat: returns the WG-host URL (the path that always works for on-WG clients).
function getCameraStreamUrl(streamName, quality = "hi") {
  return `http://${WYZE_BRIDGE_HOST}:1984${getCameraStreamPath(streamName, quality)}`;
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
  for (const dir of ["/home/gcp/ozzu/data/uploads", "/home/gcp/ozzu/data/state", "/home/gcp/ozzu/data/business-attachments"]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
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
let _epics = [];
let _redisConnected = false;
const EPICS_FILE = path.join(DATA_DIR, "epics.json");

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

// ── Epics — multi-phase project tracking (integrated into directives) ──
// Legacy: keep getEpics/saveEpics for backward compat with old /epics endpoints
function getEpics() { return _epics; }
function saveEpics(epics) {
  _epics = epics;
  writeJSON(EPICS_FILE, epics);
  if (_redisConnected) redis.set("ozzu:epics", JSON.stringify(epics)).catch(err =>
    log.redis.error("save epics failed:", err.message));
}
// Derive epic status from its child phases (directives with epicId pointing to this epic)
function deriveEpicStatus(epicId) {
  const directives = getDirectives();
  const epic = directives.find(d => d.id === epicId && d.type === "epic");
  if (!epic) return null;
  const phases = directives.filter(d => d.epicId === epicId);
  if (phases.length === 0) return epic.status;
  const allCompleted = phases.every(p => p.status === "completed");
  const anyActive = phases.some(p => ["in_progress", "planning", "planned", "approved"].includes(p.status));
  const anyBlocked = phases.some(p => ["blocked", "deploy_failed", "failed"].includes(p.status));
  const allPending = phases.every(p => p.status === "pending");
  let newStatus;
  if (allCompleted) newStatus = "completed";
  else if (anyBlocked) newStatus = "blocked";
  else if (anyActive) newStatus = "in_progress";
  else if (allPending) newStatus = "pending";
  else newStatus = "in_progress"; // mix of completed + pending
  const prevStatus = epic.status;
  if (newStatus !== prevStatus) {
    epic.status = newStatus;
    epic.updatedAt = Date.now();
    if (!Array.isArray(epic.activity_log)) epic.activity_log = [];
    epic.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "system", message: `Epic status derived: ${prevStatus} → ${newStatus}` });
    if (newStatus === "completed") {
      epic.completedAt = Date.now();
      if (epic.startedAt) epic.duration = epic.completedAt - epic.startedAt;
      epic.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "system", message: "All phases completed — epic auto-completed" });
    }
    saveDirectives(directives, epic, prevStatus, "system");
  }
  return newStatus;
}
// Get epic progress info for the progress endpoint
function getEpicProgress(epicId) {
  const directives = getDirectives();
  const phases = directives.filter(d => d.epicId === epicId).sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0));
  const total = phases.length;
  const completed = phases.filter(p => p.status === "completed").length;
  const inProgressCount = phases.filter(p => ["in_progress", "planning", "planned", "approved"].includes(p.status)).length;
  const currentPhase = phases.find(p => ["in_progress", "planning", "planned", "approved"].includes(p.status)) || null;
  const nextPhase = phases.find(p => p.status === "pending") || null;
  return {
    total, completed, inProgress: inProgressCount,
    currentPhase: currentPhase ? { id: currentPhase.id, title: currentPhase.title, status: currentPhase.status } : null,
    nextPhase: nextPhase ? { id: nextPhase.id, title: nextPhase.title } : null,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
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
    actionQueue.init({ redis, db });

    // Restore active persona from Redis
    const savedPersona = await redis.get("ozzu:activePersona");
    if (savedPersona) {
      const { persona, cipherMode: mode } = JSON.parse(savedPersona);
      currentPersona = persona;
      cipherMode = mode;
      log.bridge.info(`Restored persona: ${persona}${mode ? ` (${mode})` : ""}`);
    }

    // Restore audio preferences from Redis
    const savedAudioPrefs = await redis.get("ozzu:audioPreferences");
    if (savedAudioPrefs) {
      const { preferredInput, preferredOutputs } = JSON.parse(savedAudioPrefs);
      preferredInputDeviceId = preferredInput || null;
      preferredOutputDeviceIds = preferredOutputs || null;
      log.audio.info(`Restored audio preferences: input=${preferredInputDeviceId}, outputs=${JSON.stringify(preferredOutputDeviceIds)}`);
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

    const storedEpics = await redis.get("ozzu:epics");
    if (storedEpics) {
      _epics = JSON.parse(storedEpics);
    } else if (fs.existsSync(EPICS_FILE)) {
      _epics = readJSON(EPICS_FILE, []);
      await redis.set("ozzu:epics", JSON.stringify(_epics));
      log.redis.info("Migrated epics from JSON");
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
    _epics = readJSON(EPICS_FILE, []);
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

  // Backfill all in-memory directives to expanded PG schema
  db.backfillDirectives(_directives).then(({ synced }) => {
    if (synced > 0) log.directive.info(`Backfilled ${synced} directive(s) to postgres`);
  }).catch(err => log.directive.error(`Backfill failed: ${err.message}`));

  // Phase B: Log actionable directives (Cipher handles them directly, no worker respawn)
  const actionable = _directives.filter(d => d.status === "planning" || d.status === "approved");
  if (actionable.length > 0) {
    log.directive.info(`${actionable.length} directive(s) awaiting Cipher: ${actionable.map(d => `${d.id} (${d.status})`).join(", ")}`);
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

  // ── Background build status updater — every 60 seconds ──
  _intervals.push(setInterval(async () => {
    try {
      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFile);
      const directives = getDirectives();
      const TERMINAL_STATUSES = new Set(["completed"]);
      let updated = false;

      for (const directive of directives) {
        if (!Array.isArray(directive.buildRuns) || directive.buildRuns.length === 0) continue;
        for (const run of directive.buildRuns) {
          if (TERMINAL_STATUSES.has(run.status) && run.conclusion) continue;
          try {
            const result = await execFileAsync("gh", ["run", "view", String(run.runId), "--json", "status,conclusion,url", "-R", "ozzuworld/ozzu"], { timeout: 10000 });
            const ghData = JSON.parse(result.stdout);
            const prevStatus = run.status;
            run.status = ghData.status || run.status;
            run.conclusion = ghData.conclusion || null;
            if (ghData.url) run.url = ghData.url;
            run.lastChecked = Date.now();
            updated = true;

            // Log completion to activity_log
            if (prevStatus !== "completed" && run.status === "completed") {
              if (!Array.isArray(directive.activity_log)) directive.activity_log = [];
              directive.activity_log.push({ timestamp: Date.now(), type: "ci_build", actor: "system", message: `CI build completed: ${run.platform} — ${run.conclusion}` });
              // If build failed, mark directive as deploy_failed
              if (run.conclusion === "failure" && ["in_progress", "completed"].includes(directive.status)) {
                directive.status = "deploy_failed";
                directive.failureReason = `CI build failed: ${run.platform} (run #${run.runId})`;
                directive.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "system", message: `Status changed to deploy_failed: CI ${run.platform} build failed` });
              }
            }
          } catch (err) {
            log.directive.warn(`[build-updater] Failed to check run ${run.runId}: ${err.message}`);
          }
        }
      }
      // Auto-discover unregistered iOS/Android builds and attach to recent directives
      try {
        const { execFile: ef2 } = require("child_process");
        const { promisify: p2 } = require("util");
        const ef2Async = p2(ef2);

        // Get recent iOS builds
        for (const workflow of ["build-ios.yml", "build-android.yml"]) {
          const platform = workflow.includes("ios") ? "ios" : "android";
          const result = await ef2Async("gh", ["run", "list", "--workflow=" + workflow, "--limit", "3", "--json", "databaseId,status,conclusion,createdAt,headBranch", "-R", "ozzuworld/ozzu"], { timeout: 15000 });
          const runs = JSON.parse(result.stdout);

          for (const run of runs) {
            if (run.headBranch !== "main") continue;
            const runId = run.databaseId;

            // Check if this run is already registered on any directive
            const alreadyRegistered = directives.some((d) =>
              Array.isArray(d.buildRuns) && d.buildRuns.some((br) => br.runId === runId)
            );
            if (alreadyRegistered) continue;

            // Find the most recent directive that was completed around the time this build triggered
            const buildTime = new Date(run.createdAt).getTime();
            const candidate = directives
              .filter((d) => d.completedAt && Math.abs(d.completedAt - buildTime) < 5 * 60 * 1000) // within 5 min
              .sort((a, b) => Math.abs(a.completedAt - buildTime) - Math.abs(b.completedAt - buildTime))[0];

            if (candidate) {
              if (!Array.isArray(candidate.buildRuns)) candidate.buildRuns = [];
              candidate.buildRuns.push({
                platform,
                runId,
                triggeredAt: buildTime,
                status: run.status || "queued",
                conclusion: run.conclusion || null,
                url: `https://github.com/ozzuworld/ozzu/actions/runs/${runId}`,
                lastChecked: Date.now(),
              });
              updated = true;
              log.directive.info(`Auto-registered ${platform} build #${runId} on ${candidate.id}`);
            }
          }
        }
      } catch { /* auto-discover is best-effort */ }

      // Dedup: remove duplicate buildRuns (same platform+runId) from all directives
      for (const d of directives) {
        if (!Array.isArray(d.buildRuns) || d.buildRuns.length <= 1) continue;
        const seen = new Set();
        const before = d.buildRuns.length;
        d.buildRuns = d.buildRuns.filter((br) => {
          const key = `${br.platform}:${br.runId}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (d.buildRuns.length < before) {
          updated = true;
          log.directive.info(`Deduped ${before - d.buildRuns.length} duplicate build run(s) on ${d.id}`);
        }
      }

      if (updated) saveDirectives(directives);
    } catch (err) { log.directive.error("build status updater:", err.message); }
  }, 60 * 1000));

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

  // ── Device Schedule Executor — every 60 seconds ──
  _intervals.push(setInterval(async () => {
    try {
      const now = new Date();
      const due = await db.query(
        `SELECT * FROM device_schedules WHERE enabled = true AND next_run_at <= $1`, [now]
      );
      for (const sched of due.rows) {
        try {
          await haFetch(`/api/services/${sched.domain}/${sched.service}`, {
            method: "POST",
            body: JSON.stringify({
              ...sched.service_data,
              entity_id: sched.entity_id,
            }),
          });
          const { computeNextRun } = require("./routes/schedules");
          const nextRun = computeNextRun(sched.cron_days, sched.cron_hour, sched.cron_minute, sched.timezone);
          await db.query(
            `UPDATE device_schedules SET last_run_at = NOW(), next_run_at = $1, run_count = run_count + 1 WHERE id = $2`,
            [nextRun, sched.id]
          );
          log.bridge.info(`Schedule executed: ${sched.name} (${sched.domain}.${sched.service} → ${sched.entity_id})`);
        } catch (err) {
          log.bridge.error(`Schedule ${sched.name} failed:`, err.message);
        }
      }
    } catch (err) { log.bridge.error("schedule executor:", err.message); }
  }, 60 * 1000));

  // ── Face Crawler 24/7 Service — start after 1 minute ──
  setTimeout(() => {
    try {
      const faceCrawler = require("./face-crawler");
      faceCrawler.start();
      log.bridge.info("Face crawler 24/7 service auto-started");
    } catch (err) { log.bridge.error("Face crawler auto-start failed:", err.message); }
  }, 60 * 1000);
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

const MAX_BODY_SIZE = 1024 * 1024; // 1MB default
const MAX_IMAGE_BODY_SIZE = 20 * 1024 * 1024; // 20MB for image/file uploads
function parseBody(req, maxSize) {
  const isLargeUpload = req.url && (req.url.includes("/images/upload") || req.url.startsWith("/files"));
  const limit = maxSize || (isLargeUpload ? MAX_IMAGE_BODY_SIZE : MAX_BODY_SIZE);
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        req.destroy();
        reject(new Error("Body too large (max " + Math.round(limit / 1024 / 1024) + "MB)"));
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

const CORS_ALLOWED_ORIGINS = [
  "https://home.ozzu.world",
  "https://ozzu.world",
  "http://localhost:3333",
];

function getCorsHeaders(req) {
  const origin = req?.headers?.origin;
  // React Native doesn't send Origin — allow all non-browser requests
  const allowedOrigin = !origin ? "*" : CORS_ALLOWED_ORIGINS.includes(origin) ? origin : CORS_ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...(origin ? { "Vary": "Origin" } : {}),
  };
}

// Legacy constant for route modules that reference CORS_HEADERS directly
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function sendJSON(res, status, data, req) {
  const headers = req ? getCorsHeaders(req) : CORS_HEADERS;
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  res.end(JSON.stringify(data));
}

// ── Auth gate for public-facing requests (via nginx reverse proxy) ──
// LAN/VPN requests pass through without auth. Public requests (through nginx) need API key.
const TRUSTED_NETS = [
  { prefix: "10.9.0.", label: "WireGuard" },
  { prefix: "172.168.0.", label: "LAN" },
  { prefix: "127.0.0.", label: "localhost" },
  { prefix: "10.128.0.", label: "GCP-internal" },
];

function isPublicRequest(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (!forwarded) return false; // Direct connection — local/VPN
  const clientIp = forwarded.split(",")[0].trim();
  return !TRUSTED_NETS.some(net => clientIp.startsWith(net.prefix));
}

// ── API key auth — only enforced for public requests ──
// LAN/VPN devices work without auth (backward compatible). Public requests need Bearer token.
function requireAuth(req, res) {
  if (!BRIDGE_API_KEY) return true; // no key configured — skip auth
  if (!isPublicRequest(req)) return true; // LAN/VPN — no auth needed
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token !== BRIDGE_API_KEY) {
    sendJSON(res, 401, { error: "Unauthorized — invalid or missing API key" });
    return false;
  }
  return true;
}

const requireAuthIfPublic = requireAuth;

// ── Cosine similarity for face embeddings ──
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Route context (shared deps for extracted route modules) ──
const routeCtx = {
  // Utilities
  sendJSON, parseBody, requireAuth, requireAuthIfPublic, isPublicRequest, escapeHtml, escapeJsString, cosineSimilarity,
  // Database + external modules
  db, redis, log, metrics, osintEngine, osintMonitor, cliRunner, buildVerifier, anthropicUsage,
  // Agent spawner
  getRunningAgents, killAgent, smartDeploy, mergeWorktreeToMain, cleanupWorktree, getConfig, setConfig,
  routeDirective,
  // State accessors
  getDirectives, saveDirectives, findSimilarDirective,
  getApprovals, saveApprovals, expireApprovals,
  getEpics, saveEpics, deriveEpicStatus, getEpicProgress,
  updateEpicProgress: (epicId) => { deriveEpicStatus(epicId); },
  getNextEpicPhase: (epicId) => {
    const epics = getEpics();
    const epic = epics.find(e => e.id === epicId);
    if (!epic || !epic.phaseIds || epic.phaseIds.length === 0) return null;
    const directives = getDirectives();
    for (const pid of epic.phaseIds) {
      const d = directives.find(dd => dd.id === pid);
      if (d && !["completed", "cancelled"].includes(d.status)) return d;
    }
    return null;
  },
  getStatusEntries, saveStatusEntries, getLogRing,
  // Constants
  CORS_HEADERS, DIRECTIVE_TEMPLATES, PORT, DATA_DIR, MAX_DIRECTIVES,
  RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS,
  UPDATES_DIR, GEMINI_MODEL,
  HA_URL: process.env.HA_URL || "http://localhost:8123",
  HA_TOKEN: process.env.HA_TOKEN || "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  // Mutable state (accessed via routeCtx.xxx for mutations to propagate)
  get _serverStartedAt() { return _serverStartedAt; },
  get _restartCount() { return _restartCount; },
  get _latencyStats() { return _latencyStats; },
  get _redisConnected() { return _redisConnected; },
  get _pipelineViolations() { return _pipelineViolations; },
  set _pipelineViolations(v) { _pipelineViolations = v; },
  get _pipelineViolationIdCounter() { return _pipelineViolationIdCounter; },
  set _pipelineViolationIdCounter(v) { _pipelineViolationIdCounter = v; },
  get _buildStatusCache() { return _buildStatusCache; },
  set _buildStatusCache(v) { _buildStatusCache = v; },
  get _buildStatusCacheTime() { return _buildStatusCacheTime; },
  set _buildStatusCacheTime(v) { _buildStatusCacheTime = v; },
  get _directiveCreationTimestamps() { return _directiveCreationTimestamps; },
  get _rateLimitHits() { return _rateLimitHits; },
  set _rateLimitHits(v) { _rateLimitHits = v; },
  get _albumColorCache() { return _albumColorCache; },
  get _spotifyQueueCache() { return _spotifyQueueCache; },
  set _spotifyQueueCache(v) { _spotifyQueueCache = v; },
  get _spotifyPlaylistsCache() { return _spotifyPlaylistsCache; },
  set _spotifyPlaylistsCache(v) { _spotifyPlaylistsCache = v; },
  get _spotifyTracksCache() { return _spotifyTracksCache; },
  get _spotifyNowPlayingCache() { return _spotifyNowPlayingCache; },
  set _spotifyNowPlayingCache(v) { _spotifyNowPlayingCache = v; },
  get _spotifyLikedCache() { return _spotifyLikedCache; },
  set _spotifyLikedCache(v) { _spotifyLikedCache = v; },
  get _cachedSpotifyToken() { return _cachedSpotifyToken; },
  spotifyFetch, getSpotifyToken,
  BUILD_STATUS_CACHE_TTL: 120000,
  get _lastRestartReason() { return _lastRestartReason; },
  get _previousStartedAt() { return _previousStartedAt; },
  get cipherMode() { return typeof cipherMode !== "undefined" ? cipherMode : null; },
  get devices() { return typeof devices !== "undefined" ? devices : new Map(); },
  // Voice/WS functions (populated after they're defined)
  get engage() { return typeof engage === "function" ? engage : () => {}; },
  get sendNotification() { return typeof sendNotification === "function" ? sendNotification : () => {}; },
  get broadcastToAll() { return typeof broadcastToAll === "function" ? broadcastToAll : () => {}; },
  get geminiReady() { return typeof geminiReady !== "undefined" ? geminiReady : false; },
  get currentPersona() { return typeof currentPersona !== "undefined" ? currentPersona : "june"; },
  get conversationTranscript() { return typeof conversationTranscript !== "undefined" ? conversationTranscript : []; },
  get cipherPipeline() { return typeof cipherPipeline !== "undefined" ? cipherPipeline : null; },
  get setLastRestartReason() { return typeof setLastRestartReason === "function" ? setLastRestartReason : () => {}; },
  get buildSituationBriefing() { return typeof buildSituationBriefing === "function" ? buildSituationBriefing : async () => ""; },
  // Daemon + Action Queue + Reporter
  cipherDaemon, actionQueue, proactiveReporter,
  // Node built-ins
  fs, path, crypto,
};

// Route handlers initialized lazily on first request
let _routeHandlers = null;
function getRouteHandlers() {
  if (!_routeHandlers) {
    _routeHandlers = {
      dashboard: dashboardRoutes(routeCtx),
      directives: directiveRoutes(routeCtx),
      spotify: spotifyRoutes(routeCtx),
      osint: osintRoutes(routeCtx),
      pipeline: pipelineRoutes(routeCtx),
      epics: epicRoutes(routeCtx),
      cedula: cedulaRoutes(routeCtx),
      cipher: cipherRoutes(routeCtx),
      business: businessRoutes(routeCtx),
      businessContacts: businessContactRoutes(routeCtx),
      businessShipments: businessShipmentRoutes(routeCtx),
      businessInvoices: businessInvoiceRoutes(routeCtx),
      businessInvestments: businessInvestmentRoutes(routeCtx),
      backup: backupRoutes(routeCtx),
      files: fileRoutes(routeCtx),
      schedules: scheduleRoutes(routeCtx),
      profile: profileRoutes(routeCtx),
      identity: identityRoutes(routeCtx),
      ops: opsRoutes(routeCtx),
      positioning: positioningRoutes(routeCtx),
      mcp: mcpRoutes(routeCtx),
      infra: infraRoutes(routeCtx),
      businessEmail: businessEmailRoutes(routeCtx),
      agrovision: agrovisionRoutes(routeCtx),
      vault: vaultRoutes(routeCtx),
      finance: financeRoutes(routeCtx),
      whatsapp: whatsappRoutes(routeCtx),
      influence: influenceRoutes(routeCtx),
      fleet: fleetRoutes(routeCtx),
      octoprint: octoprintRoutes(routeCtx),
      devDashboard: devDashboardRoutes(routeCtx),
      knowledgeGraph: knowledgeGraphRoutes(routeCtx),
      soc: socRoutes(routeCtx),
      ozzuSource: ozzuSourceRoutes(routeCtx),
      designer: designerRoutes(routeCtx),
    };
  }
  return _routeHandlers;
}

// ── Route handlers ──

// ── MCP Proxy — approval-gated upstream forwarding ──
const { GATED_TOOLS, createApprovalGate } = require("./approval-gate");
const { getUpstream } = require("./mcp-proxy");
const _mcpProxyGate = createApprovalGate({ db, sendPush: require("./push-notifications").sendPush });

async function handleMcpProxy(req, res, pathname) {
  const serverName = pathname.replace("/mcp-proxy/", "").split("/")[0];
  const upstream = getUpstream(serverName);
  if (!upstream) {
    sendJSON(res, 404, { error: `Unknown MCP server: ${serverName}` }, req);
    return true;
  }

  if (req.method !== "POST") {
    sendJSON(res, 405, { error: "Method not allowed" }, req);
    return true;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    sendJSON(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }, req);
    return true;
  }

  // Gate tools/call for gated tools
  if (body.method === "tools/call") {
    const toolName = body.params?.name;
    const serverGates = GATED_TOOLS[serverName];
    const gate = serverGates?.[toolName];

    if (gate) {
      const args = body.params?.arguments || {};
      const extracted = gate.extract(args);
      const summary = `${gate.label} → ${extracted.recipient || "unknown"}: ${extracted.message || ""}`;

      log.bridge?.info?.(`[mcp-proxy] Gating ${serverName}/${toolName}: ${summary}`);

      const approval = await _mcpProxyGate(gate.label, summary, extracted);
      if (approval.error) {
        const jsonRpcError = {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: approval.error },
        };
        sendJSON(res, 200, jsonRpcError, req);
        return true;
      }
    }
  }

  // Forward to upstream
  try {
    const result = await upstream.forward(body);
    sendJSON(res, 200, result, req);
  } catch (e) {
    log.bridge?.error?.(`[mcp-proxy] ${serverName} error: ${e.message}`);
    const jsonRpcError = {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32603, message: `Upstream error: ${e.message}` },
    };
    sendJSON(res, 200, jsonRpcError, req);
  }
  return true;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  metrics.trackHttpRequest();

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, getCorsHeaders(req));
    res.end();
    return;
  }

  // ── MCP Proxy (approval-gated upstream forwarding) ──
  if (pathname.startsWith("/mcp-proxy/")) {
    if (await handleMcpProxy(req, res, pathname)) return;
  }

  // ── Extracted route dispatch ──
  const r = getRouteHandlers();
  if (await r.directives(req, res, pathname, url)) return;
  if (await r.dashboard(req, res, pathname, url)) return;
  if (await r.cipher(req, res, pathname, url)) return;
  if (await r.spotify(req, res, pathname, url)) return;
  if (await r.pipeline(req, res, pathname, url)) return;
  if (await r.epics(req, res, pathname, url)) return;
  if (await r.osint(req, res, pathname, url)) return;
  if (await r.cedula(req, res, pathname, url)) return;
  if (await r.businessContacts(req, res, pathname, url)) return;
  if (await r.businessShipments(req, res, pathname, url)) return;
  if (await r.businessInvoices(req, res, pathname, url)) return;
  if (await r.businessInvestments(req, res, pathname, url)) return;
  if (await r.business(req, res, pathname, url)) return;
  if (await r.files(req, res, pathname, url)) return;
  if (await r.schedules(req, res, pathname, url)) return;
  if (await r.profile(req, res, pathname, url)) return;
  if (await r.identity(req, res, pathname, url)) return;
  if (await r.backup(req, res, pathname, url)) return;
  if (await r.ops(req, res, pathname, url)) return;
  if (await r.positioning(req, res, pathname, url)) return;
  if (await r.mcp(req, res, pathname, url)) return;
  if (await r.infra(req, res, pathname, url)) return;
  if (await r.businessEmail(req, res, pathname, url)) return;
  if (await r.agrovision(req, res, pathname, url)) return;
  if (await r.vault(req, res, pathname, url)) return;
  if (await r.finance(req, res, pathname, url)) return;
  if (await r.whatsapp(req, res, pathname, url)) return;
  if (await r.influence(req, res, pathname, url)) return;
  if (await r.fleet(req, res, pathname, url)) return;
  if (await r.octoprint(req, res, pathname, url)) return;
  if (await r.devDashboard(req, res, pathname, url)) return;
  if (await r.knowledgeGraph(req, res, pathname, url)) return;
  if (await r.soc(req, res, pathname, url)) return;
  if (await r.ozzuSource(req, res, pathname, url)) return;
  if (await r.designer(req, res, pathname, url)) return;

  // ── AgroVisión training state poller (SSH to GPU, parse training log) ──
  async function refreshAgrovisionState(vastInstance) {
    if (!vastInstance || vastInstance.actual_status !== "running") return;
    const { execSync } = require("child_process");
    const fs = require("fs");
    // Get direct SSH port from instance
    const ports = vastInstance.ports || {};
    const sshMapping = ports["22/tcp"];
    let sshHost, sshPort;
    if (vastInstance.public_ipaddr && sshMapping && sshMapping[0]) {
      sshHost = vastInstance.public_ipaddr;
      sshPort = sshMapping[0].HostPort;
    } else {
      sshHost = vastInstance.ssh_host;
      sshPort = vastInstance.ssh_port;
    }
    try {
      const sshCmd = `tail -50 /root/training.log 2>/dev/null; echo ___NVIDIA___; nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader 2>/dev/null; echo ___FILES___; ls /root/models/*.onnx /root/models/class_map.json 2>/dev/null; true`;
      const raw = execSync(
        `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -p ${sshPort} root@${sshHost} ${JSON.stringify(sshCmd)} 2>/dev/null`,
        { timeout: 10000, maxBuffer: 1024 * 1024 }
      ).toString();
      const [logPart, nvPart, filesPart] = raw.split(/___NVIDIA___|___FILES___/);
      // Parse training log for epoch/batch progress
      const lines = (logPart || "").trim().split("\n").filter(l => l.trim());
      let epoch = null, totalEpochs = null, batch = null, totalBatches = null;
      let loss = null, acc = null, rate = null;
      let valLoss = null, valAcc = null, bestAcc = null;
      let phase = "unknown"; // downloading, training, exporting, complete
      for (const line of lines) {
        // Epoch summary: [Epoch 2/30] train_loss: 0.6388 train_acc: 93.4% | val_loss: 0.5880 val_acc: 94.4% | 153s
        const epochMatch = line.match(/\[Epoch (\d+)\/(\d+)\] train_loss: ([\d.]+) train_acc: ([\d.]+)%.*val_loss: ([\d.]+) val_acc: ([\d.]+)%/);
        if (epochMatch) {
          epoch = parseInt(epochMatch[1]);
          totalEpochs = parseInt(epochMatch[2]);
          loss = parseFloat(epochMatch[3]);
          acc = parseFloat(epochMatch[4]);
          valLoss = parseFloat(epochMatch[5]);
          valAcc = parseFloat(epochMatch[6]);
          phase = "training";
        }
        // Batch progress: [1/30] batch 350/819 | loss: 0.7910 | acc: 66.6% | 360 img/s
        const batchMatch = line.match(/\[(\d+)\/(\d+)\] batch (\d+)\/(\d+) \| loss: ([\d.]+) \| acc: ([\d.]+)% \| (\d+) img\/s/);
        if (batchMatch) {
          epoch = parseInt(batchMatch[1]);
          totalEpochs = parseInt(batchMatch[2]);
          batch = parseInt(batchMatch[3]);
          totalBatches = parseInt(batchMatch[4]);
          loss = parseFloat(batchMatch[5]);
          acc = parseFloat(batchMatch[6]);
          rate = parseInt(batchMatch[7]);
          phase = "training";
        }
        // Best model: ★ New best! val_acc=94.4%
        const bestMatch = line.match(/New best!.*val_acc=([\d.]+)%/);
        if (bestMatch) bestAcc = parseFloat(bestMatch[1]);
        // Export phase
        if (line.includes("Exporting ONNX") || line.includes("export")) phase = "exporting";
        if (line.includes("Training complete") || line.includes("ONNX saved")) phase = "complete";
        // Download phase
        if (line.includes("Downloading") && !line.includes("dinov2")) phase = "downloading";
        // Class count
      }
      // Parse nvidia-smi
      let gpuUtil = null, gpuMemUsed = null, gpuMemTotal = null, gpuTemp = null;
      if (nvPart && nvPart.trim()) {
        const nvParts = nvPart.trim().split(",").map(s => s.trim());
        if (nvParts.length >= 4) {
          gpuUtil = parseInt(nvParts[0]);
          gpuMemUsed = parseInt(nvParts[1]);
          gpuMemTotal = parseInt(nvParts[2]);
          gpuTemp = parseInt(nvParts[3]);
        }
      }
      // Check if model files exist
      const modelReady = (filesPart || "").includes(".onnx");
      const state = {
        phase, epoch, totalEpochs, batch, totalBatches,
        loss, acc, valLoss, valAcc, bestAcc, rate,
        gpuUtil, gpuMemUsed, gpuMemTotal, gpuTemp,
        modelReady, timestamp: Date.now(),
      };
      fs.writeFileSync("/home/gcp/ozzu/data/state/agrovision-training-state.json", JSON.stringify(state));
    } catch (e) {
      // SSH failed — write error state
      try {
        fs.writeFileSync("/home/gcp/ozzu/data/state/agrovision-training-state.json", JSON.stringify({
          phase: "unreachable", error: e.message, timestamp: Date.now(),
        }));
      } catch {}
    }
  }

  // GET /api/training-stats — Face DB training pipeline stats
  if (req.method === "GET" && pathname === "/api/training-stats") {
    try {
      const http = require("http");
      const fetchJSON = (url, opts = {}) => new Promise((resolve) => {
        const mod = url.startsWith("https") ? require("https") : http;
        const req = mod.get(url, { timeout: 5000, ...opts }, (res) => {
          let data = "";
          res.on("data", (c) => data += c);
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
      });

      // Vast.ai API key — from env or file
      let vastKey = process.env.VAST_API_KEY || "";
      if (!vastKey) {
        try { vastKey = require("fs").readFileSync("/root/.config/vastai/vast_api_key", "utf8").trim(); } catch {}
      }

      // Parallel fetches: collection info + vast.ai (skip per-source counts — too slow under load)
      const [qdrant] = await Promise.all([
        fetchJSON("http://localhost:6333/collections/faces"),
      ]);

      let vastData = null;
      if (vastKey) {
        try {
          vastData = await fetchJSON("https://console.vast.ai/api/v0/instances/?owner=me", {
            headers: { "Authorization": `Bearer ${vastKey}` },
          });
        } catch {}
      }

      const qdrantResult = qdrant?.result || {};
      const vastInstance = vastData?.instances?.[0] || null;

      const totalPoints = qdrantResult.points_count || 0;

      // Read pipeline state file if it exists (written by embed script heartbeat)
      let pipelineState = null;
      try {
        const fs = require("fs");
        const stateFile = "/home/gcp/ozzu/data/state/pipeline-state.json";
        if (fs.existsSync(stateFile)) {
          pipelineState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        }
      } catch {}

      // Read per-dataset progress (written by multi-dataset pipeline)
      let datasetProgress = {};
      try {
        const fs = require("fs");
        const progressFile = "/home/gcp/ozzu/data/state/pipeline-progress.json";
        if (fs.existsSync(progressFile)) {
          const prog = JSON.parse(fs.readFileSync(progressFile, "utf8"));
          datasetProgress = prog.datasets || {};
        }
      } catch {}

      // Source breakdown: use real per-dataset progress data
      const sourceBreakdown = {};
      let knownCount = 0;
      for (const [name, info] of Object.entries(datasetProgress)) {
        const count = info.indexed || 0;
        if (count > 0) {
          sourceBreakdown[name] = count;
          knownCount += count;
        }
      }
      // If active pipeline is running and not yet in progress file, add from heartbeat
      if (pipelineState?.dataset && pipelineState?.indexed > 0) {
        const ds = pipelineState.dataset;
        const existing = sourceBreakdown[ds] || 0;
        // Only use heartbeat count if it's higher (more current) than progress file
        if (pipelineState.indexed > existing && pipelineState.phase !== "complete") {
          knownCount += (pipelineState.indexed - existing);
          sourceBreakdown[ds] = pipelineState.indexed;
        }
      }
      // Remainder = untracked faces (satellite crawlers, old datasets, etc)
      if (totalPoints > knownCount) {
        sourceBreakdown["satellite"] = totalPoints - knownCount;
      }

      let activeDataset = null;
      if (pipelineState?.dataset && pipelineState?.phase !== "complete") {
        activeDataset = pipelineState.dataset;
      }
      // Check if any dataset is "running" in progress
      if (!activeDataset) {
        for (const [name, info] of Object.entries(datasetProgress)) {
          if (info.status === "running") { activeDataset = name; break; }
        }
      }

      // Calculate instance uptime from start_date (epoch seconds)
      let instanceUptimeHrs = null;
      let estCost = null;
      if (vastInstance?.start_date) {
        const uptimeSec = (Date.now() / 1000) - vastInstance.start_date;
        instanceUptimeHrs = (uptimeSec / 3600).toFixed(1);
        estCost = (uptimeSec / 3600) * (vastInstance.dph_total || 0);
      }

      // Heartbeat staleness: if last heartbeat > 30s ago, pipeline may be dead
      const heartbeatAge = pipelineState?.timestamp
        ? Math.round((Date.now() / 1000) - pipelineState.timestamp)
        : null;
      const heartbeatAlive = heartbeatAge !== null && heartbeatAge < 30;

      // AgroVisión training state — read cached state file (updated by SSH poll)
      let agrovision = null;
      try {
        const fs = require("fs");
        const avFile = "/home/gcp/ozzu/data/state/agrovision-training-state.json";
        if (fs.existsSync(avFile)) {
          const av = JSON.parse(fs.readFileSync(avFile, "utf8"));
          const age = (Date.now() - (av.timestamp || 0)) / 1000;
          agrovision = { ...av, stale: age > 30 };
          // Trigger async refresh if stale (>15s)
          if (age > 15) {
            refreshAgrovisionState(vastInstance).catch(() => {});
          }
        } else if (vastInstance?.actual_status === "running") {
          // First load — trigger async refresh
          refreshAgrovisionState(vastInstance).catch(() => {});
        }
      } catch {}

      sendJSON(res, 200, {
        qdrant: {
          status: qdrantResult.status || "unknown",
          points_count: qdrantResult.points_count || 0,
          indexed_vectors_count: qdrantResult.indexed_vectors_count || 0,
          segments_count: qdrantResult.segments_count || 0,
        },
        sources: sourceBreakdown,
        datasetProgress,
        pipeline: {
          activeDataset,
          model: "ArcFace w600k_r50",
          dimensions: 512,
          gpuBatch: pipelineState?.gpuBatch || 256,
          workers: pipelineState?.workers || 8,
          qdrantBatch: pipelineState?.qdrantBatch || 2000,
          qdrantWorkers: pipelineState?.qdrantWorkers || 4,
          shardProgress: pipelineState?.shardProgress || null,
          shardsCompleted: pipelineState?.shardsCompleted || null,
          totalShards: pipelineState?.totalShards || null,
          startShard: pipelineState?.startShard || null,
          endShard: pipelineState?.endShard || null,
          rate: pipelineState?.rate || null,
          indexed: pipelineState?.indexed || null,
          processed: pipelineState?.processed || null,
          failed: pipelineState?.failed || null,
          skipped: pipelineState?.skipped || null,
          elapsedSec: pipelineState?.elapsedSec || null,
          tensorQueueSize: pipelineState?.tensorQueueSize || null,
          embedQueueSize: pipelineState?.embedQueueSize || null,
          errors: pipelineState?.errors || [],
          heartbeatAge,
          heartbeatAlive,
        },
        gpu: pipelineState?.gpu || null,
        vast: vastInstance ? {
          id: vastInstance.id,
          status: vastInstance.actual_status,
          gpu: vastInstance.gpu_name,
          gpu_util: vastInstance.gpu_util,
          gpu_temp: vastInstance.gpu_temp,
          cost_per_hr: vastInstance.dph_total,
          uptime_hrs: instanceUptimeHrs,
          est_cost: estCost,
          ssh: `ssh -p ${vastInstance.ssh_port} root@${vastInstance.ssh_host}`,
          mem_usage_gb: vastInstance.mem_usage ? (vastInstance.mem_usage / 1073741824).toFixed(1) : null,
          disk_usage_gb: vastInstance.disk_usage || null,
          disk_space_gb: vastInstance.disk_space || null,
          geolocation: vastInstance.geolocation || null,
        } : null,
        agrovision,
        timestamp: Date.now(),
      });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/pipeline-state — receive pipeline state from GPU embed scripts
  if (req.method === "POST" && pathname === "/api/pipeline-state") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const state = JSON.parse(body);
      const fs = require("fs");
      fs.writeFileSync("/home/gcp/ozzu/data/state/pipeline-state.json", JSON.stringify(state));
      // Record heartbeat for training recovery watchdog
      try { const wd = require("./watchdog"); wd.recordHeartbeat(); } catch {}
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  // POST /api/pipeline-progress — persistent per-dataset progress from multi-dataset pipeline
  if (req.method === "POST" && pathname === "/api/pipeline-progress") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const progress = JSON.parse(body);
      const fs = require("fs");
      fs.writeFileSync("/home/gcp/ozzu/data/state/pipeline-progress.json", JSON.stringify(progress));
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/pipeline-progress — read per-dataset progress
  if (req.method === "GET" && pathname === "/api/pipeline-progress") {
    try {
      const fs = require("fs");
      const file = "/home/gcp/ozzu/data/state/pipeline-progress.json";
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        sendJSON(res, 200, data);
      } else {
        sendJSON(res, 200, { datasets: {} });
      }
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // GET /tmp-file/:filename — serve temp files (for iOS pairing etc)
  if (req.method === "GET" && pathname.startsWith("/tmp-file/")) {
    const fs = require("fs");
    const fname = pathname.replace("/tmp-file/", "");
    const fpath = `/tmp/${fname}`;
    if (!fs.existsSync(fpath)) { sendJSON(res, 404, { error: "not found" }); return; }
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${fname}"` });
    fs.createReadStream(fpath).pipe(res);
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

  // GET /audio-preferences — Audio routing preferences + live device state
  if (req.method === "GET" && pathname === "/audio-preferences") {
    const deviceList = [...devices.entries()].map(([ws, info]) => ({
      deviceId: info.deviceId, role: info.role, deviceType: info.deviceType,
      zone: info.zone, capabilities: info.capabilities,
      speakerPriority: info.speakerPriority, online: ws.readyState === WebSocket.OPEN,
      isActiveMic: ws === activeMic || (ws === cipherPhoneWs && cipherPipeline && cipherPipeline.textOnly),
      isSelectedSpeaker: false,
    }));
    const target = selectSpeaker();
    if (target) {
      const entry = deviceList.find(d => d.deviceId === target.info.deviceId);
      if (entry) entry.isSelectedSpeaker = true;
    }
    sendJSON(res, 200, {
      preferredInput: preferredInputDeviceId,
      preferredOutputs: preferredOutputDeviceIds,
      devices: deviceList,
      activeMic: (cipherPhoneWs && cipherPipeline && cipherPipeline.textOnly)
        ? devices.get(cipherPhoneWs)?.deviceId
        : (activeMic ? devices.get(activeMic)?.deviceId : null),
      autoSelectedSpeaker: target ? target.info.deviceId : null,
      mode: cipherPipeline ? "cipher" : (geminiWs ? "june" : "idle"),
    });
    return;
  }

  // POST /audio-preferences — Set audio routing preferences
  if (req.method === "POST" && pathname === "/audio-preferences") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const { preferredInput, preferredOutputs } = JSON.parse(body);
        preferredInputDeviceId = preferredInput === undefined ? preferredInputDeviceId : (preferredInput || null);
        preferredOutputDeviceIds = preferredOutputs === undefined ? preferredOutputDeviceIds : (preferredOutputs || null);
        saveAudioPreferences();
        log.audio.info(`Audio preferences updated: input=${preferredInputDeviceId}, outputs=${JSON.stringify(preferredOutputDeviceIds)}`);
        broadcastAudioRoutingState();
        sendJSON(res, 200, {
          ok: true,
          preferences: { preferredInput: preferredInputDeviceId, preferredOutputs: preferredOutputDeviceIds },
        });
      } catch (err) {
        sendJSON(res, 400, { error: "Invalid JSON" });
      }
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

  // POST /api/devices/register — Register a device push token
  if (req.method === "POST" && pathname === "/api/devices/register") {
    try {
      const body = await parseBody(req);
      const { token, deviceId, platform, deviceName } = body;
      if (!token || !token.startsWith("ExponentPushToken[")) {
        return sendJSON(res, 400, { error: "Invalid Expo push token" });
      }
      // Upsert into legacy device_push_tokens (backwards compat)
      await db.query(
        `INSERT INTO device_push_tokens (token, device_id, platform, device_name, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (token) DO UPDATE SET device_id=$2, platform=$3, device_name=$4, updated_at=NOW()`,
        [token, deviceId || null, platform || "ios", deviceName || null]
      );
      // Also link to owner Person — so KAIROS can use Person.owner().notify()
      try {
        const { Person } = require("./person");
        const owner = await Person.owner(db);
        if (owner) {
          await db.query(
            `INSERT INTO person_devices (person_id, platform, push_token, device_name, device_type, last_seen)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (push_token) DO UPDATE SET last_seen=NOW()`,
            [owner.id, platform || "ios", token, deviceName || "iPhone", "iphone"]
          );
        }
      } catch (e) { log.bridge.warn(`person_devices link failed: ${e.message}`); }
      log.bridge.info(`Push token registered: ${deviceId || "unknown"} (${platform})`);
      return sendJSON(res, 200, { ok: true });
    } catch (err) {
      // Table might not exist yet — return ok anyway so app doesn't crash
      log.bridge.warn(`Push token registration failed: ${err.message}`);
      return sendJSON(res, 200, { ok: true, warning: "token storage unavailable" });
    }
  }

  // POST /api/push/send — Send a push notification (internal use)
  if (req.method === "POST" && pathname === "/api/push/send") {
    try {
      const body = await parseBody(req);
      const { token, tokens, title, body: msgBody, data } = body;
      const { sendPush } = require("./push-notifications");
      const allTokens = tokens || (token ? [token] : []);
      if (allTokens.length === 0) {
        return sendJSON(res, 400, { error: "No tokens provided" });
      }
      const result = await sendPush(allTokens, { title, body: msgBody, data });
      return sendJSON(res, 200, result);
    } catch (err) {
      return sendJSON(res, 500, { error: err.message });
    }
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
      type: data.type || "",
      payload: data.payload || null,
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

  // ── Crash reports from app ErrorBoundary / global handler ──
  if (pathname === "/api/crash-reports" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const r = JSON.parse(body);
        const msg = `[CRASH][${r.platform||"?"}][${r.context||"?"}] ${r.error || "unknown error"}`;
        console.error("[crash-report]", msg);
        if (r.stack) console.error("[crash-report] STACK:", r.stack.slice(0, 500));
        if (!global._deviceLogs) global._deviceLogs = [];
        global._deviceLogs.push({ ts: Date.now(), level: "crash", msg, stack: r.stack });
        if (global._deviceLogs.length > 500) global._deviceLogs.shift();
      } catch {}
      sendJSON(res, 200, { ok: true });
    });
    return;
  }

  // ── Device logs (remote console from app) ──
  if (pathname === "/api/device-logs") {
    if (req.method === "POST") {
      let body = "";
      req.on("data", d => body += d);
      req.on("end", () => {
        try {
          const entry = JSON.parse(body);
          const line = `[${entry.device || "?"}][${entry.level || "log"}] ${entry.msg || ""}`;
          console.log("[device-log]", line);
          if (entry.stack) console.log("[device-log] STACK:", entry.stack);
          if (!global._deviceLogs) global._deviceLogs = [];
          global._deviceLogs.push({ ts: Date.now(), ...entry });
          if (global._deviceLogs.length > 500) global._deviceLogs.shift();
        } catch {}
        sendJSON(res, 200, { ok: true });
      });
      return;
    }
    if (req.method === "GET") {
      sendJSON(res, 200, { logs: global._deviceLogs || [] });
      return;
    }
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
  "- bridge: this server, port 3333, Node.js, manages Gemini sessions + device relay\n" +
  "- nginx: reverse proxy, ports 80/443, SSL via Let's Encrypt + Cloudflare DNS, serves home.ozzu.world\n" +
  "- WireGuard: VPN server, UDP 51820 (replaced OpenVPN as of 2026-05-02)\n" +
  "- ozzu-postgres: PostgreSQL 16, port 5432, structured data (memories, conversations, directives, entity snapshots)\n" +
  "- ozzu-redis: Redis 7, port 6379, ephemeral state (session cache, audio stats)\n" +
  "- certbot: SSL cert renewal (runs on-demand, not always up)\n\n" +
  "Network topology: see /home/gcp/ozzu/infra/devices.json (machine-readable) " +
  "and ~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md (prose context).\n\n" +
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
        camera_id: { type: "STRING", description: "Camera ID, e.g. cam_loving or cam_lroom" },
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
    name: "vacuum_history",
    description: "Report Dusk Vader's recent cleaning runs (audit log). Returns when the vacuum cleaned, for how long, how much area, and whether it completed cleanly. Use when King Kazuma asks 'when did the vacuum last run', 'is the vacuum cleaning', 'how often does it clean', or 'show vacuum history'. Ozzu polls the Dreame cloud every 10 min for the audit log.",
    parameters: {
      type: "OBJECT",
      properties: {
        days: { type: "NUMBER", description: "How many days back to look (default 7, max 30)" },
        limit: { type: "NUMBER", description: "Max rows to return (default 10, max 50)" },
      },
      required: [],
    },
  },
  {
    name: "vacuum_start",
    description: "Start a cleaning task on Dusk Vader right now. Use when King Kazuma says 'vacuum', 'start the vacuum', 'clean the floor', etc. Ozzu owns the nightly 3 AM schedule via cron; this tool is for ad-hoc triggers outside the schedule.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "vacuum_pause",
    description: "Pause Dusk Vader if it's currently cleaning. Use when King Kazuma says 'stop the vacuum', 'pause cleaning', 'quiet down', etc. No-op if vacuum is already idle.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "vacuum_dock",
    description: "Send Dusk Vader back to its charging dock. Use when King Kazuma says 'send the vacuum home', 'go to dock', 'return to base'. No-op if already docked.",
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
  {
    name: "enable_glasses_immersive",
    description:
      "Enable immersive mode on King Kazuma's glasses. " +
      "The iPhone will auto-navigate to the glasses screen, connect, and start the camera + AR/gesture pipeline. " +
      "Use when King Kazuma says 'immersive mode', 'enable glasses', 'start glasses', or similar.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "disable_glasses_immersive",
    description:
      "Disable immersive mode on King Kazuma's glasses. " +
      "Tears down the camera stream, gesture pipeline, and returns the iPhone to its previous screen. " +
      "Use when King Kazuma says 'exit immersive', 'stop glasses', 'disable glasses', or similar.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "browser_navigate",
    description:
      "Navigate to a URL in the browser. Returns page title and screenshot. " +
      "Use for web browsing, filling forms, checking websites on King Kazuma's behalf.",
    parameters: {
      type: "OBJECT",
      properties: {
        url: { type: "STRING", description: "URL to navigate to" },
        session_id: { type: "STRING", description: "Browser session ID (default: 'default')" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_click",
    description:
      "Click an element on the page by CSS selector. Returns screenshot after click. " +
      "Use wait_after='navigation' if click triggers page navigation, 'idle' for AJAX.",
    parameters: {
      type: "OBJECT",
      properties: {
        selector: { type: "STRING", description: "CSS selector of element to click" },
        session_id: { type: "STRING", description: "Browser session ID (default: 'default')" },
        wait_after: { type: "STRING", description: "'navigation', 'idle', or milliseconds to wait after click" },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into an input field by CSS selector. Clears existing content first by default.",
    parameters: {
      type: "OBJECT",
      properties: {
        selector: { type: "STRING", description: "CSS selector of input element" },
        text: { type: "STRING", description: "Text to type" },
        session_id: { type: "STRING", description: "Browser session ID (default: 'default')" },
        press_enter: { type: "BOOLEAN", description: "Press Enter after typing (default: false)" },
        clear: { type: "BOOLEAN", description: "Clear existing content first (default: true)" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Take a screenshot of the current page. Returns base64 PNG image.",
    parameters: {
      type: "OBJECT",
      properties: {
        session_id: { type: "STRING", description: "Browser session ID (default: 'default')" },
        full_page: { type: "BOOLEAN", description: "Capture full scrollable page (default: false)" },
      },
    },
  },
  {
    name: "browser_extract",
    description:
      "Extract text content from elements matching a CSS selector. Returns text, tag, id, href, value for each match.",
    parameters: {
      type: "OBJECT",
      properties: {
        selector: { type: "STRING", description: "CSS selector to extract from" },
        session_id: { type: "STRING", description: "Browser session ID (default: 'default')" },
        attribute: { type: "STRING", description: "Optional HTML attribute to extract" },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_evaluate",
    description:
      "Execute JavaScript on the current page. For complex interactions like selecting dropdowns, scrolling, or reading dynamic content. Returns result + screenshot.",
    parameters: {
      type: "OBJECT",
      properties: {
        script: { type: "STRING", description: "JavaScript code to evaluate in page context" },
        session_id: { type: "STRING", description: "Browser session ID (default: 'default')" },
      },
      required: ["script"],
    },
  },
  {
    name: "browser_set_objective",
    description:
      "REQUIRED before starting browser automation. Sets the mission objective for this session. " +
      "The objective persists across context resets so the agent always knows what it's doing. " +
      "Example: 'Renew matrícula #852156 for SKYLINE CAPITAL S.A.S.'",
    parameters: {
      type: "OBJECT",
      properties: {
        objective: { type: "STRING", description: "Clear description of what this browser session should accomplish" },
        session_id: { type: "STRING", description: "Browser session ID (default: 'default')" },
      },
      required: ["objective"],
    },
  },
  {
    name: "browser_form_snapshot",
    description:
      "Capture all form field values on the current page. Masks credit card numbers and passwords. " +
      "Use before submitting any form to verify the correct data is filled in.",
    parameters: {
      type: "OBJECT",
      properties: {
        session_id: { type: "STRING", description: "Browser session ID (default: 'default')" },
      },
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

  // Never regress terminal statuses — completed/cancelled/failed directives stay that way
  const terminalStatuses = new Set(["completed", "cancelled", "failed"]);
  if (terminalStatuses.has(directive.status)) {
    log.directive.info(`${directive.id} already ${directive.status} — ignoring stale approval ${approvalId}`);
    return;
  }

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
  const otherPersona = persona === "june" ? "cipher" : "june";
  const otherName = persona === "june" ? "Cipher" : "June";
  const [facts, summaries, crossSummaries] = await Promise.all([
    getMemories(persona, 30),
    getRecentSummaries(persona, 5),
    getRecentSummaries(otherPersona, 3),
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
  // Cross-persona: what King Kazuma discussed with the other AI
  if (crossSummaries.length > 0) {
    ctx += `\n\nWHAT KING KAZUMA DISCUSSED WITH ${otherName.toUpperCase()} RECENTLY:\n`;
    ctx += crossSummaries.map(s => {
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

  // 4b. Active epics summary
  const activeEpics = directives.filter(d => d.type === "epic" && !["completed", "cancelled"].includes(d.status));
  if (activeEpics.length > 0) {
    lines.push(`Active epics: ${activeEpics.length}`);
    for (const epic of activeEpics) {
      const progress = getEpicProgress(epic.id);
      lines.push(`  ${epic.emoji || "📦"} "${epic.title}" — Phase ${progress.completed + (progress.inProgress > 0 ? 1 : 0)}/${progress.total} ${progress.currentPhase ? `(${progress.currentPhase.status})` : ""}`);
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

  // ── Glasses immersive mode ──
  if (name === "enable_glasses_immersive") {
    broadcastToDeviceType("phone", { type: "glassesImmersiveRequest", enable: true });
    log.bridge.info("Glasses immersive mode: enabling via phone");
    return { success: true, message: "Immersive mode activation sent to iPhone. The glasses camera and AR pipeline will start automatically." };
  }
  if (name === "disable_glasses_immersive") {
    broadcastToDeviceType("phone", { type: "glassesImmersiveRequest", enable: false });
    log.bridge.info("Glasses immersive mode: disabling via phone");
    return { success: true, message: "Immersive mode deactivation sent to iPhone. Glasses stream will stop." };
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

        // Server-side enforcement: high-risk approvals ALWAYS require PIN
        // (don't trust the LLM's needs_user_pin for message sends or directive plans)
        {
          const approvals = getApprovals();
          const approval = approvals.find((a) => a.id === approvalId);
          if (approval && (approval.tool === "directive_plan" || approval.type === "message_send")) {
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
        const streamPath = getCameraStreamPath(camera.streamName, "lo");
        const streamHosts = getCameraStreamHosts();
        const streamUrl = `${streamHosts[streamHosts.length - 1]}${streamPath}`; // legacy fallback (WG host)
        broadcastToAll({ type: "showCamera", cameraId: camera.id, streamUrl, streamHosts, streamPath, cameraName: camera.name });
        log.bridge.info(`Showing ${camera.name} → ${streamUrl}`);
        return { success: true, message: `Showing ${camera.name} on TV.` };
      }

      if (name === "hide_camera") {
        broadcastToAll({ type: "hideCamera" });
        log.bridge.info("Hiding camera overlay");
        return { success: true, message: "Camera overlay dismissed." };
      }

      if (name === "vacuum_start" || name === "vacuum_pause" || name === "vacuum_dock") {
        const action = name.replace("vacuum_", "");
        const { execFile } = require("child_process");
        const result = await new Promise((resolve) => {
          execFile(
            "/home/gcp/ozzu/scripts/.venv-vacuum/bin/python",
            ["/home/gcp/ozzu/scripts/vacuum-control.py", action],
            { timeout: 20000 },
            (err, stdout, stderr) => {
              resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
            }
          );
        });
        if (result.code === 0) {
          log.bridge.info(`vacuum_${action}: ${result.stdout}`);
          return { success: true, message: `Dusk Vader: ${action} command sent (cloud accepted).` };
        }
        log.bridge.warn(`vacuum_${action} failed (exit=${result.code}): ${result.stderr || result.stdout}`);
        return { success: false, message: `Vacuum ${action} failed: ${result.stderr || result.stdout || `exit ${result.code}`}` };
      }

      if (name === "vacuum_history") {
        const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
        const rows = await db.query(
          `SELECT started_at, cleaning_minutes, cleaned_area_m2, status_code, completed, task_interrupt
             FROM vacuum_runs
            WHERE started_at >= NOW() - INTERVAL '${days} days'
            ORDER BY started_at DESC
            LIMIT ${limit}`
        );
        if (!rows || rows.length === 0) {
          return { success: true, message: `No vacuum runs in the last ${days} day(s). Check that the Dreame app schedule is enabled and the vacuum isn't blocked.` };
        }
        const lines = rows.map(r => {
          const when = new Date(r.started_at).toISOString().replace("T", " ").slice(0, 16);
          const mark = r.completed ? "✓" : (r.task_interrupt != null ? "⚠ interrupted" : "…");
          return `${when}  ${String(r.cleaning_minutes).padStart(3)} min  ${String(r.cleaned_area_m2).padStart(3)} m²  ${mark}`;
        });
        const lastRun = new Date(rows[0].started_at);
        const hoursAgo = Math.round((Date.now() - lastRun.getTime()) / 3600000);
        const summary = `Last cleaned: ${hoursAgo}h ago. ${rows.length} run(s) in last ${days}d.`;
        return { success: true, message: `${summary}\n\n${lines.join("\n")}` };
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

      // ── Browser automation tools (with financial safeguards) ──
      if (name.startsWith("browser_")) {
        const BROWSER_URL = "http://127.0.0.1:3334";
        const sessionId = args.session_id || "default";
        const browserFetch = async (path, body) => {
          const resp = await fetch(`${BROWSER_URL}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          return resp.json();
        };

        // ── Meta-tools: no gate needed ──
        if (name === "browser_set_objective") {
          if (!args.objective) return { success: false, message: "objective is required" };
          _browserSessionState.set(sessionId, {
            ..._browserSessionState.get(sessionId),
            objective: args.objective,
            isFinancial: false,
            lastUrl: null,
          });
          db.upsertBrowserSession(sessionId, { objective: args.objective }).catch(() => {});
          db.addBrowserAuditEntry({ session_id: sessionId, tool_name: name, args: { objective: args.objective }, result_summary: "Objective set" }).catch(() => {});
          log.bridge.info(`[browser] Session ${sessionId} objective: ${args.objective}`);
          return { success: true, message: `Session objective set: ${args.objective}` };
        }

        if (name === "browser_form_snapshot") {
          const script = `(() => {
            const fields = [];
            document.querySelectorAll('input, select, textarea').forEach(el => {
              const name = el.name || el.id || el.getAttribute('aria-label') || el.type || 'unnamed';
              let val = el.value || '';
              const type = el.type || el.tagName.toLowerCase();
              if (type === 'password') val = '****';
              if (/\\b\\d{13,19}\\b/.test(val)) val = val.replace(/\\d(?=\\d{4})/g, '*');
              fields.push({ name, type, value: val, tag: el.tagName });
            });
            return fields;
          })()`;
          const result = await browserFetch("/evaluate", { script, session_id: sessionId });
          if (!result.ok) return { success: false, message: result.error || "Form snapshot failed" };
          db.addBrowserAuditEntry({ session_id: sessionId, tool_name: name, args: {}, result_summary: `${(result.result || []).length} fields captured` }).catch(() => {});
          return { success: true, fields: result.result, screenshot: result.screenshot };
        }

        // ── Financial detection for browser_type, browser_click, browser_navigate ──
        const financialReasons = _detectFinancialAction(name, args, sessionId);
        if (financialReasons.length > 0) {
          log.bridge.warn(`[browser] FINANCIAL ACTION DETECTED: ${financialReasons.join(", ")}`);

          // Log the flagged action
          db.addBrowserAuditEntry({
            session_id: sessionId,
            tool_name: name,
            args,
            flagged: true,
            flag_reason: financialReasons.join("; "),
            url_at_time: _browserSessionState.get(sessionId)?.lastUrl || null,
          }).catch(() => {});

          // Capture form snapshot (best effort)
          let formFields = [];
          try {
            const snapScript = `(() => {
              const fields = [];
              document.querySelectorAll('input, select, textarea').forEach(el => {
                const n = el.name || el.id || el.type || 'unnamed';
                let v = el.value || '';
                if (el.type === 'password') v = '****';
                if (/\\b\\d{13,19}\\b/.test(v)) v = v.replace(/\\d(?=\\d{4})/g, '*');
                if (v) fields.push(n + '=' + v);
              });
              return fields.join(', ');
            })()`;
            const snap = await browserFetch("/evaluate", { script: snapScript, session_id: sessionId });
            if (snap.ok && snap.result) formFields = snap.result;
          } catch {}

          // Build description for PIN request
          const sess = _browserSessionState.get(sessionId) || {};
          const pinDescription = [
            `⚠️ FINANCIAL ACTION DETECTED`,
            `Reasons: ${financialReasons.join(", ")}`,
            sess.objective ? `Objective: ${sess.objective}` : null,
            sess.lastUrl ? `URL: ${sess.lastUrl}` : null,
            `Action: ${name}(${JSON.stringify(_maskSensitiveArgs(args))})`,
            formFields ? `Form: ${typeof formFields === 'string' ? formFields.slice(0, 300) : ''}` : null,
          ].filter(Boolean).join("\n");

          // Create approval and send PIN request
          const approvalId = `fin_${Date.now()}`;
          const approvals = getApprovals();
          const approval = {
            id: approvalId,
            tool: name,
            description: pinDescription,
            risk: "high",
            resolved: false,
            approved: false,
            createdAt: Date.now(),
          };
          approvals.push(approval);
          saveApprovals(approvals, approval);

          // Notify June
          sendNotification(`[SYSTEM — Tell King Kazuma casually.]\n⚠️ Financial action detected in browser automation. Check your iPhone for PIN approval. ${financialReasons.join(", ")}`);

          // Send PIN request to iPhone and wait
          const pinResult = await new Promise((resolve) => {
            const pinId = `pin_${Date.now()}`;
            pendingPinRequests.set(pinId, { approvalId, approved: true, resolve });
            broadcastToDeviceType("phone", {
              type: "pinRequest",
              approvalId: pinId,
              description: pinDescription,
              directiveTitle: "Financial Action Approval",
              planSummary: null,
            });

            // 3-minute timeout for financial actions
            setTimeout(() => {
              if (pendingPinRequests.has(pinId)) {
                pendingPinRequests.delete(pinId);
                broadcastToDeviceType("phone", { type: "pinResolved", approvalId: pinId });
                resolve({ success: false, message: "Financial action BLOCKED: PIN entry timed out (3 min). Action was NOT executed." });
              }
            }, 180000);
          });

          if (!pinResult.success) {
            db.addBrowserAuditEntry({
              session_id: sessionId,
              tool_name: name,
              args: _maskSensitiveArgs(args),
              result_summary: "BLOCKED: " + pinResult.message,
              flagged: true,
              flag_reason: "denied_or_timeout",
              approval_id: approvalId,
            }).catch(() => {});
            return pinResult;
          }
          // PIN approved — fall through to execute the action
          log.bridge.info(`[browser] Financial action APPROVED by King Kazuma — proceeding`);
        }

        // ── Standard browser tool dispatch ──
        let toolResult;

        if (name === "browser_navigate") {
          if (!args.url) return { success: false, message: "url is required" };
          const result = await browserFetch("/navigate", { url: args.url, session_id: sessionId });
          if (!result.ok) return { success: false, message: result.error || "Navigation failed" };
          log.bridge.info(`[browser] Navigated to ${result.url} — "${result.title}"`);
          // Update session state
          const sess = _browserSessionState.get(sessionId) || {};
          sess.lastUrl = result.url;
          _browserSessionState.set(sessionId, sess);
          toolResult = { success: true, title: result.title, url: result.url, screenshot: result.screenshot };
        } else if (name === "browser_click") {
          if (!args.selector) return { success: false, message: "selector is required" };
          const result = await browserFetch("/click", { selector: args.selector, session_id: sessionId, wait_after: args.wait_after });
          if (!result.ok) return { success: false, message: result.error || "Click failed" };
          log.bridge.info(`[browser] Clicked ${args.selector} — ${result.clicked?.tag} "${result.clicked?.text?.slice(0, 50)}"`);
          toolResult = { success: true, clicked: result.clicked, screenshot: result.screenshot };
        } else if (name === "browser_type") {
          if (!args.selector) return { success: false, message: "selector is required" };
          if (args.text === undefined) return { success: false, message: "text is required" };
          const result = await browserFetch("/type", { selector: args.selector, text: args.text, session_id: sessionId, press_enter: args.press_enter, clear: args.clear });
          if (!result.ok) return { success: false, message: result.error || "Type failed" };
          log.bridge.info(`[browser] Typed ${result.typed} into ${args.selector}`);
          toolResult = { success: true, message: `Typed ${result.typed} into ${args.selector}` };
        } else if (name === "browser_screenshot") {
          const result = await browserFetch("/screenshot", { session_id: sessionId, full_page: args.full_page });
          if (!result.ok) return { success: false, message: result.error || "Screenshot failed" };
          toolResult = { success: true, title: result.title, url: result.url, screenshot: result.screenshot };
        } else if (name === "browser_extract") {
          if (!args.selector) return { success: false, message: "selector is required" };
          const result = await browserFetch("/extract", { selector: args.selector, session_id: sessionId, attribute: args.attribute });
          if (!result.ok) return { success: false, message: result.error || "Extract failed" };
          log.bridge.info(`[browser] Extracted ${result.count} elements from ${args.selector}`);
          toolResult = { success: true, count: result.count, elements: result.elements };
        } else if (name === "browser_evaluate") {
          if (!args.script) return { success: false, message: "script is required" };
          const result = await browserFetch("/evaluate", { script: args.script, session_id: sessionId });
          if (!result.ok) return { success: false, message: result.error || "Evaluate failed" };
          log.bridge.info(`[browser] Evaluated script on page`);
          toolResult = { success: true, result: result.result, screenshot: result.screenshot };
        } else {
          return { success: false, message: `Unknown browser tool: ${name}` };
        }

        // ── Post-action audit logging ──
        db.addBrowserAuditEntry({
          session_id: sessionId,
          tool_name: name,
          args: _maskSensitiveArgs(args),
          result_summary: toolResult.success ? "ok" : toolResult.message,
          url_at_time: _browserSessionState.get(sessionId)?.lastUrl || null,
        }).catch(() => {});

        return toolResult;
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

// ── Financial safeguards for browser automation ──
const _browserSessionState = new Map(); // sessionId -> { objective, isFinancial, lastUrl }

const FINANCIAL_SELECTOR_PATTERNS = [
  /card[-_]?num/i, /credit[-_]?card/i, /cvv/i, /cvc/i, /expir/i,
  /billing/i, /payment[-_]?method/i, /cc[-_]?number/i, /cardnumber/i,
];
const PAYMENT_BUTTON_PATTERNS = [
  /\bpay\b/i, /\bpagar\b/i, /\bcomprar\b/i, /\bcheckout\b/i,
  /\bfinalizar\b/i, /\brealizar.?pago\b/i, /\bsubmit.?payment\b/i,
  /\bconfirm.?order\b/i, /\bplace.?order\b/i, /\bprocesar\b/i,
];
const PAYMENT_GATEWAY_URLS = [
  "epayco.co", "paypal.com", "stripe.com", "mercadopago",
  "placetopay", "wompi.co", "bold.co", "checkout.stripe.com",
  "payulatam.com", "kushki.com",
];

function _luhnCheck(num) {
  const digits = num.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function _maskSensitiveArgs(args) {
  const safe = { ...args };
  if (safe.text && typeof safe.text === "string") {
    // Mask CC numbers
    safe.text = safe.text.replace(/\b(\d{4})\d{9,15}/g, "$1****");
  }
  return safe;
}

function _detectFinancialAction(toolName, args, sessionId) {
  const reasons = [];
  const sess = _browserSessionState.get(sessionId) || {};

  if (toolName === "browser_type") {
    // Check if selector matches financial field patterns
    const sel = (args.selector || "").toLowerCase();
    for (const pattern of FINANCIAL_SELECTOR_PATTERNS) {
      if (pattern.test(sel)) {
        reasons.push(`Typing into financial field: ${sel}`);
        break;
      }
    }
    // Check if typed text looks like a CC number (Luhn check)
    const text = (args.text || "").replace(/[\s-]/g, "");
    if (/^\d{13,19}$/.test(text) && _luhnCheck(text)) {
      reasons.push("Text matches credit card number (Luhn valid)");
    }
    // Check CVV on financial pages
    if (/cvv|cvc|security.?code/i.test(sel) && /^\d{3,4}$/.test(args.text || "")) {
      reasons.push("Typing CVV/security code");
    }
  }

  if (toolName === "browser_click") {
    const sel = (args.selector || "").toLowerCase();
    const textMatch = (args.text_match || "").toLowerCase();
    const combined = sel + " " + textMatch;
    for (const pattern of PAYMENT_BUTTON_PATTERNS) {
      if (pattern.test(combined)) {
        reasons.push(`Clicking payment button: ${combined.trim().slice(0, 60)}`);
        break;
      }
    }
  }

  if (toolName === "browser_navigate") {
    const url = (args.url || "").toLowerCase();
    for (const gateway of PAYMENT_GATEWAY_URLS) {
      if (url.includes(gateway)) {
        reasons.push(`Navigating to payment gateway: ${gateway}`);
        sess.isFinancial = true;
        _browserSessionState.set(sessionId, sess);
        break;
      }
    }
  }

  return reasons;
}

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

// ── Audio device preferences (override auto-routing when set) ──
let preferredInputDeviceId = null;   // deviceId or null (auto)
let preferredOutputDeviceIds = null; // string[] or null (auto)

async function saveAudioPreferences() {
  const data = { preferredInput: preferredInputDeviceId, preferredOutputs: preferredOutputDeviceIds };
  if (_redisConnected) {
    redis.set("ozzu:audioPreferences", JSON.stringify(data)).catch(err =>
      log.redis.error("save audio preferences failed:", err.message));
  }
}

function broadcastAudioRoutingState() {
  const deviceList = [...devices.entries()].map(([ws, info]) => ({
    deviceId: info.deviceId, role: info.role, deviceType: info.deviceType,
    zone: info.zone, capabilities: info.capabilities,
    speakerPriority: info.speakerPriority, online: ws.readyState === WebSocket.OPEN,
    isActiveMic: ws === activeMic,
    isSelectedSpeaker: false, // filled in below
  }));
  const target = selectSpeaker();
  if (target) {
    const entry = deviceList.find(d => d.deviceId === target.info.deviceId);
    if (entry) entry.isSelectedSpeaker = true;
  }
  const msg = JSON.stringify({
    type: "audioRoutingUpdate",
    preferredInput: preferredInputDeviceId,
    preferredOutputs: preferredOutputDeviceIds,
    devices: deviceList,
    activeMic: activeMic ? devices.get(activeMic)?.deviceId : null,
    autoSelectedSpeaker: target ? target.info.deviceId : null,
    mode: cipherPipeline ? "cipher" : (geminiWs ? "june" : "idle"),
  });
  for (const [ws] of devices) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch {}
    }
  }
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
let pendingVisionRequest = null; // { ws, mode, buffer } — tracks active vision analysis request
let visionTranscriptBuffer = ""; // accumulates Gemini text for vision result

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
// Wire up OSINT monitor broadcast for push alerts
osintMonitor.setBroadcast(broadcastToAll);

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

  // Preferred output override: return first online preferred device
  if (preferredOutputDeviceIds && preferredOutputDeviceIds.length > 0) {
    for (const prefId of preferredOutputDeviceIds) {
      const match = speakers.find(s => s.info.deviceId === prefId);
      if (match) return match;
    }
    // All preferred outputs offline — fall through to auto
  }

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
    // Push to Redis live feed for CLI sync
    if (_redisConnected && text.length > 3) {
      redis.lpush("cipher:live:turns", JSON.stringify({ source: "voice", role: "user", content: text.substring(0, 2000), timestamp: Date.now() })).catch(() => {});
      redis.ltrim("cipher:live:turns", 0, 49).catch(() => {});
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
    // Push to Redis live feed for CLI sync
    if (_redisConnected && sc.outputTranscription.text.length > 3) {
      redis.lpush("cipher:live:turns", JSON.stringify({ source: "voice", role: currentPersona, content: sc.outputTranscription.text.substring(0, 2000), timestamp: Date.now() })).catch(() => {});
      redis.ltrim("cipher:live:turns", 0, 49).catch(() => {});
    }
    if (isEngaged()) {
      broadcastToAll({ type: "transcript", text: sc.outputTranscription.text });
    }
    // Accumulate for pending vision request
    if (pendingVisionRequest) {
      visionTranscriptBuffer += sc.outputTranscription.text;
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
    // Send accumulated vision result back to requesting device
    if (pendingVisionRequest && visionTranscriptBuffer) {
      try {
        const vr = pendingVisionRequest;
        if (vr.ws && vr.ws.readyState === 1) {
          vr.ws.send(JSON.stringify({
            type: "visionResult",
            mode: vr.mode,
            text: visionTranscriptBuffer.trim(),
          }));
          log.bridge.info(`Vision result sent (mode=${vr.mode}, ${visionTranscriptBuffer.length} chars)`);
        }
      } catch (e) {
        log.bridge.warn(`Vision result send failed: ${e.message}`);
      }
      pendingVisionRequest = null;
      visionTranscriptBuffer = "";
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

  // Preferred input override: reject audio from non-preferred mics (if preferred is online)
  if (preferredInputDeviceId && deviceId !== preferredInputDeviceId) {
    // Check if preferred device is actually connected
    let preferredOnline = false;
    for (const [, info] of devices) {
      if (info.deviceId === preferredInputDeviceId) { preferredOnline = true; break; }
    }
    if (preferredOnline) return; // Drop audio — preferred mic is online
    // Preferred offline → fall through to auto
  }

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
    "- Network details: see /home/gcp/ozzu/infra/devices.json (canonical) — do NOT inline IPs in directive descriptions, point the worker agent there.\n" +
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
    conversationTranscript.push({ role: "user", text, timestamp: Date.now() });
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "user", text, turnIndex++, null, 'text', { source: 'voice' }).catch(err => log.pg.warn("turn log:", err.message));
    }
    // Push to Redis live feed for CLI sync
    if (_redisConnected && text.length > 3) {
      redis.lpush("cipher:live:turns", JSON.stringify({ source: "voice", role: "user", content: text.substring(0, 2000), timestamp: Date.now() })).catch(() => {});
      redis.ltrim("cipher:live:turns", 0, 49).catch(() => {});
    }
  });

  cipherPipeline.on("outputTranscript", (text) => {
    extendEngagement();
    broadcastToAll({ type: "transcript", text });
    pushTranscript({ role: "cipher", text });
    if (currentConversationId) {
      db.addConversationTurn(currentConversationId, "cipher", text, turnIndex++, null, 'text', { source: 'voice' }).catch(err => log.pg.warn("turn log:", err.message));
    }
    // Push to Redis live feed for CLI sync
    if (_redisConnected && text.length > 3) {
      redis.lpush("cipher:live:turns", JSON.stringify({ source: "voice", role: "cipher", content: text.substring(0, 2000), timestamp: Date.now() })).catch(() => {});
      redis.ltrim("cipher:live:turns", 0, 49).catch(() => {});
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

// ── Dev Mirror — MOVED to standalone service (backend/mirror/mirror-server.js on port 3340) ──
// The execSync screencap was blocking the event loop at 5fps, causing manifest/HTTP timeouts.
// nginx now routes /bridge/dev/mirror to the standalone service.

// ── Device WebSocket server ──

const wss = new WebSocket.Server({ noServer: true });

// Handle ALL WebSocket upgrades manually (avoids conflicts between multiple ws servers)
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (pathname === "/dev/mirror") {
    // Mirror moved to standalone service on port 3340 — nginx routes there directly
    socket.destroy();
  } else if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

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

wss.on("connection", (ws, req) => {
  // Auth gate: public WS connections (via nginx) need a valid token
  if (BRIDGE_API_KEY && req.headers["x-forwarded-for"]) {
    const clientIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const isTrusted = TRUSTED_NETS.some(net => clientIp.startsWith(net.prefix));
    if (!isTrusted) {
      const wsUrl = new URL(req.url, `http://localhost:${PORT}`);
      const token = wsUrl.searchParams.get("token");
      if (token !== BRIDGE_API_KEY) {
        log.ws.warn(`Rejected public WS connection from ${clientIp} — invalid token`);
        ws.close(4001, "Unauthorized");
        return;
      }
    }
  }

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
        // Notify all devices about new routing state
        broadcastAudioRoutingState();
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
        // Broadcast to preferred output devices, or all non-phone speakers if no preference
        const audioMsg = JSON.stringify({ type: "audio", data: msg.data });
        for (const [clientWs, clientInfo] of devices) {
          if (clientWs === ws) continue; // Don't send back to iPhone
          if (!clientInfo.capabilities?.speaker) continue;
          if (clientWs.readyState !== WebSocket.OPEN) continue;
          // If preferred outputs set, only send to those devices
          if (preferredOutputDeviceIds && preferredOutputDeviceIds.length > 0) {
            if (!preferredOutputDeviceIds.includes(clientInfo.deviceId)) continue;
          }
          try { clientWs.send(audioMsg); } catch {}
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

      // Debug log from phone (remote console visibility)
      if (msg.type === "debugLog") {
        const info = devices.get(ws);
        console.log(`[phone-debug] ${info?.deviceId || "unknown"}: ${msg.msg}`);
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
          const uploadsDir = "/home/gcp/ozzu/data/uploads";
          const fs = require("fs");
          fs.mkdirSync(uploadsDir, { recursive: true });
          const ts = Date.now();
          const safeName = (filename || `upload-${ts}`).replace(/[^a-zA-Z0-9._-]/g, "_");
          const savePath = `${uploadsDir}/${ts}-${target}-${safeName}`;
          const binaryExts = [".glb", ".gltf", ".obj", ".usdz", ".zip", ".bin"];
          const ext = (filename || "").substring((filename || "").lastIndexOf(".")).toLowerCase();
          const isBinary = contentType === "image" || binaryExts.includes(ext);
          if (isBinary) {
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

      // ── Vision mode request from glasses ──
      if (msg.type === "glassesVisionRequest") {
        const info = devices.get(ws);
        const mode = msg.mode || "describe";
        log.bridge.info(`Vision request: mode=${mode} from ${info?.deviceId}`);

        const visionPrompts = {
          describe: "Look at this image from smart glasses. Describe what you see in 1-2 concise sentences. Focus on the most notable things.",
          ocr: "Extract ALL visible text from this image. Return only the text you can read, preserving layout where possible. If no text is visible, say 'No text detected'.",
          identify: "List every distinct object you can identify in this image. Format: one per line, with approximate position (left/center/right, top/middle/bottom). Be specific (e.g. 'red coffee mug' not just 'object').",
          translate: "Read any visible text in this image. If it's not in English, translate it to English. Format: 'Original: [text]' then 'English: [translation]'. If already English or no text, just read it out.",
        };

        const prompt = visionPrompts[mode] || visionPrompts.describe;

        if (geminiReady && geminiWs && geminiWs.readyState === 1 && msg.data) {
          // Track pending vision request so we can route the response back
          pendingVisionRequest = { ws, mode };
          visionTranscriptBuffer = "";

          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{
                role: "user",
                parts: [
                  { text: `[Vision analysis — ${mode} mode. Respond with ONLY the analysis, no preamble.] ${prompt}` },
                  { inlineData: { mimeType: "image/jpeg", data: msg.data } },
                ],
              }],
              turnComplete: true,
            },
          }));
          log.bridge.debug(`Vision request forwarded to Gemini (mode=${mode})`);
        } else {
          ws.send(JSON.stringify({
            type: "visionResult",
            mode,
            text: "Vision not available — Gemini session inactive",
          }));
        }
        return;
      }

      if (msg.type === "glassesPhoto") {
        const info = devices.get(ws);
        log.bridge.info(`Glasses photo captured from ${info?.deviceId}`);
        // Save to disk
        try {
          const uploadsDir = "/home/gcp/ozzu/data/uploads";
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

      // ── Glasses immersive mode state updates ──
      if (msg.type === "glassesImmersiveState") {
        const info = devices.get(ws);
        const state = msg.state || "unknown";
        const error = msg.error || null;
        log.bridge.info(`Glasses immersive state: ${state}${error ? ` (error: ${error})` : ""} from ${info?.deviceId}`);
        // Broadcast to all devices
        broadcastToAll({ type: "glassesImmersiveState", state, error, from: info?.deviceId });
        // Send context to Gemini so June can acknowledge
        if (geminiReady && geminiWs && geminiWs.readyState === 1) {
          const contextMap = {
            activating: "[System: Glasses immersive mode is activating — camera and AR pipeline starting. Acknowledge briefly.]",
            immersive: "[System: Glasses immersive mode is now fully active — gesture control ready. Acknowledge briefly.]",
            deactivating: "[System: Glasses immersive mode is shutting down. Acknowledge briefly.]",
            idle: "[System: Glasses immersive mode has been deactivated.]",
            error: `[System: Glasses immersive mode error: ${error}. Let King Kazuma know.]`,
          };
          const contextText = contextMap[state] || `[System: Glasses immersive state changed to ${state}]`;
          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: contextText }] }],
              turnComplete: true,
            },
          }));
        }
        return;
      }

      // ── Gesture debug stream ──
      if (msg.type === "gestureDebug") {
        const { tag, type: _, ...rest } = msg;
        console.log(`[GESTURE-DBG] ${tag}: ${JSON.stringify(rest)}`);
        return;
      }

      // ── Gesture command from AR hand tracking ──
      if (msg.type === "gestureCommand") {
        const info = devices.get(ws);
        const gesture = msg.gesture || "unknown";
        const action = msg.action || "";
        const fingerCount = msg.fingerCount;
        log.bridge.info(`Gesture command: ${gesture} → ${action}${fingerCount ? ` (${fingerCount} fingers)` : ""} from ${info?.deviceId}`);

        // Forward to Gemini as context so June can react
        if (geminiReady && geminiWs && geminiWs.readyState === 1) {
          const contextParts = [`[Gesture detected: ${gesture}. Action: ${action}.`];
          if (fingerCount) contextParts[0] += ` Finger count: ${fingerCount}.`;
          contextParts[0] += " React briefly and naturally — this is a hand gesture from the glasses camera.]";
          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: contextParts[0] }] }],
              turnComplete: true,
            },
          }));
        }

        // Broadcast gesture event to all devices (for UI feedback on tablets/TV)
        broadcastToAll({
          type: "gestureEvent",
          gesture,
          action,
          fingerCount,
          from: info?.deviceId,
          timestamp: msg.timestamp || Date.now(),
        });
        return;
      }

      // ── Targeted gesture command — controls a specific HA device ──
      if (msg.type === "targetedGestureCommand") {
        const info = devices.get(ws);
        const { gesture, service, entityId, domain, deviceName, continuous, continuousValue, attribute, min, max } = msg;

        // Entity allowlist — only control known domains
        const ALLOWED_DOMAINS = ["media_player", "climate", "switch", "vacuum", "siren", "number", "select"];
        const entityDomain = entityId?.split(".")[0];
        if (!entityId || !ALLOWED_DOMAINS.includes(entityDomain)) {
          log.bridge.warn(`Targeted gesture blocked: ${entityId} — domain not allowed`);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "gestureControlFeedback", entityId, deviceName, action: service, error: "Domain not allowed" }));
          }
          return;
        }

        // Rate limiting: 100ms for continuous, 1s for discrete (per entity)
        const now = Date.now();
        const rlKey = `gesture:${entityId}`;
        if (!global._gestureRateLimits) global._gestureRateLimits = new Map();
        const lastCall = global._gestureRateLimits.get(rlKey) || 0;
        const minInterval = continuous ? 100 : 1000;
        if (now - lastCall < minInterval) {
          return; // silently drop — rate limited
        }
        global._gestureRateLimits.set(rlKey, now);

        // Clean rate limit map every 60s
        if (!global._gestureRlCleanup) {
          global._gestureRlCleanup = setInterval(() => {
            if (!global._gestureRateLimits) return;
            const cutoff = Date.now() - 60000;
            for (const [k, v] of global._gestureRateLimits) {
              if (v < cutoff) global._gestureRateLimits.delete(k);
            }
          }, 60000);
        }

        log.bridge.info(`Targeted gesture: ${gesture} → ${domain}.${service} on ${entityId} (${deviceName})${continuous ? ` val=${continuousValue}` : ""} from ${info?.deviceId}`);

        (async () => {
          try {
            // Build HA service call
            const serviceData = { entity_id: entityId };

            if (continuous && continuousValue !== undefined && attribute) {
              serviceData[attribute] = continuousValue;
            }

            // Execute HA service call
            await haFetch(`/api/services/${entityDomain}/${service}`, {
              method: "POST",
              body: JSON.stringify(serviceData),
            });

            // Read back current state
            let stateStr = "";
            try {
              const stateRes = await haFetch(`/api/states/${entityId}`);
              if (stateRes && stateRes.state) {
                stateStr = stateRes.state;
                // Add relevant attribute for richer feedback
                if (stateRes.attributes) {
                  if (attribute === "volume_level" && stateRes.attributes.volume_level !== undefined) {
                    stateStr = `VOL ${Math.round(stateRes.attributes.volume_level * 100)}%`;
                  } else if (attribute === "temperature" && stateRes.attributes.temperature !== undefined) {
                    stateStr = `${stateRes.attributes.temperature}\u00B0C`;
                  }
                }
              }
            } catch (err) {
              log.bridge.warn(`[gestureControl] State readback failed for ${entityId}: ${err.message}`);
            }

            // Send feedback to requesting device
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: "gestureControlFeedback",
                entityId,
                deviceName,
                action: service,
                state: stateStr,
              }));
            }

            // Forward context to Gemini (non-intrusive)
            if (geminiReady && geminiWs && geminiWs.readyState === 1) {
              geminiWs.send(JSON.stringify({
                clientContent: {
                  turns: [{ role: "user", parts: [{ text: `[Gesture control: ${gesture} on ${deviceName} (${entityId}) \u2192 ${service}${stateStr ? `. State: ${stateStr}` : ""}. Don't narrate unless asked.]` }] }],
                  turnComplete: true,
                },
              }));
            }

            // Broadcast event to all devices for UI awareness
            broadcastToAll({
              type: "gestureControlEvent",
              gesture,
              service,
              entityId,
              deviceName,
              state: stateStr,
              from: info?.deviceId,
              timestamp: now,
            });
          } catch (err) {
            log.bridge.error(`Targeted gesture HA call failed: ${err.message}`);
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: "gestureControlFeedback",
                entityId,
                deviceName,
                action: service,
                error: err.message || "HA call failed",
              }));
            }
          }
        })();
        return;
      }

      if (msg.type === "sceneChange") {
        const info = devices.get(ws);
        const objects = msg.objects || [];
        const summary = objects.map(o => `${o.label} (${o.score}%)`).join(", ");
        log.bridge.info(`Scene change from ${info?.deviceId}: ${summary}`);

        // Forward to Gemini so June is aware of surroundings
        if (geminiReady && geminiWs && geminiWs.readyState === 1) {
          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: `[Scene update from glasses camera — objects detected: ${summary}. This is background context, don't narrate every change unless asked.]` }] }],
              turnComplete: true,
            },
          }));
        }

        // Broadcast to all devices
        broadcastToAll({
          type: "sceneUpdate",
          objects,
          from: info?.deviceId,
          timestamp: Date.now(),
        });
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
    // Notify remaining devices about routing change
    if (devices.size > 0) broadcastAudioRoutingState();
  });

  ws.on("error", (err) => {
    log.ws.error("Device error:", err.message);
  });
});

(async () => {
  await initStorage();
  // Orchestrator disabled — Cipher handles directives directly (no worker agents)
  log.bridge.info("Orchestrator disabled — Cipher handles directives directly");
  server.listen(PORT, "0.0.0.0", () => {
    log.bridge.info(`listening on :${PORT}`);
    log.bridge.info(`data dir: ${DATA_DIR}, redis: ${_redisConnected ? "connected" : "fallback to JSON"}`);
    log.bridge.info(`HA: ${HA_URL}, Gemini: ${GEMINI_API_KEY ? "configured" : "NOT SET"}`);
    log.bridge.info(`agent spawner: ready (event-driven, replaces cipher-watcher polling)`);
    startWatchdog();
    watchdog.start({ db, redis, broadcastToAll, sendNotification });
    try { require("./infra-monitor").start(); } catch (e) { log.bridge.error("infra-monitor start error:", e.message); }
    recoveryEngine.start({ db, redis, broadcastToAll, sendNotification, watchdog });
    cipherDaemon.start({ db, redis, broadcastToAll, watchdog, recoveryEngine });
    kairosService.start({ db, redis, broadcastToAll, watchdog, recoveryEngine, sendNotification });
    proactiveReporter.start({ db, redis, broadcastToAll, sendNotification, getDirectives });
    // Boot Person identity layer — ensure tables + seed owner
    require("./person").ensureTables(db).catch(e => log.bridge.error("person ensureTables:", e.message));
    // wa-service proxies to Android agent — no local connection needed on start
    metrics.startFlushTimer();
    // Initialize OSINT persistent scheduler + alert broadcast + monitoring
    osintEngine.setAlertBroadcast(broadcastToAll);
    osintMonitor.loadSchedules(osintEngine.runScan).catch((e) => log.bridge.error("OSINT monitor init error:", e.message));
    cliRunner.healthCheck().then((status) => {
      log.bridge.info(`OSINT CLI tools: container=${status.containerRunning ? "running" : "not running"}, tools=${Object.entries(status.tools).filter(([,v]) => v.available).length} available`);
    }).catch(() => {});

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
// test
