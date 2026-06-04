#!/usr/bin/env node
// telemetry-analyze.js — Step 8.4 (dir_1780599463129)
//
// Diagnose the health of a live engagement run by reading offense_telemetry,
// engagement_tasks, and soc_queue_items. Surfaces actionable problems:
//
//   - Loop detection: same intent ≥3× consecutively → orchestrator stuck
//   - Executor dead: ≥N consecutive queue items with empty output
//   - Step-queue-rate: % of advance_offense calls that produced step_queued
//   - Membrane breach: any telemetry text field containing raw commands /
//     CVE IDs / IPs that should have been sanitized
//   - Stalled DAG: tasks unblocked for > N min with no in_flight follow-up
//   - Phase regression: engagement_phase moved backwards
//
// Output: markdown report to stdout (use --json for raw structure).
//
// Usage:
//   docker exec bridge node /home/gcp/ozzu/tools/diagnostics/telemetry-analyze.js SKYLINE-SOC-2026-628
//   docker exec bridge node /home/gcp/ozzu/tools/diagnostics/telemetry-analyze.js SKYLINE-SOC-2026-628 --json > diag.json

"use strict";

const db = require("/app/db");

// arg parsing — deferred into cliMain() so require() from MCP doesn't exit

// ───────────────────── thresholds ─────────────────────
const LOOP_RUN_THRESHOLD     = 3;      // same intent ≥3 in a row → loop
const EMPTY_OUTPUT_THRESHOLD = 3;      // ≥3 consecutive empty queue outputs → executor dead
const STEP_QUEUE_FLOOR       = 0.5;    // < 50% step-queued → model can't tool-use
const STALL_MIN              = 10;     // task pending+unblocked > 10 min → stalled

// Patterns that should NEVER appear in telemetry text fields (membrane rule):
//   - raw CVE IDs (CVE-YYYY-NNNN)
//   - raw IPs (private + public)
//   - shell command keywords (curl|nmap|exploit|payload)
const MEMBRANE_PATTERNS = [
  /\bCVE-\d{4}-\d{4,7}\b/i,
  /\b(?:nmap|metasploit|sqlmap|hydra|hashcat|john|payload|exploit|reverse[\s_-]?shell)\b/i,
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,   // raw IPs (private OR public — sanitize all in telemetry)
  /\b(?:passwd|shadow|hashes?[\s_-]?dump)\b|\/etc\/(?:passwd|shadow)/i,
];

// ───────────────────── analyzers ─────────────────────

// Percentile helper. arr can be unsorted; uses linear interpolation.
function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// Latency thresholds (ms). p95 above SLOW_P95_MS → flag a warning;
// above HUNG_P95_MS → error.
const SLOW_P95_MS = 20000;   // 20 s — model is sluggish
const HUNG_P95_MS = 60000;   // 60 s — likely a near-hang or timeout retry loop

function detectSlowInference(telemetry) {
  const lats = telemetry.map((t) => t.latency_ms).filter((x) => typeof x === "number" && x > 0);
  if (lats.length < 3) return [];   // need a few samples for percentile to be meaningful
  const p95 = percentile(lats, 95);
  if (p95 >= HUNG_P95_MS) {
    return [{
      kind: "inference_hung",
      severity: "error",
      message: `latency p95 = ${(p95/1000).toFixed(1)}s across ${lats.length} calls — model is hanging or hitting internal timeouts`,
      p95_ms: p95, n_samples: lats.length,
    }];
  }
  if (p95 >= SLOW_P95_MS) {
    return [{
      kind: "slow_inference",
      severity: "warn",
      message: `latency p95 = ${(p95/1000).toFixed(1)}s across ${lats.length} calls — GPU under-provisioned or network tunnel slow`,
      p95_ms: p95, n_samples: lats.length,
    }];
  }
  return [];
}

