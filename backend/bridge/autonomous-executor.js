// autonomous-executor.js — dir_1780784224487
//
// Phase-gated autonomous execution. Model self-runs recon/enumeration steps;
// only foothold / post_exploit / lateral / exploitation queue as pending for
// human approval. Phase-advance into a gated phase fires a push notification
// to King Kazuma's iPhone (throttled).
//
// See feedback_soc_observer_role.md for the role boundary: Cipher does NOT
// trigger autonomous execution — it's the L3 model's queueStep call that
// triggers it. Cipher only observes the result via telemetry.

"use strict";

const fs = require("fs");
const path = require("path");
const db = require("/app/db");
const { sendPush } = require("/app/push-notifications");

const AUTO_RUN_PHASES = new Set(["recon", "enumeration"]);
const GATE_PHASES     = new Set(["foothold", "exploitation", "post_exploit", "lateral", "reporting"]);

// Step-level intent classifier (dir_1780784990563). Replaces phase-only gating
// with per-step intent + content-lint verification.
const AUTO_RUN_INTENTS = new Set(["recon", "enum", "banner_grab", "service_version", "tool_setup"]);
const GATE_INTENTS     = new Set(["cred_test", "exploit_probe", "lateral", "post_exploit"]);
const VALID_INTENTS    = new Set([...AUTO_RUN_INTENTS, ...GATE_INTENTS]);

// Hot-reloadable intent rules. Loaded once, refreshed on file mtime change.
let _rulesCache = { mtime: 0, rules: [] };
function loadIntentRules() {
  const p = "/app/lint/intent-rules.json";
  try {
    const st = fs.statSync(p);
    if (st.mtimeMs !== _rulesCache.mtime) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      _rulesCache = {
        mtime: st.mtimeMs,
        rules: (Array.isArray(j.rules) ? j.rules : []).map(r => ({
          intent: r.intent,
          patterns: (Array.isArray(r.patterns) ? r.patterns : []).map(s => {
            // Strip PCRE-style inline flags `(?i)` / `(?m)` / `(?ims)` etc.
            // JS RegExp doesn't accept inline flags — must be passed separately.
            let body = s;
            let flags = "";
            const m = body.match(/^\(\?([imsxu]+)\)/);
            if (m) {
              flags = m[1].replace(/[xu]/g, ""); // JS supports i,m,s,u — drop x (extended); keep u optional
              body = body.slice(m[0].length);
            }
            try { return new RegExp(body, flags); } catch (e) {
              console.warn(`[autonomous-executor] dropped invalid pattern for intent=${r.intent}: ${s.slice(0, 80)} (${e.message})`);
              return null;
            }
          }).filter(Boolean),
        })),
      };
    }
  } catch (e) {
    // Don't crash if the rules file is missing — fall back to empty (no inference).
    if (_rulesCache.rules.length === 0) _rulesCache = { mtime: 0, rules: [] };
  }
  return _rulesCache.rules;
}

// Pre-process a command body for inference. Decodes any `echo <b64> | base64 -d`
// chunks inline (wrapForExecutor wraps tablet/adb commands this way) so the
// pattern dictionary can see the actual underlying command. Original wrapping
// stays — we APPEND the decoded text rather than replace. Handles multiple
// wrapping layers by iterating until stable (cap 4 passes to avoid loops).
function unwrapCommand(command) {
  let body = String(command || "");
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    body = body.replace(/echo\s+([A-Za-z0-9+/=]{12,})\s*\|\s*base64\s+(?:-d|--decode)\b/g, (m, b64) => {
      try {
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        // Only treat as a meaningful decode if it looks like text we'd lint
        // — i.e. doesn't contain too many non-printable bytes.
        const printable = (decoded.match(/[\x20-\x7E\n\t\r]/g) || []).length;
        if (printable / Math.max(1, decoded.length) >= 0.85) {
          changed = true;
          return `${m}  ${decoded}`;
        }
      } catch (_) { /* fall through */ }
      return m;
    });
    if (!changed) break;
  }
  return body;
}

