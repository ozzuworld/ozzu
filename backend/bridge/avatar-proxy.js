// avatar-proxy.js — Bridges the Lightning.ai GPU inference server to app clients
// GPU runs MuseTalk lip-sync, sends JPEG frames over WS.
// This proxy relays GPU frames → app, and app text/audio → GPU.
"use strict";

const WebSocket = require("ws");

const GPU_WS_URL = process.env.AVATAR_GPU_URL || "";
const RECONNECT_DELAY_MS = 5000;
const HEALTH_INTERVAL_MS = 30000;

let gpuWs = null;
let gpuAlive = false;
const appClients = new Set();
let reconnectTimer = null;
let healthTimer = null;
let lastFrameTime = 0;
const MIN_FRAME_INTERVAL_MS = 80; // ~12fps max to app (lip sync doesn't need more)

function connectGpu() {
  if (!GPU_WS_URL) return;
  if (gpuWs && gpuWs.readyState === WebSocket.OPEN) return;

  const wsUrl = GPU_WS_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  const url = wsUrl.endsWith("/ws/avatar") ? wsUrl : wsUrl.replace(/\/$/, "") + "/ws/avatar";

  console.log(`[AvatarProxy] Connecting to GPU: ${url}`);
  gpuWs = new WebSocket(url);

  gpuWs.on("open", () => {
    console.log("[AvatarProxy] GPU connected");
    gpuAlive = true;
  });

  gpuWs.on("message", (data) => {
    if (appClients.size === 0) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length > 0 && buf[0] === 0x56) {
      const now = Date.now();
      if (now - lastFrameTime < MIN_FRAME_INTERVAL_MS) return;
      lastFrameTime = now;
    }
    for (const client of appClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  });

  gpuWs.on("close", () => {
    console.log("[AvatarProxy] GPU disconnected");
    gpuAlive = false;
    gpuWs = null;
    scheduleReconnect();
  });

  gpuWs.on("error", (e) => {
    console.error(`[AvatarProxy] GPU error: ${e.message}`);
    gpuAlive = false;
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectGpu();
  }, RECONNECT_DELAY_MS);
}

function handleAppClient(ws) {
  appClients.add(ws);
  console.log(`[AvatarProxy] App client connected (${appClients.size} total)`);

  // Auto-connect to GPU on first client
  if (!gpuAlive && GPU_WS_URL) connectGpu();

  ws.on("message", (data) => {
    // Forward app messages to GPU (text commands, audio chunks)
    if (gpuWs && gpuWs.readyState === WebSocket.OPEN) {
      gpuWs.send(data);
    }
  });

  ws.on("close", () => {
    appClients.delete(ws);
    console.log(`[AvatarProxy] App client disconnected (${appClients.size} total)`);
  });

  ws.on("error", () => {
    appClients.delete(ws);
  });

  // Send initial status
  ws.send(JSON.stringify({ type: "status", gpu_connected: gpuAlive }));
}

// Send text to GPU for avatar to speak (called from june-voice.js)
function sendText(text) {
  if (gpuWs && gpuWs.readyState === WebSocket.OPEN) {
    gpuWs.send(JSON.stringify({ type: "echo", text }));
    return true;
  }
  return false;
}

// Send raw PCM audio to GPU for lip-sync (called from june-voice.js)
function sendAudio(pcmBuffer) {
  if (gpuWs && gpuWs.readyState === WebSocket.OPEN) {
    const frame = Buffer.alloc(1 + pcmBuffer.length);
    frame[0] = 0x41; // 'A'
    pcmBuffer.copy(frame, 1);
    gpuWs.send(frame);
    return true;
  }
  return false;
}

function getStatus() {
  return {
    gpu_connected: gpuAlive,
    gpu_url: GPU_WS_URL || "(not configured)",
    app_clients: appClients.size,
  };
}

// Health check loop
function startHealthCheck() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    if (!GPU_WS_URL) return;
    try {
      const healthUrl = GPU_WS_URL.replace(/\/$/, "") + "/health";
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok && !gpuAlive) {
        console.log("[AvatarProxy] GPU health OK, reconnecting WS");
        connectGpu();
      }
    } catch { /* GPU unreachable, will retry */ }
  }, HEALTH_INTERVAL_MS);
}

// Auto-connect on load if URL configured
if (GPU_WS_URL) {
  connectGpu();
  startHealthCheck();
}

module.exports = { handleAppClient, sendText, sendAudio, getStatus };
