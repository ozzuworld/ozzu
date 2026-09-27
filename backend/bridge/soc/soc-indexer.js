// backend/bridge/soc/soc-indexer.js — SOC v3 record-plane indexer (dir_1790538151856)
//
// Disk → DB sync for the kill-chain-first reporting plane. Design contract:
// private/soc-redesign/PROPOSAL-v1.md. IDEMPOTENT + READ-ONLY on evidence files:
//   1. seed chains from soc-seed.json          (INSERT ON CONFLICT DO NOTHING — live DB rows win)
//   2. manifest sync from CHAIN.md frontmatter (file-first authoritative when the manifest exists)
//   3. artifacts from each chain's dir         (sha256, kind by filename, sanitized flag)
//   4. evidence runs from RUN_DIRS             (top-level rNNN*.md glob → soc_runs, DO NOTHING)
//   5. coordination events from seed           (ON CONFLICT (channel,event_date,ref) DO NOTHING)
//   6. finding links + skyline-id backfill     (explicit curated links; refs-pattern fill)
//   7. engagement archive sweep                (old empty scoping shells → 'archived')
//
// CHAIN.md frontmatter format (parser-controlled — keep it flat, one JSON line for arrays):
//   ---
//   slug: false-relay
//   status: packaged
//   drop_number: 4
//   cvss_composed: 9.1
//   cvss_standalone: 8.5
//   published_repo: https://github.com/0xReadingSteiner/False-Relay
//   published_at: 2026-10-01
//   engagement_ids: ["SKYLINE-SOC-2026-346"]
//   components: [{"skyline_id":"SKYLINE-2026-004","name":"Badgehack",...}]
//   ---
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = process.env.SOC_REPO_ROOT || "/home/gcp/ozzu";
const SEED_PATH = path.join(__dirname, "soc-seed.json");

// Evidence corpora scanned for rNNN run records (TOP-LEVEL *.md only — never
// recurse into the machine-scale RE/fuzz trees).
const RUN_DIRS = [
  { dir: "private/cucm/expressway-evidence", target: "expressway-x15" },
  { dir: "private/cucm/native-fuzz", target: "cucm-15" },
  { dir: "private/cucm/live-verification", target: "cucm-15" },
];

const ARTIFACT_KINDS = {
  "ADVISORY.md": "advisory",
  "README.md": "readme",
  "poc.sh": "poc",
  "mitigations.md": "mitigations",
  "banner.png": "banner",
  "CHAIN.md": "manifest",
  "coordination.md": "coordination-log",
};
// Kinds that passed the persona leak-scan discipline and are safe to serve
// through the in-app content viewer. manifest/other stay unsanitized (internal).
const PUBLIC_SANITIZED = new Set(["advisory", "readme", "poc", "mitigations", "banner", "coordination-log"]);

function loadSeed() {
  try { return JSON.parse(fs.readFileSync(SEED_PATH, "utf8")); }
  catch (err) { return null; }
}

function resolve(p) { return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p); }

function sha256File(fp) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex"); }
  catch (_) { return null; }
}

// Parse the CHAIN.md frontmatter block. Flat `key: value` lines; values that look
// like JSON ([...]/{...}) are JSON.parsed; empty → null; numeric strings → Number.
function parseManifest(dir) {
  try {
    const fp = path.join(dir, "CHAIN.md");
    if (!fs.existsSync(fp)) return null;
    const txt = fs.readFileSync(fp, "utf8");
    const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v.startsWith("[") || v.startsWith("{")) {
        try { v = JSON.parse(v); } catch (_) { /* keep raw string */ }
      } else if (v === "") {
        v = null;
      } else if (/^-?\d+(\.\d+)?$/.test(v)) {
        v = Number(v);
      }
      out[kv[1]] = v;
    }
    return out;
  } catch (_) { return null; }
}

// Serialize a DB chain row back to CHAIN.md (file-first contract is two-way:
// MCP updates rewrite the manifest so the disk stays canonical).
function manifestFor(row) {
  const date = (v) => (v ? new Date(v).toISOString().slice(0, 10) : "");
  return [
    "---",
    `slug: ${row.slug}`,
    `status: ${row.status || ""}`,
    `drop_number: ${row.drop_number ?? ""}`,
    `cvss_composed: ${row.cvss_composed ?? ""}`,
    `cvss_standalone: ${row.cvss_standalone ?? ""}`,
    `published_repo: ${row.published_repo || ""}`,
    `published_at: ${date(row.published_at)}`,
    `engagement_ids: ${JSON.stringify(row.engagement_ids || [])}`,
    `components: ${JSON.stringify(row.components || [])}`,
    "---",
    "",
    `# ${row.name} — internal chain manifest`,
    "",
    "Two-way sync with soc_kill_chains via soc-indexer.js (manifest is file-first",
    "authoritative for status/components; MCP update_kill_chain rewrites this file).",
    "",
    "⚠️ INTERNAL FILE — contains engagement IDs. NEVER copy into public/persona repos",
    "(leak-scan rule; the public drop package = ADVISORY/README/poc/mitigations/banner).",
    "",
  ].join("\n");
}

