// routes/infra.js — HTTP endpoints for infrastructure state
"use strict";
const fs = require("fs");
const path = require("path");

module.exports = function infraRoutes(ctx) {
  const { sendJSON } = ctx;
  const infraMonitor = (() => { try { return require("../infra-monitor"); } catch { return null; } })();

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
      const wgFile = path.join(__dirname, "..", "..", "..", "data", "infra", "wg-state.json");
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

    return false;
  };
};
