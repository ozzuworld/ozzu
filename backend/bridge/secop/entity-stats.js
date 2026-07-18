"use strict";

// Competitiveness / "amarrado-risk" scoring (dir_1784401815863). The strongest
// data-driven proxy for a rigged process is a low bidder count, so we precompute
// each contracting entity's historical single-bidder rate from adjudicated processes
// (field `proveedores_unicos_con` = distinct bidders) and score open tenders against it.
// Single-bidder is a PROXY, not proof — surfaced honestly in the UI.

const https = require("https");
const { socrataHeaders } = require("./socrata");

const DATASET = process.env.SECOP_DATASET || "p6dx-8zbt";
const BASE = `https://www.datos.gov.co/resource/${DATASET}.json`;
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || null;
const MIN_HISTORY = parseInt(process.env.SECOP_ENTITY_MIN_HISTORY) || 5;

// National single-bidder baselines by modality (computed 2026-07-18 from adjudicated
// data) — the fallback when an entity has too little history of its own.
const MODALITY_SINGLE_RATE = {
  "Mínima cuantía": 0.35,
  "Selección abreviada subasta inversa": 0.11,
  "Contratación régimen especial (con ofertas)": 0.26,
  "Selección Abreviada de Menor Cuantía": 0.37,
  "Licitación pública": 0.13,
  "Licitación pública Obra Publica": 0.07,
  "Concurso de méritos abierto": 0.22,
  "Seleccion Abreviada Menor Cuantia Sin Manifestacion Interes": 0.14,
  "Licitación Pública Acuerdo Marco de Precios": 0.0,
};
const DEFAULT_RATE = 0.35;

function labelFor(score) {
  if (score >= 70) return "Competitivo";
  if (score >= 45) return "Moderado";
  return "Riesgo amarrado";
}

// Score one tender. stat = row from secop_entity_stats (or null). Pure.
function scoreTender(lic, stat) {
  let rate, basis, avg = null, n = 0;
  if (stat && stat.adjudicated_total >= MIN_HISTORY) {
    rate = Number(stat.single_rate);
    avg = stat.avg_bidders != null ? Number(stat.avg_bidders) : null;
    n = Number(stat.adjudicated_total);
    basis = "entidad";
  } else {
    rate = MODALITY_SINGLE_RATE[lic.modalidad] ?? DEFAULT_RATE;
    n = stat ? Number(stat.adjudicated_total) : 0;
    basis = "modalidad";
  }
  const score = Math.round(100 * (1 - rate));
  return {
    score,
    label: labelFor(score),
    single_rate: Math.round(rate * 100),
    avg_bidders: avg != null ? Math.round(avg * 10) / 10 : null,
    adjudicated_total: n,
    basis,
  };
}

function fetchJSON(url, tries = 4) {
  const once = () =>
    new Promise((resolve, reject) => {
      https.get(url, { headers: socrataHeaders(), timeout: 120000 }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const e = new Error(`HTTP ${res.statusCode}`);
            e.statusCode = res.statusCode;
            return reject(e);
          }
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      }).on("error", reject).on("timeout", function () { this.destroy(); reject(new Error("timeout")); });
    });
  return (async () => {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await once(); }
      catch (e) { last = e; if (e.statusCode !== 503 && e.statusCode !== 429) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
    }
    throw last;
  })();
}

// Precompute every entity's historical competitiveness (2 grouped queries → upsert).
async function buildEntityStats(db) {
  const F = "proveedores_unicos_con";
  const totUrl = `${BASE}?$select=nit_entidad,count(*) as n,avg(${F}) as avg_b&$where=estado_resumen='Adjudicado' AND ${F}>0&$group=nit_entidad&$limit=50000`;
  const sngUrl = `${BASE}?$select=nit_entidad,count(*) as s&$where=estado_resumen='Adjudicado' AND ${F}=1&$group=nit_entidad&$limit=50000`;
  const [tot, sng] = await Promise.all([fetchJSON(encodeURI(totUrl)), fetchJSON(encodeURI(sngUrl))]);

  const single = {};
  for (const r of sng) single[r.nit_entidad] = parseInt(r.s) || 0;

  const rows = [];
  for (const r of tot) {
    const nit = r.nit_entidad;
    if (!nit) continue;
    const n = parseInt(r.n) || 0;
    const avg = parseFloat(r.avg_b) || 0;
    const s = single[nit] || 0;
    rows.push([nit, n, s, avg, n ? s / n : 0]);
  }

  // Chunked upsert
  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const vals = [];
    const ph = chunk
      .map((row, j) => {
        const b = j * 5;
        vals.push(...row);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},now())`;
      })
      .join(",");
    await db.query(
      `INSERT INTO secop_entity_stats (nit_entidad, adjudicated_total, single_bidder, avg_bidders, single_rate, updated_at)
       VALUES ${ph}
       ON CONFLICT (nit_entidad) DO UPDATE SET
         adjudicated_total=EXCLUDED.adjudicated_total, single_bidder=EXCLUDED.single_bidder,
         avg_bidders=EXCLUDED.avg_bidders, single_rate=EXCLUDED.single_rate, updated_at=now()`,
      vals
    );
    upserted += chunk.length;
  }
  return { entities: upserted };
}

module.exports = { scoreTender, buildEntityStats, MODALITY_SINGLE_RATE, labelFor };
