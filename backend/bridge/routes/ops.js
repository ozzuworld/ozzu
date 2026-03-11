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

    // GET /ops/token-usage — Token usage summary and history
    if (req.method === "GET" && pathname === "/ops/token-usage") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "Database not available" }); return true; }

      const range = url.searchParams.get("range") || "7d";
      const m = range.match(/^(\d+)(d|h)$/);
      const interval = m ? `${m[1]} ${m[2] === "d" ? "days" : "hours"}` : "7 days";

      try {
        // Daily aggregates
        const daily = await db.query(
          `SELECT
            DATE(recorded_at) as date,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cache_read_tokens) as cache_read_tokens,
            SUM(cache_creation_tokens) as cache_creation_tokens,
            SUM(total_tokens) as total_tokens,
            SUM(cost_usd)::NUMERIC(10,4) as cost_usd,
            COUNT(*) as runs
          FROM token_usage
          WHERE recorded_at > NOW() - $1::interval
          GROUP BY DATE(recorded_at)
          ORDER BY date DESC`,
          [interval]
        );

        // Per-model breakdown
        const byModel = await db.query(
          `SELECT
            model,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cache_read_tokens) as cache_read_tokens,
            SUM(total_tokens) as total_tokens,
            SUM(cost_usd)::NUMERIC(10,4) as cost_usd,
            COUNT(*) as runs
          FROM token_usage
          WHERE recorded_at > NOW() - $1::interval
          GROUP BY model
          ORDER BY total_tokens DESC`,
          [interval]
        );

        // Per-source breakdown (agent_sdk vs cli_session)
        const bySource = await db.query(
          `SELECT
            source,
            SUM(total_tokens) as total_tokens,
            SUM(cost_usd)::NUMERIC(10,4) as cost_usd,
            COUNT(*) as runs
          FROM token_usage
          WHERE recorded_at > NOW() - $1::interval
          GROUP BY source`,
          [interval]
        );

        // Totals
        const totals = await db.query(
          `SELECT
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cache_read_tokens) as cache_read_tokens,
            SUM(cache_creation_tokens) as cache_creation_tokens,
            SUM(total_tokens) as total_tokens,
            SUM(cost_usd)::NUMERIC(10,4) as cost_usd,
            COUNT(*) as total_runs,
            CASE WHEN SUM(input_tokens + cache_read_tokens + cache_creation_tokens) > 0
              THEN ROUND(SUM(cache_read_tokens)::NUMERIC / SUM(input_tokens + cache_read_tokens + cache_creation_tokens) * 100, 1)
              ELSE 0 END as cache_hit_rate
          FROM token_usage
          WHERE recorded_at > NOW() - $1::interval`,
          [interval]
        );

        sendJSON(res, 200, {
          ok: true,
          range,
          totals: totals.rows[0] || {},
          daily: daily.rows,
          byModel: byModel.rows,
          bySource: bySource.rows,
        });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // GET /ops/token-usage/recent — Recent individual runs with token data
    if (req.method === "GET" && pathname === "/ops/token-usage/recent") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "Database not available" }); return true; }
      const limitParam = url.searchParams.get("limit");
      let limit = limitParam ? parseInt(limitParam, 10) : 20;
      if (isNaN(limit) || limit < 1) limit = 20;
      if (limit > 100) limit = 100;

      try {
        const result = await db.query(
          `SELECT id, source, session_id, run_id, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_creation_tokens, total_tokens, cost_usd,
                  duration_ms, recorded_at
           FROM token_usage
           ORDER BY recorded_at DESC
           LIMIT $1`,
          [limit]
        );
        sendJSON(res, 200, { ok: true, runs: result.rows });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    return false;
  };
};