// ── Pre-flight command linter (dir_1780794595572) ──
// Catches MODEL command-syntax bugs before they hit the executor. The model
// sees the rejection diagnostic via wait_for_outcome and self-corrects on
// the next iter. Rules live in lint/cmd-preflight-rules.json.
let _preflightCache = { mtime: 0, rules: [] };
function loadPreflightRules() {
  const p = "/app/lint/cmd-preflight-rules.json";
  try {
    const st = fs.statSync(p);
    if (st.mtimeMs !== _preflightCache.mtime) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      _preflightCache = {
        mtime: st.mtimeMs,
        rules: (Array.isArray(j.rules) ? j.rules : []).map(r => ({
          id: r.id,
          pattern: (() => {
            let body = String(r.pattern || "");
            let flags = "";
            const m = body.match(/^\(\?([imsxu]+)\)/);
            if (m) {
              flags = m[1].replace(/[xu]/g, "");
              body = body.slice(m[0].length);
            }
            try { return new RegExp(body, flags); } catch (_) { return null; }
          })(),
          applies_when: r.applies_when || "any",
          hint: r.hint || "",
          allowlist: Array.isArray(r.allowlist) ? r.allowlist : null,
        })).filter(r => r.pattern),
      };
    }
  } catch (e) {
    if (_preflightCache.rules.length === 0) _preflightCache = { mtime: 0, rules: [] };
  }
  return _preflightCache.rules;
}

// Returns null if pass, { rule, hint, match } if a rule rejects.
function lintCommandPreflight(commandText, engagement) {
  if (!commandText) return null;
  const isTablet = engagement && engagement.executor_host && engagement.executor_host !== "dev-01";
  const body = unwrapCommand(commandText);
  const rules = loadPreflightRules();
  for (const r of rules) {
    if (r.applies_when === "tablet" && !isTablet) continue;
    if (r.applies_when === "dev-01" && isTablet) continue;
    const m = body.match(r.pattern);
    if (!m) continue;
    // Allowlist short-circuit (for --script <name> rule)
    if (r.allowlist && m[1]) {
      // Comma-separated multi-script: each must be in the allowlist
      const names = String(m[1]).split(",").map(s => s.trim()).filter(Boolean);
      const bad = names.filter(n => !r.allowlist.includes(n));
      if (bad.length === 0) continue;
      return { rule: r.id, hint: r.hint, match: bad.join(",") };
    }
    return { rule: r.id, hint: r.hint, match: m[0].slice(0, 100) };
  }
  return null;
}

// inferIntentFromCommand: scan the command string against the rules dictionary.
// Returns the FIRST matching intent. The rules file ORDERS most-specific →
// least-specific so e.g. `cred_test` regex wins over `enum` regex on a
// `hydra` command. Pre-processes the command via unwrapCommand so tablet
// adb-wrapped + base64-encoded commands also classify correctly. Returns
// null when nothing matches.
function inferIntentFromCommand(command) {
  if (!command || typeof command !== "string") return null;
  const body = unwrapCommand(command);
  const rules = loadIntentRules();
  for (const r of rules) {
    for (const re of r.patterns) {
      if (re.test(body)) return r.intent;
    }
  }
  return null;
}

// ── Harness auto-verify (dir_1780831335787) ──
// Multi-agent Step 8 flow doesn't use function-calling so the model never
// invokes verify_cve / list_nse_scripts. Harness extracts the same signals
// from the synthesizer's command + auto-checks them via the same code paths
// the (unused-by-model) MCP tools use.

const CVE_EXTRACT_RE = /CVE-\d{4}-\d{4,7}/gi;
const NSE_SCRIPT_RE  = /--script[=\s]+([A-Za-z0-9_,*-]+)/gi;

