#!/usr/bin/env node
// Layer 3 — drift / consistency checks. Custom AST/regex rules catching
// the patterns Cipher keeps missing.
//
// Output: .cipher/layer3/drift-report.json + .cipher/layer3/SUMMARY.md
//
// Rules are inlined here. Each rule:
//   { name, severity, files (glob), pattern (regex or function), report }

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const LAYER3_DIR = path.resolve(__dirname, "../layer3");

function* walk(dir, exclude = new Set(["node_modules", ".expo", "android", "ios", "build", "dist", ".cipher", ".git"])) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (exclude.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, exclude);
    else if (e.isFile()) yield full;
  }
}

function relPath(abs) { return path.relative(REPO_ROOT, abs); }

// ── RULES ────────────────────────────────────────────────────────

const rules = {
  // ── Hardcoded hex colors in component files (except design-tokens.ts) ──
  "hardcoded-hex-color": (files) => {
    const findings = [];
    const allowedFiles = ["frontend/lib/design-tokens.ts"];
    const re = /["']#[0-9a-fA-F]{3,8}["']/g;
    for (const f of files) {
      const rel = relPath(f);
      if (!rel.match(/^frontend\/(app|components)\/.*\.tsx?$/)) continue;
      if (allowedFiles.includes(rel)) continue;
      const content = fs.readFileSync(f, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        let m;
        const lineRe = /["']#[0-9a-fA-F]{3,8}["']/g;
        while ((m = lineRe.exec(line))) {
          findings.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 120), match: m[0] });
        }
      });
    }
    return findings;
  },

  // ── TOP_BAR_HEIGHT / similar layout constants redefined per file ──
  "duplicated-layout-constants": (files) => {
    const findings = {};
    const constNames = ["TOP_BAR_HEIGHT", "TAB_BAR_HEIGHT", "BOTTOM_BAR_HEIGHT", "HEADER_HEIGHT"];
    const re = new RegExp(`\\bconst\\s+(${constNames.join("|")})\\s*=\\s*([0-9]+)`);
    for (const f of files) {
      const rel = relPath(f);
      if (!rel.match(/^frontend\/.*\.tsx?$/)) continue;
      const content = fs.readFileSync(f, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const m = line.match(re);
        if (m) {
          const name = m[1];
          findings[name] = findings[name] || [];
          findings[name].push({ file: rel, line: i + 1, value: m[2] });
        }
      });
    }
    // Only return constants defined in 2+ places
    const out = [];
    for (const [name, defs] of Object.entries(findings)) {
      if (defs.length >= 2) {
        out.push({ name, count: defs.length, definitions: defs });
      }
    }
    return out;
  },

  // ── Time/format helpers defined per screen instead of shared ──
  "duplicated-format-helpers": (files) => {
    const findings = {};
    const fnNames = ["relativeTime", "formatDate", "formatTime", "formatDuration", "formatBytes", "formatCOP"];
    const re = new RegExp(`\\bfunction\\s+(${fnNames.join("|")})\\s*\\(`);
    for (const f of files) {
      const rel = relPath(f);
      if (!rel.match(/^frontend\/.*\.(tsx?|jsx?)$/)) continue;
      const content = fs.readFileSync(f, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const m = line.match(re);
        if (m) {
          const name = m[1];
          findings[name] = findings[name] || [];
          findings[name].push({ file: rel, line: i + 1 });
        }
      });
    }
    const out = [];
    for (const [name, defs] of Object.entries(findings)) {
      if (defs.length >= 2) {
        out.push({ name, count: defs.length, definitions: defs });
      }
    }
    return out;
  },

  // ── router.push("/x") where /x doesn't exist ──
  "broken-route-references": (files) => {
    // Build set of existing routes
    const appDir = path.join(REPO_ROOT, "frontend/app");
    const existing = new Set();
    for (const f of walk(appDir)) {
      const rel = path.relative(appDir, f);
      if (!rel.match(/\.tsx?$/)) continue;
      const route = "/" + rel.replace(/\.(tsx?|jsx?)$/, "").replace(/\(tabs\)\//, "").replace(/\/_layout$/, "").replace(/\/index$/, "");
      existing.add(route);
      // Also accept without trailing /index variants
      existing.add(route.replace(/\/\[.*\]/, ""));
    }
    existing.add("/"); // root

    const findings = [];
    const re = /router\.(push|replace|navigate)\s*\(\s*["']([^"']+)["']/g;
    for (const f of files) {
      const rel = relPath(f);
      if (!rel.match(/\.(tsx?|jsx?)$/)) continue;
      const content = fs.readFileSync(f, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        let m;
        const lineRe = /router\.(push|replace|navigate)\s*\(\s*["']([^"'#?]+)/g;
        while ((m = lineRe.exec(line))) {
          let route = m[2];
          if (!route.startsWith("/")) continue;
          // Strip params like /chat/[jid] → /chat
          const base = route.split("/").slice(0, 3).join("/");
          // Check both exact and base
          const candidates = [route, route.replace(/\/$/, ""), base];
          const found = candidates.some((c) => existing.has(c) || [...existing].some((e) => e.startsWith(c + "/") || c.startsWith(e + "/")));
          if (!found) {
            findings.push({ file: rel, line: i + 1, route, snippet: line.trim().slice(0, 120) });
          }
        }
      });
    }
    return findings;
  },

  // ── HamburgerMenu / shortcut tile entries → check route exists ──
  "broken-menu-references": (files) => {
    const appDir = path.join(REPO_ROOT, "frontend/app");
    const existing = new Set();
    for (const f of walk(appDir)) {
      const rel = path.relative(appDir, f);
      if (!rel.match(/\.tsx?$/)) continue;
      const route = "/" + rel.replace(/\.(tsx?|jsx?)$/, "").replace(/\(tabs\)\//, "").replace(/\/_layout$/, "").replace(/\/index$/, "");
      existing.add(route);
    }
    const findings = [];
    const re = /route:\s*["']([^"']+)["']/g;
    for (const f of files) {
      const rel = relPath(f);
      if (!rel.match(/^frontend\/(components|app)\/.*\.(tsx?|jsx?)$/)) continue;
      const content = fs.readFileSync(f, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const m = line.match(/route:\s*["']([^"']+)["']/);
        if (m) {
          const route = m[1];
          if (!route.startsWith("/")) return;
          const candidates = [route, route.replace(/\/$/, "")];
          const found = candidates.some((c) => existing.has(c) || [...existing].some((e) => e.startsWith(c + "/")));
          if (!found) {
            findings.push({ file: rel, line: i + 1, route, snippet: line.trim().slice(0, 120) });
          }
        }
      });
    }
    return findings;
  },
};

// ── Run all rules ────────────────────────────────────────────────

const files = [...walk(REPO_ROOT)];
const report = {};
const startTime = Date.now();

for (const [name, fn] of Object.entries(rules)) {
  try {
    report[name] = fn(files);
  } catch (err) {
    report[name] = { error: err.message };
  }
}

fs.mkdirSync(LAYER3_DIR, { recursive: true });
fs.writeFileSync(path.join(LAYER3_DIR, "drift-report.json"), JSON.stringify(report, null, 2));

// ── Human-readable summary ───────────────────────────────────────

const summary = [];
const push = (s) => summary.push(s);

push("# Cipher Layer 3 — Drift Report");
push("");
push(`Generated: ${new Date().toISOString()}`);
push(`Scanned ${files.length} files in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
push("");
push("Cipher: **read this before claiming the codebase is clean.**");
push("");

const ruleDescriptions = {
  "hardcoded-hex-color": "Hex colors hardcoded outside design-tokens.ts (use the design system)",
  "duplicated-layout-constants": "Layout constants like TOP_BAR_HEIGHT redefined per screen (move to shared)",
  "duplicated-format-helpers": "Time/format helpers reimplemented per screen (one shared lib should win)",
  "broken-route-references": "router.push() to routes that don't exist",
  "broken-menu-references": "HamburgerMenu / shortcut tile entries pointing at deleted screens",
};

for (const [name, findings] of Object.entries(report)) {
  push(`## ${name}`);
  push(`*${ruleDescriptions[name] || ""}*`);
  push("");
  if (findings.error) {
    push(`⚠️ Rule errored: ${findings.error}`);
    push("");
    continue;
  }
  if (Array.isArray(findings) && findings.length === 0) {
    push("✅ No findings");
    push("");
    continue;
  }
  if (Array.isArray(findings)) {
    push(`**${findings.length} findings:**`);
    push("");
    if (name === "hardcoded-hex-color") {
      // Group by file
      const byFile = {};
      findings.forEach((f) => { (byFile[f.file] = byFile[f.file] || []).push(f); });
      const sorted = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length).slice(0, 20);
      sorted.forEach(([file, occs]) => {
        push(`- \`${file}\` — **${occs.length}** hex literals`);
      });
      const total = Object.values(byFile).flat().length;
      if (Object.keys(byFile).length > 20) push(`- ... +${Object.keys(byFile).length - 20} more files (${total} total)`);
    } else if (name === "duplicated-layout-constants" || name === "duplicated-format-helpers") {
      findings.forEach((f) => {
        push(`- **\`${f.name}\`** defined ${f.count}× in:`);
        f.definitions.forEach((d) => push(`  - ${d.file}:${d.line}${d.value ? ` (= ${d.value})` : ""}`));
      });
    } else if (name === "broken-route-references" || name === "broken-menu-references") {
      findings.forEach((f) => {
        push(`- ${f.file}:${f.line} → \`${f.route}\``);
      });
    }
    push("");
  }
}

push("---");
push("");
push("**To fix:** edit code, re-run `scripts/cipher-analyze.sh layer3` to verify.");

fs.writeFileSync(path.join(LAYER3_DIR, "SUMMARY.md"), summary.join("\n") + "\n");
console.error(`[check-drift] wrote drift-report.json + SUMMARY.md (${files.length} files scanned)`);
console.error(`[check-drift] findings per rule:`);
for (const [n, f] of Object.entries(report)) {
  const count = Array.isArray(f) ? f.length : "?";
  console.error(`    ${count.toString().padStart(4)}  ${n}`);
}
