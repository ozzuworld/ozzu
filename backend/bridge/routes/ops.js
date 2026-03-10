// routes/ops.js — Service health & observability endpoints

"use strict";

const watchdog = require("../watchdog");

module.exports = function opsRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  return async function handleOpsRoutes(req, res, pathname, url) {

    // GET /ops/status — Current status of all services
    if (req.method === "GET" && pathname === "/ops/status") {
      const status = watchdog.getStatus();
      sendJSON(res, 200, { ok: true, services: status, ts: new Date().toISOString() });
      return true;
    }

    // GET /ops/incidents — Recent incidents
    if (req.method === "GET" && pathname === "/ops/incidents") {
      const limitParam = url.searchParams.get("limit");
      const since = url.searchParams.get("since");
      let limit = limitParam ? parseInt(limitParam, 10) : 50;
      if (isNaN(limit) || limit < 1) limit = 50;
      if (limit > 200) limit = 200;

      // If "since" param, query DB for richer history
      if (since && db) {
        try {
          let interval = "1 hour";
          const m = since.match(/^(\d+)(h|d|m)$/);
          if (m) {
            const val = parseInt(m[1], 10);
            const unit = m[2] === "h" ? "hours" : m[2] === "d" ? "days" : "minutes";
            interval = `${val} ${unit}`;
          }
          const result = await db.query(
            `SELECT id, service, from_status, to_status, details, started_at, resolved_at
             FROM service_incidents
             WHERE started_at > NOW() - $1::interval
             ORDER BY started_at DESC
             LIMIT $2`,
            [interval, limit]
          );
          sendJSON(res, 200, { ok: true, incidents: result.rows, source: "db" });
          return true;
        } catch (err) {
          // Fall through to in-memory
        }
      }

      const incidents = watchdog.getIncidents(limit);
      sendJSON(res, 200, { ok: true, incidents, source: "memory" });
      return true;
    }

    // POST /ops/check — Force immediate health check cycle
    if (req.method === "POST" && pathname === "/ops/check") {
      const status = await watchdog.forceCheck();
      sendJSON(res, 200, { ok: true, services: status, ts: new Date().toISOString() });
      return true;
    }

    // GET /ops/gpu — Vast.ai instance info + utilization
    if (req.method === "GET" && pathname === "/ops/gpu") {
      const status = watchdog.getStatus();
      const gpu = status["vast-gpu"] || { status: "unknown", details: {} };
      sendJSON(res, 200, { ok: true, gpu });
      return true;
    }

    return false;
  };
};
