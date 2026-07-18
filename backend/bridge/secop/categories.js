"use strict";

// SECOP categorization: canonical UNSPSC (SECOP's own codigo_principal_de_categoria)
// + a tunable "relevant-to-us" overlay (overlay.json). Pure functions, no I/O beyond
// loading the two JSON config files once at require time.

const path = require("path");
const UNSPSC = require(path.join(__dirname, "unspsc.json"));
const OVERLAY = require(path.join(__dirname, "overlay.json"));

const SEGMENTS = UNSPSC.segments || {};
const OVERLAY_CATS = (OVERLAY.categories || []).map((c) => ({
  ...c,
  _segments: new Set(c.unspsc_segments || []),
  _families: new Set(c.unspsc_families || []),
  _keywords: (c.keywords || []).map(norm),
}));

// Lowercase + strip diacritics so "Videovigilancia" matches "video vigilancia" etc.
function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// "V1.86131900" -> "86131900"; "86131900" -> "86131900"; junk -> "".
function normalizeUnspsc(raw) {
  if (!raw) return "";
  const parts = String(raw).split(".");
  return parts[parts.length - 1].replace(/\D/g, "");
}

// Derive all category fields for one raw SECOP row.
function deriveCategory(row) {
  const unspscRaw = row.codigo_principal_de_categoria || null;
  const code = normalizeUnspsc(unspscRaw);
  const segmentCode = code.length >= 2 ? code.slice(0, 2) : null;
  const familyCode = code.length >= 4 ? code.slice(0, 4) : null;
  const segmentName = segmentCode ? SEGMENTS[segmentCode] || null : null;

  // Overlay tags: match by UNSPSC segment/family OR keyword in entidad+nombre+descripcion.
  const haystack = norm(
    [row.entidad, row.nombre_del_procedimiento, row.descripci_n_del_procedimiento].join(" ")
  );
  const overlay = [];
  for (const cat of OVERLAY_CATS) {
    const byCode =
      (segmentCode && cat._segments.has(segmentCode)) ||
      (familyCode && cat._families.has(familyCode));
    const byKeyword = cat._keywords.some((k) => k && haystack.includes(k));
    if (byCode || byKeyword) overlay.push(cat.name);
  }

  return {
    unspsc_raw: unspscRaw,
    unspsc_code: code || null,
    segment_code: segmentCode,
    segment_name: segmentName,
    family_code: familyCode,
    overlay_categories: overlay,
  };
}

// For seeding the reference table / powering the browse API.
function unspscSegmentList() {
  return Object.entries(SEGMENTS).map(([code, name]) => ({ code, name }));
}
function overlayCategoryList() {
  return OVERLAY_CATS.map((c) => ({
    name: c.name,
    emoji: c.emoji || null,
    unspsc_segments: c.unspsc_segments || [],
    unspsc_families: c.unspsc_families || [],
    keyword_count: (c.keywords || []).length,
  }));
}

module.exports = {
  norm,
  normalizeUnspsc,
  deriveCategory,
  unspscSegmentList,
  overlayCategoryList,
};
