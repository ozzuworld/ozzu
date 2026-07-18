"use strict";

// Background pre-analysis worker (dir_1784411316803). Pre-builds each relevant/open/
// undecided tender's detail + brief (Claude, Max plan) so offers land in the inbox
// already analyzed. Runs up to N jobs CONCURRENTLY — Claude's latency is queue-wait,
// not compute, so parallel waiting is ~N× throughput for free. The extract.js semaphore
// bounds actual Claude sessions so the no-swap box can't OOM. Kill switch SECOP_WORKER=off.

const { buildTenderDetail } = require("./detail-pipeline");
const { generateBrief } = require("./extract");
const schema = require("./schema");

const ENABLED = process.env.SECOP_WORKER !== "off";
const TICK_MS = parseInt(process.env.SECOP_WORKER_TICK_MS) || 15000;
const MAX_JOBS = parseInt(process.env.SECOP_CONCURRENCY) || 5;
const ERROR_COOLDOWN_MS = parseInt(process.env.SECOP_WORKER_COOLDOWN_MS) || 5 * 60 * 1000;

let ticking = false;
let cooldownUntil = 0;
const inFlight = new Set();

// Next un-analyzed relevant/open/undecided tender (full build), excluding in-flight.
async function pickFull(db, skip) {
  const r = await db.query(`
    SELECT l.id_proceso
    FROM secop_licitaciones l
    WHERE l.is_open
      AND ${schema.relevanceClause("l")}
      AND NOT (l.id_proceso = ANY($1))
      AND NOT EXISTS (SELECT 1 FROM secop_decisions d
                      WHERE d.id_proceso = l.id_proceso AND d.decision IN ('rejected','accepted'))
      AND NOT EXISTS (SELECT 1 FROM secop_tender_detail t
                      WHERE t.id_proceso = l.id_proceso AND t.status IN ('ok','building'))
    ORDER BY l.fecha_recepcion ASC NULLS LAST
    LIMIT 1`, [skip]);
  return r.rows[0] ? r.rows[0].id_proceso : null;
}

// Analyzed tender whose brief lacks the card preview — fast regen (no PDF).
async function pickBriefRegen(db, skip) {
  const r = await db.query(`
    SELECT t.id_proceso
    FROM secop_tender_detail t
    JOIN secop_licitaciones l ON l.id_proceso = t.id_proceso
    WHERE t.status = 'ok' AND (t.brief ? 'recomendacion') AND NOT (t.brief ? 'card')
      AND l.is_open
      AND ${schema.relevanceClause("l")}
      AND NOT (l.id_proceso = ANY($1))
      AND NOT EXISTS (SELECT 1 FROM secop_decisions d
                      WHERE d.id_proceso = l.id_proceso AND d.decision IN ('rejected','accepted'))
    ORDER BY l.fecha_recepcion ASC NULLS LAST
    LIMIT 1`, [skip]);
  return r.rows[0] ? r.rows[0].id_proceso : null;
}

async function pickJob(db) {
  const skip = [...inFlight];
  let id = await pickBriefRegen(db, skip); // fast card fills first
  if (id) return { id, type: "brief" };
  id = await pickFull(db, skip);
  if (id) return { id, type: "full" };
  return null;
}

async function processJob(db, job) {
  const t0 = Date.now();
  if (job.type === "brief") {
    const d = await schema.getTenderDetail(db, job.id);
    const lic = await schema.getLicitacion(db, job.id);
    const brief = await generateBrief(d, { entidad: lic.entidad, modalidad: lic.modalidad, valor: lic.precio_base, competitividad: lic.competitividad });
    await schema.setBrief(db, job.id, brief);
    console.log(`[secop-worker] card ${job.id} in ${Math.round((Date.now() - t0) / 1000)}s`);
  } else {
    console.log(`[secop-worker] analyzing ${job.id}`);
    await buildTenderDetail(db, job.id);
    console.log(`[secop-worker] done ${job.id} in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}

async function tick(db) {
  if (ticking || Date.now() < cooldownUntil) return;
  ticking = true;
  try {
    while (inFlight.size < MAX_JOBS) {
      const job = await pickJob(db);
      if (!job) break; // nothing left to do (or all remaining are in-flight)
      inFlight.add(job.id);
      processJob(db, job)
        .catch((e) => {
          console.error(`[secop-worker] ${job.id}: ${e.message}`);
          if (/rate|429|limit|overload/i.test(e.message)) cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
        })
        .finally(() => inFlight.delete(job.id));
    }
  } catch (e) {
    console.error(`[secop-worker] tick: ${e.message}`);
  } finally {
    ticking = false;
  }
}

function startWorker(db) {
  if (!ENABLED) { console.log("[secop-worker] disabled (SECOP_WORKER=off)"); return null; }
  console.log(`[secop-worker] started (tick ${TICK_MS / 1000}s, concurrency ${MAX_JOBS})`);
  return setInterval(() => { tick(db).catch(() => {}); }, TICK_MS);
}

module.exports = { startWorker, pickFull, pickBriefRegen };
