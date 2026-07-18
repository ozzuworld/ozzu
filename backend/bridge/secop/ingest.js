"use strict";

// SECOP II ingester. Pulls currently-OPEN competitive procurement opportunities
// from Colombia's open-data portal (Socrata SODA API, dataset p6dx-8zbt), maps them
// to secop_licitaciones, categorizes (UNSPSC segment + Skyline overlay), and upserts.
//
// Standalone:   node secop/ingest.js               (full refresh)
//               node secop/ingest.js --recategorize (re-apply overlay.json, no fetch)
//               node secop/ingest.js --dry-run      (fetch + categorize, no DB write)
// In-process:   const { runIngest } = require("./secop/ingest"); await runIngest(db);

const https = require("https");
const schema = require("./schema");
const { deriveCategory } = require("./categories");
const { socrataHeaders } = require("./socrata");

const DATASET = process.env.SECOP_DATASET || "p6dx-8zbt";
const BASE = `https://www.datos.gov.co/resource/${DATASET}.json`;
const PAGE = parseInt(process.env.SECOP_PAGE_SIZE) || 1000;
const MAX_PAGES = parseInt(process.env.SECOP_MAX_PAGES) || 50; // safety cap
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || null;

// Competitive, biddable modalities. Edit to widen/narrow "available opportunities".
const MODALITIES = (process.env.SECOP_MODALITIES
  ? process.env.SECOP_MODALITIES.split("|")
  : [
      "Licitación pública",
      "Licitación pública Obra Publica",
      "Licitación Pública Acuerdo Marco de Precios",
      "Selección Abreviada de Menor Cuantía",
      "Selección abreviada subasta inversa",
      "Seleccion Abreviada Menor Cuantia Sin Manifestacion Interes",
      "Concurso de méritos abierto",
      "Concurso de méritos con precalificación",
      "Mínima cuantía",
    ]
).map((s) => s.trim());

function log(...a) { console.log(`[secop-ingest ${new Date().toISOString()}]`, ...a); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const headers = socrataHeaders();
    const req = https.get(url, { headers, timeout: 60000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function whereClause() {
  const today = new Date().toISOString().slice(0, 10);
  const list = MODALITIES.map((m) => `'${m.replace(/'/g, "''")}'`).join(",");
  return `fecha_de_recepcion_de >= '${today}T00:00:00.000' AND modalidad_de_contratacion in(${list})`;
}

function pageURL(offset) {
  const p = new URLSearchParams();
  p.set("$where", whereClause());
  p.set("$order", "fecha_de_recepcion_de ASC, id_del_proceso ASC");
  p.set("$limit", String(PAGE));
  p.set("$offset", String(offset));
  return `${BASE}?${p.toString()}`;
}

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));
const urlOf = (v) => (v && typeof v === "object" ? v.url || null : str(v));

// Map one raw SECOP row -> a normalized record for secop_licitaciones.
function buildRecord(row) {
  if (!row.id_del_proceso) return null;
  const cat = deriveCategory(row);
  return {
    id_proceso: String(row.id_del_proceso),
    referencia: str(row.referencia_del_proceso),
    entidad: str(row.entidad),
    nit_entidad: str(row.nit_entidad),
    orden_entidad: str(row.ordenentidad),
    departamento: str(row.departamento_entidad),
    ciudad: str(row.ciudad_entidad),
    nombre: str(row.nombre_del_procedimiento),
    descripcion: str(row.descripci_n_del_procedimiento),
    modalidad: str(row.modalidad_de_contratacion),
    fase: str(row.fase),
    estado: str(row.estado_del_procedimiento),
    estado_resumen: str(row.estado_resumen),
    precio_base: num(row.precio_base),
    duracion: num(row.duracion),
    unidad_duracion: str(row.unidad_de_duracion),
    fecha_publicacion: str(row.fecha_de_publicacion_del),
    fecha_recepcion: str(row.fecha_de_recepcion_de),
    fecha_apertura: str(row.fecha_de_apertura_de_respuesta),
    tipo_contrato: str(row.tipo_de_contrato),
    subtipo_contrato: str(row.subtipo_de_contrato),
    categorias_adicionales: str(row.categorias_adicionales),
    url_proceso: urlOf(row.urlproceso),
    raw: row,
    ...cat,
  };
}

// Full refresh: paginate the open-opportunity feed, upsert, close expired.
async function runIngest(db, opts = {}) {
  const dryRun = opts.dryRun || false;
  await schema.ensureSchema(db);
  const runId = dryRun ? null : await schema.startIngestRun(db, { dataset: DATASET, modalities: MODALITIES });
  let fetched = 0, upserted = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchJSON(pageURL(page * PAGE));
      if (!Array.isArray(rows) || rows.length === 0) break;
      fetched += rows.length;
      for (const row of rows) {
        const rec = buildRecord(row);
        if (!rec) continue;
        if (!dryRun) { await schema.upsertLicitacion(db, rec); upserted++; }
      }
      log(`page ${page}: +${rows.length} (fetched=${fetched}, upserted=${upserted})`);
      if (rows.length < PAGE) break;
    }
    const closed = dryRun ? 0 : await schema.closeExpired(db);
    if (!dryRun) await schema.finishIngestRun(db, runId, { status: "ok", fetched, upserted, closed });
    log(`DONE fetched=${fetched} upserted=${upserted} closed=${closed}${dryRun ? " (dry-run)" : ""}`);
    return { fetched, upserted, closed };
  } catch (err) {
    if (!dryRun && runId) await schema.finishIngestRun(db, runId, { status: "error", fetched, upserted, error: err.message });
    throw err;
  }
}

// Re-derive categories from stored raw rows (after editing overlay.json / unspsc.json).
async function recategorize(db) {
  await schema.ensureSchema(db);
  const res = await db.query(`SELECT id_proceso, raw FROM secop_licitaciones WHERE raw IS NOT NULL`);
  let updated = 0;
  for (const r of res.rows) {
    const cat = deriveCategory(r.raw || {});
    await db.query(
      `UPDATE secop_licitaciones
       SET unspsc_raw=$2, unspsc_code=$3, segment_code=$4, segment_name=$5,
           family_code=$6, overlay_categories=$7, updated_at=now()
       WHERE id_proceso=$1`,
      [r.id_proceso, cat.unspsc_raw, cat.unspsc_code, cat.segment_code, cat.segment_name, cat.family_code, cat.overlay_categories]
    );
    updated++;
  }
  log(`recategorized ${updated} rows`);
  return { updated };
}

module.exports = { runIngest, recategorize, buildRecord, MODALITIES };

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
  const task = args.includes("--recategorize")
    ? recategorize(db)
    : runIngest(db, { dryRun: args.includes("--dry-run") });
  task
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => { console.error("[secop-ingest] FAILED:", e.message); pool.end().finally(() => process.exit(1)); });
}
