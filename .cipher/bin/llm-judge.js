#!/usr/bin/env node
// Layer 3.5 — LLM-judge fitness functions.
// Reads .cipher/layer3/llm-rules.json. For each rule, finds in-scope files,
// asks Claude Haiku per-file "does this violate?", aggregates findings.
//
// Output:
//   .cipher/layer3/llm-drift-report.json — all results
//   .cipher/layer3/SUMMARY-LLM.md         — human-readable digest
//
// Usage:
//   node .cipher/bin/llm-judge.js              # run all rules, default file caps
//   node .cipher/bin/llm-judge.js --rule X     # only run rule X
//   node .cipher/bin/llm-judge.js --files A B  # only judge files A B (still per-rule scope)

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../..");
const RULES_PATH = path.resolve(__dirname, "../layer3/llm-rules.json");
const INTENT_INDEX_PATH = path.resolve(__dirname, "../layer2/intent-index.json");
const OUT_REPORT = path.resolve(__dirname, "../layer3/llm-drift-report.json");
const OUT_SUMMARY = path.resolve(__dirname, "../layer3/SUMMARY-LLM.md");
const MODEL = process.env.CIPHER_JUDGE_MODEL || "haiku";
const CONCURRENCY = parseInt(process.env.CIPHER_JUDGE_CONCURRENCY || "5", 10);

// ── CLI args ──
const args = process.argv.slice(2);
const ruleFilter = (() => {
  const i = args.indexOf("--rule");
  return i >= 0 ? args[i + 1] : null;
})();
const fileFilter = (() => {
  const i = args.indexOf("--files");
  return i >= 0 ? new Set(args.slice(i + 1).filter((s) => !s.startsWith("--"))) : null;
})();

// ── Load rules + intent index ──
const { rules } = JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
const intentIndex = (() => {
  try { return JSON.parse(fs.readFileSync(INTENT_INDEX_PATH, "utf8")); }
  catch { return {}; }
})();

// ── Walk repo for files matching a regex scope ──
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

function filesForRule(rule) {
  const scopeRe = new RegExp(rule.scopeGlob);
  const excludeRe = rule.excludeGlob ? new RegExp(rule.excludeGlob) : null;
  const out = [];
  for (const abs of walk(REPO_ROOT)) {
    const rel = path.relative(REPO_ROOT, abs);
    if (!scopeRe.test(rel)) continue;
    if (excludeRe && excludeRe.test(rel)) continue;
    if (fileFilter && !fileFilter.has(rel)) continue;
    out.push({ abs, rel });
  }
  // Order: prefer larger files first (more drift potential)
  out.sort((a, b) => fs.statSync(b.abs).size - fs.statSync(a.abs).size);
  if (rule.maxFiles) return out.slice(0, rule.maxFiles);
  return out;
}

// ── Build prompt from template ──
function buildPrompt(rule, file) {
  let content = fs.readFileSync(file.abs, "utf8");
  // Cap content length to keep cost in check
  const lines = content.split("\n");
  if (lines.length > 220) {
    content = lines.slice(0, 120).join("\n") + "\n\n... [truncated " + (lines.length - 170) + " lines] ...\n\n" + lines.slice(-50).join("\n");
  }
  let p = rule.prompt.replace("{{path}}", file.rel).replace("{{content}}", content);
  if (rule.needsIntent) {
    const intentEntry = intentIndex[file.rel];
    const intent = intentEntry ? intentEntry.intent : "(no recorded intent — file may be too new for Layer 2 index)";
    p = p.replace("{{intent}}", intent);
  }
  return p;
}

// ── Call claude CLI ──
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", "--model", MODEL, "--output-format", "text", "--no-session-persistence", "--disable-slash-commands"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      else resolve(stdout.trim());
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ── Parse Claude's JSON response (be lenient — strip code fences if present) ──
function parseVerdict(raw) {
  let cleaned = raw.trim();
  // Strip markdown code fences if present
  cleaned = cleaned.replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
  // Find first { and last }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) {
    return { violates: null, reason: "PARSE_ERROR: no JSON object in response: " + raw.slice(0, 200) };
  }
  const jsonStr = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      violates: typeof parsed.violates === "boolean" ? parsed.violates : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : JSON.stringify(parsed),
    };
  } catch (err) {
    return { violates: null, reason: "PARSE_ERROR: " + err.message + " (raw: " + raw.slice(0, 200) + ")" };
  }
}

// ── Concurrency pool ──
async function pool(items, worker, concurrency) {
  const queue = [...items];
  const out = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) {
        try { out.push(await worker(item)); }
        catch (err) { out.push({ item, error: err.message }); }
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Main ──
async function main() {
  const startTime = Date.now();
  const report = { generated: new Date().toISOString(), rules: [] };

  for (const rule of rules) {
    if (ruleFilter && rule.name !== ruleFilter) continue;
    const files = filesForRule(rule);
    console.error(`[llm-judge] ${rule.name}: ${files.length} files in scope (cap=${rule.maxFiles || "none"})`);
    if (files.length === 0) {
      report.rules.push({ name: rule.name, severity: rule.severity, principle: rule.principle, results: [] });
      continue;
    }
    const ruleResults = await pool(files, async (file) => {
      const prompt = buildPrompt(rule, file);
      const raw = await callClaude(prompt);
      const verdict = parseVerdict(raw);
      return { file: file.rel, ...verdict };
    }, CONCURRENCY);
    const violations = ruleResults.filter((r) => r.violates === true);
    console.error(`[llm-judge]   ${rule.name}: ${violations.length}/${ruleResults.length} violations`);
    report.rules.push({
      name: rule.name,
      severity: rule.severity,
      principle: rule.principle,
      filesJudged: ruleResults.length,
      violations: violations.length,
      results: ruleResults,
    });
  }

  fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2));

  // ── Human-readable summary ──
  const lines = [];
  lines.push("# Cipher Layer 3.5 — LLM-judge drift report");
  lines.push("");
  lines.push(`Generated: ${report.generated}`);
  lines.push(`Elapsed: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  lines.push(`Model: ${MODEL}`);
  lines.push("");
  lines.push("Cipher: **read this for semantic drift findings** that the regex-based Layer 3 can't see.");
  lines.push("");
  for (const r of report.rules) {
    lines.push(`## ${r.name} (${r.severity})`);
    lines.push(`*${r.principle}*`);
    lines.push("");
    if (!r.results || r.results.length === 0) {
      lines.push("(no files in scope)\n");
      continue;
    }
    const violations = r.results.filter((x) => x.violates === true);
    const errors = r.results.filter((x) => x.violates === null);
    lines.push(`**${violations.length}/${r.filesJudged} files flagged.**`);
    if (errors.length > 0) lines.push(`(${errors.length} parse errors — see report JSON)`);
    lines.push("");
    if (violations.length > 0) {
      for (const v of violations) {
        lines.push(`- **\`${v.file}\`** — ${v.reason}`);
      }
    } else {
      lines.push("✅ All in-scope files pass.");
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("Run again: `node .cipher/bin/llm-judge.js [--rule NAME] [--files A B]`");

  fs.writeFileSync(OUT_SUMMARY, lines.join("\n") + "\n");
  console.error(`[llm-judge] done in ${((Date.now() - startTime) / 1000).toFixed(1)}s — see ${OUT_SUMMARY}`);
}

main().catch((err) => {
  console.error("[llm-judge] FATAL", err);
  process.exit(1);
});