async function autoVerifyCves(body, engagement) {
  const ids = [...new Set([...body.matchAll(CVE_EXTRACT_RE)].map(m => m[0].toUpperCase()))];
  if (ids.length === 0) return null;
  let mk;
  try { mk = require("/app/model-knowledge-tools"); }
  catch (_) { return null; } // model-knowledge-tools not loaded — skip silently
  for (const id of ids) {
    let result;
    try { result = await mk.verifyCve({ cve_id: id }); }
    catch (_) { continue; }
    if (!result || result.error) continue;
    if (result.exists === false) {
      return {
        rule: "auto_cve_not_found",
        hint: `${id} not found in NVD. Real CVE IDs match a record. Either the ID is wrong (typo from CVE-2021-36260?) or fabricated. Call verify_cve before citing CVE IDs, or check ExploitDB via search_exploits for the real ID.`,
        match: id,
      };
    }
    // Affected-product mismatch check
    const targetTokens = collectTargetTokens(engagement);
    if (targetTokens.length === 0) continue;
    const affected = Array.isArray(result.affected_products) ? result.affected_products.join(" ").toLowerCase() : "";
    const summary = (result.summary || "").toLowerCase();
    const matched = targetTokens.some(t => affected.includes(t) || summary.includes(t));
    if (!matched) {
      return {
        rule: "auto_cve_affected_mismatch",
        hint: `${id} exists but its affected_products do NOT include the engagement target. Sample affected CPE: ${(result.affected_products || []).slice(0,3).join(" | ") || "(none)"}. Summary: ${(result.summary || "").slice(0,180)}. Pick a CVE whose affected_products actually covers the target.`,
        match: id,
      };
    }
  }
  return null;
}

function collectTargetTokens(engagement) {
  const tokens = [];
  if (!engagement) return tokens;
  // scope.targets is a free-text array; pull alphabetic vendor/product tokens
  try {
    const scope = typeof engagement.scope === "object" ? engagement.scope : JSON.parse(engagement.scope || "{}");
    const t = Array.isArray(scope.targets) ? scope.targets.join(" ").toLowerCase() : "";
    for (const word of t.match(/\b[a-z][a-z0-9]{2,}\b/g) || []) tokens.push(word);
  } catch (_) {}
  return [...new Set(tokens)].filter(w => !["the","and","for","via","with","over","local","internal","external","subnet","lan","wifi"].includes(w));
}

// ── Auto-enrich with Sploitus (dir_1780841976173) ──
// When a CVE is mentioned in the command body, query Sploitus in parallel
// for available PoCs. Returns null OR an informational note (non-blocking)
// that gets appended to the queue item output so the aggregator/next iter
// sees the real PoC IDs instead of letting the model fabricate them.
async function autoEnrichSploitus(body) {
  const ids = [...new Set([...body.matchAll(CVE_EXTRACT_RE)].map(m => m[0].toUpperCase()))];
  if (ids.length === 0) return null;
  let mk;
  try { mk = require("/app/model-knowledge-tools"); }
  catch (_) { return null; }
  if (typeof mk.searchSploitus !== "function") return null;
  const results = [];
  for (const id of ids.slice(0, 3)) {
    let r;
    try { r = await mk.searchSploitus({ query: id, type: "exploits", limit: 5 }); }
    catch (_) { continue; }
    if (!r || r.error || !Array.isArray(r.exploits) || r.exploits.length === 0) continue;
    const summary = r.exploits.slice(0, 5)
      .map((e) => `  - [${e.type}] ${e.id} — ${(e.title || "").slice(0, 80)}${e.source_url ? ` (${e.source_url})` : ""}`)
      .join("\n");
    results.push(`${id}: ${r.exploits.length}/${r.total_results || r.exploits.length} PoCs available\n${summary}`);
  }
  if (results.length === 0) return null;
  return {
    rule: "sploitus_pocs_enriched",
    hint: `Sploitus PoCs available for ${results.length} of the ${ids.length} CVE(s) cited`,
    note: `[SPLOITUS_ENRICHMENT — dir_1780841976173]\n${results.join("\n\n")}\n[end enrichment]`,
  };
}

async function autoCheckNseNames(body) {
  const matches = [...body.matchAll(NSE_SCRIPT_RE)];
  if (matches.length === 0) return null;
  const names = new Set();
  for (const m of matches) {
    for (const n of String(m[1] || "").split(",")) {
      const trimmed = n.trim();
      if (trimmed && !["all", "default", "safe", "vuln", "discovery", "auth", "broadcast", "brute", "intrusive", "malware", "fuzzer", "external", "version", "dos", "exploit"].includes(trimmed)) {
        names.add(trimmed);
      }
    }
  }
  if (names.size === 0) return null;
  // Check against nse_script_catalog
  for (const name of names) {
    try {
      const r = await db.query("SELECT 1 FROM nse_script_catalog WHERE name=$1 LIMIT 1", [name]);
      if (r.rows.length === 0) {
        return {
          rule: "auto_nse_not_found",
          hint: `--script "${name}" is not a real Nmap NSE script. Call list_nse_scripts({category:'...'}) to see what's available, or use a category alias like 'safe','vuln','discovery'. Common SSH scripts: ssh-hostkey, ssh-auth-methods, ssh2-enum-algos. Common RTSP: rtsp-methods, rtsp-url-brute.`,
          match: name,
        };
      }
    } catch (_) { /* catalog table missing — fall through */ }
  }
  return null;
}

