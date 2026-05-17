#!/usr/bin/env node
// Layer 4.5 — Conversation-to-principle mining.
// Reads recent postgres conversation turns, extracts user corrections of Cipher
// behavior, asks Claude Haiku to distill proposed principles, dedupes against
// existing memory + Layer 4 PRINCIPLES, writes proposals for review.
//
// Usage:
//   node .cipher/bin/mine-conversations.js          # last 7 days, default scope
//   node .cipher/bin/mine-conversations.js --days N # custom window
//   node .cipher/bin/mine-conversations.js --max-windows N
//
// Output:
//   .cipher/layer4/proposed-principles.md — human-readable proposals for King Kazuma to review
//   .cipher/layer4/.proposals-raw.json    — raw Haiku output (debug)

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../..");
const MEMORY_DIR = "/root/.claude/projects/-home-gcp-ozzu/memory";
const PRINCIPLES_PATH = path.resolve(__dirname, "../layer4/PRINCIPLES.md");
const OUT_PATH = path.resolve(__dirname, "../layer4/proposed-principles.md");
const RAW_PATH = path.resolve(__dirname, "../layer4/.proposals-raw.json");
const MODEL = process.env.CIPHER_MINE_MODEL || "haiku";

// CLI
const args = process.argv.slice(2);
const days = parseInt(args[args.indexOf("--days") + 1] || "7", 10);
const maxWindows = parseInt(args[args.indexOf("--max-windows") + 1] || "25", 10);

// Frustration markers — heuristic for "user is correcting Cipher's behavior"
// Match case-insensitive, word-boundary where it makes sense
// NOTE: contains no single-quotes so it embeds cleanly into the SQL string below.
const FRUST_RE = /(fuck|fucking|fuckign|fuckin|stop|wrong|dont\b|do not|never\b|AGAIN\b|why the|you keep|you always|why you|pila de mierda)/i;

