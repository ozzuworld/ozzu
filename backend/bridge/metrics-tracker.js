// metrics-tracker.js — Lightweight usage metrics collection and aggregation
// Tracks Gemini, Cipher, Spotify, and Bridge infrastructure metrics in-memory
// Flushes daily aggregates to PostgreSQL every 5 minutes

const db = require("./db");

// ── Today's counters (reset at midnight) ──
let _today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

const _counters = {
  gemini: {
    sessions: 0,
    sessionDurationMs: 0,
    audioChunksSent: 0,
    audioChunksReceived: 0,
    toolCalls: 0,
    reconnects: 0,
    turnsCompleted: 0,
    lastSessionStart: null,
  },
  cipher: {
    agentSpawns: 0,
    agentCompletions: 0,
    agentFailures: 0,
    activeAgents: 0,
  },
  spotify: {
    apiCalls: 0,
    tokenRefreshes: 0,
    cacheHits: 0,
  },
  bridge: {
    wsConnectionsTotal: 0,
    wsDisconnections: 0,
    httpRequests: 0,
  },
};

// ── Connection history ring buffer (last 50 events) ──
const MAX_CONNECTION_EVENTS = 50;
const _connectionHistory = [];

// ── Flush timer ──
let _flushTimer = null;

function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function checkMidnightRollover() {
  const now = getDateKey();
  if (now !== _today) {
    flushToDb(); // flush yesterday's data
    // Reset all counters
    _counters.gemini.sessions = 0;
    _counters.gemini.sessionDurationMs = 0;
    _counters.gemini.audioChunksSent = 0;
    _counters.gemini.audioChunksReceived = 0;
    _counters.gemini.toolCalls = 0;
    _counters.gemini.reconnects = 0;
    _counters.gemini.turnsCompleted = 0;
    _counters.gemini.lastSessionStart = null;
    _counters.cipher.agentSpawns = 0;
    _counters.cipher.agentCompletions = 0;
    _counters.cipher.agentFailures = 0;
    _counters.spotify.apiCalls = 0;
    _counters.spotify.tokenRefreshes = 0;
    _counters.spotify.cacheHits = 0;
    _counters.bridge.wsConnectionsTotal = 0;
    _counters.bridge.wsDisconnections = 0;
    _counters.bridge.httpRequests = 0;
    _today = now;
  }
}

// ── Gemini tracking ──

function trackGeminiSession() {
  checkMidnightRollover();
  _counters.gemini.sessions++;
  _counters.gemini.lastSessionStart = Date.now();
}

function trackGeminiSessionEnd() {
  if (_counters.gemini.lastSessionStart) {
    _counters.gemini.sessionDurationMs += Date.now() - _counters.gemini.lastSessionStart;
    _counters.gemini.lastSessionStart = null;
  }
}

function trackGeminiAudioSent() {
  _counters.gemini.audioChunksSent++;
}

function trackGeminiAudioReceived() {
  _counters.gemini.audioChunksReceived++;
}

function trackGeminiToolCall() {
  _counters.gemini.toolCalls++;
}

function trackGeminiTurnComplete() {
  _counters.gemini.turnsCompleted++;
}

function trackGeminiReconnect() {
  _counters.gemini.reconnects++;
}

// ── Cipher tracking ──

function trackAgentSpawn() {
  checkMidnightRollover();
  _counters.cipher.agentSpawns++;
}

function trackAgentComplete() {
  _counters.cipher.agentCompletions++;
}

function trackAgentFailure() {
  _counters.cipher.agentFailures++;
}

function setActiveAgents(count) {
  _counters.cipher.activeAgents = count;
}

// ── Spotify tracking ──

function trackSpotifyApiCall() {
  checkMidnightRollover();
  _counters.spotify.apiCalls++;
}

function trackSpotifyTokenRefresh() {
  _counters.spotify.tokenRefreshes++;
}

function trackSpotifyCacheHit() {
  _counters.spotify.cacheHits++;
}

// ── Bridge tracking ──

function trackWsConnection(deviceId, deviceType) {
  checkMidnightRollover();
  _counters.bridge.wsConnectionsTotal++;
  _connectionHistory.push({
    event: "connect",
    deviceId,
    deviceType,
    timestamp: Date.now(),
  });
  if (_connectionHistory.length > MAX_CONNECTION_EVENTS) {
    _connectionHistory.shift();
  }
}

function trackWsDisconnection(deviceId) {
  _counters.bridge.wsDisconnections++;
  _connectionHistory.push({
    event: "disconnect",
    deviceId,
    timestamp: Date.now(),
  });
  if (_connectionHistory.length > MAX_CONNECTION_EVENTS) {
    _connectionHistory.shift();
  }
}

function trackHttpRequest() {
  checkMidnightRollover();
  _counters.bridge.httpRequests++;
}

// ── Snapshot: return all current metrics ──

