"use strict";

// Background pre-analysis worker (dir_1784407896444). Everything runs on the backend:
// this continuously pre-builds each relevant/open/undecided tender's detail + brief
// (Claude, Max plan) so offers arrive in the inbox already analyzed. ONE at a time
// (each analysis is a heavy ~180s Claude session; the box has no swap), soonest-closing
// first, with a cooldown on error / rate-limit. Kill switch: SECOP_WORKER=off.

const { buildTenderDetail } = require("./detail-pipeline");
const { generateBrief } = require("./extract");
const schema = require("./schema");

const ENABLED = process.env.SECOP_WORKER !== "off";
const TICK_MS = parseInt(process.env.SECOP_WORKER_TICK_MS) || 20000;
const ERROR_COOLDOWN_MS = parseInt(process.env.SECOP_WORKER_COOLDOWN_MS) || 10 * 60 * 1000;
// Gap between successful analyses — keeps the Max-plan usage gentle so the backfill
// doesn't compete with King Kazuma's interactive Claude. Tune with SECOP_WORKER_GAP_MS.
const GAP_MS = parseInt(process.env.SECOP_WORKER_GAP_MS) || 90 * 1000;

let running = false;
let cooldownUntil = 0;

// Next relevant, open, undecided tender with no completed/in-flight analysis.
async function pickNext(db) {
  const r = await db.query(`
    SELECT l.id_proceso
    FROM secop_licitaciones l
    WHERE l.is_open
      AND (l.family_code IN (SELECT family_code FROM secop_unspsc_families WHERE relevant)
           OR cardinality(l.overlay_categories) > 0)
      AND NOT EXISTS (SELECT 1 FROM secop_decisions d
                      WHERE d.id_proceso = l.id_proceso AND d.decision IN ('rejected','accepted'))
      AND NOT EXISTS (SELECT 1 FROM secop_tender_detail t
                      WHERE t.id_proceso = l.id_proceso AND t.status IN ('ok','building'))
    ORDER BY l.fecha_recepcion ASC NULLS LAST
    LIMIT 1`);
  return r.rows[0] ? r.rows[0].id_proceso : null;
}

// Analyzed tender whose brief lacks the card preview — fast regen (no PDF read).
async function pickBriefRegen(db) {
  const r = await db.query(`
    SELECT t.id_proceso
    FROM secop_tender_detail t
    JOIN secop_licitaciones l ON l.id_proceso = t.id_proceso
    WHERE t.status = 'ok' AND (t.brief ? 'recomendacion') AND NOT (t.brief ? 'card')
      AND l.is_open
      AND (l.family_code IN (SELECT family_code FROM secop_unspsc_families WHERE relevant)
           OR cardinality(l.overlay_categories) > 0)
      AND NOT EXISTS (SELECT 1 FROM secop_decisions d
                      WHERE d.id_proceso = l.id_proceso AND d.decision IN ('rejected','accepted'))
    ORDER BY l.fecha_recepcion ASC NULLS LAST
    LIMIT 1`);
  return r.rows[0] ? r.rows[0].id_proceso : null;
}

async function tick(db) {
  if (running || Date.now() < cooldownUntil) return;
  running = true;
  try {
    // 1. Fast pass: regenerate briefs missing the card preview (~20s, no PDF).
    const briefId = await pickBriefRegen(db);
    if (briefId) {
      const t0 = Date.now();
      const d = await schema.getTenderDetail(db, briefId);
      const lic = await schema.getLicitacion(db, briefId);
      const brief = await generateBrief(d, { entidad: lic.entidad, modalidad: lic.modalidad, valor: lic.precio_base, competitividad: lic.competitividad });
      await schema.setBrief(db, briefId, brief);
      console.log(`[secop-worker] card ${briefId} in ${Math.round((Date.now() - t0) / 1000)}s`);
      cooldownUntil = Date.now() + 15000; // light job — short gap
      return;
    }
    // 2. Full analysis of the next un-analyzed tender.
    const id = await pickNext(db);
    if (!id) return; // inbox fully analyzed — nothing to do
    const t0 = Date.now();
    console.log(`[secop-worker] analyzing ${id}`);
    await buildTenderDetail(db, id);
    console.log(`[secop-worker] done ${id} in ${Math.round((Date.now() - t0) / 1000)}s`);
    cooldownUntil = Date.now() + GAP_MS; // gentle gap before the next one
  } catch (e) {
    console.error(`[secop-worker] ${e.message} — cooling down ${ERROR_COOLDOWN_MS / 1000}s`);
    cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
  } finally {
    running = false;
  }
}

// Returns the interval handle (or null if disabled).
function startWorker(db) {
  if (!ENABLED) { console.log("[secop-worker] disabled (SECOP_WORKER=off)"); return null; }
  console.log(`[secop-worker] started (tick ${TICK_MS / 1000}s)`);
  return setInterval(() => { tick(db).catch(() => {}); }, TICK_MS);
}

module.exports = { startWorker, pickNext };
