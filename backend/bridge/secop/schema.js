"use strict";

// SECOP II data layer: table DDL (idempotent), reference-table seeding, and all
// query helpers used by both the ingester and the /secop API routes.
//
// `db` is any object exposing `query(text, params)` (the bridge db.js module, or a
// thin wrapper around a standalone pg Pool — see ingest.js). No pool is created here.

const categories = require("./categories");
const entityStats = require("./entity-stats");
const UNSPSC_FAMILIES = require("./unspsc-families.json");
const UNSPSC_CLASSES = require("./unspsc-classes.json");
const SCOPE = require("./scope.json");

// Relevance (the cheap pre-filter, no Claude): the tender's 6-digit UNSPSC CLASS is in the
// curated in-scope set AND the objeto does NOT match a scope-exclude keyword. We gate at the
// CLASS (6-digit) level, not the 4-digit family, because a family mixes lanes — e.g. family
// 8110 holds 811015 (civil engineering) next to 811115 (software engineering). The class is
// the first 6 digits of unspsc_code (the 8-digit commodity code SECOP tags each process
// with). The keyword excludes stay as a safety net for the rare off-lane tender that lands
// inside an in-scope class. Shared by the list API and the worker.
const EXCLUDE_RX = (SCOPE.exclude_keywords || [])
  .map((k) => String(k).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
function relevanceClause(a = "l") {
  const cls = `left(${a}.unspsc_code, 6) IN (SELECT code FROM secop_unspsc_classes WHERE relevant)`;
  if (!EXCLUDE_RX) return `(${cls})`;
  const objeto = `translate(lower(coalesce(${a}.nombre,'') || ' ' || coalesce(${a}.descripcion,'')), 'áéíóúñü', 'aeiounu')`;
  return `(${cls} AND ${objeto} !~ '${EXCLUDE_RX}')`;
}

// Columns written on ingest (search_tsv is GENERATED; first_seen/updated_at handled below).
const INSERT_COLS = [
  "id_proceso", "referencia", "entidad", "nit_entidad", "orden_entidad",
  "departamento", "ciudad", "nombre", "descripcion", "modalidad", "fase",
  "estado", "estado_resumen", "precio_base", "duracion", "unidad_duracion",
  "fecha_publicacion", "fecha_recepcion", "fecha_apertura", "tipo_contrato",
  "subtipo_contrato", "unspsc_raw", "unspsc_code", "segment_code", "segment_name",
  "family_code", "categorias_adicionales", "overlay_categories", "url_proceso", "raw",
];

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS secop_licitaciones (
      id_proceso             TEXT PRIMARY KEY,
      referencia             TEXT,
      entidad                TEXT,
      nit_entidad            TEXT,
      orden_entidad          TEXT,
      departamento           TEXT,
      ciudad                 TEXT,
      nombre                 TEXT,
      descripcion            TEXT,
      modalidad              TEXT,
      fase                   TEXT,
      estado                 TEXT,
      estado_resumen         TEXT,
      precio_base            NUMERIC,
      duracion               NUMERIC,
      unidad_duracion        TEXT,
      fecha_publicacion      TIMESTAMPTZ,
      fecha_recepcion        TIMESTAMPTZ,
      fecha_apertura         TIMESTAMPTZ,
      tipo_contrato          TEXT,
      subtipo_contrato       TEXT,
      unspsc_raw             TEXT,
      unspsc_code            TEXT,
      segment_code           TEXT,
      segment_name           TEXT,
      family_code            TEXT,
      categorias_adicionales TEXT,
      overlay_categories     TEXT[] DEFAULT '{}',
      url_proceso            TEXT,
      raw                    JSONB,
      is_open                BOOLEAN DEFAULT TRUE,
      first_seen             TIMESTAMPTZ DEFAULT now(),
      last_seen              TIMESTAMPTZ DEFAULT now(),
      updated_at             TIMESTAMPTZ DEFAULT now(),
      search_tsv             tsvector GENERATED ALWAYS AS (
        to_tsvector('spanish',
          coalesce(entidad,'') || ' ' || coalesce(nombre,'') || ' ' || coalesce(descripcion,''))
      ) STORED
    )
  `);

  for (const idx of [
    `CREATE INDEX IF NOT EXISTS idx_secop_modalidad    ON secop_licitaciones(modalidad)`,
    `CREATE INDEX IF NOT EXISTS idx_secop_departamento ON secop_licitaciones(departamento)`,
    `CREATE INDEX IF NOT EXISTS idx_secop_segment      ON secop_licitaciones(segment_code)`,
    `CREATE INDEX IF NOT EXISTS idx_secop_recepcion    ON secop_licitaciones(fecha_recepcion)`,
    `CREATE INDEX IF NOT EXISTS idx_secop_precio       ON secop_licitaciones(precio_base)`,
    `CREATE INDEX IF NOT EXISTS idx_secop_open         ON secop_licitaciones(is_open)`,
    `CREATE INDEX IF NOT EXISTS idx_secop_overlay      ON secop_licitaciones USING GIN(overlay_categories)`,
    `CREATE INDEX IF NOT EXISTS idx_secop_search       ON secop_licitaciones USING GIN(search_tsv)`,
  ]) {
    await db.query(idx);
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS secop_categories (
      kind   TEXT NOT NULL,
      code   TEXT NOT NULL,
      name   TEXT NOT NULL,
      emoji  TEXT,
      meta   JSONB DEFAULT '{}',
      PRIMARY KEY (kind, code)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS secop_ingest_runs (
      id          SERIAL PRIMARY KEY,
      started_at  TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ,
      status      TEXT DEFAULT 'running',
      fetched     INT DEFAULT 0,
      upserted    INT DEFAULT 0,
      closed      INT DEFAULT 0,
      error       TEXT,
      params      JSONB DEFAULT '{}'
    )
  `);

  // Structured tender detail extracted from the pliego/estudios (Gemini). One row
  // per licitación, built lazily on first open + refreshable.
  await db.query(`
    CREATE TABLE IF NOT EXISTS secop_tender_detail (
      id_proceso       TEXT PRIMARY KEY,
      objeto           TEXT,
      valor_estimado   TEXT,
      plazo_ejecucion  TEXT,
      lugar_ejecucion  TEXT,
      cronograma       JSONB DEFAULT '[]',
      habilitantes     JSONB DEFAULT '{}',
      evaluacion       JSONB DEFAULT '[]',
      especificaciones JSONB DEFAULT '[]',
      obligaciones     JSONB DEFAULT '[]',
      garantias        JSONB DEFAULT '[]',
      documentos       JSONB DEFAULT '[]',
      detail           JSONB DEFAULT '{}',
      source_docs      JSONB DEFAULT '[]',
      model            TEXT,
      status           TEXT DEFAULT 'pending',
      error            TEXT,
      extracted_at     TIMESTAMPTZ,
      updated_at       TIMESTAMPTZ DEFAULT now()
    )
  `);
  await db.query(`ALTER TABLE secop_tender_detail ADD COLUMN IF NOT EXISTS brief JSONB DEFAULT '{}'`);

  // Ofertas inbox decisions — reject clears it from the queue forever.
  await db.query(`
    CREATE TABLE IF NOT EXISTS secop_decisions (
      id_proceso TEXT PRIMARY KEY,
      decision   TEXT NOT NULL DEFAULT 'pending',
      decided_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Authoritative UNSPSC family index (names from OCDS) — defines the relevance filter.
  await db.query(`
    CREATE TABLE IF NOT EXISTS secop_unspsc_families (
      family_code      TEXT PRIMARY KEY,
      name             TEXT,
      display_category TEXT,
      relevant         BOOLEAN DEFAULT false
    )
  `);
  for (const f of UNSPSC_FAMILIES.families || []) {
    await db.query(
      `INSERT INTO secop_unspsc_families (family_code, name, display_category, relevant)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (family_code) DO UPDATE SET name=EXCLUDED.name, display_category=EXCLUDED.display_category, relevant=EXCLUDED.relevant`,
      [f.code, f.name, f.display, f.relevant === true]
    );
  }

  // Authoritative UNSPSC CLASS (6-digit) scope map — the precise pre-filter (dir_1784416887835).
  // Gates the expensive Claude analysis: only tenders whose 6-digit class is relevant here
  // reach it. Curated by lane (services / software / cybersecurity / connectivity / network
  // gear); classes not listed are NOT relevant by default. Mirrors the families table above;
  // reseeded idempotently on boot, so editing unspsc-classes.json + restarting retunes it.
  await db.query(`
    CREATE TABLE IF NOT EXISTS secop_unspsc_classes (
      code     TEXT PRIMARY KEY,
      label    TEXT,
      relevant BOOLEAN DEFAULT false
    )
  `);
  for (const c of UNSPSC_CLASSES.classes || []) {
    await db.query(
      `INSERT INTO secop_unspsc_classes (code, label, relevant)
       VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label, relevant=EXCLUDED.relevant`,
      [c.code, c.label, c.relevant === true]
    );
  }

  // Per-entity historical competitiveness (single-bidder rate) — powers the score.
  await db.query(`
    CREATE TABLE IF NOT EXISTS secop_entity_stats (
      nit_entidad       TEXT PRIMARY KEY,
      adjudicated_total INT DEFAULT 0,
      single_bidder     INT DEFAULT 0,
      avg_bidders       NUMERIC,
      single_rate       NUMERIC,
      updated_at        TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Single-row runtime control for the pre-analysis worker (dir_1784646309888). The worker
  // reads SECOP_WORKER env only once at boot; this DB flag is what the app's play/pause
  // button flips at runtime (checked every tick), so it survives across restarts. Default
  // = paused (false) — the worker spends King Kazuma's Claude Max quota, so it must be
  // manually driven. Env SECOP_WORKER=off is still an emergency HARD kill above this.
  await db.query(`
    CREATE TABLE IF NOT EXISTS secop_worker_state (
      id         SMALLINT PRIMARY KEY DEFAULT 1,
      enabled    BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      CONSTRAINT secop_worker_singleton CHECK (id = 1)
    )
  `);
  await db.query(`INSERT INTO secop_worker_state (id, enabled) VALUES (1, false) ON CONFLICT (id) DO NOTHING`);

  // Link column on ventures (business_projects) so a licitación can become a venture.
  // business_projects is created earlier in db.js init(); guard in case of ordering.
  try {
    await db.query(`ALTER TABLE business_projects ADD COLUMN IF NOT EXISTS secop_id TEXT`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_business_projects_secop ON business_projects(secop_id)`);
  } catch (e) {
    console.error("[secop] business_projects link column skipped:", e.message);
  }

  await seedCategories(db);
}

// Idempotent upsert of the reference taxonomy (UNSPSC segments + overlay defs).
async function seedCategories(db) {
  for (const s of categories.unspscSegmentList()) {
    await db.query(
      `INSERT INTO secop_categories (kind, code, name) VALUES ('unspsc_segment', $1, $2)
       ON CONFLICT (kind, code) DO UPDATE SET name = EXCLUDED.name`,
      [s.code, s.name]
    );
  }
  for (const o of categories.overlayCategoryList()) {
    await db.query(
      `INSERT INTO secop_categories (kind, code, name, emoji, meta)
       VALUES ('overlay', $1, $2, $3, $4)
       ON CONFLICT (kind, code) DO UPDATE SET name=EXCLUDED.name, emoji=EXCLUDED.emoji, meta=EXCLUDED.meta`,
      [o.name, o.name, o.emoji, JSON.stringify({ unspsc_segments: o.unspsc_segments, unspsc_families: o.unspsc_families })]
    );
  }
}

// Upsert one normalized record (from ingest.js buildRecord). Last-write-wins; reseen
// rows are re-opened and re-categorized. first_seen is preserved on conflict.
async function upsertLicitacion(db, rec) {
  const ph = INSERT_COLS.map((_, i) => `$${i + 1}`).join(", ");
  const updates = INSERT_COLS.filter((c) => c !== "id_proceso")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  const vals = INSERT_COLS.map((c) => {
    if (c === "raw") return rec.raw == null ? null : JSON.stringify(rec.raw);
    return rec[c] === undefined ? null : rec[c];
  });
  await db.query(
    `INSERT INTO secop_licitaciones (${INSERT_COLS.join(", ")})
     VALUES (${ph})
     ON CONFLICT (id_proceso) DO UPDATE SET
       ${updates}, is_open = TRUE, last_seen = now(), updated_at = now()`,
    vals
  );
}

// Mark opportunities whose offer deadline has passed as closed (kept for history).
async function closeExpired(db) {
  const r = await db.query(
    `UPDATE secop_licitaciones SET is_open = FALSE, updated_at = now()
     WHERE is_open = TRUE AND fecha_recepcion IS NOT NULL AND fecha_recepcion < now()`
  );
  return r.rowCount || 0;
}

// ── Ingest-run bookkeeping ──
async function startIngestRun(db, params) {
  const r = await db.query(
    `INSERT INTO secop_ingest_runs (params) VALUES ($1) RETURNING id`,
    [JSON.stringify(params || {})]
  );
  return r.rows[0].id;
}
async function finishIngestRun(db, id, patch) {
  await db.query(
    `UPDATE secop_ingest_runs
     SET finished_at = now(), status = $2, fetched = $3, upserted = $4, closed = $5, error = $6
     WHERE id = $1`,
    [id, patch.status, patch.fetched || 0, patch.upserted || 0, patch.closed || 0, patch.error || null]
  );
}
async function lastIngestRun(db) {
  const r = await db.query(`SELECT * FROM secop_ingest_runs ORDER BY id DESC LIMIT 1`);
  return r.rows[0] || null;
}

// ── Read API used by routes/secop.js ──
const SORTS = {
  deadline: "fecha_recepcion ASC NULLS LAST",
  newest: "fecha_publicacion DESC NULLS LAST",
  value_desc: "precio_base DESC NULLS LAST",
  value_asc: "precio_base ASC NULLS LAST",
  seen: "first_seen DESC",
  competitividad: "COALESCE(es.single_rate, 0.35) ASC, fecha_recepcion ASC NULLS LAST",
};

async function listLicitaciones(db, f = {}) {
  const where = [];
  const args = [];
  const add = (sql, val) => { args.push(val); where.push(sql.replace("?", `$${args.length}`)); };

  if (f.all !== true && f.all !== "true") where.push("is_open = TRUE");
  if (f.relevant === true || f.relevant === "true") {
    where.push(relevanceClause("l"));
  }
  if (f.inbox === true || f.inbox === "true") {
    where.push("NOT EXISTS (SELECT 1 FROM secop_decisions d WHERE d.id_proceso = l.id_proceso AND d.decision IN ('rejected','accepted'))");
  }
  if (f.analyzed === true || f.analyzed === "true") {
    where.push("EXISTS (SELECT 1 FROM secop_tender_detail t WHERE t.id_proceso = l.id_proceso AND t.status = 'ok' AND t.brief ? 'recomendacion')");
  }
  if (f.segment) add("segment_code = ?", String(f.segment));
  if (f.overlay) add("? = ANY(overlay_categories)", String(f.overlay));
  if (f.modalidad) add("modalidad = ?", String(f.modalidad));
  if (f.departamento) add("departamento = ?", String(f.departamento));
  if (f.entidad) add("entidad ILIKE ?", `%${f.entidad}%`);
  if (f.min_value) add("precio_base >= ?", Number(f.min_value));
  if (f.max_value) add("precio_base <= ?", Number(f.max_value));
  if (f.q) add("search_tsv @@ plainto_tsquery('spanish', ?)", String(f.q));

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = SORTS[f.sort] || SORTS.deadline;
  const limit = Math.min(Math.max(parseInt(f.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(f.offset) || 0, 0);

  const totalRes = await db.query(`SELECT count(*)::int AS n FROM secop_licitaciones l ${whereSql}`, args);
  const rowsRes = await db.query(
    `SELECT l.id_proceso, l.referencia, l.entidad, l.departamento, l.ciudad, l.nombre, l.modalidad,
            l.estado_resumen, l.precio_base, l.fecha_publicacion, l.fecha_recepcion,
            l.unspsc_code, l.segment_code, l.segment_name, l.overlay_categories, l.url_proceso, l.is_open,
            bp.id AS linked_venture_id, uf.display_category AS family_display,
            es.adjudicated_total AS es_adj, es.single_rate AS es_rate, es.avg_bidders AS es_avg,
            td.brief->'card' AS card, td.brief->'recomendacion'->>'decision' AS reco
     FROM secop_licitaciones l
     LEFT JOIN business_projects bp ON bp.secop_id = l.id_proceso AND bp.status <> 'archived'
     LEFT JOIN secop_entity_stats es ON es.nit_entidad = l.nit_entidad
     LEFT JOIN secop_unspsc_families uf ON uf.family_code = l.family_code
     LEFT JOIN secop_tender_detail td ON td.id_proceso = l.id_proceso
     ${whereSql}
     ORDER BY ${orderSql}
     LIMIT ${limit} OFFSET ${offset}`,
    args
  );
  const items = rowsRes.rows.map((r) => {
    const { es_adj, es_rate, es_avg, ...rest } = r;
    const stat = es_adj != null ? { adjudicated_total: es_adj, single_rate: es_rate, avg_bidders: es_avg } : null;
    return { ...rest, competitividad: entityStats.scoreTender(rest, stat) };
  });
  return { total: totalRes.rows[0].n, limit, offset, items };
}

async function getLicitacion(db, id) {
  const r = await db.query(
    `SELECT l.*, bp.id AS linked_venture_id,
            es.adjudicated_total AS es_adj, es.single_rate AS es_rate, es.avg_bidders AS es_avg
     FROM secop_licitaciones l
     LEFT JOIN business_projects bp ON bp.secop_id = l.id_proceso AND bp.status <> 'archived'
     LEFT JOIN secop_entity_stats es ON es.nit_entidad = l.nit_entidad
     WHERE l.id_proceso = $1`,
    [id]
  );
  const row = r.rows[0];
  if (!row) return null;
  const { es_adj, es_rate, es_avg, ...rest } = row;
  const stat = es_adj != null ? { adjudicated_total: es_adj, single_rate: es_rate, avg_bidders: es_avg } : null;
  return { ...rest, competitividad: entityStats.scoreTender(rest, stat) };
}

async function browseCategories(db, openOnly = true) {
  const openClause = openOnly ? "l.is_open = TRUE AND" : "";
  const unspsc = await db.query(
    `SELECT segment_code, segment_name, count(*)::int AS count,
            coalesce(sum(precio_base),0)::numeric AS total_value
     FROM secop_licitaciones l
     WHERE ${openClause} segment_code IS NOT NULL
     GROUP BY segment_code, segment_name
     ORDER BY count DESC`
  );
  const overlay = await db.query(
    `SELECT cat AS name, count(*)::int AS count,
            coalesce(sum(precio_base),0)::numeric AS total_value
     FROM secop_licitaciones l
     CROSS JOIN LATERAL unnest(l.overlay_categories) AS cat
     WHERE ${openClause} cardinality(l.overlay_categories) > 0
     GROUP BY cat
     ORDER BY count DESC`
  );
  return { unspsc: unspsc.rows, overlay: overlay.rows };
}

async function getStats(db) {
  const [open, all, byDept, run, distinctEnt] = await Promise.all([
    db.query(`SELECT count(*)::int AS n, coalesce(sum(precio_base),0)::numeric AS v FROM secop_licitaciones WHERE is_open = TRUE`),
    db.query(`SELECT count(*)::int AS n FROM secop_licitaciones`),
    db.query(`SELECT departamento, count(*)::int AS count FROM secop_licitaciones WHERE is_open = TRUE AND departamento IS NOT NULL GROUP BY departamento ORDER BY count DESC LIMIT 15`),
    lastIngestRun(db),
    db.query(`SELECT count(DISTINCT entidad)::int AS n FROM secop_licitaciones WHERE is_open = TRUE`),
  ]);
  return {
    open_count: open.rows[0].n,
    open_total_value: open.rows[0].v,
    all_count: all.rows[0].n,
    distinct_entities: distinctEnt.rows[0].n,
    by_departamento: byDept.rows,
    last_ingest: run,
  };
}

// ── Tender detail (extracted) ──
async function getTenderDetail(db, id) {
  const r = await db.query(`SELECT * FROM secop_tender_detail WHERE id_proceso = $1`, [id]);
  return r.rows[0] || null;
}

async function setTenderDetailStatus(db, id, status, error) {
  await db.query(
    `INSERT INTO secop_tender_detail (id_proceso, status, error, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id_proceso) DO UPDATE SET status = $2, error = $3, updated_at = now()`,
    [id, status, error || null]
  );
}

async function upsertTenderDetail(db, id, d) {
  await db.query(
    `INSERT INTO secop_tender_detail
       (id_proceso, objeto, valor_estimado, plazo_ejecucion, lugar_ejecucion,
        cronograma, habilitantes, evaluacion, especificaciones, obligaciones,
        garantias, documentos, detail, source_docs, model, status, error, extracted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ok',NULL,now(),now())
     ON CONFLICT (id_proceso) DO UPDATE SET
       objeto=EXCLUDED.objeto, valor_estimado=EXCLUDED.valor_estimado,
       plazo_ejecucion=EXCLUDED.plazo_ejecucion, lugar_ejecucion=EXCLUDED.lugar_ejecucion,
       cronograma=EXCLUDED.cronograma, habilitantes=EXCLUDED.habilitantes,
       evaluacion=EXCLUDED.evaluacion, especificaciones=EXCLUDED.especificaciones,
       obligaciones=EXCLUDED.obligaciones, garantias=EXCLUDED.garantias,
       documentos=EXCLUDED.documentos, detail=EXCLUDED.detail, source_docs=EXCLUDED.source_docs,
       model=EXCLUDED.model, status='ok', error=NULL, extracted_at=now(), updated_at=now()`,
    [
      id, d.objeto || null, d.valor_estimado || null, d.plazo_ejecucion || null, d.lugar_ejecucion || null,
      JSON.stringify(d.cronograma || []), JSON.stringify(d.requisitos_habilitantes || d.habilitantes || {}),
      JSON.stringify(d.criterios_evaluacion || d.evaluacion || []), JSON.stringify(d.especificaciones_tecnicas || d.especificaciones || []),
      JSON.stringify(d.obligaciones || []), JSON.stringify(d.garantias || []),
      JSON.stringify(d.documentos || []), JSON.stringify(d.detail || d || {}),
      JSON.stringify(d.source_docs || []), d.model || null,
    ]
  );
}

async function setBrief(db, id, brief) {
  await db.query(`UPDATE secop_tender_detail SET brief = $2, updated_at = now() WHERE id_proceso = $1`, [id, JSON.stringify(brief || {})]);
}

async function setDecision(db, id, decision) {
  await db.query(
    `INSERT INTO secop_decisions (id_proceso, decision, decided_at) VALUES ($1, $2, now())
     ON CONFLICT (id_proceso) DO UPDATE SET decision = $2, decided_at = now()`,
    [id, decision]
  );
}

// Count of tenders the worker will still FULL-analyze — same predicate as worker.js pickFull
// (in-scope + open + undecided + no ok/recent-building/recent-error detail). This is what the
// app shows as "pending", so the token estimate reflects real work, not the raw open backlog.
async function countPendingFull(db) {
  const r = await db.query(`
    SELECT count(*)::int AS n
    FROM secop_licitaciones l
    WHERE l.is_open
      AND ${relevanceClause("l")}
      AND NOT EXISTS (SELECT 1 FROM secop_decisions d
                      WHERE d.id_proceso = l.id_proceso AND d.decision IN ('rejected','accepted'))
      AND NOT EXISTS (SELECT 1 FROM secop_tender_detail t
                      WHERE t.id_proceso = l.id_proceso
                        AND (t.status = 'ok'
                          OR (t.status = 'building' AND t.updated_at > now() - interval '30 minutes')
                          OR (t.status = 'error'    AND t.updated_at > now() - interval '1 hour')))`);
  return r.rows[0].n;
}

// Count of in-scope open tenders already analyzed OK — for the "X ya analizadas" context line.
async function countAnalyzedOk(db) {
  const r = await db.query(`
    SELECT count(*)::int AS n
    FROM secop_tender_detail t
    JOIN secop_licitaciones l ON l.id_proceso = t.id_proceso
    WHERE t.status = 'ok' AND l.is_open AND ${relevanceClause("l")}`);
  return r.rows[0].n;
}

async function getWorkerState(db) {
  try {
    const r = await db.query(`SELECT enabled, updated_at, updated_by FROM secop_worker_state WHERE id = 1`);
    return r.rows[0] || { enabled: false, updated_at: null, updated_by: null };
  } catch (e) {
    return { enabled: false, updated_at: null, updated_by: null }; // table not yet created
  }
}

async function setWorkerState(db, enabled, by) {
  const r = await db.query(
    `INSERT INTO secop_worker_state (id, enabled, updated_at, updated_by)
     VALUES (1, $1, now(), $2)
     ON CONFLICT (id) DO UPDATE SET enabled = $1, updated_at = now(), updated_by = $2
     RETURNING enabled, updated_at, updated_by`,
    [!!enabled, by || null]
  );
  return r.rows[0];
}

module.exports = {
  INSERT_COLS,
  ensureSchema,
  seedCategories,
  relevanceClause,
  setBrief,
  setDecision,
  countPendingFull,
  countAnalyzedOk,
  getWorkerState,
  setWorkerState,
  upsertLicitacion,
  closeExpired,
  startIngestRun,
  finishIngestRun,
  lastIngestRun,
  listLicitaciones,
  getLicitacion,
  browseCategories,
  getStats,
  getTenderDetail,
  setTenderDetailStatus,
  upsertTenderDetail,
};
