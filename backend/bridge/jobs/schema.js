"use strict";

// Jobs inbox data layer (dir_1785424018953): idempotent table DDL + all query helpers used
// by jobs/ingest.js, jobs/worker.js and routes/jobs.js. Fully independent of SECOP — its
// own tables (jobs, jobs_decisions, jobs_ingest_runs, jobs_worker_state), no shared state.
//
// `db` is any object exposing query(text, params) (the bridge db.js, or a standalone pg Pool
// wrapper — see ingest.js). No pool is created here.

const { scoreJob } = require("./scope");

// Columns written on upsert (first_seen/last_seen/updated_at/is_open/search_tsv are managed
// by the table/DDL, not passed in).
const INSERT_COLS = [
  "id", "source", "source_id", "title", "company", "company_logo", "url", "apply_url",
  "location", "location_restrictions", "timezone_restrictions", "remote", "employment_type",
  "seniority", "tags", "tags_text", "salary_min", "salary_max", "salary_currency", "salary_period",
  "description", "excerpt", "posted_at", "expires_at",
  "relevant", "score", "matched_skills", "latam_reachable", "raw",
];

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id                     TEXT PRIMARY KEY,
      source                 TEXT NOT NULL,
      source_id              TEXT NOT NULL,
      title                  TEXT,
      company                TEXT,
      company_logo           TEXT,
      url                    TEXT,
      apply_url              TEXT,
      location               TEXT,
      location_restrictions  TEXT[] DEFAULT '{}',
      timezone_restrictions  NUMERIC[] DEFAULT '{}',
      remote                 BOOLEAN DEFAULT TRUE,
      employment_type        TEXT,
      seniority              TEXT[] DEFAULT '{}',
      tags                   TEXT[] DEFAULT '{}',
      tags_text              TEXT,
      salary_min             NUMERIC,
      salary_max             NUMERIC,
      salary_currency        TEXT,
      salary_period          TEXT,
      description            TEXT,
      excerpt                TEXT,
      posted_at              TIMESTAMPTZ,
      expires_at             TIMESTAMPTZ,
      relevant               BOOLEAN DEFAULT FALSE,
      score                  NUMERIC DEFAULT 0,
      matched_skills         TEXT[] DEFAULT '{}',
      latam_reachable        BOOLEAN DEFAULT FALSE,
      raw                    JSONB,
      is_open                BOOLEAN DEFAULT TRUE,
      first_seen             TIMESTAMPTZ DEFAULT now(),
      last_seen              TIMESTAMPTZ DEFAULT now(),
      updated_at             TIMESTAMPTZ DEFAULT now(),
      search_tsv             tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(title,'') || ' ' || coalesce(company,'') || ' ' ||
          coalesce(tags_text,'') || ' ' || coalesce(excerpt,''))
      ) STORED
    )
  `);

  for (const idx of [
    `CREATE INDEX IF NOT EXISTS idx_jobs_source     ON jobs(source)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_relevant   ON jobs(relevant)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_open        ON jobs(is_open)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_score       ON jobs(score DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_posted      ON jobs(posted_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_tags        ON jobs USING GIN(tags)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_skills      ON jobs USING GIN(matched_skills)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_search      ON jobs USING GIN(search_tsv)`,
  ]) {
    await db.query(idx);
  }

  // Triage inbox: pending | saved | dismissed | applied. dismissed drops it from the inbox.
  await db.query(`
    CREATE TABLE IF NOT EXISTS jobs_decisions (
      id         TEXT PRIMARY KEY,
      decision   TEXT NOT NULL DEFAULT 'pending',
      note       TEXT,
      decided_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS jobs_ingest_runs (
      id          SERIAL PRIMARY KEY,
      started_at  TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ,
      status      TEXT DEFAULT 'running',
      fetched     INT DEFAULT 0,
      upserted    INT DEFAULT 0,
      closed      INT DEFAULT 0,
      relevant    INT DEFAULT 0,
      by_source   JSONB DEFAULT '{}',
      error       TEXT,
      params      JSONB DEFAULT '{}'
    )
  `);

  // Single-row runtime control for the refresh worker. Unlike SECOP's Claude worker (which
  // spends Max quota, so it defaults OFF), jobs ingest is just cheap public-API HTTP, so it
  // defaults ON. The app's play/pause flips this flag; env JOBS_WORKER=off is a hard kill.
  await db.query(`
    CREATE TABLE IF NOT EXISTS jobs_worker_state (
      id         SMALLINT PRIMARY KEY DEFAULT 1,
      enabled    BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      CONSTRAINT jobs_worker_singleton CHECK (id = 1)
    )
  `);
  await db.query(`INSERT INTO jobs_worker_state (id, enabled) VALUES (1, true) ON CONFLICT (id) DO NOTHING`);
}

// ── Upsert (from ingest.js). Last-write-wins; re-seen rows re-open + refresh score. ──
async function upsertJob(db, rec) {
  const ph = INSERT_COLS.map((_, i) => `$${i + 1}`).join(", ");
  const updates = INSERT_COLS.filter((c) => c !== "id" && c !== "source" && c !== "source_id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  const vals = INSERT_COLS.map((c) => {
    if (c === "raw") return rec.raw == null ? null : JSON.stringify(rec.raw);
    return rec[c] === undefined ? null : rec[c]; // arrays pass through as pg array literals
  });
  await db.query(
    `INSERT INTO jobs (${INSERT_COLS.join(", ")})
     VALUES (${ph})
     ON CONFLICT (id) DO UPDATE SET
       ${updates}, is_open = TRUE, last_seen = now(), updated_at = now()`,
    vals
  );
}

// Retire listings that a successfully-refreshed source stopped returning this run (delisted).
// Only sweeps sources we actually fetched, so a source outage never mass-closes its jobs.
async function closeStaleForSources(db, sources, since) {
  if (!sources || sources.length === 0) return 0;
  const r = await db.query(
    `UPDATE jobs SET is_open = FALSE, updated_at = now()
     WHERE source = ANY($1) AND is_open = TRUE AND last_seen < $2`,
    [sources, since]
  );
  return r.rowCount || 0;
}

// ── Ingest-run bookkeeping ──
async function startIngestRun(db, params) {
  const r = await db.query(`INSERT INTO jobs_ingest_runs (params) VALUES ($1) RETURNING id`, [JSON.stringify(params || {})]);
  return r.rows[0].id;
}
async function finishIngestRun(db, id, patch) {
  await db.query(
    `UPDATE jobs_ingest_runs
     SET finished_at = now(), status = $2, fetched = $3, upserted = $4, closed = $5, relevant = $6, by_source = $7, error = $8
     WHERE id = $1`,
    [id, patch.status, patch.fetched || 0, patch.upserted || 0, patch.closed || 0, patch.relevant || 0,
     JSON.stringify(patch.by_source || {}), patch.error || null]
  );
}
async function lastIngestRun(db) {
  const r = await db.query(`SELECT * FROM jobs_ingest_runs ORDER BY id DESC LIMIT 1`);
  return r.rows[0] || null;
}

// ── Read API used by routes/jobs.js ──
const SORTS = {
  best: "score DESC, posted_at DESC NULLS LAST",
  newest: "posted_at DESC NULLS LAST",
  salary_desc: "COALESCE(salary_max, salary_min, 0) DESC",
  seen: "first_seen DESC",
};

async function listJobs(db, f = {}) {
  const where = [];
  const args = [];
  const add = (sql, val) => { args.push(val); where.push(sql.replace("?", `$${args.length}`)); };
  const truthy = (v) => v === true || v === "true" || v === "1";

  if (!truthy(f.all)) where.push("j.is_open = TRUE");
  if (truthy(f.relevant)) where.push("j.relevant = TRUE");
  if (truthy(f.latam)) where.push("j.latam_reachable = TRUE");
  // Inbox = relevant + not dismissed + not applied (the triage queue).
  if (truthy(f.inbox)) {
    where.push("j.relevant = TRUE");
    where.push("NOT EXISTS (SELECT 1 FROM jobs_decisions d WHERE d.id = j.id AND d.decision IN ('dismissed','applied'))");
  }
  if (f.decision) add("EXISTS (SELECT 1 FROM jobs_decisions d WHERE d.id = j.id AND d.decision = ?)", String(f.decision));
  if (f.source) add("j.source = ?", String(f.source));
  if (f.tag) add("? = ANY(j.tags)", String(f.tag));
  if (f.company) add("j.company ILIKE ?", `%${f.company}%`);
  if (f.min_salary) add("COALESCE(j.salary_max, j.salary_min) >= ?", Number(f.min_salary));
  if (f.q) add("j.search_tsv @@ plainto_tsquery('english', ?)", String(f.q));

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = SORTS[f.sort] || SORTS.best;
  const limit = Math.min(Math.max(parseInt(f.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(f.offset) || 0, 0);

  const totalRes = await db.query(`SELECT count(*)::int AS n FROM jobs j ${whereSql}`, args);
  const rowsRes = await db.query(
    `SELECT j.id, j.source, j.source_id, j.title, j.company, j.company_logo, j.url, j.apply_url,
            j.location, j.location_restrictions, j.timezone_restrictions, j.remote, j.employment_type,
            j.seniority, j.tags, j.salary_min, j.salary_max, j.salary_currency, j.salary_period,
            j.excerpt, j.posted_at, j.expires_at, j.relevant, j.score, j.matched_skills,
            j.latam_reachable, j.is_open, j.first_seen,
            COALESCE(d.decision, 'pending') AS decision
     FROM jobs j
     LEFT JOIN jobs_decisions d ON d.id = j.id
     ${whereSql}
     ORDER BY ${orderSql}
     LIMIT ${limit} OFFSET ${offset}`,
    args
  );
  return { total: totalRes.rows[0].n, limit, offset, items: rowsRes.rows };
}

async function getJob(db, id) {
  const r = await db.query(
    `SELECT j.*, COALESCE(d.decision, 'pending') AS decision, d.note AS decision_note
     FROM jobs j LEFT JOIN jobs_decisions d ON d.id = j.id
     WHERE j.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function getStats(db) {
  const [open, relevant, inbox, bySource, decisions, run] = await Promise.all([
    db.query(`SELECT count(*)::int AS n FROM jobs WHERE is_open = TRUE`),
    db.query(`SELECT count(*)::int AS n FROM jobs WHERE is_open = TRUE AND relevant = TRUE`),
    db.query(`SELECT count(*)::int AS n FROM jobs j WHERE is_open = TRUE AND relevant = TRUE
              AND NOT EXISTS (SELECT 1 FROM jobs_decisions d WHERE d.id = j.id AND d.decision IN ('dismissed','applied'))`),
    db.query(`SELECT source, count(*)::int AS total,
                     count(*) FILTER (WHERE relevant)::int AS relevant
              FROM jobs WHERE is_open = TRUE GROUP BY source ORDER BY relevant DESC`),
    db.query(`SELECT decision, count(*)::int AS n FROM jobs_decisions GROUP BY decision`),
    lastIngestRun(db),
  ]);
  const byDecision = {};
  for (const r of decisions.rows) byDecision[r.decision] = r.n;
  return {
    open_count: open.rows[0].n,
    relevant_count: relevant.rows[0].n,
    inbox_count: inbox.rows[0].n,
    by_source: bySource.rows,
    saved_count: byDecision.saved || 0,
    applied_count: byDecision.applied || 0,
    dismissed_count: byDecision.dismissed || 0,
    last_ingest: run,
  };
}

async function setDecision(db, id, decision, note) {
  const r = await db.query(
    `INSERT INTO jobs_decisions (id, decision, note, decided_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET decision = $2, note = COALESCE($3, jobs_decisions.note), decided_at = now()
     RETURNING id, decision, note, decided_at`,
    [id, decision, note || null]
  );
  return r.rows[0];
}

// Re-derive relevant/score from stored columns after editing scope.json (no re-fetch).
async function rescoreAll(db) {
  const res = await db.query(
    `SELECT id, title, tags, excerpt, description, salary_min, salary_max, seniority,
            location, location_restrictions, timezone_restrictions, posted_at FROM jobs`
  );
  let updated = 0, relevant = 0;
  for (const row of res.rows) {
    const s = scoreJob(row);
    if (s.relevant) relevant++;
    await db.query(
      `UPDATE jobs SET relevant = $2, score = $3, matched_skills = $4, latam_reachable = $5, updated_at = now() WHERE id = $1`,
      [row.id, s.relevant, s.score, s.matched_skills, s.latam_reachable]
    );
    updated++;
  }
  return { updated, relevant };
}

async function getWorkerState(db) {
  try {
    const r = await db.query(`SELECT enabled, updated_at, updated_by FROM jobs_worker_state WHERE id = 1`);
    return r.rows[0] || { enabled: true, updated_at: null, updated_by: null };
  } catch (e) {
    return { enabled: true, updated_at: null, updated_by: null };
  }
}
async function setWorkerState(db, enabled, by) {
  const r = await db.query(
    `INSERT INTO jobs_worker_state (id, enabled, updated_at, updated_by) VALUES (1, $1, now(), $2)
     ON CONFLICT (id) DO UPDATE SET enabled = $1, updated_at = now(), updated_by = $2
     RETURNING enabled, updated_at, updated_by`,
    [!!enabled, by || null]
  );
  return r.rows[0];
}

module.exports = {
  INSERT_COLS,
  ensureSchema,
  upsertJob,
  closeStaleForSources,
  startIngestRun,
  finishIngestRun,
  lastIngestRun,
  listJobs,
  getJob,
  getStats,
  setDecision,
  rescoreAll,
  getWorkerState,
  setWorkerState,
};
