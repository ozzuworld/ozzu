// mcp-proxy.js — Upstream MCP client for SSE and Streamable HTTP transports
// Manages persistent connections to upstream MCP servers and forwards JSON-RPC
"use strict";

const http = require("http");
const https = require("https");
const { EventEmitter } = require("events");

const UPSTREAMS = {
  "gmail-personal": { transport: "http", url: "http://localhost:8000/mcp" },
  "gmail-ozzu":     { transport: "http", url: "http://localhost:8001/mcp" },
};

// ── SSE Client for WhatsApp MCP ──
class SSEUpstream extends EventEmitter {
  constructor(name, sseUrl) {
    super();
    this.name = name;
    this.sseUrl = sseUrl;
    this.messageEndpoint = null;
    this.pendingRequests = new Map(); // id → { resolve, timer }
    this.sseConnection = null;
    this.connecting = false;
    this.connected = false;
    this.reconnectTimer = null;
    this._initialized = false;
  }

  async ensureConnected() {
    if (this.connected && this.messageEndpoint) return;
    if (this.connecting) {
      // Wait for existing connection attempt
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("SSE connection timeout")), 15000);
        this.once("connected", () => { clearTimeout(timeout); resolve(); });
        this.once("error", (e) => { clearTimeout(timeout); reject(e); });
      });
    }
    this.connecting = true;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.connecting = false;
        reject(new Error(`SSE connection to ${this.name} timed out`));
      }, 15000);

      const parsed = new URL(this.sseUrl);
      const client = parsed.protocol === "https:" ? https : http;

      this.sseConnection = client.get(this.sseUrl, { headers: { Accept: "text/event-stream" } }, (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timeout);
          this.connecting = false;
          reject(new Error(`SSE ${this.name}: HTTP ${res.statusCode}`));
          return;
        }

        let buffer = "";
        let currentEvent = null;
        let currentData = "";

        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete line

          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, ""); // strip \r from \r\n
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              currentData += (currentData ? "\n" : "") + line.slice(6);
            } else if (line === "") {
              // End of event
              if (currentEvent === "endpoint" && currentData) {
                // Parse endpoint — may be relative or absolute
                let endpoint = currentData.trim();
                if (endpoint.startsWith("/")) {
                  const base = new URL(this.sseUrl);
                  endpoint = `${base.protocol}//${base.host}${endpoint}`;
                }
                this.messageEndpoint = endpoint;
                this.connected = true;
                this.connecting = false;
                clearTimeout(timeout);
                this.emit("connected");
                resolve();
              } else if (currentEvent === "message" && currentData) {
                try {
                  const msg = JSON.parse(currentData);
                  if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
                    const pending = this.pendingRequests.get(msg.id);
                    clearTimeout(pending.timer);
                    this.pendingRequests.delete(msg.id);
                    pending.resolve(msg);
                  }
                } catch (e) { /* ignore parse errors */ }
              }
              currentEvent = null;
              currentData = "";
            }
          }
        });

        res.on("end", () => {
          this.connected = false;
          this.messageEndpoint = null;
          this.scheduleReconnect();
        });

        res.on("error", (e) => {
          this.connected = false;
          this.messageEndpoint = null;
          this.scheduleReconnect();
        });
      });

      this.sseConnection.on("error", (e) => {
        clearTimeout(timeout);
        this.connecting = false;
        reject(new Error(`SSE ${this.name} connection failed: ${e.message}`));
      });
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(() => {});
    }, 3000);
  }

  async ensureInitialized() {
    if (this._initialized) return;
    await this.ensureConnected();
    // Send MCP initialize handshake
    const initResult = await this._rawForward({
      jsonrpc: "2.0", id: -1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bridge-proxy", version: "1.0" } },
    });
    this._initialized = true;
  }

  async forward(jsonRpcBody) {
    await this.ensureInitialized();
    if (!this.messageEndpoint) throw new Error(`No message endpoint for ${this.name}`);

    return this._rawForward(jsonRpcBody);
  }

  async _rawForward(jsonRpcBody) {
    await this.ensureConnected();
    if (!this.messageEndpoint) throw new Error(`No message endpoint for ${this.name}`);

    const id = jsonRpcBody.id;
    const body = JSON.stringify(jsonRpcBody);
    const parsed = new URL(this.messageEndpoint);
    const client = parsed.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
      // Register pending request listener for response via SSE
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`SSE request to ${this.name} timed out (60s)`));
      }, 60000);

      this.pendingRequests.set(id, { resolve, timer });

      const req = client.request(this.messageEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, (res) => {
        // POST response is typically 202 Accepted for SSE transport
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          if (res.statusCode >= 400) {
            clearTimeout(timer);
            this.pendingRequests.delete(id);
            reject(new Error(`SSE POST ${this.name}: HTTP ${res.statusCode} — ${d}`));
          }
          // For SSE transport, actual response comes via the SSE stream, not the POST response
          // But some implementations return the result directly — handle both
          if (d && res.statusCode === 200) {
            try {
              const parsed = JSON.parse(d);
              if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
                clearTimeout(timer);
                this.pendingRequests.delete(id);
                resolve(parsed);
              }
            } catch { /* response comes via SSE */ }
          }
        });
      });
      req.on("error", (e) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(e);
      });
      req.write(body);
      req.end();
    });
  }

  destroy() {
    if (this.sseConnection) { this.sseConnection.destroy(); this.sseConnection = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: "Connection closed" } });
    }
    this.pendingRequests.clear();
    this.connected = false;
    this.messageEndpoint = null;
  }
}