function getSnapshot() {
  checkMidnightRollover();

  // Calculate active Gemini session duration if one is running
  let activeSessionMs = 0;
  if (_counters.gemini.lastSessionStart) {
    activeSessionMs = Date.now() - _counters.gemini.lastSessionStart;
  }

  return {
    date: _today,
    gemini: {
      sessions: _counters.gemini.sessions,
      sessionDurationMs: _counters.gemini.sessionDurationMs + activeSessionMs,
      audioChunksSent: _counters.gemini.audioChunksSent,
      audioChunksReceived: _counters.gemini.audioChunksReceived,
      toolCalls: _counters.gemini.toolCalls,
      reconnects: _counters.gemini.reconnects,
      turnsCompleted: _counters.gemini.turnsCompleted,
    },
    cipher: {
      agentSpawns: _counters.cipher.agentSpawns,
      agentCompletions: _counters.cipher.agentCompletions,
      agentFailures: _counters.cipher.agentFailures,
      activeAgents: _counters.cipher.activeAgents,
    },
    spotify: {
      apiCalls: _counters.spotify.apiCalls,
      tokenRefreshes: _counters.spotify.tokenRefreshes,
      cacheHits: _counters.spotify.cacheHits,
    },
    bridge: {
      wsConnectionsTotal: _counters.bridge.wsConnectionsTotal,
      wsDisconnections: _counters.bridge.wsDisconnections,
      httpRequests: _counters.bridge.httpRequests,
    },
    connectionHistory: _connectionHistory.slice(-20),
  };
}

// ── PostgreSQL flush: upsert daily aggregate metrics ──

async function flushToDb() {
  if (!db.isConnected()) return;

  const date = _today;
  const metrics = [
    ["gemini_sessions", _counters.gemini.sessions],
    ["gemini_session_duration_ms", _counters.gemini.sessionDurationMs],
    ["gemini_audio_chunks_sent", _counters.gemini.audioChunksSent],
    ["gemini_audio_chunks_received", _counters.gemini.audioChunksReceived],
    ["gemini_tool_calls", _counters.gemini.toolCalls],
    ["gemini_reconnects", _counters.gemini.reconnects],
    ["gemini_turns_completed", _counters.gemini.turnsCompleted],
    ["cipher_agent_spawns", _counters.cipher.agentSpawns],
    ["cipher_agent_completions", _counters.cipher.agentCompletions],
    ["cipher_agent_failures", _counters.cipher.agentFailures],
    ["spotify_api_calls", _counters.spotify.apiCalls],
    ["spotify_token_refreshes", _counters.spotify.tokenRefreshes],
    ["spotify_cache_hits", _counters.spotify.cacheHits],
    ["bridge_ws_connections", _counters.bridge.wsConnectionsTotal],
    ["bridge_ws_disconnections", _counters.bridge.wsDisconnections],
    ["bridge_http_requests", _counters.bridge.httpRequests],
  ];

  for (const [name, value] of metrics) {
    try {
      await db.query(
        `INSERT INTO usage_metrics (date, metric_name, metric_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (date, metric_name) DO UPDATE SET metric_value = $3`,
        [date, name, value]
      );
    } catch (err) {
      console.error(`[metrics] flush ${name}: ${err.message}`);
    }
  }
}

// ── History: query last N days from PG ──

async function getHistory(days = 7) {
  if (!db.isConnected()) return [];

  try {
    const res = await db.query(
      `SELECT date, metric_name, metric_value
       FROM usage_metrics
       WHERE date >= CURRENT_DATE - $1::integer
       ORDER BY date DESC, metric_name`,
      [days]
    );

    // Group by date
    const byDate = {};
    for (const row of res.rows) {
      const d = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date);
      if (!byDate[d]) byDate[d] = {};
      byDate[d][row.metric_name] = parseFloat(row.metric_value);
    }

    return Object.entries(byDate)
      .map(([date, metrics]) => ({ date, metrics }))
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch (err) {
    console.error(`[metrics] getHistory: ${err.message}`);
    return [];
  }
}

// ── Start periodic flush (every 5 minutes) ──

function startFlushTimer() {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => {
    flushToDb().catch(err => console.error(`[metrics] periodic flush: ${err.message}`));
  }, 5 * 60 * 1000);
  // Also flush once on startup after a short delay (let PG connect first)
  setTimeout(() => flushToDb().catch(() => {}), 10000);
}

function stopFlushTimer() {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
}

module.exports = {
  // Gemini
  trackGeminiSession,
  trackGeminiSessionEnd,
  trackGeminiAudioSent,
  trackGeminiAudioReceived,
  trackGeminiToolCall,
  trackGeminiTurnComplete,
  trackGeminiReconnect,
  // Cipher
  trackAgentSpawn,
  trackAgentComplete,
  trackAgentFailure,
  setActiveAgents,
  // Spotify
  trackSpotifyApiCall,
  trackSpotifyTokenRefresh,
  trackSpotifyCacheHit,
  // Bridge
  trackWsConnection,
  trackWsDisconnection,
  trackHttpRequest,
  // Queries
  getSnapshot,
  getHistory,
  flushToDb,
  // Lifecycle
  startFlushTimer,
  stopFlushTimer,
};
