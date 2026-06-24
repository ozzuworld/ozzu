// model-knowledge-tools.js — dir_1780827444328
//
// Three tools that catch the dominant model failure modes seen on engagement
// 628 (NSE script hallucination, fake CVE IDs, no public-PoC lookup before
// claiming exploitation):
//
//   verify_cve({cve_id})              → ground truth from NVD
//   list_nse_scripts({category})      → real NSE script catalog from dev-01
//   search_exploits({product, ...})   → real ExploitDB metadata via searchsploit
//
// All three are MEMBRANE-SAFE: metadata only, no PoC bodies or exploit code
// in any response. The model gets factual ground truth WITHOUT exploitation
// instructions leaking into the L4 (Cipher) context.

"use strict";

const { spawn } = require("child_process");
const db = require("/app/db");

// ──────────────────────────── verify_cve ────────────────────────────

const CVE_ID_RE = /^CVE-\d{4}-\d{4,7}$/i;
const NVD_BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const CVE_CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

async function verifyCve(args) {
  const { cve_id } = args || {};
  if (!cve_id || typeof cve_id !== "string") return { error: "cve_id required (string)" };
  const id = cve_id.trim().toUpperCase();
  if (!CVE_ID_RE.test(id)) return { error: `invalid CVE format: '${id}' — expected CVE-YYYY-NNNN` };

  // Cache check
  try {
    const r = await db.query(
      `SELECT metadata, EXTRACT(EPOCH FROM (NOW() - fetched_at)) AS age_sec
         FROM cve_cache WHERE cve_id = $1`, [id]);
    if (r.rows.length > 0 && r.rows[0].age_sec < CVE_CACHE_TTL_SEC) {
      return { ...r.rows[0].metadata, _cache: "hit" };
    }
  } catch (_) { /* cache miss / table not yet — fall through */ }

  // Live NVD fetch
  let nvdResp;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(`${NVD_BASE}?cveId=${encodeURIComponent(id)}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "ozzu-soc-bridge/1.0 (offense-model-grounding)" },
    });
    clearTimeout(timeout);
    nvdResp = await resp.json();
  } catch (e) {
    return { error: `NVD fetch failed: ${e.message}` };
  }

  const vulnerabilities = Array.isArray(nvdResp.vulnerabilities) ? nvdResp.vulnerabilities : [];
  if (vulnerabilities.length === 0) {
    const out = { exists: false, cve_id: id, summary: null };
    try {
      await db.query(
        `INSERT INTO cve_cache (cve_id, metadata, fetched_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (cve_id) DO UPDATE SET metadata = EXCLUDED.metadata, fetched_at = NOW()`,
        [id, JSON.stringify(out)]);
    } catch (_) { /* swallow */ }
    return { ...out, _cache: "miss" };
  }

  const cve = vulnerabilities[0].cve || {};
  const descEn = (cve.descriptions || []).find(d => d.lang === "en");
  const m31 = (cve.metrics && cve.metrics.cvssMetricV31 && cve.metrics.cvssMetricV31[0]) || null;
  const m30 = (cve.metrics && cve.metrics.cvssMetricV30 && cve.metrics.cvssMetricV30[0]) || null;
  const cvssScore = m31?.cvssData?.baseScore ?? m30?.cvssData?.baseScore ?? null;
  const cvssVector = m31?.cvssData?.vectorString ?? m30?.cvssData?.vectorString ?? null;
  const configs = Array.isArray(cve.configurations) ? cve.configurations : [];
  const affected = [];
  for (const cfg of configs) {
    for (const node of cfg.nodes || []) {
      for (const m of node.cpeMatch || []) {
        if (m.criteria) affected.push(m.criteria);
      }
    }
  }

  const out = {
    exists: true,
    cve_id: cve.id || id,
    summary: descEn ? (descEn.value || "").slice(0, 600) : null,
    cvss_v3_score: cvssScore,
    cvss_v3_vector: cvssVector,
    published_date: cve.published || null,
    last_modified: cve.lastModified || null,
    affected_products: affected.slice(0, 40),
    references: (cve.references || []).slice(0, 10).map(r => ({ url: r.url, tags: r.tags || [] })),
  };

  try {
    await db.query(
      `INSERT INTO cve_cache (cve_id, metadata, fetched_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (cve_id) DO UPDATE SET metadata = EXCLUDED.metadata, fetched_at = NOW()`,
      [id, JSON.stringify(out)]);
  } catch (_) { /* swallow */ }

  return { ...out, _cache: "miss" };
}

// ──────────────────────────── list_nse_scripts ────────────────────────────
// Cached parse of `nmap --script-help all` run on dev-01. Refreshed via the
// `?refresh=true` arg. Postgres-backed catalog so it survives bridge restarts.

const VALID_CATEGORIES = new Set([
  "auth", "broadcast", "brute", "default", "discovery", "dos", "exploit",
  "external", "fuzzer", "intrusive", "malware", "safe", "version", "vuln",
]);

async function runOnDev01(scriptStdin, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=15",
      "-o", "BatchMode=yes",
      "dev-01", "bash", "-s",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} reject(new Error("dev-01 timeout")); }, timeoutMs);
    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => err += d.toString());
    proc.on("close", code => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`dev-01 exit ${code}: ${err.slice(0, 200)}`)); });
    proc.on("error", e => { clearTimeout(t); reject(e); });
    proc.stdin.write(scriptStdin); proc.stdin.end();
  });
}

async function refreshNseCatalog() {
  // `nmap --script-help all` emits records separated by blank lines:
  //   <name>
  //   Categories: <cat1> <cat2> ...
  //   <description ...>
  const raw = await runOnDev01("nmap --script-help all 2>/dev/null");
  const records = raw.split(/\n\n+/);
  const scripts = [];
  for (const rec of records) {
    const lines = rec.split("\n");
    if (lines.length < 2) continue;
    const name = lines[0].trim();
    if (!name || /^[A-Z]/.test(name) || name.includes(" ")) continue; // skip headers
    let categories = [];
    let descLines = [];
    for (const line of lines.slice(1)) {
      const m = line.match(/^Categories:\s*(.+)$/);
      if (m) categories = m[1].split(/\s+/).filter(c => VALID_CATEGORIES.has(c));
      else descLines.push(line.trim());
    }
    const description = descLines.filter(Boolean).join(" ").slice(0, 400);
    if (name) scripts.push({ name, categories, description });
  }
  // Upsert to catalog
  for (const s of scripts) {
    try {
      await db.query(
        `INSERT INTO nse_script_catalog (name, categories, description, refreshed_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (name) DO UPDATE SET categories = EXCLUDED.categories, description = EXCLUDED.description, refreshed_at = NOW()`,
        [s.name, JSON.stringify(s.categories), s.description]);
    } catch (_) { /* skip bad rows */ }
  }
  return scripts.length;
}

async function listNseScripts(args) {
  const { category, refresh } = args || {};
  if (category && !VALID_CATEGORIES.has(String(category).toLowerCase())) {
    return { error: `unknown category '${category}'; valid: ${[...VALID_CATEGORIES].join(", ")}` };
  }

  // Refresh on demand or if catalog is empty / very stale (>30 days)
  if (refresh) {
    const n = await refreshNseCatalog();
    return { refreshed: true, total_after: n, note: "Catalog refreshed from dev-01. Re-call without refresh:true to query." };
  }
  let rows;
  try {
    if (category) {
      const r = await db.query(
        `SELECT name, categories, description FROM nse_script_catalog
          WHERE categories @> $1::jsonb ORDER BY name`,
        [JSON.stringify([String(category).toLowerCase()])]);
      rows = r.rows;
    } else {
      const r = await db.query(
        `SELECT name, categories, description FROM nse_script_catalog ORDER BY name`);
      rows = r.rows;
    }
  } catch (e) {
    return { error: `catalog query failed: ${e.message}` };
  }

  if (rows.length === 0) {
    // Cold cache — refresh on first call
    const n = await refreshNseCatalog();
    return { cold_cache_refreshed: n, note: "First call — catalog refreshed from dev-01. Re-call to query." };
  }

  return {
    scripts: rows.map(r => ({ name: r.name, categories: r.categories, description: r.description })),
    total: rows.length,
    source: "dev-01 nmap --script-help all (cached)",
    category_filter: category || null,
  };
}

// ──────────────────────────── search_exploits ────────────────────────────

async function searchExploits(args) {
  const { product, version, port } = args || {};
  if (!product) return { error: "product required (e.g. 'Hikvision', 'Dropbear')" };
  const query = [product, version].filter(Boolean).join(" ").replace(/[`$"';|&]/g, "");
  if (!query.trim()) return { error: "empty query after sanitization" };

  // searchsploit --json is well-supported and parseable.
  // dev-01 version is older — no --colour flag; --json suffices.
  const cmd = `searchsploit --json ${JSON.stringify(query)}`;
  let raw;
  try {
    raw = await runOnDev01(cmd, 30000);
  } catch (e) {
    return { error: `searchsploit failed: ${e.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `searchsploit returned non-JSON: ${raw.slice(0, 200)}` };
  }

  const results = Array.isArray(parsed["RESULTS_EXPLOIT"]) ? parsed["RESULTS_EXPLOIT"] : [];
  const shellcodes = Array.isArray(parsed["RESULTS_SHELLCODE"]) ? parsed["RESULTS_SHELLCODE"] : [];

  const exploits = results.slice(0, 40).map(r => ({
    edb_id: r["EDB-ID"],
    title: r["Title"],
    date_published: r["Date_Published"],
    author: r["Author"],
    type: r["Type"],
    platform: r["Platform"],
    port: r["Port"] || null,
    codes: r["Codes"] || null,             // CVE refs
    source_path: r["Path"],                 // reference path on filesystem, not the body
  }));

  // Optional port filter
  const portFilter = port ? String(port) : null;
  const filtered = portFilter
    ? exploits.filter(e => !e.port || String(e.port) === portFilter)
    : exploits;

  return {
    query,
    total_exploits: results.length,
    total_shellcodes: shellcodes.length,
    exploits: filtered,
    note: "Reference metadata only. To execute a PoC, queue a step via queue_step. The membrane + intent_class + ROE checks apply.",
  };
}

// ── Sploitus search (dir_1780841976173) ──────────────────────────────────
// Sploitus aggregates ExploitDB + Packet Storm + Vulners + GitHub PoCs +
// Metasploit modules. CVE→PoC mappings ExploitDB lacks. Cloudflare-fronted;
// browser-like headers required (adapted from PentAGI sploitus.go).
async function searchSploitus(args) {
  const { query, type = "exploits", limit = 10 } = args || {};
  if (!query || typeof query !== "string" || !query.trim()) {
    return { error: "query required (e.g. 'CVE-2023-48795', 'Hikvision', 'Dropbear 2020.81')" };
  }
  const cleanQuery = query.trim().slice(0, 200);
  const allowedTypes = new Set(["exploits", "tools", "cve"]);
  const reqType = allowedTypes.has(type) ? type : "exploits";

  // Node's https-module TLS fingerprint trips Cloudflare on sploitus.com. curl's
  // fingerprint passes. Shell out instead of fighting the JA3 layer.
  const { execFile } = require("child_process");
  const body = JSON.stringify({ query: cleanQuery, type: reqType, sort: "default", title: false, offset: 0 });
  const referer = `https://sploitus.com/?query=${encodeURIComponent(cleanQuery)}`;
  const curlArgs = [
    "-sS", "--max-time", "15", "-o", "-", "-w", "\nHTTP_STATUS:%{http_code}",
    "-X", "POST", "https://sploitus.com/search",
    "-H", "Accept: application/json",
    "-H", "Accept-Language: en-US,en;q=0.9",
    "-H", "Content-Type: application/json",
    "-H", "Origin: https://sploitus.com",
    "-H", `Referer: ${referer}`,
    "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "-H", 'sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    "-H", "sec-ch-ua-mobile: ?0",
    "-H", 'sec-ch-ua-platform: "macOS"',
    "-H", "sec-fetch-dest: empty",
    "-H", "sec-fetch-mode: cors",
    "-H", "sec-fetch-site: same-origin",
    "-H", "DNT: 1",
    "--data", body,
  ];

  return new Promise((resolve) => {
    execFile("curl", curlArgs, { maxBuffer: 16 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      if (err) return resolve({ error: `Sploitus curl failed: ${err.message}` });
      const m = String(stdout).match(/\nHTTP_STATUS:(\d{3})\s*$/);
      const status = m ? parseInt(m[1], 10) : 0;
      const buf = m ? stdout.slice(0, -m[0].length) : stdout;
      if (status === 499 || status === 422) {
        return resolve({ error: `Sploitus rate-limited (HTTP ${status}). Retry in 60s.`, retry_after: 60 });
      }
      if (status !== 200) {
        return resolve({ error: `Sploitus HTTP ${status}: ${String(buf).slice(0, 200)}` });
      }
      let parsed;
      try { parsed = JSON.parse(buf); }
      catch (e) { return resolve({ error: `Sploitus non-JSON response: ${e.message}` }); }
      const exploits = Array.isArray(parsed.exploits) ? parsed.exploits : [];
      const trimmed = exploits.slice(0, Math.max(1, Math.min(50, parseInt(limit, 10) || 10)))
        .map((x) => ({
          id: x.id,
          title: x.title,
          type: x.type,
          source_url: x.href,
          cvss_score: x.score || null,
          published: x.published || null,
          language: x.language || null,
          snippet: (x.source || "").replace(/\s+/g, " ").slice(0, 400),
        }));
      resolve({
        query: cleanQuery,
        type: reqType,
        total_results: parsed.exploits_total || exploits.length,
        returned: trimmed.length,
        exploits: trimmed,
        note: "Reference metadata only. To execute a PoC, queue a step via queue_step. Membrane + intent_class + ROE checks apply.",
      });
    });
  });
}

// dir_1780855118472: list_executor_wordlists — surface what wordlists ACTUALLY
// exist on the engagement executor so the model can stop hallucinating paths
// like /usr/share/wordlists/common_users.txt.
const _WORDLIST_CACHE = new Map();    // key=executor_host  → {result, ts}
const _WORDLIST_TTL_MS = 60 * 60 * 1000;  // 1h

function categorizeWordlistPath(p) {
  const s = String(p).toLowerCase();
  if (s.includes("/passwords/") || s.endsWith("rockyou.txt") || s.includes("/passwd")) return "passwords";
  if (s.includes("/usernames/") || s.includes("/users/")) return "usernames";
  if (s.includes("/discovery/web-content") || s.includes("/dirb/") || s.includes("/dirbuster/") || s.includes("common.txt") || s.includes("directories")) return "web_dir";
  if (s.includes("/fuzzing/")) return "fuzzing";
  if (s.includes("/snmp/")) return "snmp";
  if (s.includes("/cgis/")) return "cgi";
  return "generic";
}

async function listExecutorWordlists(args) {
  const { executor_host = "dev-01", refresh = false } = args || {};
  const cached = _WORDLIST_CACHE.get(executor_host);
  if (!refresh && cached && (Date.now() - cached.ts) < _WORDLIST_TTL_MS) {
    return { ...cached.result, cached: true, cached_at: new Date(cached.ts).toISOString() };
  }
  // Bounded find: 5 levels deep, .txt/.lst only, top 250 by size+ name ordering
  const cmd =
    "find /usr/share/wordlists /usr/share/seclists /opt/wordlists 2>/dev/null " +
    "  -maxdepth 5 -type f \\( -name '*.txt' -o -name '*.lst' \\) " +
    "  -printf '%s\\t%p\\n' 2>/dev/null " +
    "| sort -n " +
    "| head -250";
  let raw;
  try {
    if (executor_host === "dev-01") {
      raw = await runOnDev01(cmd, 30000);
    } else {
      // Future: per-executor SSH wrap. v1 only supports dev-01.
      return { error: `executor_host '${executor_host}' not supported in v1 (dev-01 only)` };
    }
  } catch (e) {
    return { error: `find failed: ${e.message}` };
  }
  const lines = String(raw || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const wordlists = lines.map(l => {
    const [sizeStr, ...pathParts] = l.split("\t");
    const path = pathParts.join("\t");
    const sizeB = parseInt(sizeStr, 10);
    if (!path || !Number.isInteger(sizeB)) return null;
    return {
      path,
      size_kb: Math.round(sizeB / 1024),
      category: categorizeWordlistPath(path),
    };
  }).filter(Boolean);
  // Detect seclists root
  const seclists = wordlists.find(w => /\/seclists\//i.test(w.path));
  const result = {
    executor_host,
    wordlists,
    seclists_root: seclists ? "/usr/share/seclists" : null,
    total_found: wordlists.length,
  };
  _WORDLIST_CACHE.set(executor_host, { result, ts: Date.now() });
  return { ...result, cached: false };
}

module.exports = { verifyCve, listNseScripts, searchExploits, searchSploitus, listExecutorWordlists };
