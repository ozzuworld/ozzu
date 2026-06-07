// dispatch-tracer.js — dir_1780846511537
//
// Dry-run inspection tool: walks a hypothetical command through every gate
// layer of the SOC pipeline and returns a layered verdict report. No queue
// item is inserted. No hook is actually executed. No SSH is spawned.
//
// Layers traced (in dispatch order, same as autonomous-executor.maybeAutoExecute):
//   1. roe_blocklist          (regex prohibitions on engagement.roe)
//   2. permission_mode        (intent_class vs current mode ceiling)
//   3. workspace_jail         (IP/host extracted vs engagement.scope.targets[])
//   4. command_tokens         (token-level intent classifier, anti-spoof)
//   5. preflight_lint         (nmap flags, fake NSE names, etc.)
//   6. hooks_pre_queue        (lists registered hooks; doesn't execute them)
//   7. auto_verify_cve        (NVD CVE existence + product match)
//   8. auto_verify_nse        (nse_script_catalog lookup)
//   9. sploitus_enrichment    (informational, non-blocking)

"use strict";

const db = require("./db");

async function traceDispatch(engagementId, command, intentClass) {
  if (!engagementId || !command) {
    return { error: "engagement_id and command are required" };
  }
  // Fetch engagement
  const er = await db.query(
    `SELECT id, engagement_type, scope, roe, permission_mode, agent_status, executor_host
       FROM pentest_engagements WHERE id = $1`, [engagementId]);
  if (er.rows.length === 0) {
    return { error: `engagement ${engagementId} not found` };
  }
  const eng = er.rows[0];
  const intent = intentClass || "recon";
  const layers = [];
  let blockingLayer = null;
  let blockingReason = null;

  function addLayer(name, allowed, details) {
    layers.push({ layer: name, outcome: allowed ? "allowed" : "denied", details: details || {} });
    if (!allowed && !blockingLayer) {
      blockingLayer = name;
      blockingReason = (details && details.reason) || (details && details.denied_reason) || `${name} denied`;
    }
  }

  // 1. ROE blocklist
  try {
    const ae = require("./autonomous-executor");
    const roeHit = ae.roeLint(command, eng.roe);
    addLayer("roe_blocklist", !roeHit, roeHit ? { reason: `ROE blocklist hit: ${roeHit}`, pattern: roeHit, prohibited: eng.roe } : { prohibited_count: Array.isArray(eng.roe && eng.roe.prohibited) ? eng.roe.prohibited.length : 0 });
  } catch (e) { addLayer("roe_blocklist", true, { tracer_note: "skipped: " + e.message }); }

  // 2. permission_mode
  try {
    const pe = require("./permission-enforcer");
    const v = pe.enforcePermissionMode(eng, intent);
    addLayer("permission_mode", v.allowed, {
      current_mode: v.current_mode,
      required_mode: v.required_mode,
      reason: v.denied_reason,
    });
  } catch (e) { addLayer("permission_mode", true, { tracer_error: e.message }); }

  // 3. workspace_jail
  try {
    const pe = require("./permission-enforcer");
    const v = pe.enforceWorkspaceJail(eng, command);
    addLayer("workspace_jail", v.allowed, {
      scope_targets: v.scope_targets,
      found_targets: v.found_targets,
      out_of_scope_targets: v.out_of_scope_targets,
      reason: v.denied_reason,
      note: v.note,
    });
  } catch (e) { addLayer("workspace_jail", true, { tracer_error: e.message }); }

  // 4. command_tokens (anti-spoof)
  try {
    const pe = require("./permission-enforcer");
    const v = pe.enforceCommandTokens(eng, command);
    addLayer("command_tokens", v.allowed, {
      command_intent: v.command_intent,
      first_token: v.first_token,
      matched_rule: v.matched_rule,
      required_mode: v.required_mode,
      reason: v.reason,
    });
  } catch (e) { addLayer("command_tokens", true, { tracer_error: e.message }); }

  // 5. preflight_lint
  try {
    const ae = require("./autonomous-executor");
    const hit = ae.lintCommandPreflight(command, { executor_host: eng.executor_host });
    addLayer("preflight_lint", !hit, hit ? { rule: hit.rule, match: hit.match, hint: hit.hint, reason: hit.hint } : { tests: "passed" });
  } catch (e) { addLayer("preflight_lint", true, { tracer_error: e.message }); }

  // 6. hooks_pre_queue (lookup only — never execute in tracer)
  try {
    const hr = await db.query(
      `SELECT id, command, enabled, timeout_ms FROM engagement_hooks
        WHERE event = 'pre_queue_dispatch'
          AND enabled = true
          AND (engagement_id IS NULL OR engagement_id = $1)
        ORDER BY id ASC`, [engagementId]);
    addLayer("hooks_pre_queue", true, {
      registered_count: hr.rows.length,
      hooks: hr.rows.map(h => ({ id: h.id, command_preview: (h.command || "").slice(0, 80), timeout_ms: h.timeout_ms })),
      note: "tracer does NOT execute hooks — only lists registered ones. Actual dispatch may deny.",
    });
  } catch (e) { addLayer("hooks_pre_queue", true, { tracer_error: e.message }); }

  // 7. auto_verify_cve
  try {
    const ae = require("./autonomous-executor");
    const hit = await ae.autoVerifyCves(command, eng);
    addLayer("auto_verify_cve", !hit, hit ? { rule: hit.rule, match: hit.match, hint: hit.hint, reason: hit.hint } : { tests: "passed_or_no_cves_in_command" });
  } catch (e) { addLayer("auto_verify_cve", true, { tracer_error: e.message }); }

  // 8. auto_verify_nse
  try {
    const ae = require("./autonomous-executor");
    const hit = await ae.autoCheckNseNames(command);
    addLayer("auto_verify_nse", !hit, hit ? { rule: hit.rule, match: hit.match, hint: hit.hint, reason: hit.hint } : { tests: "passed_or_no_nse_in_command" });
  } catch (e) { addLayer("auto_verify_nse", true, { tracer_error: e.message }); }

  // 9. sploitus enrichment (informational; never blocks)
  try {
    const ae = require("./autonomous-executor");
    const enrich = await ae.autoEnrichSploitus(command);
    layers.push({
      layer: "sploitus_enrichment",
      outcome: "informational",
      details: enrich ? { rule: enrich.rule, hint: enrich.hint, would_append_to_output: enrich.note ? enrich.note.length : 0 } : { tests: "no_cves_or_no_pocs" },
    });
  } catch (e) {
    layers.push({ layer: "sploitus_enrichment", outcome: "informational", details: { tracer_error: e.message } });
  }

  return {
    engagement_id: engagementId,
    engagement_phase: eng.engagement_phase || null,
    permission_mode: eng.permission_mode || "enumeration",
    command_preview: String(command).slice(0, 300),
    intent_class: intent,
    layers,
    final_verdict: blockingLayer ? "would_be_blocked" : "would_execute",
    blocking_layer: blockingLayer,
    blocking_reason: blockingReason,
    scope_targets: (() => {
      try {
        const s = typeof eng.scope === "string" ? JSON.parse(eng.scope || "{}") : (eng.scope || {});
        return Array.isArray(s.targets) ? s.targets : [];
      } catch (_) { return []; }
    })(),
  };
}