async function writeManifest(db, slug) {
  try {
    const r = await db.query(`SELECT * FROM soc_kill_chains WHERE slug = $1`, [slug]);
    if (!r.rows.length || !r.rows[0].dir_path) return false;
    const row = r.rows[0];
    const dir = resolve(row.dir_path);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CHAIN.md"), manifestFor(row));
    return true;
  } catch (_) { return false; }
}

async function runIndex(db) {
  const summary = { chains_seeded: 0, manifests_synced: 0, artifacts: 0, runs_scanned: 0, coordination: 0, links: 0, archived: 0, errors: [] };
  const seed = loadSeed();
  if (!seed) { summary.errors.push("soc-seed.json missing or unparseable"); return summary; }

  // 1) Seed chains — DO NOTHING on conflict: live DB rows (MCP-updated) win over seed.
  for (const c of seed.chains || []) {
    try {
      await db.query(
        `INSERT INTO soc_kill_chains
           (id, slug, name, drop_number, status, cvss_composed, cvss_standalone,
            engagement_ids, components, dir_path, published_repo, published_at, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (slug) DO NOTHING`,
        [`chain_${c.slug}`, c.slug, c.name, c.drop_number ?? null, c.status || "researching",
         c.cvss_composed ?? null, c.cvss_standalone ?? null,
         JSON.stringify(c.engagement_ids || []), JSON.stringify(c.components || []),
         c.dir_path || null, c.published_repo || null, c.published_at || null, c.summary || null]);
      summary.chains_seeded++;
    } catch (err) { summary.errors.push(`chain seed ${c.slug}: ${err.message}`); }
  }

  // 2+3) Per chain: manifest sync (file-first) + artifact scan.
  let chainRows = [];
  try { chainRows = (await db.query(`SELECT * FROM soc_kill_chains`)).rows; }
  catch (err) { summary.errors.push(`chain fetch: ${err.message}`); }

  for (const row of chainRows) {
    if (!row.dir_path) continue;
    const dir = resolve(row.dir_path);
    const man = parseManifest(dir);
    if (man) {
      try {
        await db.query(
          `UPDATE soc_kill_chains SET
             status          = COALESCE($2, status),
             cvss_composed   = COALESCE($3, cvss_composed),
             cvss_standalone = COALESCE($4, cvss_standalone),
             components      = COALESCE($5, components),
             engagement_ids  = COALESCE($6, engagement_ids),
             published_repo  = COALESCE($7, published_repo),
             published_at    = COALESCE($8, published_at),
             drop_number     = COALESCE($9, drop_number),
             updated_at      = now()
           WHERE slug = $1`,
          [row.slug, man.status || null, man.cvss_composed ?? null, man.cvss_standalone ?? null,
           Array.isArray(man.components) ? JSON.stringify(man.components) : null,
           Array.isArray(man.engagement_ids) ? JSON.stringify(man.engagement_ids) : null,
           man.published_repo || null, man.published_at || null, man.drop_number ?? null]);
        summary.manifests_synced++;
        // keep in-memory row fresh for the manifest writer below
        Object.assign(row, man.published_at ? { published_at: man.published_at } : {});
      } catch (err) { summary.errors.push(`manifest sync ${row.slug}: ${err.message}`); }
    }
    try {
      if (fs.existsSync(dir)) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!ent.isFile()) continue;
          const kind = ARTIFACT_KINDS[ent.name] ||
            (/\.(md|sh|png|pdf|txt)$/i.test(ent.name) ? "other" : null);
          if (!kind) continue;
          const fp = path.join(dir, ent.name);
          await db.query(
            `INSERT INTO soc_artifacts (chain_id, kind, path, sha256, sanitized)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (chain_id, path) DO UPDATE
               SET sha256 = EXCLUDED.sha256, kind = EXCLUDED.kind,
                   sanitized = EXCLUDED.sanitized, updated_at = now()`,
            [row.id, kind, fp, sha256File(fp), PUBLIC_SANITIZED.has(kind)]);
          summary.artifacts++;
        }
      }
    } catch (err) { summary.errors.push(`artifacts ${row.slug}: ${err.message}`); }
  }

  // 4) Evidence runs — top-level rNNN*.md glob, insert-once (MCP log_run enriches).
  const slugById = {};
  for (const c of seed.chains || []) slugById[`chain_${c.slug}`] = c.slug;
  for (const rd of RUN_DIRS) {
    try {
      const dir = resolve(rd.dir);
      if (!fs.existsSync(dir)) continue;
      for (const ent of fs.readdirSync(dir)) {
        // run_key = rNNN or an explicit rNNN-rMMM range ONLY — a bare "-\d+" tail is
        // usually a CVE number (r387-58157-… mis-keyed as "r387-5815" before this fix).
        const m = ent.match(/^(r\d{2,4}(?:-r\d{2,4})?)[-_ ]?(.*)\.md$/i);
        if (!m) continue;
        const fp = path.join(dir, ent);
        let st; try { st = fs.statSync(fp); } catch (_) { continue; }
        const title = (m[2] || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || null;
        await db.query(
          `INSERT INTO soc_runs (run_key, target, run_date, purpose, files, indexed_from)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (run_key) DO NOTHING`,
          [m[1].toLowerCase(), rd.target, st.mtime.toISOString().slice(0, 10),
           title, JSON.stringify([fp]), fp]);
        summary.runs_scanned++;
      }
    } catch (err) { summary.errors.push(`runs ${rd.dir}: ${err.message}`); }
  }

  // 5) Coordination events — seeded from verified TIMELINE/memory facts.
  for (const ev of seed.coordination || []) {
    try {
      await db.query(
        `INSERT INTO soc_coordination_events (channel, event_date, direction, subject, ref, status, chain_id)
         VALUES ($1,$2,$3,$4,$5,$6,(SELECT id FROM soc_kill_chains WHERE slug = $7))
         ON CONFLICT (channel, event_date, ref) DO NOTHING`,
        [ev.channel, ev.event_date, ev.direction || "sent", ev.subject || null,
         ev.ref || "", ev.status || "pending", ev.chain_slug || null]);
      summary.coordination++;
    } catch (err) { summary.errors.push(`coordination ${ev.ref}: ${err.message}`); }
  }

  // 6a) Explicit curated finding links (verified against the live DB when seeded).
  for (const link of seed.finding_links || []) {
    try {
      await db.query(
        `UPDATE pentest_findings SET
           chain_id   = (SELECT id FROM soc_kill_chains WHERE slug = $2),
           lifecycle  = COALESCE($3, lifecycle),
           skyline_id = COALESCE($4, skyline_id)
         WHERE id = $1`,
        [link.finding_id, link.chain_slug, link.lifecycle || null, link.skyline_id || null]);
      summary.links++;
    } catch (err) { summary.errors.push(`finding link ${link.finding_id}: ${err.message}`); }
  }
  // 6b) Skyline-ID backfill: any finding citing a component ID in refs[] joins the chain.
  for (const row of chainRows) {
    for (const comp of (typeof row.components === "string" ? JSON.parse(row.components || "[]") : row.components) || []) {
      if (!comp || !comp.skyline_id) continue;
      try {
        await db.query(
          `UPDATE pentest_findings SET skyline_id = $1, chain_id = $2
           WHERE refs::text LIKE '%' || $1 || '%' AND skyline_id IS NULL`,
          [comp.skyline_id, row.id]);
      } catch (err) { summary.errors.push(`skyline backfill ${comp.skyline_id}: ${err.message}`); }
    }
  }

  // 6c) Explicit run → chain attribution (VERIFIED links only — never guess a
  // mapping; MCP log_run enriches/attributes new runs going forward).
  for (const link of seed.run_links || []) {
    try {
      await db.query(
        `UPDATE soc_runs SET chain_id = (SELECT id FROM soc_kill_chains WHERE slug = $2)
         WHERE run_key = $1 AND chain_id IS NULL`,
        [link.run_key, link.chain_slug]);
    } catch (err) { summary.errors.push(`run link ${link.run_key}: ${err.message}`); }
  }

  // 7) Engagement archive sweep — old EMPTY scoping shells only (no findings, no
  // queue items). Conservative by design; the sweep config lives in the seed.
  const sweep = seed.archive_sweep;
  if (sweep) {
    try {
      const r = await db.query(
        `UPDATE pentest_engagements SET status = 'archived', updated_at = now()
         WHERE status = $1
           AND created_at < now() - make_interval(days => $2)
           AND NOT EXISTS (SELECT 1 FROM pentest_findings f WHERE f.engagement_id = pentest_engagements.id)
           AND NOT EXISTS (SELECT 1 FROM soc_queue_items q WHERE q.engagement_id = pentest_engagements.id)`,
        [sweep.status || "scoping", sweep.older_than_days || 30]);
      summary.archived = r.rowCount || 0;
    } catch (err) { summary.errors.push(`archive sweep: ${err.message}`); }
  }

  return summary;
}

module.exports = { runIndex, parseManifest, writeManifest, manifestFor, resolve, sha256File };
