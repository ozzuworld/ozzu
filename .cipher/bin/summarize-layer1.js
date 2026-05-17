#!/usr/bin/env node
// Cipher Layer 1 summary — collapses all four indexers into one Markdown digest.
// Cipher reads .cipher/layer1/SUMMARY.md before answering codebase-shape questions.
//
// Output: .cipher/layer1/SUMMARY.md
//
// Inputs:
//   .cipher/layer1/knip-frontend.json
//   .cipher/layer1/knip-backend.json
//   .cipher/layer1/depcruise-frontend.json
//   .cipher/layer1/depcruise-backend.json
//   .cipher/layer1/jscpd/jscpd-report.json
//   .cipher/layer1/repomap.txt (just file size)

const fs = require("fs");
const path = require("path");

const LAYER1 = path.resolve(__dirname, "../layer1");

const tryRead = (rel) => {
  const p = path.join(LAYER1, rel);
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
};

const tryStat = (rel) => {
  const p = path.join(LAYER1, rel);
  try { return fs.statSync(p); }
  catch { return null; }
};

const knipFE = tryRead("knip-frontend.json");
const knipBE = tryRead("knip-backend.json");
const depFE = tryRead("depcruise-frontend.json");
const depBE = tryRead("depcruise-backend.json");
const jscpd = tryRead("jscpd/jscpd-report.json");
const repomapStat = tryStat("repomap.txt");

const lines = [];
const push = (s) => lines.push(s);

push("# Cipher Layer 1 — Codebase Map Summary");
push("");
push(`Generated: ${new Date().toISOString()}`);
push("");
push("Cipher: **read this first** before answering questions about the codebase.");
push("Raw outputs live in `.cipher/layer1/` next to this file.");
push("");

// ── Repo map ──
push("## Repo map (`repomap.txt`)");
if (repomapStat) {
  push(`- Size: ${(repomapStat.size / 1024).toFixed(0)} KB`);
  push(`- Generated: ${repomapStat.mtime.toISOString()}`);
  push(`- Use: pass to LLM context when you need to grep across the whole repo at once`);
} else {
  push("- ⚠️ Missing — run `scripts/cipher-analyze.sh layer1`");
}
push("");

// ── Dead code (knip) ──
push("## Dead code (knip)");
push("");
const knipSection = (name, k) => {
  if (!k) { push(`### ${name}\n⚠️ Missing\n`); return; }
  const files = k.files || [];
  const issues = k.issues || [];
  push(`### ${name}`);
  push(`- **Orphan files (zero imports):** ${files.length}`);
  if (files.length > 0) {
    push("```");
    files.slice(0, 30).forEach((f) => push(`  ${f}`));
    if (files.length > 30) push(`  ... +${files.length - 30} more`);
    push("```");
  }
  // Issues are per-file; count types
  const typeCount = {};
  issues.forEach((it) => {
    (it.exports || []).forEach(() => typeCount.exports = (typeCount.exports || 0) + 1);
    (it.types || []).forEach(() => typeCount.types = (typeCount.types || 0) + 1);
    (it.unresolved || []).forEach(() => typeCount.unresolved = (typeCount.unresolved || 0) + 1);
    (it.dependencies || []).forEach(() => typeCount.dependencies = (typeCount.dependencies || 0) + 1);
  });
  push(`- **Unused symbols across ${issues.length} files:** ${Object.entries(typeCount).map(([k, v]) => `${v} ${k}`).join(", ") || "0"}`);
  push("");
};
knipSection("Frontend", knipFE);
knipSection("Backend bridge", knipBE);

// ── Dependency graph (depcruise) ──
push("## Import graph (dependency-cruiser)");
push("");
const depSection = (name, d) => {
  if (!d) { push(`### ${name}\n⚠️ Missing\n`); return; }
  const s = d.summary || {};
  const modules = d.modules || [];
  const violations = s.warn + s.error;
  push(`### ${name}`);
  push(`- Modules cruised: ${s.totalCruised}`);
  push(`- Dependencies: ${s.totalDependenciesCruised}`);
  push(`- Rule violations: ${violations} (warn=${s.warn}, error=${s.error})`);
  // Top "fan-in" modules — most imported
  const fanin = {};
  modules.forEach((m) => {
    (m.dependents || []).forEach((dep) => {
      fanin[m.source] = (fanin[m.source] || 0) + 1;
    });
  });
  const topImported = Object.entries(fanin).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topImported.length > 0) {
    push(`- **Most-imported modules (top 10):**`);
    push("```");
    topImported.forEach(([m, c]) => push(`  ${c.toString().padStart(3)} ← ${m}`));
    push("```");
  }
  // Orphans (no dependents and not entry)
  const orphans = modules.filter((m) => (m.dependents || []).length === 0 && !m.source.match(/(_layout|index|server|agent-spawner)\.(t|j)sx?$/));
  if (orphans.length > 0) {
    push(`- **Orphan modules (no dependents, not entry):** ${orphans.length}`);
    push("```");
    orphans.slice(0, 15).forEach((m) => push(`  ${m.source}`));
    if (orphans.length > 15) push(`  ... +${orphans.length - 15} more`);
    push("```");
  }
  push("");
};
depSection("Frontend", depFE);
depSection("Backend bridge", depBE);

// ── Copy-paste (jscpd) ──
push("## Copy-paste duplication (jscpd)");
push("");
if (jscpd) {
  const stats = jscpd.statistics || {};
  const total = stats.total || {};
  push(`- Total clones: ${total.clones || 0}`);
  push(`- Duplicated lines: ${total.duplicatedLines || 0} / ${total.lines || 0} (${total.percentage || 0}%)`);
  push(`- Duplicated tokens: ${total.duplicatedTokens || 0} / ${total.tokens || 0}`);
  const dupes = jscpd.duplicates || [];
  if (dupes.length > 0) {
    push("");
    push("**Top duplications (first 10):**");
    push("");
    dupes.slice(0, 10).forEach((d, i) => {
      const a = d.firstFile || {};
      const b = d.secondFile || {};
      push(`${i + 1}. \`${a.name || a.path}\` ↔ \`${b.name || b.path}\` (${d.lines || "?"} lines)`);
    });
  }
} else {
  push("⚠️ Missing — run `scripts/cipher-analyze.sh layer1`");
}
push("");

push("---");
push("");
push("**Next steps:**");
push("- Layer 2 (intent index): not yet implemented — see `scripts/cipher-analyze.sh layer2`");
push("- Layer 3 (drift checks): not yet implemented — see `scripts/cipher-analyze.sh layer3`");

fs.writeFileSync(path.join(LAYER1, "SUMMARY.md"), lines.join("\n") + "\n", "utf8");
console.log(`[summarize-layer1] wrote ${path.join(LAYER1, "SUMMARY.md")} (${lines.length} lines)`);