function detectLoops(telemetry) {
  // Group consecutive rows by intent_category, flag runs ≥ threshold
  const issues = [];
  let runStart = 0, runIntent = null, runLen = 0;
  const flush = (endIdx) => {
    if (runLen >= LOOP_RUN_THRESHOLD) {
      issues.push({
        kind: "loop_detected",
        severity: "warn",
        message: `intent '${runIntent}' fired ${runLen}× consecutively (rows ${runStart}..${endIdx-1})`,
        intent: runIntent,
        run_length: runLen,
      });
    }
  };
  telemetry.forEach((row, i) => {
    if (row.intent_category === runIntent) {
      runLen++;
    } else {
      flush(i);
      runStart = i; runIntent = row.intent_category; runLen = 1;
    }
  });
  flush(telemetry.length);
  return issues;
}

function detectExecutorDead(queueItems) {
  // Look for consecutive runs of done items with empty/null output
  const issues = [];
  let runLen = 0, runStart = -1;
  queueItems.forEach((q, i) => {
    const empty = !q.output || q.output.trim() === "" || q.output.length < 10;
    if (q.status === "done" && empty) {
      if (runLen === 0) runStart = i;
      runLen++;
    } else {
      if (runLen >= EMPTY_OUTPUT_THRESHOLD) {
        issues.push({
          kind: "executor_dead",
          severity: "error",
          message: `${runLen} consecutive done items returned empty output (items #${queueItems[runStart].id}..#${queueItems[i-1].id}) — executor likely unreachable`,
          run_length: runLen,
        });
      }
      runLen = 0;
    }
  });
  if (runLen >= EMPTY_OUTPUT_THRESHOLD) {
    issues.push({
      kind: "executor_dead",
      severity: "error",
      message: `${runLen} consecutive done items at end of run had empty output — executor likely unreachable`,
      run_length: runLen,
    });
  }
  return issues;
}

function detectStepQueueRate(telemetry) {
  if (telemetry.length === 0) return [];
  const n = telemetry.length;
  const queued = telemetry.filter((t) => t.step_queued === true).length;
  const rate = queued / n;
  if (rate < STEP_QUEUE_FLOOR) {
    return [{
      kind: "low_step_queue_rate",
      severity: "warn",
      message: `step_queued rate: ${(rate*100).toFixed(1)}% (${queued}/${n}) — below ${(STEP_QUEUE_FLOOR*100).toFixed(0)}% floor. Model is calling advance_offense but not producing queueable commands.`,
      rate,
    }];
  }
  return [];
}

function detectMembraneBreach(telemetry) {
  // Telemetry text fields that should NEVER contain raw offensive content
  const issues = [];
  for (const row of telemetry) {
    for (const field of ["intent_category", "outcome_notes", "error_message"]) {
      const v = row[field];
      if (!v) continue;
      for (const pattern of MEMBRANE_PATTERNS) {
        if (pattern.test(v)) {
          issues.push({
            kind: "membrane_breach",
            severity: "error",
            message: `telemetry row #${row.id} field '${field}' matches forbidden pattern ${pattern} — sanitization failed`,
            row_id: row.id, field, pattern: pattern.toString(),
          });
          break;
        }
      }
    }
  }
  return issues;
}

function detectStalledTasks(tasks, unblocked, nowMs) {
  const issues = [];
  for (const t of tasks) {
    if (t.status !== "pending") continue;
    if (!unblocked.includes(t.id)) continue;
    const created = new Date(t.created_at).getTime();
    const ageMin = (nowMs - created) / 60000;
    if (ageMin > STALL_MIN) {
      issues.push({
        kind: "task_stalled",
        severity: "warn",
        message: `task #${t.id} unblocked + pending for ${ageMin.toFixed(1)} min — orchestrator hasn't picked it up`,
        task_id: t.id, age_min: ageMin,
      });
    }
  }
  return issues;
}

function detectPhaseRegression(history) {
  // Walk audit_log for engagement_phase changes; flag any backward move.
  const order = ["recon", "enumeration", "foothold", "exploitation", "post_exploit", "reporting"];
  const issues = [];
  let lastIdx = -1;
  for (const h of history) {
    const idx = order.indexOf(h.phase);
    if (idx < 0) continue;
    if (lastIdx >= 0 && idx < lastIdx) {
      issues.push({
        kind: "phase_regression",
        severity: "warn",
        message: `engagement_phase moved backwards: ${order[lastIdx]} → ${h.phase} at ${h.at}`,
        from: order[lastIdx], to: h.phase, at: h.at,
      });
    }
    if (idx > lastIdx) lastIdx = idx;
  }
  return issues;
}