function renderTraceMarkdown(trace) {
  if (!trace || trace.error) return `**trace_dispatch error:** ${trace && trace.error}`;
  const verdict = trace.final_verdict === "would_execute"
    ? "✅ **WOULD EXECUTE**"
    : `🛑 **WOULD BE BLOCKED** at layer \`${trace.blocking_layer}\``;
  const head = [
    `# Dispatch trace for ${trace.engagement_id}`,
    "",
    `**Command:** \`${trace.command_preview}\``,
    `**Declared intent_class:** \`${trace.intent_class}\``,
    `**Engagement permission_mode:** \`${trace.permission_mode}\``,
    `**Scope targets:** ${trace.scope_targets.length ? trace.scope_targets.join(", ") : "(none declared — permissive)"}`,
    "",
    `## Final verdict: ${verdict}`,
    trace.blocking_reason ? `**Reason:** ${trace.blocking_reason}\n` : "",
    "",
    "## Layer-by-layer",
  ];
  const layerLines = trace.layers.map((l) => {
    const icon = l.outcome === "allowed" ? "✅"
              : l.outcome === "denied"  ? "🛑"
              : "ℹ️";
    const dKeys = Object.keys(l.details || {}).filter(k => l.details[k] != null);
    const dStr = dKeys.length
      ? "\n  " + dKeys.map(k => {
          const v = l.details[k];
          const s = typeof v === "string" ? v
                  : Array.isArray(v) ? v.slice(0, 5).join(", ")
                  : JSON.stringify(v).slice(0, 200);
          return `- ${k}: ${s}`;
        }).join("\n  ")
      : "";
    return `### ${icon} ${l.layer} → ${l.outcome}${dStr}`;
  });
  return head.concat(layerLines).join("\n");
}

module.exports = { traceDispatch, renderTraceMarkdown };
