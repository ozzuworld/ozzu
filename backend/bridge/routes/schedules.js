// Device scheduling — cron-style automation for HA entities
// CRUD schedules + execution engine

module.exports = function scheduleRoutes(ctx) {
  const { sendJSON, parseBody, db, CORS_HEADERS } = ctx;

  return async function (req, res, pathname, url) {
    // GET /schedules — list all schedules
    if (req.method === "GET" && pathname === "/schedules") {
      try {
        const result = await db.query(
          `SELECT * FROM device_schedules ORDER BY enabled DESC, cron_hour, cron_minute`
        );
        sendJSON(res, 200, { schedules: result.rows });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /schedules — create a schedule
    if (req.method === "POST" && pathname === "/schedules") {
      try {
        const body = await parseBody(req);
        const { name, entity_id, domain, service, service_data, cron_days, cron_hour, cron_minute, enabled } = body;
        if (!name || !entity_id || !domain || !service) {
          sendJSON(res, 400, { error: "name, entity_id, domain, service required" });
          return true;
        }
        const nextRun = computeNextRun(
          cron_days || [0, 1, 2, 3, 4, 5, 6],
          cron_hour ?? 22,
          cron_minute ?? 0
        );
        const result = await db.query(
          `INSERT INTO device_schedules (name, entity_id, domain, service, service_data, cron_days, cron_hour, cron_minute, enabled, next_run_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            name, entity_id, domain, service,
            JSON.stringify(service_data || {}),
            cron_days || [0, 1, 2, 3, 4, 5, 6],
            cron_hour ?? 22,
            cron_minute ?? 0,
            enabled !== false,
            nextRun,
          ]
        );
        sendJSON(res, 201, result.rows[0]);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /schedules/:id — update a schedule
    const patchMatch = pathname.match(/^\/schedules\/(\d+)$/);
    if (req.method === "PATCH" && patchMatch) {
      try {
        const id = parseInt(patchMatch[1]);
        const body = await parseBody(req);
        const fields = [];
        const values = [];
        let idx = 1;

        for (const key of ["name", "entity_id", "domain", "service", "cron_hour", "cron_minute", "enabled"]) {
          if (body[key] !== undefined) {
            fields.push(`${key} = $${idx++}`);
            values.push(body[key]);
          }
        }
        if (body.service_data !== undefined) {
          fields.push(`service_data = $${idx++}`);
          values.push(JSON.stringify(body.service_data));
        }
        if (body.cron_days !== undefined) {
          fields.push(`cron_days = $${idx++}`);
          values.push(body.cron_days);
        }

        if (fields.length === 0) {
          sendJSON(res, 400, { error: "No fields to update" });
          return true;
        }

        fields.push(`updated_at = NOW()`);
        values.push(id);

        // Recompute next_run_at
        const hour = body.cron_hour ?? null;
        const minute = body.cron_minute ?? null;
        const days = body.cron_days ?? null;

        const result = await db.query(
          `UPDATE device_schedules SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
          values
        );
        if (result.rowCount === 0) {
          sendJSON(res, 404, { error: "Schedule not found" });
          return true;
        }

        // Recompute next run based on updated values
        const sched = result.rows[0];
        const nextRun = computeNextRun(sched.cron_days, sched.cron_hour, sched.cron_minute);
        await db.query(`UPDATE device_schedules SET next_run_at = $1 WHERE id = $2`, [nextRun, id]);
        sched.next_run_at = nextRun;

        sendJSON(res, 200, sched);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /schedules/:id
    const deleteMatch = pathname.match(/^\/schedules\/(\d+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      try {
        const id = parseInt(deleteMatch[1]);
        const result = await db.query(`DELETE FROM device_schedules WHERE id = $1`, [id]);
        if (result.rowCount === 0) {
          sendJSON(res, 404, { error: "Schedule not found" });
          return true;
        }
        sendJSON(res, 200, { deleted: true });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  };
};

// Compute next occurrence of a cron schedule
function computeNextRun(days, hour, minute) {
  const now = new Date();
  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setHours(hour, minute);

  // If today's time already passed, start from tomorrow
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  // Find next matching day (max 7 iterations)
  for (let i = 0; i < 7; i++) {
    if (days.includes(target.getDay())) {
      return target.toISOString();
    }
    target.setDate(target.getDate() + 1);
  }
  // Fallback (shouldn't happen if days is valid)
  return target.toISOString();
}

// Exported for use by the scheduler engine in server.js
module.exports.computeNextRun = computeNextRun;
