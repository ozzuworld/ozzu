"use strict";

// Self-hosted tender-detail extraction (dir_1784406309892). Turns a SECOP pliego /
// estudios previos into structured JSON via Claude on King Kazuma's Max plan — the
// `claude` CLI headless (`-p`), auth from /root/.claude.json, no API key, flat-rate
// (feedback_claude_sdk_over_gemini). PDFs are read natively by Claude's Read tool
// (handles scanned docs via vision); no pdftotext needed.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const WORKROOT = process.env.SECOP_EXTRACT_WORKDIR || "/tmp/ozzu-bridge/secop-extract";
const TIMEOUT_MS = parseInt(process.env.SECOP_EXTRACT_TIMEOUT_MS) || 240000;
const MAX_DOCS = parseInt(process.env.SECOP_EXTRACT_MAX_DOCS) || 5;

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

function buildPrompt(source) {
  return (
    "Eres analista de licitaciones públicas de Colombia (SECOP II). " +
    source +
    "\nExtrae la información del proceso en JSON con este esquema EXACTO (usa arreglos vacíos si un dato no aparece; no inventes):\n" +
    SCHEMA_HINT +
    "\nResponde ÚNICAMENTE con el JSON válido, sin texto ni explicación adicional."
  );
}

// Parse the JSON object out of Claude's answer (may be fenced or have prose).
function parseJSONFromText(t) {
  t = String(t || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// Bound concurrent Claude sessions (not serial). Parallelism helps because the API
// round-trip has real queue-wait — but the CLI session itself is NOT free: it spawns a
// runtime and reads PDFs across many agentic turns (real CPU+RAM). On this no-swap 16GB
// box, 5 concurrent + a deploy build hit load ~117 and hung the bridge, so keep this
// conservative (default 3). Tune up with SECOP_CONCURRENCY only if the box has headroom.
const MAX_CONCURRENT = parseInt(process.env.SECOP_CONCURRENCY) || 3;
let _active = 0;
const _waiters = [];
function _acquire() {
  return new Promise((resolve) => {
    if (_active < MAX_CONCURRENT) { _active++; resolve(); }
    else _waiters.push(resolve);
  });
}
function _release() {
  _active--;
  if (_waiters.length && _active < MAX_CONCURRENT) { _active++; _waiters.shift()(); }
}
function runClaude(args, prompt, cwd) {
  return _acquire().then(() =>
    _runClaudeRaw(args, prompt, cwd).then(
      (v) => { _release(); return v; },
      (e) => { _release(); throw e; }
    )
  );
}

// Run the claude CLI headless; pipe the prompt on stdin, return the result text.
function _runClaudeRaw(args, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, { cwd, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("claude timeout")); }, TIMEOUT_MS);
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`claude spawn: ${e.message}`)); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${(err || out).slice(0, 200)}`));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(`claude error: ${String(j.result).slice(0, 200)}`));
        resolve(j.result || "");
      } catch (e) { reject(new Error(`claude output parse: ${e.message} :: ${out.slice(0, 150)}`)); }
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// Extract from concatenated document text (no file reading needed).
async function extractTenderDetail(text, opts = {}) {
  if (!text || text.trim().length < 200) throw new Error("document text too short to extract");
  const prompt = buildPrompt("A partir del siguiente texto de los documentos del proceso:\n\n" + text.slice(0, 200000));
  const result = await runClaude(["-p", "--output-format", "json", "--allowedTools", ""], prompt);
  return { ok: true, model: "claude", detail: parseJSONFromText(result) };
}

// Extract from PDF documents — Claude reads them directly (Read tool). docs = [{name, base64}].
async function extractTenderDetailFromDocs(docs, opts = {}) {
  if (!Array.isArray(docs) || docs.length === 0) throw new Error("no documents to extract");
  const work = path.join(WORKROOT, crypto.randomUUID());
  fs.mkdirSync(work, { recursive: true });
  try {
    const used = [];
    const files = [];
    for (const d of docs.slice(0, MAX_DOCS)) {
      if (!d.base64) continue;
      const fn = `doc${files.length + 1}.pdf`;
      fs.writeFileSync(path.join(work, fn), Buffer.from(d.base64, "base64"));
      files.push(fn);
      used.push(d.name);
    }
    if (files.length === 0) throw new Error("no valid PDF documents");
    const prompt = buildPrompt(
      `Lee y analiza los siguientes archivos PDF (pliego de condiciones / estudios previos / invitación) ubicados en el directorio actual: ${files.join(", ")}.`
    );
    const result = await runClaude(["-p", "--output-format", "json", "--allowedTools", "Read"], prompt, work);
    return { ok: true, model: "claude", detail: parseJSONFromText(result), docs_used: used };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Decision brief: synthesize the tech + financial implications from the extracted
// detail, tailored to Skyline (Herbert = senior connectivity/network + software eng).
const BRIEF_SCHEMA = `{
  "card": {
    "emoji": "un emoji que represente el objeto del contrato",
    "titulo": "título corto y claro de qué es (máx 6 palabras, no el código del proceso)",
    "contexto": "una sola línea de contexto útil para decidir de un vistazo"
  },
  "que_es": "1-2 frases claras: qué contrata la entidad y para qué",
  "implicaciones_tecnicas": {
    "resumen": "qué exige técnicamente y qué tan viable/complejo es para nosotros",
    "requiere": ["capacidad, tecnología o perfil concreto que haría falta"],
    "riesgos": ["riesgo o dificultad técnica relevante"]
  },
  "implicaciones_financieras": {
    "resumen": "lectura financiera: valor, margen probable y si compensa el esfuerzo",
    "costos_clave": ["costo o compromiso relevante, p.ej. garantía 10% de vigencia N"],
    "consideracion": "una frase: qué mirar antes de comprometer plata"
  },
  "recomendacion": { "decision": "go | no-go | revisar", "razon": "1 frase directa" }
}`;

async function generateBrief(detail, context = {}) {
  const payload = {
    entidad: context.entidad, modalidad: context.modalidad, valor: context.valor,
    competitividad: context.competitividad, objeto: detail.objeto,
    requisitos_habilitantes: detail.requisitos_habilitantes || detail.habilitantes,
    criterios_evaluacion: detail.criterios_evaluacion || detail.evaluacion,
    especificaciones: (detail.especificaciones_tecnicas || detail.especificaciones || []).slice(0, 25),
    garantias: detail.garantias, plazo: detail.plazo_ejecucion,
  };
  const prompt =
    "Eres asesor de licitaciones públicas para Skyline en Colombia. El decisor es un ingeniero senior de " +
    "conectividad/redes y software (puede ejecutar trabajo de TI, software, redes e ingeniería, remoto). " +
    "Con la siguiente información de un proceso SECOP II, redacta un BRIEF de decisión en JSON con este esquema EXACTO:\n" +
    BRIEF_SCHEMA +
    "\nSé conciso, directo y honesto sobre si conviene ofertar. Enfócate en IMPLICACIONES (técnicas y financieras), no en repetir datos. " +
    "Responde ÚNICAMENTE el JSON.\n\n=== DATOS ===\n" + JSON.stringify(payload);
  const result = await runClaude(["-p", "--output-format", "json", "--allowedTools", ""], prompt);
  return parseJSONFromText(result);
}

module.exports = { extractTenderDetail, extractTenderDetailFromDocs, generateBrief, SCHEMA_HINT };