// Throttle: max 1 push per engagement per N seconds (any cause).
const PHASE_PUSH_THROTTLE_SEC = 300;

// --- ROE block-list lint ---
// Cheap regex pass on the command string. Patterns come from the engagement's
// roe.prohibited[] array. Each entry is treated as a case-insensitive substring
// match by default; entries prefixed `re:` are treated as regex.
function roeLint(command, roe) {
  if (!roe || !command) return null;
  const prohibited = Array.isArray(roe.prohibited) ? roe.prohibited :
                    (roe.prohibited ? [roe.prohibited] : []);
  if (prohibited.length === 0) return null;
  const cmd = String(command).toLowerCase();
  for (const p of prohibited) {
    if (typeof p !== "string") continue;
    if (p.startsWith("re:")) {
      try {
        const re = new RegExp(p.slice(3), "i");
        if (re.test(command)) return p;
      } catch (_) { /* invalid regex — skip */ }
    } else {
      // Substring match on hint phrases. Match against keywords from the
      // prohibited line — too literal a match misses "Factory data reset"
      // when the prohibited line is "factory reset, firmware wipe, ...".
      const keywords = p.toLowerCase().split(/[,/(){}\[\]]+/).map(s => s.trim()).filter(Boolean);
      for (const kw of keywords) {
        if (kw.length < 4) continue; // skip noise words
        if (cmd.includes(kw)) return `${p} (matched: "${kw}")`;
      }
    }
  }
  return null;
}

// Log mismatch + write diagnostic to queue row. Membrane bypass since the
// diagnostic may quote the offending command.
async function recordIntentMismatch(engagementId, itemId, claimed, inferred, command) {
  try {
    await db.query(
      `INSERT INTO offense_telemetry
         (engagement_id, queue_item_id, model_used, intent_category,
          n_hosts, n_findings, step_queued, in_scope, n_references,
          latency_ms, outcome, outcome_notes, error_message)
       VALUES ($1, $2, 'lint', $3, 0, 0, true, true, 0, 0,
               'intent_mismatch', $4, NULL)`,
      [engagementId, itemId, claimed || "(none)",
       `claimed=${claimed || "(none)"}, inferred=${inferred}`]);
  } catch (_) { /* telemetry never breaks gating */ }
  try {
    await db.withBypass("intent_mismatch_diag", (client) => client.query(
      `UPDATE soc_queue_items
          SET output = COALESCE(output, '') ||
                       '[INTENT_MISMATCH dir_1780784990563] declared=' || $1 ||
                       ' but command content suggests=' || $2 ||
                       '. Gated — human review required.'
        WHERE id = $3`,
      [claimed || "(none)", inferred, itemId]));
  } catch (e) {
    console.error(`[autonomous-executor] mismatch diag write failed:`, e.message);
  }
}

