// engagement-cron.js — dir_1780846234615
//
// Scheduled background tasks per engagement. Port of claw-code's
// runtime/src/team_cron_registry.rs (CronRegistry portion) — adapted to
// Postgres-backed storage + queue-item dispatch instead of in-memory state.
//
// Use cases:
//   - Hourly re-recon of a target
//   - Daily credential re-verification
//   - Periodic finding staleness check
//   - Engagement summary at end of day

"use strict";

const db = require("./db");

// ── Cron parser (5-field, minute precision) ───────────────────────────────
//
// Grammar (each field, space-separated):
//   minute   0-59
//   hour     0-23
//   day      1-31
//   month    1-12
//   weekday  0-6 (Sunday=0)
//
// Each field accepts:
//   *         — any value
//   N         — exact value
//   N-M       — inclusive range
//   N,M,P     — list (no spaces inside)
//   */N       — step (every N starting at field min)
//   N-M/S     — range with step

function parseField(field, min, max) {
  if (field === "*") return { kind: "any", min, max };
  const parts = field.split(",");
  const set = new Set();
  for (const raw of parts) {
    let p = raw.trim();
    let step = 1;
    if (p.includes("/")) {
      const [rng, stepStr] = p.split("/");
      step = parseInt(stepStr, 10);
      if (!Number.isInteger(step) || step <= 0) return { error: `bad step in '${raw}'` };
      p = rng;
    }
    let from, to;
    if (p === "*") { from = min; to = max; }
    else if (p.includes("-")) {
      const [a, b] = p.split("-").map(s => parseInt(s, 10));
      if (!Number.isInteger(a) || !Number.isInteger(b)) return { error: `bad range '${raw}'` };
      from = a; to = b;
    } else {
      const n = parseInt(p, 10);
      if (!Number.isInteger(n)) return { error: `bad value '${raw}'` };
      from = n; to = n;
    }
    if (from < min || to > max || from > to) return { error: `range out of bounds in '${raw}' (allowed ${min}-${max})` };
    for (let v = from; v <= to; v += step) set.add(v);
  }
  return { kind: "set", values: set };
}

function parseCron(expr) {
  if (!expr || typeof expr !== "string") return { valid: false, error: "expression is empty" };
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return { valid: false, error: `expected 5 fields, got ${fields.length}` };
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const parsed = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(fields[i], ranges[i][0], ranges[i][1]);
    if (r.error) return { valid: false, error: `field ${i+1}: ${r.error}` };
    parsed.push(r);
  }
  return {
    valid: true,
    expr,
    minute: parsed[0],
    hour: parsed[1],
    day: parsed[2],
    month: parsed[3],
    weekday: parsed[4],
  };
}

function fieldMatches(field, value) {
  if (field.kind === "any") return true;
  return field.values.has(value);
}

function matchesNow(expr, date) {
  const p = parseCron(expr);
  if (!p.valid) return false;
  const d = date || new Date();
  return (
    fieldMatches(p.minute,  d.getUTCMinutes()) &&
    fieldMatches(p.hour,    d.getUTCHours()) &&
    fieldMatches(p.day,     d.getUTCDate()) &&
    fieldMatches(p.month,   d.getUTCMonth() + 1) &&
    fieldMatches(p.weekday, d.getUTCDay())
  );
}

// Compute the next minute at which this cron will fire, starting at `from`.
// Returns Date or null if no match in next 366 days (effectively never).
function nextFireAfter(expr, from) {
  const p = parseCron(expr);
  if (!p.valid) return null;
  const start = new Date(from || Date.now());
  // Advance to the next whole minute boundary
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (
      fieldMatches(p.minute,  start.getUTCMinutes()) &&
      fieldMatches(p.hour,    start.getUTCHours()) &&
      fieldMatches(p.day,     start.getUTCDate()) &&
      fieldMatches(p.month,   start.getUTCMonth() + 1) &&
      fieldMatches(p.weekday, start.getUTCDay())
    ) {
      return start;
    }
    start.setUTCMinutes(start.getUTCMinutes() + 1);
  }
  return null;
}

// ── Registry / dispatch ──────────────────────────────────────────────────

const VALID_INTENT_CLASSES = new Set(["recon", "enumeration", "exploit_test", "exploit_rce", "post_exploit"]);

async function createCron({ engagement_id, schedule, prompt, intent_class, description, created_by }) {
  if (!engagement_id) return { error: "engagement_id required" };
  if (!schedule)      return { error: "schedule required" };
  if (!prompt)        return { error: "prompt required" };
  const p = parseCron(schedule);
  if (!p.valid)       return { error: `invalid schedule: ${p.error}` };
  const intent = VALID_INTENT_CLASSES.has(intent_class) ? intent_class : "recon";
  const next = nextFireAfter(schedule, Date.now());
  const r = await db.query(
    `INSERT INTO engagement_crons (engagement_id, schedule, prompt, intent_class, description, created_by, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, engagement_id, schedule, prompt, intent_class, enabled, description, created_at, next_run_at, run_count`,
    [engagement_id, schedule, prompt, intent, description || null, created_by || "operator", next]);
  return r.rows[0];
}

