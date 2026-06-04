#!/usr/bin/env node
// membrane-audit.js — Step 8.9 (dir_1780600750384)
//
// Historical fleet-wide sweep for membrane-breach patterns across ALL
// offense_telemetry rows. The membrane rule says offensive content (CVE
// IDs, raw IPs, exploit keywords, sensitive file refs) must NEVER appear
// in the sanitized text fields (intent_category, outcome_notes,
// error_message). This tool scans the entire table and reports any rows
// where it did — either confirming "membrane held historically" OR
// pointing to the exact rows that leaked.
//
// Usage:
//   docker exec bridge node /home/gcp/ozzu/tools/diagnostics/membrane-audit.js
//   docker exec bridge node /home/gcp/ozzu/tools/diagnostics/membrane-audit.js --json
//   docker exec bridge node /home/gcp/ozzu/tools/diagnostics/membrane-audit.js --since 2026-05-01

"use strict";

const db = require("/app/db");

// Membrane patterns — same set used by telemetry-analyze.js, kept here
// to avoid coupling (so this tool can audit even if the analyzer changes).
const MEMBRANE_PATTERNS = [
  { kind: "cve_id",          regex: /\bCVE-\d{4}-\d{4,7}\b/i },
  { kind: "exploit_keyword", regex: /\b(?:nmap|metasploit|sqlmap|hydra|hashcat|john|payload|exploit|reverse[\s_-]?shell)\b/i },
  { kind: "raw_ip",          regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { kind: "credential_file", regex: /\b(?:passwd|shadow|hashes?[\s_-]?dump)\b|\/etc\/(?:passwd|shadow)/i },
];

const TEXT_FIELDS = ["intent_category", "outcome_notes", "error_message"];

async function audit({ since } = {}) {
  const params = [];
  let where = "WHERE 1=1";
  if (since) {
    params.push(since);
    where += ` AND created_at >= $${params.length}`;
  }
  const r = await db.query(
    `SELECT id, engagement_id, model_used, intent_category, outcome_notes, error_message, created_at
       FROM offense_telemetry ${where}
       ORDER BY created_at ASC, id ASC`,
    params);

  const breaches = [];   // [{row_id, engagement_id, field, kind, sample, at}]
  for (const row of r.rows) {
    for (const field of TEXT_FIELDS) {
      const v = row[field];
      if (!v) continue;
      for (const { kind, regex } of MEMBRANE_PATTERNS) {
        const m = v.match(regex);
        if (m) {
          breaches.push({
            row_id: row.id, engagement_id: row.engagement_id, model_used: row.model_used,
            field, kind, at: row.created_at,
            // Redacted sample — show only that we DETECTED, not what
            // (preserves the membrane even in the audit output)
            sample: `<<${kind}-redacted len=${m[0].length}>>`,
          });
          break; // one breach per row.field pair is enough
        }
      }
    }
  }
  // Group by engagement_id
  const byEng = {};
  for (const b of breaches) {
    (byEng[b.engagement_id] ||= []).push(b);
  }
  return { total_rows: r.rows.length, total_breaches: breaches.length, by_engagement: byEng, breaches };
}

function renderMarkdown(result, since) {
  const lines = [];
  lines.push(`# Membrane audit — historical sweep`);
  if (since) lines.push(`**Since:** ${since}`);
  lines.push(`**Rows scanned:** ${result.total_rows}`);
  lines.push(`**Total breaches:** ${result.total_breaches}`);
  lines.push("");
  if (result.total_breaches === 0) {
    lines.push("✅ **MEMBRANE INTACT** — no rows in offense_telemetry contain CVE IDs, raw IPs, exploit keywords, or credential-file refs in their text fields. The L3→L4 contract has held historically.");
  } else {
    lines.push("🚨 **MEMBRANE BREACH DETECTED** — sanitization has leaked. Per-engagement counts:");
    lines.push("");
    lines.push("| engagement | breaches |");
    lines.push("|---|---|");
    for (const [eng, arr] of Object.entries(result.by_engagement).sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`| ${eng} | ${arr.length} |`);
    }
    lines.push("");
    lines.push("## Sample (first 20 breaches, content redacted)");
    lines.push("| row_id | engagement | field | kind | model | at |");
    lines.push("|---|---|---|---|---|---|");
    for (const b of result.breaches.slice(0, 20)) {
      lines.push(`| ${b.row_id} | ${b.engagement_id} | ${b.field} | ${b.kind} | ${b.model_used} | ${new Date(b.at).toISOString()} |`);
    }
    if (result.breaches.length > 20) lines.push(`_(${result.breaches.length - 20} more breaches omitted)_`);
  }
  return lines.join("\n");
}

module.exports = { audit };

// ───────────────────── CLI ─────────────────────

async function cliMain() {
  const args = process.argv.slice(2);
  const AS_JSON = args.includes("--json");
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
  const result = await audit({ since });
  if (AS_JSON) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(renderMarkdown(result, since) + "\n");
  }
  try { db.pool && db.pool.end && await db.pool.end(); } catch {}
  process.exit(result.total_breaches > 0 ? 1 : 0);
}

if (require.main === module) {
  cliMain().catch((e) => {
    console.error("membrane-audit CRASH:", e.message);
    process.exit(2);
  });
}
