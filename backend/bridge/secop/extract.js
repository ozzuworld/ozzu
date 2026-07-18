"use strict";

// Self-hosted tender-detail extraction (dir_1784397346001). Turns the text of a
// SECOP pliego / estudios previos into structured JSON via Gemini (GEMINI_API_KEY —
// same key June uses; no third-party licitaciones service). Proven 2026-07-18 on a
// real Estudios Previos: habilitantes/evaluación/garantías/especificaciones extracted.

const https = require("https");

const MODELS = (process.env.SECOP_EXTRACT_MODELS
  ? process.env.SECOP_EXTRACT_MODELS.split(",")
  : ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"]
).map((s) => s.trim());

const MAX_DOC_CHARS = parseInt(process.env.SECOP_EXTRACT_MAX_CHARS) || 200000;

// The structured shape we pull out of a tender's documents.
const SCHEMA_HINT = `{
  "objeto": "",
  "valor_estimado": "",
  "plazo_ejecucion": "",
  "lugar_ejecucion": "",
  "cronograma": [{"hito": "", "fecha": ""}],
  "requisitos_habilitantes": {"juridicos": [], "financieros": [], "tecnicos": [], "experiencia": []},
  "criterios_evaluacion": [{"factor": "", "puntaje": ""}],
  "especificaciones_tecnicas": [],
  "obligaciones": [],
  "garantias": [{"tipo": "", "porcentaje": "", "vigencia": ""}],
  "documentos_requeridos": []
}`;

function buildPrompt(text) {
  return (
    "Eres analista de licitaciones públicas de Colombia (SECOP II). A partir del texto de los " +
    "documentos del proceso (pliego de condiciones / estudios previos / invitación), extrae la " +
    "información en JSON con este esquema EXACTO (usa arreglos vacíos si un dato no aparece; no inventes):\n" +
    SCHEMA_HINT +
    "\nResponde SOLO con el JSON válido.\n\n=== DOCUMENTOS ===\n" +
    String(text || "").slice(0, MAX_DOC_CHARS)
  );
}

function callGemini(model, prompt, apiKey) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, timeout: 120000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          try {
            const j = JSON.parse(data);
            const txt = j.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!txt) return reject(new Error("Gemini: empty candidate"));
            resolve(JSON.parse(txt));
          } catch (e) {
            reject(new Error(`Gemini parse: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Gemini timeout")); });
    req.write(body);
    req.end();
  });
}

// Multimodal call: send PDF bytes straight to Gemini (no pdftotext needed — the
// bridge container has none, and Gemini reads PDFs natively incl. tables/scans).
function callGeminiDocs(model, parts, apiKey) {
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, timeout: 180000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          try {
            const j = JSON.parse(data);
            const txt = j.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!txt) return reject(new Error("Gemini: empty candidate"));
            resolve(JSON.parse(txt));
          } catch (e) {
            reject(new Error(`Gemini parse: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Gemini timeout")); });
    req.write(body);
    req.end();
  });
}

// Total inline payload cap (Gemini inline_data ~20MB request limit; leave headroom).
const MAX_INLINE_BYTES = parseInt(process.env.SECOP_EXTRACT_MAX_BYTES) || 15 * 1024 * 1024;

// Extract from PDF documents directly. docs = [{ name, base64 }] (PDF). Sends the
// most important docs up to the size cap. Returns { ok, model, detail, docs_used }.
async function extractTenderDetailFromDocs(docs, opts = {}) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  if (!Array.isArray(docs) || docs.length === 0) throw new Error("no documents to extract");

  const parts = [];
  const used = [];
  let bytes = 0;
  for (const d of docs) {
    if (!d.base64) continue;
    const sz = Math.floor((d.base64.length * 3) / 4);
    if (bytes + sz > MAX_INLINE_BYTES) continue;
    parts.push({ inline_data: { mime_type: "application/pdf", data: d.base64 } });
    used.push(d.name);
    bytes += sz;
  }
  if (parts.length === 0) throw new Error("all documents exceeded the size cap");
  parts.push({ text: buildPrompt("(ver documentos PDF adjuntos)") });

  let lastErr;
  for (const model of MODELS) {
    try {
      const detail = await callGeminiDocs(model, parts, apiKey);
      return { ok: true, model, detail, docs_used: used };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all extraction models failed");
}

// Extract structured tender detail from concatenated document text.
// Returns { ok, model, detail } or throws.
async function extractTenderDetail(text, opts = {}) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  if (!text || text.trim().length < 200) throw new Error("document text too short to extract");
  const prompt = buildPrompt(text);
  let lastErr;
  for (const model of MODELS) {
    try {
      const detail = await callGemini(model, prompt, apiKey);
      return { ok: true, model, detail };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all extraction models failed");
}

module.exports = { extractTenderDetail, extractTenderDetailFromDocs, MODELS, SCHEMA_HINT };
