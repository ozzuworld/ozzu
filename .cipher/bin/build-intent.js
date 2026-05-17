#!/usr/bin/env node
// Layer 2 — intent extraction. For every source file in the repo, asks Claude Haiku
// "what does this do?" and stores 2-sentence intent in .cipher/layer2/intent-index.json.
//
// Incremental: skips files whose mtime hasn't changed since last run.
// Concurrent: runs N extractions in parallel (default 5).
//
// Output: .cipher/layer2/intent-index.json — { "frontend/app/(tabs)/home.tsx": { intent, mtime, indexed_at } }
//
// Usage:
//   node .cipher/bin/build-intent.js              # incremental
//   node .cipher/bin/build-intent.js --full       # rebuild from scratch
//   node .cipher/bin/build-intent.js --files X    # only re-index these files

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../..");
const INDEX_PATH = path.resolve(__dirname, "../layer2/intent-index.json");
const CACHE_DIR = path.resolve(__dirname, "../layer2/cache");
const CONCURRENCY = parseInt(process.env.CIPHER_INTENT_CONCURRENCY || "5", 10);
const MODEL = process.env.CIPHER_INTENT_MODEL || "haiku";

// Files we care about
const ROOTS = [
  "frontend/app",
  "frontend/components",
  "frontend/lib",
  "frontend/modules",
  "backend/bridge",
];
const EXT_RE = /\.(tsx?|jsx?)$/;
const EXCLUDE_DIRS = new Set(["node_modules", ".expo", "android", "ios", "build", "dist", ".cipher"]);

// ── CLI args ──
const args = process.argv.slice(2);
const fullRebuild = args.includes("--full");
const filesIdx = args.indexOf("--files");
const onlyFiles = filesIdx >= 0 ? args.slice(filesIdx + 1) : null;

// ── Walk filesystem ──
function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && EXT_RE.test(e.name)) yield full;
  }
}

function collectFiles() {
  if (onlyFiles) {
    return onlyFiles.map((f) => path.resolve(REPO_ROOT, f)).filter(fs.existsSync);
  }
  const out = [];
  for (const root of ROOTS) {
    const full = path.join(REPO_ROOT, root);
    if (!fs.existsSync(full)) continue;
    out.push(...walk(full));
  }
  return out;
}

// ── Prompt builder ──
function buildPrompt(relPath, content) {
  // Keep token cost down: send first 40 lines + last 10 if long
  const lines = content.split("\n");
  let snippet;
  if (lines.length <= 60) {
    snippet = content;
  } else {
    snippet = lines.slice(0, 40).join("\n") + "\n\n... [truncated] ...\n\n" + lines.slice(-10).join("\n");
  }
  return `Path: ${relPath}

\`\`\`
${snippet}
\`\`\`

In 2 sentences max, describe what this file does and why it exists in this Ozzu app codebase. Be concrete (mention specific components/screens/endpoints it provides). Don't restate the path. Don't say "this file". Just the description.`;
}

// ── Run claude CLI ──
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
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(stdout.trim());
      }
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ── Main ──
async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let index = {};
  if (!fullRebuild && fs.existsSync(INDEX_PATH)) {
    try { index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")); }
    catch { index = {}; }
  }

  const allFiles = collectFiles();
  const toProcess = [];
  for (const abs of allFiles) {
    const rel = path.relative(REPO_ROOT, abs);
    const st = fs.statSync(abs);
    const cur = index[rel];
    if (!fullRebuild && cur && cur.mtime === st.mtimeMs) continue;
    toProcess.push({ abs, rel, mtime: st.mtimeMs });
  }

  console.error(`[build-intent] ${allFiles.length} source files total, ${toProcess.length} need indexing (concurrency=${CONCURRENCY}, model=${MODEL})`);

  let done = 0;
  let failed = 0;
  const startTime = Date.now();

  async function worker(file) {
    try {
      const content = fs.readFileSync(file.abs, "utf8");
      const prompt = buildPrompt(file.rel, content);
      const intent = await callClaude(prompt);
      index[file.rel] = {
        intent: intent.replace(/\s+/g, " ").trim(),
        mtime: file.mtime,
        indexed_at: Date.now(),
      };
      done++;
      if (done % 10 === 0) {
        // Checkpoint every 10
        fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
        const rate = done / ((Date.now() - startTime) / 1000);
        console.error(`[build-intent] ${done}/${toProcess.length}  (${rate.toFixed(1)}/s, ~${Math.round((toProcess.length - done) / rate)}s left)`);
      }
    } catch (err) {
      failed++;
      console.error(`[build-intent] FAIL ${file.rel}: ${err.message.slice(0, 100)}`);
    }
  }

  // Concurrency pool
  const queue = [...toProcess];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const file = queue.shift();
      if (file) await worker(file);
    }
  });
  await Promise.all(workers);

  // Final write
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`[build-intent] done in ${elapsed}s. ${done} indexed, ${failed} failed. Index: ${INDEX_PATH}`);
}

main().catch((err) => {
  console.error("[build-intent] FATAL", err);
  process.exit(1);
});