function exec(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

// ── Query postgres for recent conversation windows ──
function fetchWindows() {
  const sql = `
    WITH frust AS (
      SELECT id, conversation_id, turn_index, role, content, created_at
      FROM conversation_turns
      WHERE created_at > now() - interval '${days} days'
        AND role = 'user'
        AND content ~* '${FRUST_RE.source}'
      ORDER BY created_at DESC
      LIMIT ${maxWindows}
    )
    SELECT json_agg(
      json_build_object(
        'frust_id', f.id,
        'frust_at', f.created_at,
        'conv', f.conversation_id,
        'turns', (
          SELECT json_agg(json_build_object('idx', t.turn_index, 'role', t.role, 'content', LEFT(t.content, 2000)) ORDER BY t.turn_index)
          FROM conversation_turns t
          WHERE t.conversation_id = f.conversation_id
            AND t.turn_index BETWEEN f.turn_index - 3 AND f.turn_index + 2
        )
      )
    ) AS windows
    FROM frust f;
  `.trim();
  const raw = exec("docker", ["exec", "-i", "ozzu-postgres", "psql", "-U", "ozzu", "-d", "ozzu", "-At", "-c", sql]);
  if (!raw.trim()) return [];
  try { return JSON.parse(raw.trim()) || []; }
  catch (err) {
    console.error("[mine] failed to parse postgres output:", err.message);
    console.error(raw.slice(0, 500));
    return [];
  }
}

// ── Build prompt ──
function buildPrompt(window) {
  const turns = window.turns || [];
  const transcript = turns.map((t) => `[${t.role}] ${t.content}`).join("\n\n");
  return `You are mining a conversation transcript for behavioral corrections King Kazuma gave Cipher. King Kazuma's tone is direct and often profane — that's normal, not noise.

EXTRACT: any explicit or implicit rule King Kazuma is establishing for Cipher's future behavior. Ignore the profanity, focus on the rule.

TRANSCRIPT (window of ~6 turns around a frustration trigger):

${transcript}

OUTPUT: strict JSON array. Each entry: { "rule": "<short imperative>", "why": "<the incident, briefly>", "when": "<when this rule applies>", "type": "principle|feedback|reference" }. Empty array [] if no rule can be extracted.

Examples of valid rules:
- {"rule":"Don't restart bridge without verifying config is plaintext","why":"git-crypt+bind mounts broke OpenVPN restart","when":"Before any bridge or VPN container restart","type":"feedback"}
- {"rule":"Read STATE.md before answering drone questions","why":"User had to repeat IMX519 vs IMX335 distinction 3 times","when":"Any drone/gimbal/CAD topic","type":"feedback"}

Do NOT extract:
- Generic frustration without a specific rule ("you're being slow")
- Decisions about the project itself (those are project memories, not behavioral rules)
- One-time clarifications that don't generalize

JSON only:`;
}

// ── Call claude ──
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
    proc.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`exit ${code}: ${stderr.slice(0,200)}`)));
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function parseRules(raw) {
  let cleaned = raw.trim().replace(/^```(json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end < 0) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// ── Dedupe: simple similarity check against existing memory + PRINCIPLES ──
function loadExistingRules() {
  const out = [];
  const principlesText = fs.readFileSync(PRINCIPLES_PATH, "utf8").toLowerCase();
  out.push({ source: "PRINCIPLES.md", text: principlesText });
  try {
    for (const f of fs.readdirSync(MEMORY_DIR)) {
      if (!f.startsWith("feedback_")) continue;
      const txt = fs.readFileSync(path.join(MEMORY_DIR, f), "utf8").toLowerCase();
      out.push({ source: f, text: txt });
    }
  } catch {}
  return out;
}

function isLikelyDuplicate(rule, existing) {
  const ruleLower = (rule.rule + " " + (rule.when || "")).toLowerCase();
  const keywords = ruleLower.split(/\s+/).filter((w) => w.length > 4);
  for (const e of existing) {
    let matches = 0;
    for (const kw of keywords) {
      if (e.text.includes(kw)) matches++;
    }
    if (keywords.length > 0 && matches / keywords.length > 0.55) return e.source;
  }
  return null;
}

// ── Concurrency pool ──
async function pool(items, worker, concurrency = 5) {
  const queue = [...items];
  const out = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      try { const r = await worker(item); if (r) out.push(r); }
      catch (err) { console.error("[mine]", err.message); }
    }
  }));
  return out;
}

// ── Main ──
async function main() {
  const t0 = Date.now();
  console.error(`[mine] window: last ${days} days, max ${maxWindows} frustration triggers`);

  const windows = fetchWindows();
  console.error(`[mine] fetched ${windows.length} conversation windows from postgres`);
  if (windows.length === 0) {
    fs.writeFileSync(OUT_PATH, `# Proposed principles\n\nNo frustration-triggered windows in the last ${days} days.\n`);
    return;
  }

  const existing = loadExistingRules();
  console.error(`[mine] loaded ${existing.length} existing rule sources for dedupe`);

  const rawResults = [];
  const allRules = [];

  await pool(windows, async (w) => {
    const prompt = buildPrompt(w);
    const raw = await callClaude(prompt);
    const rules = parseRules(raw);
    rawResults.push({ frust_id: w.frust_id, conv: w.conv, raw });
    for (const r of rules) {
      const dup = isLikelyDuplicate(r, existing);
      allRules.push({ ...r, dup, source_window: w.frust_id, source_conv: w.conv, source_time: w.frust_at });
    }
  });

  fs.writeFileSync(RAW_PATH, JSON.stringify(rawResults, null, 2));

  // ── Write proposals ──
  const novelRules = allRules.filter((r) => !r.dup);
  const dupRules = allRules.filter((r) => r.dup);

  const lines = [];
  lines.push("# Proposed principles — mined from recent conversations");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Window: last ${days} days, ${windows.length} frustration triggers analyzed, ${((Date.now() - t0) / 1000).toFixed(1)}s elapsed`);
  lines.push("");
  lines.push("**For King Kazuma to review.** Pick which to promote to memory / PRINCIPLES / .claude/rules.");
  lines.push("");

  lines.push(`## Novel rules (${novelRules.length}) — not already covered by memory/PRINCIPLES`);
  lines.push("");
  if (novelRules.length === 0) {
    lines.push("✅ No new rules — recent corrections are all covered by existing memory.");
  } else {
    for (const r of novelRules) {
      lines.push(`### ${r.rule}`);
      lines.push(`- **Why:** ${r.why || "(not extracted)"}`);
      lines.push(`- **When:** ${r.when || "(any time)"}`);
      lines.push(`- **Type:** ${r.type || "feedback"}`);
      lines.push(`- **Source:** conv ${r.source_conv} (${r.source_time})`);
      lines.push("");
    }
  }
  lines.push("");

  lines.push(`## Likely duplicates (${dupRules.length}) — overlap with existing rules`);
  lines.push("");
  if (dupRules.length === 0) {
    lines.push("(none)");
  } else {
    for (const r of dupRules) {
      lines.push(`- **${r.rule}** — likely duplicate of \`${r.dup}\` (${r.source_time})`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Run again: `node .cipher/bin/mine-conversations.js [--days N] [--max-windows N]`");

  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n");
  console.error(`[mine] done in ${((Date.now() - t0) / 1000).toFixed(1)}s. ${novelRules.length} novel + ${dupRules.length} duplicate proposals → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("[mine] FATAL", err);
  process.exit(1);
});
