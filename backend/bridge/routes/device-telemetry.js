// routes/device-telemetry.js — rich device telemetry ingest (dir_1782487057792).
// Replaces the thin heartbeat with a full device profile: identity (static), vitals
// (fast-tier 60s), system (medium 5m), inventory (slow 30m). Same per-device token
// auth as /heartbeat. The old /heartbeat endpoint stays for backward compat.
"use strict";

module.exports = function deviceTelemetryRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  const _lastSeen = new Map();
  const MIN_INTERVAL_MS = 10_000;

  function extractToken(req) {
    const auth = req.headers["authorization"] || "";
    if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
    const x = req.headers["x-device-token"];
    return x ? String(x).trim() : "";
  }

  return async function handleDeviceTelemetry(req, res, pathname) {
    if (pathname !== "/api/device-telemetry") return false;
    if (req.method !== "POST") {
      sendJSON(res, 405, { ok: false, error: "POST only" }, req);
      return true;
    }
    if (!db || !db.isConnected || !db.isConnected()) {
      sendJSON(res, 503, { ok: false, error: "Database not available" }, req);
      return true;
    }

    // ── Auth ──
    const token = extractToken(req);
    if (!token) {
      sendJSON(res, 401, { ok: false, error: "Missing device token" }, req);
      return true;
    }
    let cred;
    try {
      cred = await db.verifyDeviceToken(token, "heartbeat:write");
    } catch {
      sendJSON(res, 500, { ok: false, error: "Auth check failed" }, req);
      return true;
    }
    if (!cred) {
      sendJSON(res, 401, { ok: false, error: "Invalid or revoked device token" }, req);
      return true;
    }
    const deviceId = cred.device_id;

    // Rate limit
    const now = Date.now();
    const prev = _lastSeen.get(deviceId) || 0;
    if (now - prev < MIN_INTERVAL_MS) {
      sendJSON(res, 429, { ok: false, error: "Too frequent" }, req);
      return true;
    }

    let body;
    try {
      body = await parseBody(req);
    } catch {
      sendJSON(res, 400, { ok: false, error: "Invalid JSON body" }, req);
      return true;
    }
    if (!body || typeof body !== "object") {
      sendJSON(res, 400, { ok: false, error: "Body must be a JSON object" }, req);
      return true;
    }

    _lastSeen.set(deviceId, now);
    const results = { inventory: false, state: false, snapshot: false };

    try {
      // 1. Identity → device_inventory (static, sent on boot or change)
      if (body.identity && typeof body.identity === "object") {
        await db.upsertDeviceInventory(deviceId, body.identity);
        results.inventory = true;
      }

      // 2. Vitals → device_state (backward-compat fields + rich telemetry JSONB)
      const v = body.vitals || {};
      const net = v.network || {};
      const wifi = net.wifi || {};
      const batt = v.battery || {};
      const clamp = (val, lo, hi) => {
        const n = Number(val);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : null;
      };

      const stateSnapshot = {
        device_id: deviceId,
        status: "online",
        source: "telemetry-v2",
        wifi_ssid: wifi.ssid || null,
        lan_ip: net.lan_ip || null,
        public_ip: net.public_ip || null,
        wg_ip: net.wg_ip || null,
        wg_handshake_age_s: clamp(net.wg_handshake_age_s, 0, 31_536_000),
        battery_pct: clamp(batt.pct, 0, 100),
        meta: body.meta || null,
      };
      await db.upsertDeviceState(stateSnapshot);

      // Store the full telemetry blob as latest on device_state
      const telemetryBlob = {};
      if (v.cpu) telemetryBlob.cpu = v.cpu;
      if (v.memory) telemetryBlob.memory = v.memory;
      if (v.battery) telemetryBlob.battery = v.battery;
      if (v.thermal) telemetryBlob.thermal = v.thermal;
      if (v.network) telemetryBlob.network = v.network;
      if (v.uptime_s != null) telemetryBlob.uptime_s = v.uptime_s;
      if (body.system) telemetryBlob.system = body.system;
      if (body.inventory_data) telemetryBlob.inventory_data = body.inventory_data;
      telemetryBlob._collected_at = new Date().toISOString();

      await db.updateDeviceTelemetry(deviceId, telemetryBlob);
      results.state = true;

      // 3. Periodic snapshot (throttled to every 5 min in db layer)
      await db.insertTelemetrySnapshot(deviceId, telemetryBlob);
      results.snapshot = true;
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: "Persist failed", detail: e.message }, req);
      return true;
    }

    // Broadcast state change for live UI
    try {
      ctx.broadcastToAll({ type: "device_telemetry", device_id: deviceId, tier: body.tier || "fast" });
    } catch { /* best-effort */ }

    sendJSON(res, 200, { ok: true, device_id: deviceId, results }, req);
    return true;
  };
};
