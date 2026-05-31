// routes/heartbeat.js — push-based device heartbeat ingest (infra-state D5).
// A device POSTs its OWN view of the world every ~60s; the bridge persists it to
// device_state (live) + device_state_log (transitions). This is the half of the
// infra-state fix that a pull-based probe can't do: a device behind CGNAT / on a
// roaming wifi / temporarily off-VPN reports where it actually is.
//
// Auth: per-device rotatable token (Authorization: Bearer <token> OR x-device-token),
// NOT the global BRIDGE_API_KEY. The token resolves to a device_id with scope
// 'heartbeat:write' (db.verifyDeviceToken). The body's claimed device_id is only
// honored if it matches the token's device_id — a device cannot impersonate another.
"use strict";

module.exports = function heartbeatRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  // simple per-device rate limit: 1 accepted heartbeat / 10s
  const _lastSeen = new Map();
  const MIN_INTERVAL_MS = 10_000;

  function extractToken(req) {
    const auth = req.headers["authorization"] || "";
    if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
    const x = req.headers["x-device-token"];
    return x ? String(x).trim() : "";
  }

  return async function handleHeartbeatRoutes(req, res, pathname /*, url */) {
    if (pathname !== "/heartbeat" && pathname !== "/infra/heartbeat") return false;

    if (req.method !== "POST") {
      sendJSON(res, 405, { ok: false, error: "POST only" }, req);
      return true;
    }
    if (!db || !db.isConnected || !db.isConnected()) {
      sendJSON(res, 503, { ok: false, error: "Database not available" }, req);
      return true;
    }

    // ── Auth: resolve per-device token → device_id ──
    const token = extractToken(req);
    if (!token) {
      sendJSON(res, 401, { ok: false, error: "Missing device token (Authorization: Bearer or x-device-token)" }, req);
      return true;
    }
    let cred;
    try {
      cred = await db.verifyDeviceToken(token, "heartbeat:write");
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: "Auth check failed" }, req);
      return true;
    }
    if (!cred) {
      sendJSON(res, 401, { ok: false, error: "Invalid, revoked, or insufficiently-scoped device token" }, req);
      return true;
    }
    const deviceId = cred.device_id;

    // per-device rate limit
    const now = Date.now();
    const prev = _lastSeen.get(deviceId) || 0;
    if (now - prev < MIN_INTERVAL_MS) {
      sendJSON(res, 429, { ok: false, error: "Too frequent", retry_after_s: Math.ceil((MIN_INTERVAL_MS - (now - prev)) / 1000) }, req);
      return true;
    }

    let body;
    try {
      body = await parseBody(req);
    } catch (e) {
      sendJSON(res, 400, { ok: false, error: "Invalid JSON body" }, req);
      return true;
    }
    body = body || {};

    // The token is the identity. A body device_id is allowed only if it matches.
    if (body.device_id && body.device_id !== deviceId) {
      sendJSON(res, 403, { ok: false, error: "device_id does not match token identity" }, req);
      return true;
    }

    const clamp = (v, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : null;
    };

    const snapshot = {
      device_id: deviceId,
      status: "online",
      source: "heartbeat",
      wifi_ssid: typeof body.wifi_ssid === "string" ? body.wifi_ssid.slice(0, 200) : null,
      lan_ip: typeof body.lan_ip === "string" ? body.lan_ip.slice(0, 64) : null,
      public_ip: typeof body.public_ip === "string" ? body.public_ip.slice(0, 64) : null,
      wg_ip: typeof body.wg_ip === "string" ? body.wg_ip.slice(0, 64) : null,
      wg_handshake_age_s: clamp(body.wg_handshake_age_s, 0, 31_536_000),
      battery_pct: clamp(body.battery_pct, 0, 100),
      meta: body.meta && typeof body.meta === "object" ? body.meta : null,
      last_seen: null, // db defaults to NOW()
    };

    let result;
    try {
      result = await db.upsertDeviceState(snapshot);
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: "Persist failed", detail: e.message }, req);
      return true;
    }
    _lastSeen.set(deviceId, now);

    // ── Notify on noteworthy transitions (roam / drop / first-seen / IP change) ──
    const changes = (result && result.changed) || [];
    if (changes.length && changes.some(c => c !== "first_seen")) {
      try {
        ctx.sendNotification({
          title: `📡 ${deviceId} ${changes.join(", ")}`,
          body: `ssid=${snapshot.wifi_ssid || "?"} lan=${snapshot.lan_ip || "?"} public=${snapshot.public_ip || "?"}`,
          tag: `infra-${deviceId}`,
        });
      } catch { /* notifications are best-effort */ }
      try { ctx.broadcastToAll({ type: "device_state_change", device_id: deviceId, changes, snapshot }); } catch {}
    }

    sendJSON(res, 200, { ok: true, device_id: deviceId, changes }, req);
    return true;
  };
};
