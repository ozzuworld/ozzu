"use strict";

// Jobs ingester (dir_1785424018953). Pulls remote software-engineering listings from the
// free public feeds (Himalayas, RemoteOK), normalizes both to the `jobs` table, scores
// relevance (scope.js), and upserts. Delisted roles are retired per successfully-fetched
// source only, so one source outage never mass-closes its jobs.
//
// Standalone:  node jobs/ingest.js            (full refresh against live PG)
//              node jobs/ingest.js --dry-run  (fetch + score, no DB write)
//              node jobs/ingest.js --rescore  (re-apply scope.json, no fetch)
// In-process:  const { runIngest } = require("./jobs/ingest"); await runIngest(db);

const schema = require("./schema");
const { scoreJob } = require("./scope");

// Register sources here. Each exposes { SOURCE, fetch(), normalize(row) }.
const SOURCES = [require("./sources/himalayas"), require("./sources/remoteok")];

function log(...a) { console.log(`[jobs-ingest ${new Date().toISOString()}]`, ...a); }

async function runIngest(db, opts = {}) {
  const dryRun = opts.dryRun || false;
  await schema.ensureSchema(db);
  const runStart = new Date();
  const runId = dryRun ? null : await schema.startIngestRun(db, { sources: SOURCES.map((s) => s.SOURCE) });

  let fetched = 0, upserted = 0, relevant = 0;
  const bySource = {};
  const fetchedSources = [];

  try {
    for (const src of SOURCES) {
      const t0 = Date.now();
      try {
        const rows = await src.fetch();
        fetchedSources.push(src.SOURCE);
        let srcRelevant = 0;
        for (const row of rows) {
          let rec;
          try { rec = src.normalize(row); } catch (e) { continue; }
          if (!rec || !rec.id || !rec.title) continue;
          const s = scoreJob(rec);
          rec.relevant = s.relevant;
          rec.score = s.score;
          rec.matched_skills = s.matched_skills;
          rec.latam_reachable = s.latam_reachable;
          rec.tags_text = Array.isArray(rec.tags) ? rec.tags.join(" ") : null;
          fetched++;
          if (s.relevant) { relevant++; srcRelevant++; }
          if (!dryRun) { await schema.upsertJob(db, rec); upserted++; }
        }
        bySource[src.SOURCE] = { fetched: rows.length, relevant: srcRelevant };
        log(`${src.SOURCE}: ${rows.length} fetched, ${srcRelevant} relevant (${Math.round((Date.now() - t0) / 1000)}s)`);
      } catch (e) {
        bySource[src.SOURCE] = { error: e.message };
        log(`${src.SOURCE}: FAILED ${e.message}`);
      }
    }

    // Only retire delistings for sources that actually answered this run.
    const closed = dryRun ? 0 : await schema.closeStaleForSources(db, fetchedSources, runStart);
    if (!dryRun) await schema.finishIngestRun(db, runId, { status: "ok", fetched, upserted, closed, relevant, by_source: bySource });
    log(`DONE fetched=${fetched} upserted=${upserted} relevant=${relevant} closed=${closed}${dryRun ? " (dry-run)" : ""}`);
    return { fetched, upserted, relevant, closed, by_source: bySource };
  } catch (err) {
    if (!dryRun && runId) await schema.finishIngestRun(db, runId, { status: "error", fetched, upserted, relevant, by_source: bySource, error: err.message });
    throw err;
  }
}

module.exports = { runIngest, SOURCES };

// ── Standalone entrypoint ──
if (require.main === module) {
  const { Pool } = require("pg");
  const pool = new Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: parseInt(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE || "ozzu",
    user: process.env.PGUSER || "ozzu",
    password: process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || "ozzu",
    max: 4,
    connectionTimeoutMillis: 8000,
  });
  const db = { query: (t, p) => pool.query(t, p) };
  const args = process.argv.slice(2);
  const task = args.includes("--rescore")
    ? schema.ensureSchema(db).then(() => schema.rescoreAll(db))
    : runIngest(db, { dryRun: args.includes("--dry-run") });
  task
    .then((r) => { console.log("[jobs-ingest] result:", JSON.stringify(r)); return pool.end(); })
    .then(() => process.exit(0))
    .catch((e) => { console.error("[jobs-ingest] FAILED:", e.message); pool.end().finally(() => process.exit(1)); });
}