// ───────────────────── data fetch ─────────────────────

async function fetchAll() {
  const eng = await db.query(`SELECT id, engagement_phase, agent_status, created_at, updated_at FROM pentest_engagements WHERE id = $1`, [ENGAGEMENT_ID]);
  if (eng.rows.length === 0) {
    console.error(`engagement ${ENGAGEMENT_ID} not found`);
    process.exit(3);
  }
  const telemetry = await db.query(
    `SELECT id, intent_category, step_queued, n_hosts, n_findings, in_scope, latency_ms, outcome, outcome_notes, error_message, created_at
       FROM offense_telemetry WHERE engagement_id = $1 ORDER BY created_at ASC, id ASC`,
    [ENGAGEMENT_ID]);
  const queueItems = await db.query(
    `SELECT id, seq, title, status, output, created_at, completed_at FROM soc_queue_items WHERE engagement_id = $1 ORDER BY id ASC`,
    [ENGAGEMENT_ID]);
  let tasks = { rows: [] }, unblockedRes = { rows: [{ unblocked: [] }] };
  try {
    tasks = await db.query(`SELECT id, parent_ids, status, directive, phase, created_at FROM engagement_tasks WHERE engagement_id = $1 ORDER BY id ASC`, [ENGAGEMENT_ID]);
    // Compute unblocked-set the same way the API does
    const byId = Object.create(null);
    for (const t of tasks.rows) byId[t.id] = t;
    const isResolved = (t) => t.status === "done" || t.status === "skipped";
    const unblocked = [];
    for (const t of tasks.rows) {
      if (t.status !== "pending") continue;
      if ((t.parent_ids || []).every((pid) => byId[pid] && isResolved(byId[pid]))) unblocked.push(t.id);
    }
    unblockedRes.rows[0].unblocked = unblocked;
  } catch { /* engagement_tasks may not exist on legacy engagements */ }
  return {
    engagement: eng.rows[0],
    telemetry: telemetry.rows,
    queueItems: queueItems.rows,
    tasks: tasks.rows,
    unblocked: unblockedRes.rows[0].unblocked,
  };
}

// ───────────────────── output ─────────────────────

