// routes/infra.js — HTTP endpoints for infrastructure state
"use strict";
const fs = require("fs");
const path = require("path");

module.exports = function infraRoutes(ctx) {
  const { sendJSON, db } = ctx;
  const infraMonitor = (() => { try { return require("../infra-monitor"); } catch { return null; } })();

  // Parse ?since= as "24h" / "30m" / "7d" / ISO into a timestamptz string, like ops.js.
  function parseSince(raw) {
    if (!raw) return null;
    const m = /^(\d+)\s*([hdm])$/i.exec(raw.trim());
    if (m) {
      const n = parseInt(m[1], 10);
      const ms = m[2].toLowerCase() === "h" ? 3600e3 : m[2].toLowerCase() === "d" ? 86400e3 : 60e3;
      return new Date(Date.now() - n * ms).toISOString();
    }
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  return async function handleInfraRoutes(req, res, pathname, url) {

    // GET /infra/state — full infra state (cached)
    if (req.method === "GET" && pathname === "/infra/state") {
      if (!infraMonitor) { sendJSON(res, 500, { error: "Infra monitor not available" }); return true; }
      const refresh = url.searchParams.get("refresh") === "true";
      const state = refresh ? await infraMonitor.refresh() : infraMonitor.getState();
      sendJSON(res, 200, state || { error: "No state yet" });
      return true;
    }

    // GET /infra/devices — just device reachability
    if (req.method === "GET" && pathname === "/infra/devices") {
      if (!infraMonitor) { sendJSON(res, 500, { error: "Infra monitor not available" }); return true; }
      const state = infraMonitor.getState();
      sendJSON(res, 200, { devices: state?.devices, esp32Nodes: state?.esp32Nodes, timestamp: state?.timestamp });
      return true;
    }

    // GET /infra/network — just network topology
    if (req.method === "GET" && pathname === "/infra/network") {
      if (!infraMonitor) { sendJSON(res, 500, { error: "Infra monitor not available" }); return true; }
      const state = infraMonitor.getState();
      sendJSON(res, 200, { network: state?.network, timestamp: state?.timestamp });
      return true;
    }

    // GET /infra/wg — live WireGuard peer state (handshake age, endpoint, status).
    // Source: scripts/wg-state-poller.sh writes data/infra/wg-state.json on the
    // HOST every 60s (the bridge container has no `wg` binary). We just read it.
    if (req.method === "GET" && pathname === "/infra/wg") {
      const wgFile = "/home/gcp/ozzu/data/infra/wg-state.json";
      let data;
      try {
        data = JSON.parse(fs.readFileSync(wgFile, "utf8"));
      } catch (e) {
        sendJSON(res, 200, { error: "wg state not available yet", detail: e.code || String(e.message || e), peers: [] });
        return true;
      }
      const nowS = Math.floor(Date.now() / 1000);
      const fileAgeS = data.generated_at ? nowS - data.generated_at : null;
      sendJSON(res, 200, {
        interface: data.interface || "wg0",
        generated_at: data.generated_at || null,
        file_age_s: fileAgeS,
        poller_fresh: fileAgeS !== null && fileAgeS <= 150,
        peer_count: (data.peers || []).length,
        peers: data.peers || [],
      });
      return true;
    }

    // GET /infra/devices/:id/history?since=24h — roam/drop/IP-change timeline (D7)
    {
      const m = /^\/infra\/devices\/([^/]+)\/history$/.exec(pathname);
      if (req.method === "GET" && m) {
        if (!db || !db.isConnected || !db.isConnected()) { sendJSON(res, 503, { error: "Database not available" }, req); return true; }
        const deviceId = decodeURIComponent(m[1]);
        const since = parseSince(url.searchParams.get("since"));
        let limit = parseInt(url.searchParams.get("limit") || "100", 10);
        if (isNaN(limit) || limit < 1) limit = 100;
        if (limit > 500) limit = 500;
        try {
          const rows = await db.getDeviceHistory(deviceId, { since, limit });
          sendJSON(res, 200, { device_id: deviceId, since: since || null, count: rows.length, history: rows }, req);
        } catch (e) {
          sendJSON(res, 500, { error: "history query failed", detail: e.message }, req);
        }
        return true;
      }
    }

    // GET /infra/heartbeats — persisted per-device state from heartbeats (D7).
    // Survives bridge restarts (unlike infra-monitor's in-memory probe state).
    if (req.method === "GET" && pathname === "/infra/heartbeats") {
      if (!db || !db.isConnected || !db.isConnected()) { sendJSON(res, 503, { error: "Database not available" }, req); return true; }
      try {
        const rows = await db.getDeviceStates();
        const nowMs = Date.now();
        const STALE_MS = 150_000; // 2.5× the 60s heartbeat interval
        const devices = rows.map(r => {
          const lastSeenMs = r.last_seen ? new Date(r.last_seen).getTime() : null;
          const ageS = lastSeenMs ? Math.round((nowMs - lastSeenMs) / 1000) : null;
          // Pull-side safety net: a device that stopped pushing is offline even if
          // its last stored status says "online" (the lockdown-killswitch case).
          const effectiveStatus = (lastSeenMs && nowMs - lastSeenMs > STALE_MS) ? "offline" : r.status;
          return { ...r, last_seen_age_s: ageS, effective_status: effectiveStatus };
        });
        sendJSON(res, 200, { count: devices.length, devices }, req);
      } catch (e) {
        sendJSON(res, 500, { error: "device_state query failed", detail: e.message }, req);
      }
      return true;
    }

    return false;
  };
};