// --- main: called from queueStep after the row is inserted ---
async function maybeAutoExecute(queueItemId, opts = {}) {
  try {
    const r = await db.query(
      `SELECT q.id, q.command, q.engagement_id, q.intent_class,
              e.autonomous_execution_enabled, e.autonomous_paused,
              e.autonomous_full_access,
              e.engagement_phase, e.roe, e.executor_host,
              e.permission_mode, e.scope
         FROM soc_queue_items q
         JOIN pentest_engagements e ON q.engagement_id = e.id
        WHERE q.id = $1`,
      [queueItemId]);
    if (r.rows.length === 0) return { autoExecuted: false, reason: "queue item not found" };
    const item = r.rows[0];

    if (!item.autonomous_execution_enabled) return { autoExecuted: false, reason: "engagement opt-out" };
    if (item.autonomous_paused)              return { autoExecuted: false, reason: "engagement paused" };

    // ROE block-list lint always runs first. ROE-prohibited wins everything.
    const roeHit = roeLint(item.command, item.roe);
    if (roeHit) {
      await db.withBypass("autonomous_roe_block", (client) => client.query(
        `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
        [`[ROE-BLOCKED — prohibited pattern matched: ${roeHit}]\n[See engagement.roe.prohibited.]`, item.id]));
      return { autoExecuted: false, reason: "ROE block-list hit", pattern: roeHit };
    }

    // dir_1780844590951: claw-analog permission modes + workspace jail.
    // Runs AFTER ROE blocklist (which is absolute) but BEFORE the preflight
    // linter and auto-verify. Declarative replacement for scattered
    // autonomous_full_access / intent_class gating.
    try {
      const enforcer = require("/app/permission-enforcer");
      const pEng = {
        permission_mode: item.permission_mode,
        scope:           item.scope,
      };
      const verdict = enforcer.enforceAll(pEng, item.intent_class, item.command);
      if (!verdict.allowed) {
        const diag = `[PERMISSION_DENIED — dir_1780844590951]\nlayer=${verdict.layer}\nreason=${verdict.denied_reason}\ncurrent_mode=${verdict.current_mode || pEng.permission_mode || "enumeration"}${verdict.required_mode ? `\nrequired_mode=${verdict.required_mode}` : ""}${verdict.out_of_scope_targets ? `\nout_of_scope=${verdict.out_of_scope_targets.join(", ")}` : ""}`;
        await db.withBypass("autonomous_permission_deny", (client) => client.query(
          `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
          [diag, item.id]));
        try {
          await db.query(
            `INSERT INTO offense_telemetry
               (engagement_id, queue_item_id, model_used, intent_category,
                n_hosts, n_findings, step_queued, in_scope, n_references,
                latency_ms, outcome, outcome_notes)
             VALUES ($1, $2, 'permission_enforcer', $3, 0, 0, false, false, 0, 0,
                     'permission_denied', $4)`,
            [item.engagement_id, item.id, verdict.layer || "unknown",
             `${verdict.layer}: ${(verdict.denied_reason || "").slice(0, 200)}`]);
        } catch (_) {}
        return { autoExecuted: false, reason: `permission:${verdict.layer}`, hint: verdict.denied_reason };
      }
    } catch (e) {
      console.error(`[autonomous-executor] permission enforcer failed:`, e.message);
    }

    // dir_1780794595572: pre-flight command linter. Catches model command-
    // syntax bugs (quoted user@host, nmap without -Pn -sT on tablet, fake NSE
    // scripts). Diagnostic lands in output column so wait_for_outcome surfaces
    // the hint to the model on next iter — model self-corrects instead of
    // accumulating "this avenue doesn't work" context.
    // dir_1780831335787: harness auto-verify of CVE + NSE references.
    // Runs in parallel with the regex preflight — first hit wins. Works on
    // any model regardless of function-calling support (Step 8 multi-agent
    // included).
    let autoVerifyHit = null;
    try {
      const body = (() => { try { return require("/app/autonomous-executor").__bodyForLint?.(item.command); } catch (_) { return item.command; } })() || item.command;
      const decoded = (typeof unwrapCommand === "function") ? unwrapCommand(body) : body;
      const fullText = `${item.command || ""} ${decoded || ""}`;
      const engRow = await db.query(
        `SELECT scope FROM pentest_engagements WHERE id = $1`, [item.engagement_id]);
      const engagement = engRow.rows[0] || null;
      const [cveHit, nseHit, sploitusEnrich] = await Promise.all([
        autoVerifyCves(fullText, engagement),
        autoCheckNseNames(fullText),
        autoEnrichSploitus(fullText),
      ]);
      autoVerifyHit = cveHit || nseHit;
      // Non-blocking enrichment: append Sploitus PoC list to queue item output
      // (only when CVE wasn't auto-refuted — no point enriching a fabricated ID).
      if (!autoVerifyHit && sploitusEnrich) {
        try {
          await db.withBypass("autonomous_sploitus_enrich", (client) => client.query(
            `UPDATE soc_queue_items
                SET output = COALESCE(output, '') || E'\n\n' || $1
              WHERE id = $2`,
            [sploitusEnrich.note, item.id]));
          await db.query(
            `INSERT INTO offense_telemetry
               (engagement_id, queue_item_id, model_used, intent_category,
                n_hosts, n_findings, step_queued, in_scope, n_references,
                latency_ms, outcome, outcome_notes)
             VALUES ($1, $2, 'sploitus', 'autoenrich', 0, 0, false, true, 0, 0,
                     'sploitus_pocs_enriched', $3)`,
            [item.engagement_id, item.id, sploitusEnrich.hint.slice(0, 200)]);
        } catch (e) { console.error(`[autonomous-executor] sploitus enrich failed:`, e.message); }
      }
    } catch (e) {
      console.error(`[autonomous-executor] auto-verify failed:`, e.message);
    }
    if (autoVerifyHit) {
      const diag = `[PREFLIGHT_LINT_BLOCKED — dir_1780831335787]\nrule=${autoVerifyHit.rule}\nmatched=${autoVerifyHit.match}\nhint=${autoVerifyHit.hint}`;
      await db.withBypass("autonomous_autoverify_block", (client) => client.query(
        `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
        [diag, item.id]));
      try {
        await db.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, $2, 'lint', 'autoverify', 0, 0, false, true, 0, 0,
                   $3, $4)`,
          [item.engagement_id, item.id, autoVerifyHit.rule.slice(0, 24), `${autoVerifyHit.rule}; matched=${autoVerifyHit.match}`]);
      } catch (_) {}
      return { autoExecuted: false, reason: `autoverify:${autoVerifyHit.rule}`, hint: autoVerifyHit.hint };
    }

    const preflightCheck = lintCommandPreflight(item.command, { executor_host: item.executor_host });
    if (preflightCheck) {
      const diag = `[PREFLIGHT_LINT_BLOCKED — dir_1780794595572]\nrule=${preflightCheck.rule}\nmatched=${preflightCheck.match}\nhint=${preflightCheck.hint}`;
      await db.withBypass("autonomous_preflight_block", (client) => client.query(
        `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
        [diag, item.id]));
      try {
        await db.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, $2, 'lint', 'cmd_preflight', 0, 0, false, true, 0, 0,
                   'preflight_lint_fail', $3)`,
          [item.engagement_id, item.id, `rule=${preflightCheck.rule}; matched=${preflightCheck.match}`]);
      } catch (_) { /* telemetry never breaks lint */ }
      return { autoExecuted: false, reason: `preflight_lint:${preflightCheck.rule}`, hint: preflightCheck.hint };
    }

    // Step-level intent classifier (dir_1780784990563 + dir_1780786024387 fallback).
    // 1) Model SHOULD declare intent_class. If omitted, harness infers from
    //    command content and proceeds. inferred-fallback is logged to
    //    offense_telemetry as outcome='intent_inferred_fallback' — training signal.
    // 2) MISMATCH gates regardless (claim vs infer disagrees + one is gated).
    // 3) If claimed+inferred agree AND intent is in AUTO_RUN_INTENTS → auto-run.
    // 4) Otherwise gate. If gated intent → fire push (throttled).
    let claimed = item.intent_class;
    const inferred = inferIntentFromCommand(item.command);

    if (!claimed) {
      if (!inferred) {
        // dir_1780788278335: in full-access mode, NULL+NULL doesn't gate —
        // operator opted out of approval taxes. ROE block-list already ran.
        if (item.autonomous_full_access) {
          try {
            await db.query(
              `INSERT INTO offense_telemetry
                 (engagement_id, queue_item_id, model_used, intent_category,
                  n_hosts, n_findings, step_queued, in_scope, n_references,
                  latency_ms, outcome, outcome_notes)
               VALUES ($1, $2, 'lint', 'unclassified', 0, 0, true, true, 0, 0,
                       'intent_unclassified_full_access',
                       'model omitted intent_class; no rule inferred; full_access ON — running anyway')`,
              [item.engagement_id, item.id]);
          } catch (_) { /* telemetry never breaks gating */ }
          await db.query(`UPDATE soc_queue_items SET intent_class='unclassified' WHERE id=$1`, [item.id]);
          claimed = "unclassified";
          // Fall through to auto-execute (won't hit AUTO_RUN_INTENTS check below
          // because full_access bypasses it; mismatch lint can't fire either since
          // inferred is null).
        } else {
          return { autoExecuted: false, reason: "intent_class not declared and command not inferable — gated as safe default" };
        }
      } else {
      // Inference fallback. Use the inferred intent as if model claimed it,
      // but log telemetry so v1.4 training picks up "model omitted required field".
      try {
        await db.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, $2, 'lint', $3, 0, 0, true, true, 0, 0,
                   'intent_inferred_fallback', $4)`,
          [item.engagement_id, item.id, inferred,
           `model omitted intent_class; harness inferred ${inferred} from command`]);
      } catch (_) { /* telemetry never breaks gating */ }
      // Persist the inferred value on the row so downstream tools see it.
      await db.query(`UPDATE soc_queue_items SET intent_class=$1 WHERE id=$2`, [inferred, item.id]);
      claimed = inferred;
      }  // close else (inferred-truthy fallback)
    }
    // 'unclassified' is a synthetic marker for full-access unclassifiable rows;
    // it isn't a real intent but is allowed past the VALID_INTENTS gate below.
    if (claimed !== "unclassified" && !VALID_INTENTS.has(claimed)) {
      await recordIntentMismatch(item.engagement_id, item.id, claimed, inferred || "(none)", item.command);
      return { autoExecuted: false, reason: `intent_class=${claimed} not in enum — gated`, inferred };
    }
    // Mismatch check: if we COULD infer an intent and it disagrees with the
    // claimed one AND one of them is gated, that's a mismatch. (If both are in
    // AUTO_RUN_INTENTS we treat it as harmless — e.g. claimed=enum, inferred=
    // banner_grab is a labeling nuance, not a safety risk.)
    if (inferred && inferred !== claimed) {
      const oneIsGated = GATE_INTENTS.has(claimed) || GATE_INTENTS.has(inferred);
      if (oneIsGated) {
        await recordIntentMismatch(item.engagement_id, item.id, claimed, inferred, item.command);
        // Push iff inferred is gated — the model TRIED to slip something past.
        if (GATE_INTENTS.has(inferred)) {
          await pushOnGatedIntent(item.engagement_id, item.id, `mismatch(${claimed}→${inferred})`, item.command);
        }
        return { autoExecuted: false, reason: `intent_mismatch claimed=${claimed} inferred=${inferred}` };
      }
    }
    if (!AUTO_RUN_INTENTS.has(claimed)) {
      // Gated intent. In full-access mode (dir_1780787660588) we proceed to
      // auto-execute anyway — operator opted in to unattended observation.
      // ROE block-list + mismatch lint above already ran; this is purely
      // about removing the human-approval gate.
      if (!item.autonomous_full_access) {
        await pushOnGatedIntent(item.engagement_id, item.id, claimed, item.command);
        return { autoExecuted: false, reason: `intent=${claimed} is gated — pending human approval`, inferred };
      }
      // Full-access — fall through to auto-run. No push (would spam).
    }

    // All checks passed — auto-execute.
    await db.query(`UPDATE soc_queue_items SET auto_executed=true WHERE id=$1`, [item.id]);

    const apiKey = process.env.BRIDGE_API_KEY || "";
    try {
      const resp = await fetch(`http://localhost:3333/soc/queue/${item.id}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const okBody = resp.ok ? await resp.json().catch(() => null) : null;
      return {
        autoExecuted: resp.ok,
        reason: resp.ok ? "ssh-spawned" : `run endpoint returned ${resp.status}`,
        session_id: okBody && okBody.session_id,
        inferred,
      };
    } catch (e) {
      console.error(`[autonomous-executor] run-endpoint call failed for item ${item.id}:`, e.message);
      return { autoExecuted: false, reason: `run endpoint error: ${e.message}`, inferred };
    }
  } catch (e) {
    console.error(`[autonomous-executor] maybeAutoExecute crashed:`, e.message);
    return { autoExecuted: false, reason: `internal: ${e.message}` };
  }
}