function renderMarkdown({ engagement, telemetry, queueItems, tasks, unblocked, issues }) {
  const lines = [];
  lines.push(`# Engagement diagnostic — ${engagement.id}`);
  lines.push("");
  lines.push(`- **agent_status:** ${engagement.agent_status}`);
  lines.push(`- **engagement_phase:** ${engagement.engagement_phase}`);
  lines.push(`- **created:** ${engagement.created_at}`);
  lines.push(`- **last update:** ${engagement.updated_at}`);
  lines.push("");
  lines.push("## Volumes");
  lines.push(`- telemetry rows: ${telemetry.length}`);
  lines.push(`- queue items:    ${queueItems.length}`);
  lines.push(`- DAG tasks:      ${tasks.length} (unblocked-pending: ${unblocked.length})`);
  lines.push("");
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
  lines.push("## Diagnosis");
  if (issues.length === 0) {
    lines.push("");
    lines.push("✓ No issues detected. Agent looks healthy.");
  } else {
    lines.push(`**${counts.error || 0} errors · ${counts.warn || 0} warnings · ${counts.info || 0} info**`);
    lines.push("");
    for (const sev of ["error", "warn", "info"]) {
      const matching = issues.filter((i) => i.severity === sev);
      if (matching.length === 0) continue;
      lines.push(`### ${sev.toUpperCase()}`);
      for (const issue of matching) {
        lines.push(`- **${issue.kind}**: ${issue.message}`);
      }
      lines.push("");
    }
  }
  if (telemetry.length > 0) {
    const queued = telemetry.filter((t) => t.step_queued).length;
    const inScope = telemetry.filter((t) => t.in_scope).length;
    const lats = telemetry.map((t) => t.latency_ms).filter((x) => typeof x === "number" && x > 0);
    const avgLatency = lats.length ? Math.round(lats.reduce((s, x) => s + x, 0) / lats.length) : 0;
    const p50 = Math.round(percentile(lats, 50));
    const p95 = Math.round(percentile(lats, 95));
    const max = lats.length ? Math.max(...lats) : 0;
    lines.push("## Stats");
    lines.push(`- step_queued rate: ${queued}/${telemetry.length} (${(100*queued/telemetry.length).toFixed(0)}%)`);
    lines.push(`- in_scope rate:    ${inScope}/${telemetry.length} (${(100*inScope/telemetry.length).toFixed(0)}%)`);
    lines.push(`- latency:          avg ${avgLatency} ms · p50 ${p50} ms · p95 ${p95} ms · max ${max} ms (n=${lats.length})`);
    const byIntent = {};
    for (const t of telemetry) byIntent[t.intent_category] = (byIntent[t.intent_category] || 0) + 1;
    lines.push("- intent distribution:");
    for (const [k, v] of Object.entries(byIntent).sort((a, b) => b[1] - a[1])) {
      lines.push(`  - ${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

// ───────────────────── exported analyzer (used by MCP tool) ─────────────────────

async function analyzeEngagement(engagementId) {
  // Same logic as the CLI main(), but returns the result rather than printing.
  // Module-level ENGAGEMENT_ID is bypassed; we use the arg.
  const eng = await db.query(`SELECT id, engagement_phase, agent_status, created_at, updated_at FROM pentest_engagements WHERE id = $1`, [engagementId]);
  if (eng.rows.length === 0) return { ok: false, error: `engagement ${engagementId} not found` };

  const telemetry = (await db.query(
    `SELECT id, intent_category, step_queued, n_hosts, n_findings, in_scope, latency_ms, outcome, outcome_notes, error_message, created_at
       FROM offense_telemetry WHERE engagement_id = $1 ORDER BY created_at ASC, id ASC`, [engagementId])).rows;
  const queueItems = (await db.query(
    `SELECT id, seq, title, status, output, created_at, completed_at FROM soc_queue_items WHERE engagement_id = $1 ORDER BY id ASC`, [engagementId])).rows;
  let tasks = [], unblocked = [];
  try {
    tasks = (await db.query(`SELECT id, parent_ids, status, directive, phase, created_at FROM engagement_tasks WHERE engagement_id = $1 ORDER BY id ASC`, [engagementId])).rows;
    const byId = Object.create(null); for (const t of tasks) byId[t.id] = t;
    const isResolved = (t) => t.status === "done" || t.status === "skipped";
    for (const t of tasks) {
      if (t.status !== "pending") continue;
      if ((t.parent_ids || []).every((pid) => byId[pid] && isResolved(byId[pid]))) unblocked.push(t.id);
    }
  } catch { /* engagement_tasks may not exist on legacy engagements */ }

  const nowMs = Date.now();
  const issues = [
    ...detectLoops(telemetry),
    ...detectExecutorDead(queueItems),
    ...detectStepQueueRate(telemetry),
    ...detectMembraneBreach(telemetry),
    ...detectStalledTasks(tasks, unblocked, nowMs),
    ...detectSlowInference(telemetry),
  ];
  const data = { engagement: eng.rows[0], telemetry, queueItems, tasks, unblocked };
  const report_md = renderMarkdown({ ...data, issues });
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
  return {
    ok: true,
    engagement_id: engagementId,
    engagement: eng.rows[0],   // {id, engagement_phase, agent_status, created_at, updated_at}
    issues, counts, report_md,
    n_telemetry: telemetry.length,
  };
}

// Fleet-wide: analyze every active engagement (in_progress OR agent_status
// in {running, error}). Returns one summary plus per-engagement reports.
async function analyzeAllActive() {
  const r = await db.query(
    `SELECT id FROM pentest_engagements
      WHERE status = 'in_progress' OR agent_status IN ('running', 'error')
      ORDER BY updated_at DESC NULLS LAST, id DESC`);
  const ids = r.rows.map((row) => row.id);
  const reports = [];
  let totalIssues = 0, totalErrors = 0, totalWarns = 0;
  for (const id of ids) {
    const res = await analyzeEngagement(id);
    if (!res.ok) {
      reports.push({ engagement_id: id, ok: false, error: res.error });
      continue;
    }
    totalIssues += res.issues.length;
    totalErrors += res.counts.error;
    totalWarns  += res.counts.warn;
    reports.push(res);
  }
  // Render a fleet summary
  const lines = [];
  lines.push(`# Fleet diagnostic — ${ids.length} active engagements`);
  lines.push("");
  lines.push(`**Totals:** ${totalIssues} issues across the fleet (${totalErrors} errors, ${totalWarns} warnings)`);
  lines.push("");
  if (ids.length === 0) {
    lines.push("_(no engagements with status='in_progress' or agent_status in {running, error})_");
  } else {
    lines.push("## Per-engagement summary");
    lines.push("| engagement | agent_status | phase | issues | errors | warnings |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of reports) {
      if (!r.ok) { lines.push(`| ${r.engagement_id} | — | — | ERR: ${r.error} | — | — |`); continue; }
      lines.push(`| ${r.engagement_id} | ${r.engagement.agent_status} | ${r.engagement.engagement_phase} | ${r.issues.length} | ${r.counts.error} | ${r.counts.warn} |`);
    }
    lines.push("");
    // Surface only engagements with issues for detail
    const flagged = reports.filter((r) => r.ok && r.issues.length > 0);
    if (flagged.length > 0) {
      lines.push("## Detail (only engagements with issues)");
      for (const r of flagged) {
        lines.push("");
        lines.push(`### ${r.engagement_id}`);
        for (const i of r.issues) {
          const sev = i.severity === "error" ? "🔴" : i.severity === "warn" ? "🟡" : "🔵";
          lines.push(`- ${sev} **${i.kind}**: ${i.message}`);
        }
      }
    }
  }
  return {
    n_engagements: ids.length,
    total_issues: totalIssues,
    total_errors: totalErrors,
    total_warns: totalWarns,
    report_md: lines.join("\n"),
    reports,
  };
}

module.exports = { analyzeEngagement, analyzeAllActive };

// ───────────────────── CLI main ─────────────────────

async function cliMain() {
  const args = process.argv.slice(2);
  const AS_JSON = args.includes("--json");
  const QUIET = args.includes("--quiet");
  const FLEET = args.includes("--fleet");

  if (FLEET) {
    const result = await analyzeAllActive();
    if (AS_JSON) {
      process.stdout.write(JSON.stringify({
        n_engagements: result.n_engagements,
        total_issues: result.total_issues,
        total_errors: result.total_errors,
        total_warns: result.total_warns,
        engagements: result.reports.map((r) => ({
          id: r.engagement_id || (r.engagement && r.engagement.id),
          ok: r.ok !== false,
          issues_count: r.issues ? r.issues.length : 0,
        })),
      }) + "\n");
    } else if (!QUIET) {
      process.stdout.write(result.report_md + "\n");
    }
    try { db.pool && db.pool.end && await db.pool.end(); } catch {}
    process.exit(result.total_errors > 0 ? 1 : 0);
  }

  const ENGAGEMENT_ID = args.find((a) => !a.startsWith("--"));
  if (!ENGAGEMENT_ID) {
    console.error("Usage:");
    console.error("  telemetry-analyze.js <engagement_id> [--json] [--quiet]");
    console.error("  telemetry-analyze.js --fleet [--json] [--quiet]   # all active engagements");
    process.exit(2);
  }
  const result = await analyzeEngagement(ENGAGEMENT_ID);
  if (!result.ok) {
    console.error(result.error);
    process.exit(3);
  }
  if (AS_JSON) {
    process.stdout.write(JSON.stringify({ engagement: result.engagement_id, issues: result.issues, counts: result.n_telemetry }) + "\n");
  } else if (!QUIET) {
    process.stdout.write(result.report_md + "\n");
  }
  try { db.pool && db.pool.end && await db.pool.end(); } catch {}
  process.exit(result.issues.some((i) => i.severity === "error") ? 1 : 0);
}

// Only run CLI if invoked directly (not when require()'d by the MCP handler)
if (require.main === module) {
  cliMain().catch((e) => {
    console.error("telemetry-analyze CRASH:", e.message);
    console.error(e.stack);
    process.exit(2);
  });
}
