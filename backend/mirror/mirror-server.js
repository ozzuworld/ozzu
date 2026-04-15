#!/usr/bin/env node
/**
 * Standalone device mirror server.
 * Streams device screenshots over WebSocket using async child_process.
 * Runs independently from the bridge — no event loop contention.
 *
 * Usage: node mirror-server.js [port]
 * Default port: 3340
 *
 * Clients connect via WebSocket: ws://localhost:3340/mirror?device=localhost:5560&fps=5
 * Frames are sent as binary PNG data.
 */

const http = require("http");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const fs = require("fs");

const PORT = parseInt(process.env.MIRROR_PORT || process.argv[2] || "3340");
const ADB = fs.existsSync("/app/adb") ? "/app/adb" : "adb";
const MAX_FPS = 10;
const CAPTURE_TIMEOUT = 4000;

// Track active streams: device -> { clients, timer, capturing, lastFrame }
const streams = new Map();

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`${ts} [mirror] ${msg}`);
}

// Async screencap — does NOT block the event loop
function captureFrame(device) {
  return new Promise((resolve, reject) => {
    execFile(ADB, ["-s", device, "exec-out", "screencap", "-p"], {
      timeout: CAPTURE_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "buffer",
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

function startStream(device, fps) {
  if (streams.has(device) && streams.get(device).timer) return;

  const stream = streams.get(device) || { clients: new Set(), timer: null, capturing: false, lastFrame: null };
  streams.set(device, stream);

  const intervalMs = Math.max(Math.floor(1000 / Math.min(fps, MAX_FPS)), 100);

  stream.timer = setInterval(async () => {
    if (stream.capturing || stream.clients.size === 0) return;
    stream.capturing = true;
    try {
      const png = await captureFrame(device);
      stream.lastFrame = png;
      for (const ws of stream.clients) {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(png);
        }
      }
    } catch (e) {
      // Silent — device may be temporarily unreachable
    }
    stream.capturing = false;
  }, intervalMs);

  log(`streaming ${device} @ ${fps}fps (${intervalMs}ms interval)`);
}

function stopStream(device) {
  const stream = streams.get(device);
  if (!stream) return;
  if (stream.clients.size === 0 && stream.timer) {
    clearInterval(stream.timer);
    stream.timer = null;
    stream.lastFrame = null;
    log(`stopped streaming ${device} (no clients)`);
  }
}

// HTTP server — health check only
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    const info = {};
    for (const [device, stream] of streams) {
      info[device] = { clients: stream.clients.size, active: !!stream.timer };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", streams: info }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Support both ?device=localhost:5560 and ?port=5560 (backward compat with TV app)
  const portParam = url.searchParams.get("port");
  const device = url.searchParams.get("device") || (portParam ? `localhost:${portParam}` : "localhost:5560");
  const fps = Math.min(parseInt(url.searchParams.get("fps") || "5"), MAX_FPS);

  log(`client connected for ${device} @ ${fps}fps`);

  // Register client
  if (!streams.has(device)) {
    streams.set(device, { clients: new Set(), timer: null, capturing: false, lastFrame: null });
  }
  const stream = streams.get(device);
  stream.clients.add(ws);

  // Send last frame immediately if available
  if (stream.lastFrame && ws.readyState === 1) {
    ws.send(stream.lastFrame);
  }

  // Start streaming
  startStream(device, fps);

  ws.on("close", () => {
    stream.clients.delete(ws);
    log(`client disconnected from ${device} (${stream.clients.size} remaining)`);
    stopStream(device);
  });

  ws.on("error", () => {
    stream.clients.delete(ws);
    stopStream(device);
  });
});

server.listen(PORT, () => {
  log(`listening on port ${PORT}`);
  log(`connect: ws://localhost:${PORT}/mirror?device=localhost:5560&fps=5`);
});