// Push when a GATED intent is queued (replaces dir_1780784224487's phase-advance
// push). Throttled per engagement.
async function pushOnGatedIntent(engagementId, itemId, intentLabel, command) {
  try {
    const eg = await db.query(
      `SELECT autonomous_execution_enabled, last_phase_advance_push_at FROM pentest_engagements WHERE id=$1`,
      [engagementId]);
    if (eg.rows.length === 0) return { pushed: false, reason: "engagement not found" };
    if (!eg.rows[0].autonomous_execution_enabled) return { pushed: false, reason: "engagement opt-out" };
    const lastPush = eg.rows[0].last_phase_advance_push_at;
    if (lastPush) {
      const ageSec = (Date.now() - new Date(lastPush).getTime()) / 1000;
      if (ageSec < PHASE_PUSH_THROTTLE_SEC) return { pushed: false, reason: `throttled — ${Math.round(ageSec)}s` };
    }
    const tk = await db.query(`SELECT token FROM device_push_tokens WHERE token IS NOT NULL`);
    const tokens = tk.rows.map(r => r.token).filter(Boolean);
    if (tokens.length === 0) return { pushed: false, reason: "no push tokens" };
    const result = await sendPush(tokens, {
      title: `${engagementId} — ${intentLabel} queued`,
      body:  `Model proposed a ${intentLabel} step. Review + approve in app.`,
      data:  { engagement_id: engagementId, queue_item_id: itemId, kind: "gated_intent", intent: intentLabel },
      priority: "high",
    });
    await db.query(`UPDATE pentest_engagements SET last_phase_advance_push_at = NOW() WHERE id=$1`, [engagementId]);
    return { pushed: true, sent: result.sent, errors: result.errors, tokens: tokens.length };
  } catch (e) {
    console.error(`[autonomous-executor] pushOnGatedIntent crashed:`, e.message);
    return { pushed: false, reason: `internal: ${e.message}` };
  }
}

