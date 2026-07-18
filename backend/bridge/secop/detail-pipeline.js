"use strict";

// Build the structured tender detail for one licitación: pull its document list
// (Archivos dataset, keyed on id_del_portafolio), download the key PDFs (captcha-free),
// send them to Gemini (extract.js), fold in a cronograma fallback from the Socrata
// dates, and store in secop_tender_detail. Runs lazily (first open) + refreshable.

const https = require("https");
const schema = require("./schema");
const { extractTenderDetailFromDocs, generateBrief } = require("./extract");
const { socrataHeaders } = require("./socrata");

const DOCS_DATASET = process.env.SECOP_DOCS_DATASET || "dmgg-8hin";
const MAX_DOCS = parseInt(process.env.SECOP_DETAIL_MAX_DOCS) || 4;
const MAX_DOC_BYTES = parseInt(process.env.SECOP_DETAIL_MAX_DOC_BYTES) || 8 * 1024 * 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// Priority for which docs actually define the tender (higher = more important).
function docPriority(name) {
  const n = (name || "").toLowerCase();
  if (/pliego|condiciones|invitaci/.test(n)) return 5;
  if (/estudio.*previo|estudios previos/.test(n)) return 4;
  if (/requerimiento|especificac|anexo.*tecnic|ficha tecnica/.test(n)) return 3;
  if (/estudio|analisis del sector/.test(n)) return 2;
  return 0; // cotizaciones, CDP, resoluciones, formatos que llena el proponente, etc.
}

const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || null;

function fetchJSONOnce(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: socrataHeaders(), timeout: 60000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on("error", reject).on("timeout", function () { this.destroy(); reject(new Error("timeout")); });
  });
}

// datos.gov.co throttles anonymous callers with 503/429 — retry with backoff.
// A free Socrata app token (SOCRATA_APP_TOKEN) raises the limit and avoids this.
async function fetchJSON(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fetchJSONOnce(url); }
    catch (e) {
      lastErr = e;
      if (e.statusCode !== 503 && e.statusCode !== 429) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

function downloadBase64(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    https.get(url, { headers: { "User-Agent": UA }, timeout: 90000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBase64(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_DOC_BYTES) { res.destroy(); return reject(new Error("doc too large")); }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
    }).on("error", reject).on("timeout", function () { this.destroy(); reject(new Error("timeout")); });
  });
}

const urlOf = (v) => (v && typeof v === "object" ? v.url : v) || null;

// Cronograma fallback from the Socrata process dates when the docs don't yield one.
function ymd(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function cronogramaFromDates(lic) {
  const out = [];
  const push = (hito, v) => { const f = ymd(v); if (f) out.push({ hito, fecha: f }); };
  push("Publicación del proceso", lic.fecha_publicacion);
  push("Apertura de ofertas", lic.fecha_apertura);
  push("Cierre — presentación de ofertas", lic.fecha_recepcion);
  return out;
}

async function buildTenderDetail(db, idProceso) {
  const lic = await schema.getLicitacion(db, idProceso);
  if (!lic) throw new Error("licitación not found");
  const portfolio = lic.raw && lic.raw.id_del_portafolio;
  await schema.setTenderDetailStatus(db, idProceso, "building");

  try {
    // 1. Document list (dedup by filename)
    let docList = [];
    if (portfolio) {
      const rows = await fetchJSON(
        `https://www.datos.gov.co/resource/${DOCS_DATASET}.json?proceso=${encodeURIComponent(portfolio)}&$limit=60`
      );
      const seen = new Set();
      for (const r of rows) {
        const name = r.nombre_archivo || "";
        if (seen.has(name)) continue;
        seen.add(name);
        docList.push({
          name,
          ext: (r.extensi_n || "").toLowerCase(),
          size: Number(r.tamanno_archivo) || 0,
          url: urlOf(r.url_descarga_documento),
          fecha: r.fecha_carga || null,
        });
      }
    }

    // 2. Pick + download the key PDFs (priority desc, PDFs only for direct Gemini)
    const candidates = docList
      .filter((d) => d.ext === "pdf" && d.url && d.size <= MAX_DOC_BYTES)
      .map((d) => ({ ...d, prio: docPriority(d.name) }))
      .sort((a, b) => b.prio - a.prio || a.size - b.size)
      .slice(0, MAX_DOCS);

    const docs = [];
    for (const c of candidates) {
      try { docs.push({ name: c.name, base64: await downloadBase64(c.url) }); }
      catch (e) { /* skip a failed doc, keep going */ }
    }
    if (docs.length === 0) throw new Error("no downloadable PDF documents for this process");

    // 3. Extract with Gemini
    const { detail, model, docs_used } = await extractTenderDetailFromDocs(docs);

    // 4. Fold in fallbacks + the full document list for the UI
    if (!Array.isArray(detail.cronograma) || detail.cronograma.length === 0) {
      detail.cronograma = cronogramaFromDates(lic);
    }
    detail.documentos = docList.map((d) => ({ name: d.name, ext: d.ext, size: d.size, url: d.url }));
    detail.source_docs = docs_used;
    detail.model = model;

    await schema.upsertTenderDetail(db, idProceso, detail);

    // Decision brief: tech + financial implications (Claude, best-effort).
    try {
      const brief = await generateBrief(detail, {
        entidad: lic.entidad, modalidad: lic.modalidad, valor: lic.precio_base,
        competitividad: lic.competitividad,
      });
      await schema.setBrief(db, idProceso, brief);
    } catch (e) { /* detail already stored; brief can be regenerated */ }

    return { ok: true, model, docs_used, doc_count: docList.length };
  } catch (err) {
    await schema.setTenderDetailStatus(db, idProceso, "error", err.message);
    throw err;
  }
}

module.exports = { buildTenderDetail, docPriority, cronogramaFromDates };