async function listCrons(engagementId) {
  const r = await db.query(
    `SELECT id, engagement_id, schedule, prompt, intent_class, enabled, description,
            created_at, created_by, last_run_at, next_run_at, run_count
       FROM engagement_crons
      WHERE ($1::text IS NULL OR engagement_id = $1)
      ORDER BY id ASC`,
    [engagementId || null]);
  return r.rows;
}

async function deleteCron(cronId) {
  const r = await db.query(`DELETE FROM engagement_crons WHERE id = $1 RETURNING id`, [cronId]);
  return r.rows[0] || null;
}

async function setCronEnabled(cronId, enabled) {
  const r = await db.query(
    `UPDATE engagement_crons SET enabled = $2 WHERE id = $1 RETURNING id, enabled`,
    [cronId, !!enabled]);
  return r.rows[0] || null;
}

// Insert a queue item for the fired cron. The bridge's normal queue dispatch
// + autonomous-executor.maybeAutoExecute will pick it up and apply the gate
// stack (ROE → permission_mode → workspace_jail → command_tokens → preflight →
// hooks → auto-verify). We don't bypass anything.
async function fireCron(cron) {
  try {
    const r = await db.query(
      `INSERT INTO soc_queue_items (engagement_id, title, command, intent_class, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       RETURNING id`,
      [cron.engagement_id,
       `[CRON #${cron.id}] ${(cron.description || cron.prompt).slice(0, 80)}`,
       cron.prompt,
       cron.intent_class || "recon"]);
    return { queued: true, queue_item_id: r.rows[0].id };
  } catch (e) {
    return { queued: false, error: e.message };
  }
}

// tickAllDue called every minute by the bridge poller. Iterates ENABLED crons,
// checks matchesNow, fires + updates last_run_at + next_run_at + run_count.
async function tickAllDue(nowDate) {
  const now = nowDate || new Date();
  let crons;
  try {
    const r = await db.query(
      `SELECT id, engagement_id, schedule, prompt, intent_class, description,
              last_run_at, next_run_at, run_count
         FROM engagement_crons
        WHERE enabled = true`);
    crons = r.rows;
  } catch (e) { return { error: e.message }; }
  const fired = [];
  for (const c of crons) {
    // Avoid double-firing within the same minute by checking last_run_at
    if (c.last_run_at) {
      const lastMin = Math.floor(new Date(c.last_run_at).getTime() / 60000);
      const nowMin = Math.floor(now.getTime() / 60000);
      if (lastMin === nowMin) continue;
    }
    if (!matchesNow(c.schedule, now)) continue;
    const res = await fireCron(c);
    if (res.queued) {
      const next = nextFireAfter(c.schedule, now.getTime());
      try {
        await db.query(
          `UPDATE engagement_crons
              SET last_run_at = NOW(),
                  next_run_at = $2,
                  run_count = COALESCE(run_count, 0) + 1
            WHERE id = $1`,
          [c.id, next]);
      } catch (_) {}
      fired.push({ cron_id: c.id, queue_item_id: res.queue_item_id });
    } else {
      console.error(`[engagement-cron] fire failed for cron ${c.id}:`, res.error);
    }
  }
  return { fired, checked: crons.length };
}

// Long-lived poller — start once at bridge boot. Drift is tolerated (we check
// matchesNow against the actual fire moment, not the scheduled moment).
let _pollerHandle = null;
function startPoller(intervalMs) {
  if (_pollerHandle) return _pollerHandle;
  const period = Math.max(15000, intervalMs || 60000);
  _pollerHandle = setInterval(async () => {
    try {
      const r = await tickAllDue();
      if (r && Array.isArray(r.fired) && r.fired.length > 0) {
        console.log(`[engagement-cron] fired ${r.fired.length} cron(s):`, r.fired);
      }
    } catch (e) { console.error(`[engagement-cron] poller error:`, e.message); }
  }, period);
  console.log(`[engagement-cron] poller started, period=${period}ms`);
  return _pollerHandle;
}
function stopPoller() {
  if (_pollerHandle) { clearInterval(_pollerHandle); _pollerHandle = null; }
}

module.exports = {
  parseCron,
  matchesNow,
  nextFireAfter,
  createCron,
  listCrons,
  deleteCron,
  setCronEnabled,
  fireCron,
  tickAllDue,
  startPoller,
  stopPoller,
};