// --- phase-advance hook ---
// Called from offense-agent-tools.js advancePhase (after the UPDATE lands).
// Pushes a notification iff the new phase is gated AND the previous phase
// was auto-run (= we're crossing the human-attention boundary), AND we
// haven't already pushed within PHASE_PUSH_THROTTLE_SEC.
async function onPhaseAdvance(engagementId, oldPhase, newPhase) {
  try {
    if (!GATE_PHASES.has(newPhase))    return { pushed: false, reason: "new phase not gated" };
    if (!AUTO_RUN_PHASES.has(oldPhase)) return { pushed: false, reason: "old phase not auto-run — not crossing boundary" };

    // Engagement flag — if autonomous isn't enabled, we never pushed for it
    // before, and we don't owe a notification now (legacy gated-everywhere mode).
    const eg = await db.query(
      `SELECT autonomous_execution_enabled, last_phase_advance_push_at FROM pentest_engagements WHERE id=$1`,
      [engagementId]);
    if (eg.rows.length === 0) return { pushed: false, reason: "engagement not found" };
    if (!eg.rows[0].autonomous_execution_enabled) return { pushed: false, reason: "engagement opt-out" };

    const lastPush = eg.rows[0].last_phase_advance_push_at;
    if (lastPush) {
      const ageSec = (Date.now() - new Date(lastPush).getTime()) / 1000;
      if (ageSec < PHASE_PUSH_THROTTLE_SEC) {
        return { pushed: false, reason: `throttled — last push ${Math.round(ageSec)}s ago` };
      }
    }

    // Pull all push tokens. INVENTORY says device_push_tokens table is the source.
    const tk = await db.query(`SELECT token FROM device_push_tokens WHERE token IS NOT NULL`);
    const tokens = tk.rows.map(r => r.token).filter(Boolean);
    if (tokens.length === 0) return { pushed: false, reason: "no push tokens" };

    const result = await sendPush(tokens, {
      title: `${engagementId} → ${newPhase}`,
      body:  `Model advanced to ${newPhase}. First gated step queued — approve in app.`,
      data:  { engagement_id: engagementId, kind: "phase_advance", from: oldPhase, to: newPhase },
      priority: "high",
    });

    await db.query(
      `UPDATE pentest_engagements SET last_phase_advance_push_at = NOW() WHERE id=$1`,
      [engagementId]);

    return { pushed: true, sent: result.sent, errors: result.errors, tokens: tokens.length };
  } catch (e) {
    console.error(`[autonomous-executor] onPhaseAdvance crashed:`, e.message);
    return { pushed: false, reason: `internal: ${e.message}` };
  }
}

module.exports = {
  maybeAutoExecute,
  onPhaseAdvance,
  pushOnGatedIntent,
  roeLint,
  inferIntentFromCommand,
  lintCommandPreflight,
  AUTO_RUN_PHASES,
  GATE_PHASES,
  AUTO_RUN_INTENTS,
  GATE_INTENTS,
  VALID_INTENTS,
};