// ── Streamable HTTP client for Gmail MCP ──
class HTTPUpstream {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.sessionId = null;
    this.initialized = false;
  }

  async forward(jsonRpcBody) {
    const body = JSON.stringify(jsonRpcBody);
    const parsed = new URL(this.url);
    const client = parsed.protocol === "https:" ? https : http;

    // Auto-initialize on first request
    if (!this.initialized && jsonRpcBody.method !== "initialize") {
      await this._initialize(client);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`HTTP request to ${this.name} timed out (60s)`)), 60000);

      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Accept": "application/json, text/event-stream",
      };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

      const req = client.request(this.url, { method: "POST", headers }, (res) => {
        // Track session ID
        const sid = res.headers["mcp-session-id"];
        if (sid) this.sessionId = sid;

        const contentType = res.headers["content-type"] || "";

        if (contentType.includes("text/event-stream")) {
          // Parse SSE response
          let buffer = "";
          let result = null;
          res.on("data", (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop();
            for (const rawLine of lines) {
              const line = rawLine.replace(/\r$/, "");
              if (line.startsWith("data: ")) {
                try {
                  const msg = JSON.parse(line.slice(6));
                  // For JSON-RPC responses, match by id
                  if (msg.id !== undefined && msg.id === jsonRpcBody.id) result = msg;
                  // Also capture notifications / results without id matching
                  if (msg.result !== undefined && result === null) result = msg;
                } catch { /* skip */ }
              }
            }
          });
          res.on("end", () => {
            clearTimeout(timer);
            if (result) resolve(result);
            else reject(new Error(`SSE response from ${this.name} had no matching result`));
          });
        } else {
          // Plain JSON response
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => {
            clearTimeout(timer);
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${this.name}: ${res.statusCode} — ${d}`));
              return;
            }
            try { resolve(JSON.parse(d)); }
            catch { reject(new Error(`Invalid JSON from ${this.name}: ${d.slice(0, 200)}`)); }
          });
        }
      });

      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.write(body);
      req.end();
    });
  }

  async _initialize(client) {
    try {
      const initBody = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "ozzu-bridge-proxy", version: "1.0.0" },
      }});
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("init timeout")), 10000);
        const headers = {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(initBody),
          "Accept": "application/json, text/event-stream",
        };
        if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

        const req = client.request(this.url, { method: "POST", headers }, (res) => {
          const sid = res.headers["mcp-session-id"];
          if (sid) this.sessionId = sid;
          const ct = res.headers["content-type"] || "";
          if (ct.includes("text/event-stream")) {
            let buf = "", result = null;
            res.on("data", c => { buf += c.toString(); const lines = buf.split("\n"); buf = lines.pop();
              for (const rl of lines) { const l = rl.replace(/\r$/, ""); if (l.startsWith("data: ")) try { result = JSON.parse(l.slice(6)); } catch {} }
            });
            res.on("end", () => { clearTimeout(timer); resolve(result || {}); });
          } else {
            let d = "";
            res.on("data", c => d += c);
            res.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(d)); } catch { resolve({}); } });
          }
        });
        req.on("error", e => { clearTimeout(timer); reject(e); });
        req.write(initBody); req.end();
      });

      // Send initialized notification
      const notifyBody = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      await new Promise((resolve) => {
        const headers = {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(notifyBody),
        };
        if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
        const req = client.request(this.url, { method: "POST", headers }, (res) => {
          res.resume(); res.on("end", resolve);
        });
        req.on("error", resolve);
        req.write(notifyBody); req.end();
      });

      this.initialized = true;
    } catch (e) {
      // Non-fatal — some servers don't require initialize
      this.initialized = true;
    }
  }

  destroy() {
    this.sessionId = null;
    this.initialized = false;
  }
}

// ── Upstream manager ──
const upstreamInstances = {};

function getUpstream(serverName) {
  if (upstreamInstances[serverName]) return upstreamInstances[serverName];
  const config = UPSTREAMS[serverName];
  if (!config) return null;

  if (config.transport === "sse") {
    upstreamInstances[serverName] = new SSEUpstream(serverName, config.url);
  } else {
    upstreamInstances[serverName] = new HTTPUpstream(serverName, config.url);
  }
  return upstreamInstances[serverName];
}

function destroyAll() {
  for (const inst of Object.values(upstreamInstances)) inst.destroy();
  Object.keys(upstreamInstances).forEach(k => delete upstreamInstances[k]);
}

module.exports = { UPSTREAMS, getUpstream, destroyAll };
