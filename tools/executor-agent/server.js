#!/usr/bin/env node
// Lightweight executor agent for dev-01.
//
// Replaces the bridge's SSH-per-command pattern with HTTP keep-alive.
// One TCP connection from bridge → dev-01 carries hundreds of POST /exec.
//
// Listens on $EXEC_AGENT_HOST:$EXEC_AGENT_PORT (default 10.9.0.5:8888 — WG addr).
// Auth: Bearer token from $EXEC_AGENT_TOKEN (shared with bridge).
//
// Endpoints:
//   GET  /health                → { ok, uptime, in_flight }
//   POST /exec  { command, timeout_seconds?, engagement_id? }
//                             → { exit_code, stdout, stderr, duration_ms, timed_out }

const http  = require("http");
const { spawn } = require("child_process");

const HOST = process.env.EXEC_AGENT_HOST || "10.9.0.5";
const PORT = parseInt(process.env.EXEC_AGENT_PORT || "8888", 10);
const TOKEN = process.env.EXEC_AGENT_TOKEN || "";
const DEFAULT_TIMEOUT_S = parseInt(process.env.EXEC_AGENT_DEFAULT_TIMEOUT || "300", 10);
const MAX_TIMEOUT_S = parseInt(process.env.EXEC_AGENT_MAX_TIMEOUT || "900", 10);
const MAX_OUTPUT_BYTES = parseInt(process.env.EXEC_AGENT_MAX_OUTPUT || "1048576", 10); // 1 MiB

if (!TOKEN) {
  console.error("[exec-agent] FATAL: EXEC_AGENT_TOKEN env var not set.");
  process.exit(1);
}

const startedAt = Date.now();
let inFlight = 0;
let totalServed = 0;

function jsend(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Connection": "keep-alive",
  });
  res.end(body);
}

function requireAuth(req, res) {
  const h = req.headers.authorization || "";
  const expect = "Bearer " + TOKEN;
  if (h.length !== expect.length) { jsend(res, 401, { error: "auth required" }); return false; }
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) { jsend(res, 401, { error: "auth required" }); return false; }
  return true;
}

function execOne(command, timeoutSec) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let killed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
    }, timeoutSec * 1000);

    child.stdout.on("data", (chunk) => {
      const space = MAX_OUTPUT_BYTES - stdout.length;
      if (space <= 0) return;
      stdout = Buffer.concat([stdout, chunk.subarray(0, Math.min(chunk.length, space))]);
    });
    child.stderr.on("data", (chunk) => {
      const space = MAX_OUTPUT_BYTES - stderr.length;
      if (space <= 0) return;
      stderr = Buffer.concat([stderr, chunk.subarray(0, Math.min(chunk.length, space))]);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        signal: signal || null,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        duration_ms: Date.now() - t0,
        timed_out: timedOut,
        killed,
        truncated: stdout.length >= MAX_OUTPUT_BYTES || stderr.length >= MAX_OUTPUT_BYTES,
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        exit_code: -1,
        signal: null,
        stdout: "",
        stderr: `spawn error: ${e.message}`,
        duration_ms: Date.now() - t0,
        timed_out: false,
        killed: false,
        truncated: false,
      });
    });

    child.stdin.write(command);
    child.stdin.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return jsend(res, 200, {
      ok: true,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      in_flight: inFlight,
      total_served: totalServed,
      host: HOST,
      port: PORT,
    });
  }

  if (req.method === "POST" && req.url === "/exec") {
    if (!requireAuth(req, res)) return;
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); }
      catch (e) { return jsend(res, 400, { error: "invalid JSON body" }); }
      const command = payload.command;
      if (typeof command !== "string" || !command.trim()) {
        return jsend(res, 400, { error: "command (string) required" });
      }
      let timeoutSec = parseInt(payload.timeout_seconds || DEFAULT_TIMEOUT_S, 10);
      if (isNaN(timeoutSec) || timeoutSec <= 0) timeoutSec = DEFAULT_TIMEOUT_S;
      if (timeoutSec > MAX_TIMEOUT_S) timeoutSec = MAX_TIMEOUT_S;

      inFlight++;
      try {
        const result = await execOne(command, timeoutSec);
        totalServed++;
        jsend(res, 200, {
          ok: true,
          engagement_id: payload.engagement_id || null,
          ...result,
        });
      } catch (e) {
        jsend(res, 500, { error: e.message });
      } finally {
        inFlight--;
      }
    });
    return;
  }

  jsend(res, 404, { error: "not found" });
});

server.keepAliveTimeout = 60 * 1000;
server.headersTimeout = 65 * 1000;

server.listen(PORT, HOST, () => {
  console.log(`[exec-agent] listening on http://${HOST}:${PORT}`);
  console.log(`[exec-agent] default timeout=${DEFAULT_TIMEOUT_S}s max=${MAX_TIMEOUT_S}s, max output=${MAX_OUTPUT_BYTES}B`);
});

process.on("SIGTERM", () => { console.log("[exec-agent] SIGTERM — shutting down"); server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { console.log("[exec-agent] SIGINT — shutting down");  server.close(() => process.exit(0)); });
