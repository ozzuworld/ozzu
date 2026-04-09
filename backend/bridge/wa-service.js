// wa-service.js — WhatsApp proxy to Android agent
// Forwards all WA calls to the Android agent via SSH reverse tunnel on port 8766.

"use strict";

const http = require("http");

const AGENT_PORT = 8766; // GCP:8766 → Android:8765 via autossh reverse tunnel

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: "127.0.0.1",
      port: AGENT_PORT,
      path,
      method,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function normalizePhone(phone) {
  return String(phone).replace(/\D/g, "");
}

module.exports = {
  normalizePhone,

  async connect() {
    // No-op: Android agent manages its own connection
  },

  status() {
    // Returns sync-ish status; caller may not await so we return last known
    return { status: "android_agent", note: "Connected via Android tunnel on port 8766" };
  },

  qr() {
    return null; // QR managed on Android
  },

  async send(to, message) {
    const phone = normalizePhone(to);
    const result = await request("POST", "/send", { phone, message });
    if (result.error) throw new Error(result.error);
    return { ok: true };
  },

  getMessages(phone, limit = 50) {
    // Sync call not possible; return empty, MCP tool uses async read_whatsapp
    return [];
  },

  async readMessages(phone) {
    const p = normalizePhone(phone);
    const result = await request("GET", `/messages/${p}`);
    return result.messages || [];
  },

  pause(phone) {
    const p = normalizePhone(phone);
    request("POST", "/pause", { phone: p }).catch(() => {});
  },

  resume(phone) {
    const p = normalizePhone(phone);
    request("POST", "/resume", { phone: p }).catch(() => {});
  },

  async notifyHuman(phone, reason, preview) {
    this.pause(phone);
    return { notified: true, reason };
  },
};
