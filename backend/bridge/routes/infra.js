// routes/infra.js — HTTP endpoints for infrastructure state
"use strict";

module.exports = function infraRoutes(ctx) {
  const { sendJSON } = ctx;
  const infraMonitor = (() => { try { return require("../infra-monitor"); } catch { return null; } })();

  return async function handleInfraRoutes(req, res, pathname, url) {

    // GET /infra/state — full infra state (cached)
    if (req.method === "GET" && pathname === "/infra/state") {
      if (!infraMonitor) { sendJSON(res, 500, { error: "Infra monitor not available" }); return true; }
      const refresh = url.searchParams.get("refresh") === "true";
      const state = refresh ? infraMonitor.refresh() : infraMonitor.getState();
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

    return false;
  };
};
