#!/usr/bin/env node
// One-shot hex → design-token replacement for dir_1779034939863.
// Walks frontend/app + frontend/components for .tsx/.ts files,
// replaces top hex literals with token references, adds the import if missing.
//
// Does NOT touch:
//   - frontend/lib/design-tokens.ts (the source)
//   - frontend/lib/format.ts (no hex there)
//   - any file in lib/ (could be intentional non-color hex)
//
// Safe — won't replace hex used inside non-string non-style contexts (it only
// matches inside double-quoted or single-quoted strings).

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const ROOTS = [
  path.join(REPO_ROOT, "frontend/app"),
  path.join(REPO_ROOT, "frontend/components"),
];

// Mapping: hex value (case-insensitive) → token reference (string to insert verbatim)
// Order matters — longer patterns first to avoid partial collisions.
const MAP = {
  // Brand / accent
  "#06b6d4": "colors.accent",
  "#06B6D4": "colors.accent",
  "#22d3ee": "colors.accentLight",
  "#22D3EE": "colors.accentLight",
  "#1db954": "colors.brand.spotify",
  "#1DB954": "colors.brand.spotify",
  "#a855f7": "colors.brand.purple",
  "#A855F7": "colors.brand.purple",
  "#3b82f6": "colors.brand.blue",
  "#3B82F6": "colors.brand.blue",
  "#f59e0b": "colors.brand.amber",
  "#F59E0B": "colors.brand.amber",
  "#eab308": "colors.brand.amberDeep",
  "#EAB308": "colors.brand.amberDeep",
  "#f97316": "colors.brand.orange",
  "#F97316": "colors.brand.orange",

  // Status / semantic
  "#22c55e": "colors.success",
  "#22C55E": "colors.success",
  "#ef4444": "colors.error",
  "#EF4444": "colors.error",

  // Gray scale (most-used variants)
  "#e5e5e5": "colors.gray[50]",
  "#E5E5E5": "colors.gray[50]",
  "#cbd5e1": "colors.gray[100]",
  "#CBD5E1": "colors.gray[100]",
  "#a3a3a3": "colors.gray[200]",
  "#A3A3A3": "colors.gray[200]",
  "#94a3b8": "colors.gray[250]",
  "#94A3B8": "colors.gray[250]",
  "#737373": "colors.gray[300]",
  "#525252": "colors.gray[400]",
  "#404040": "colors.gray[500]",
  "#333333": "colors.gray[600]",
  "#333": "colors.gray[600]",
  "#2a2a2a": "colors.gray[700]",
  "#2A2A2A": "colors.gray[700]",
  "#1a1a1a": "colors.gray[800]",
  "#1A1A1A": "colors.gray[800]",
  "#111111": "colors.gray[850]",
  "#111": "colors.gray[850]",
  "#0a0a0a": "colors.bg.base",
  "#0A0A0A": "colors.bg.base",
};

// File extensions we'll touch
const EXTS = new Set([".tsx", ".ts"]);

// Walk
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".expo" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (EXTS.has(path.extname(e.name))) yield full;
  }
}

function processFile(absPath) {
  const rel = path.relative(REPO_ROOT, absPath);
  // Skip the source of truth + format.ts
  if (rel.endsWith("design-tokens.ts") || rel.endsWith("format.ts")) return { rel, replaced: 0, importAdded: false };

  const orig = fs.readFileSync(absPath, "utf8");
  let updated = orig;
  let replaced = 0;

  for (const [hex, token] of Object.entries(MAP)) {
    // Match the hex inside a single OR double-quoted string only.
    // We KEEP the surrounding quotes-removed form (i.e. replace "X" → token)
    // by matching with quotes.
    const escaped = hex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(['"])${escaped}\\1`, "g");
    updated = updated.replace(re, () => {
      replaced++;
      return token;
    });
  }

  let importAdded = false;
  if (replaced > 0) {
    // Add the design-tokens `colors` import if not present
    const hasColorsImport = /\bimport\s*\{[^}]*\bcolors\b[^}]*\}\s*from\s*["']\.{1,2}\/.*design-tokens["']/.test(updated)
      || /\bimport\s*\{[^}]*\bcolors\b[^}]*\}\s*from\s*["']\.{1,3}\/.*lib\/design-tokens["']/.test(updated);

    if (!hasColorsImport) {
      // Compute the relative import path
      const fileDir = path.dirname(absPath);
      let importPath = path.relative(fileDir, path.join(REPO_ROOT, "frontend/lib/design-tokens"));
      if (!importPath.startsWith(".")) importPath = "./" + importPath;
      // Find the last top-level import to insert after; else top of file
      const importRe = /^import\s+[^;]+;?\s*$/m;
      const matches = [...updated.matchAll(/^import\s+[^;]+;\s*$/gm)];
      if (matches.length > 0) {
        const last = matches[matches.length - 1];
        const insertAt = last.index + last[0].length;
        updated = updated.slice(0, insertAt) + `\nimport { colors } from "${importPath}";` + updated.slice(insertAt);
      } else {
        updated = `import { colors } from "${importPath}";\n` + updated;
      }
      importAdded = true;
    }

    fs.writeFileSync(absPath, updated, "utf8");
  }

  return { rel, replaced, importAdded };
}

// Main
const summary = { filesChanged: 0, totalReplaced: 0, importsAdded: 0, files: [] };
for (const root of ROOTS) {
  for (const f of walk(root)) {
    const r = processFile(f);
    if (r.replaced > 0) {
      summary.filesChanged++;
      summary.totalReplaced += r.replaced;
      if (r.importAdded) summary.importsAdded++;
      summary.files.push(r);
    }
  }
}

console.log(`Files changed: ${summary.filesChanged}`);
console.log(`Total hex literals replaced: ${summary.totalReplaced}`);
console.log(`Imports added: ${summary.importsAdded}`);
console.log("\nTop 10 changed files:");
summary.files.sort((a, b) => b.replaced - a.replaced).slice(0, 10).forEach((f) => {
  console.log(`  ${f.replaced.toString().padStart(4)}  ${f.rel}${f.importAdded ? "  (+import)" : ""}`);
});
