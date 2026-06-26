#!/usr/bin/env node
"use strict";

// report-via-model.js — Generates pentest reports from engagement trajectory.
// Two modes:
//   CLI:    node report-via-model.js <trajectory.jsonl> <scope.json> <fullPath|none> <debriefPath>
//   Module: require("report-via-model").generateReport(engagementId)

const fs = require("fs");
const path = require("path");

const RAW_URL = process.env.OFFENSE_MODEL_URL || "https://openrouter.ai/api/v1";
const MODEL_URL = RAW_URL.endsWith("/chat/completions") ? RAW_URL : `${RAW_URL.replace(/\/+$/, "")}/v1/chat/completions`;
// deepseek-reasoner (R1) doesn't support system messages and is slow for report writing.
// Default to deepseek-chat (V3) which is faster and supports system messages.
const MODEL_NAME = process.env.REPORT_MODEL || "deepseek-chat";
const MODEL_KEY = process.env.OFFENSE_MODEL_KEY || "";

async function callModel(systemPrompt, userPrompt) {
  const resp = await fetch(MODEL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MODEL_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 8000,
      temperature: 0.3,
    }),
  });
  if (!resp.ok) throw new Error(`Model API ${resp.status}: ${await resp.text().catch(() => "")}`);
  const j = await resp.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}

function buildTrajectoryDigest(iters, maxSteps) {
  const lines = [];
  const slice = iters.slice(0, maxSteps || 200);
  for (const it of slice) {
    const status = it.exit_code === 0 ? "OK" : it.exit_code === 1 ? "FAIL" : "PENDING";
    const flag = it.flag_captured ? " [FLAG]" : "";
    const intent = it.intent_class ? ` (${it.intent_class})` : "";
    const excerpt = (it.output_excerpt || "").replace(/\n/g, " ").slice(0, 300);
    lines.push(`[${it.iter}] ${status}${intent}${flag}: ${(it.command || "").slice(0, 120)}`);
    if (excerpt) lines.push(`    → ${excerpt}`);
  }
  if (iters.length > (maxSteps || 200)) {
    lines.push(`... (${iters.length - (maxSteps || 200)} more steps truncated)`);
  }
  return lines.join("\n");
}

const DEBRIEF_SYSTEM = `You are a senior penetration test report writer. Given a pentest engagement trajectory (commands run, outputs, findings), produce a SANITIZED DEBRIEF report.

The debrief is for the CLIENT — it must:
- Describe what was tested and what was found
- List all findings with severity, affected asset, description, evidence summary, and remediation
- Include an executive summary
- NOT contain raw exploit code, shell commands, or attack payloads
- NOT contain raw tool output dumps
- Use professional language suitable for a non-technical executive + technical IT staff

Format as clean Markdown with these sections:
# Executive Summary
# Scope & Methodology
# Findings (table + detail per finding)
# Recommendations
# Appendix: Timeline`;

const FULL_SYSTEM = `You are a senior penetration test report writer. Given a pentest engagement trajectory, produce the FULL OPERATOR REPORT with complete technical detail.

This report is for the OPERATOR (internal red team) — it must:
- Include every command run and key output excerpts
- Document the full attack chain for each finding
- Note what worked, what didn't, and why
- Include remediation recommendations with technical specifics
- Be honest about false positives and dead ends

Format as Markdown with:
# Engagement Summary
# Attack Narrative (chronological)
# Findings (full technical detail per finding)
# Failed Approaches
# Recommendations`;

async function generateFromTrajectory(trajectoryData, scopeData, fullPath, debriefPath) {
  const digest = buildTrajectoryDigest(trajectoryData.iters || [], 200);
  const scopeStr = JSON.stringify(scopeData, null, 1);

  const userPrompt = `Engagement: ${scopeData.id || "unknown"}
Client: ${scopeData.client_name || "unknown"}
Type: ${scopeData.engagement_type || "internal_pentest"}
Scope: ${scopeStr}
Total steps: ${(trajectoryData.iters || []).length}

TRAJECTORY:
${digest}`;

  // Always generate debrief
  console.log(`[report] Generating debrief (${(trajectoryData.iters || []).length} steps, model: ${MODEL_NAME})...`);
  const debrief = await callModel(DEBRIEF_SYSTEM, userPrompt);
  if (debrief && debriefPath) {
    fs.mkdirSync(path.dirname(debriefPath), { recursive: true });
    fs.writeFileSync(debriefPath, debrief, "utf8");
    console.log(`[report] Debrief written: ${debriefPath} (${debrief.length} chars)`);
  }

  // Generate full report if requested
  if (fullPath && fullPath !== "none") {
    console.log(`[report] Generating full operator report...`);
    const full = await callModel(FULL_SYSTEM, userPrompt);
    if (full) {
      fs.writeFileSync(fullPath, full, "utf8");
      console.log(`[report] Full report written: ${fullPath} (${full.length} chars)`);
    }
  }

  return { debrief, full: fullPath !== "none" };
}

// Module API — called from offense-agent.js
async function generateReport(engagementId) {
  const db = require("/app/db");
  const er = await db.query(`SELECT * FROM pentest_engagements WHERE id = $1`, [engagementId]);
  if (er.rows.length === 0) throw new Error(`Engagement ${engagementId} not found`);
  const eng = er.rows[0];

  const qr = await db.query(
    `SELECT seq, command, output, status, intent_class FROM soc_queue_items WHERE engagement_id = $1 ORDER BY seq`,
    [engagementId]
  );
  if (qr.rows.length === 0) throw new Error("No trajectory data");

  const iters = qr.rows.map((q) => ({
    iter: q.seq,
    intent_class: q.intent_class || null,
    exit_code: q.status === "done" ? 0 : q.status === "failed" ? 1 : null,
    flag_captured: /OZZULAB\{/.test(q.output || ""),
    command: q.command || "",
    output_excerpt: (q.output || "").slice(0, 4000),
  }));

  const scopeObj = {
    id: eng.id,
    client_name: eng.client_name,
    engagement_type: eng.engagement_type,
    scope: eng.scope,
    executor_host: eng.executor_host,
  };

  const dir = `/home/gcp/ozzu/private/soc-reports/${engagementId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const fullPath = `${dir}/report-FULL.md`;
  const debriefPath = `${dir}/report-DEBRIEF.md`;

  return generateFromTrajectory({ engagement_id: engagementId, iters }, scopeObj, fullPath, debriefPath);
}

// CLI mode
if (require.main === module) {
  const [, , trajPath, scopePath, fullPath, debriefPath] = process.argv;
  if (!trajPath || !scopePath || !debriefPath) {
    console.error("Usage: report-via-model.js <trajectory.jsonl> <scope.json> <fullPath|none> <debriefPath>");
    process.exit(1);
  }
  const traj = JSON.parse(fs.readFileSync(trajPath, "utf8"));
  const scope = JSON.parse(fs.readFileSync(scopePath, "utf8"));
  generateFromTrajectory(traj, scope, fullPath, debriefPath)
    .then(() => process.exit(0))
    .catch((e) => { console.error("[report] Fatal:", e.message); process.exit(1); });
}

module.exports = { generateReport, generateFromTrajectory };
