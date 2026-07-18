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

// Run the claude CLI headless; pipe the prompt on stdin, return the result text.
function runClaude(args, prompt, cwd) {
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

module.exports = { extractTenderDetail, extractTenderDetailFromDocs, SCHEMA_HINT };
