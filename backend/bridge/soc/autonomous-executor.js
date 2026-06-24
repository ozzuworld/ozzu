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
  // dir_1780930740964: msfconsole module hallucination preflight.
  // Catches xxx/XXX/NNN placeholder substrings + bare cve_YYYY_NNN-style
  // unverifiable paths. Real MSF modules don't contain placeholder substrings.
  const msfMatch = body.match(/(?:msfconsole[^"]*"|use\s+)(exploit|auxiliary|payload|encoder|post|nop)\/([\w./-]+)/i);
  if (msfMatch) {
    const modulePath = msfMatch[2];
    // Placeholder detection: contains "xx", "XXX", "NNN", "YYYY" in path
    if (/(?:xx|XXX|NNN|YYYY)(?:\b|$|\/)/.test(modulePath) || /(?:^|_)nginx_cve_\d+_\d+xx\b/i.test(modulePath)) {
      return {
        rule: "msf_module_hallucination",
        hint: `MSF module path '${modulePath}' contains placeholder substring (xx/XXX/NNN). Real module paths are concrete. Verify with 'msfconsole -q -x "search <keyword>; exit"' or 'searchsploit <product> <version>' first.`,
        match: modulePath.slice(0, 100),
      };
    }
  }
  // dir_1780930740964: unsubstituted placeholder preflight.
  // <attacker_ip>, /path/to/X, YOUR_PASSWORD, CHANGEME, TODO, FIXME literals.
  const placeholderPatterns = [
    { re: /<(?:attacker|target|your|listener|local)_(?:ip|host|url|port|password|user|key|domain)>/i, label: "angle-bracket placeholder" },
    { re: /\/path\/to\/[\w.-]+/i, label: "/path/to/X placeholder" },
    { re: /\bYOUR_[A-Z_]{3,}\b/, label: "YOUR_X placeholder" },
    { re: /\b(?:CHANGEME|TODO|FIXME|PLACEHOLDER|XXXXXX+|YYYYYY+)\b/, label: "CHANGEME/TODO/FIXME placeholder" },
  ];
  for (const p of placeholderPatterns) {
    const m = body.match(p.re);
    if (m) {
      return {
        rule: "placeholder_unsubstituted",
        hint: `Command contains literal ${p.label}: "${m[0]}". Replace with the actual value (e.g. LHOST → bridge tunnel IP, /path/to/X → real path on executor).`,
        match: m[0].slice(0, 100),
      };
    }
  }
  // dir_1780957501726: LFI success-check via HTTP status code only.
  // Run #12 #789: bruteforced LFI param names, then `grep -q '200' && echo
  // "[+] LFI candidate"` — every test "succeeded" against any 200 page,
  // including edge-gw's default index. Body-content match is required.
  // Pattern: status-only grep right next to an LFI traversal payload.
  const hasLfiPayload = /\.\.\/\.\.\/(?:\.\.\/)*(?:etc\/(?:passwd|shadow)|proc\/self\/environ|var\/www\/[a-z]+\.txt)/.test(body);
  const hasStatusOnlyGrep = /\|\s*grep\s+-q\s+['"]?(?:200|HTTP\/[\d.]+\s+200)\b/.test(body);
  const hasBodyContentGrep = /grep\s+(?:-[a-zA-Z]+\s+)*['"]?(?:root:|bin\/(?:bash|sh)|[a-z_]+:[x*!]:\d+:\d+|OZZULAB\{|FLAG\{|flag\{|<\?php|\bAPI_KEY\b|\bSECRET\b)/.test(body);
  if (hasLfiPayload && hasStatusOnlyGrep && !hasBodyContentGrep) {
    return {
      rule: "lfi_status_only_check",
      hint: "LFI exploit checks only HTTP status code (`grep -q '200'`). Any 200 page (homepage, /status, etc.) will false-positive. Add body content match: `grep -E 'root:|bin/bash|OZZULAB\\{|<\\?php'` so only real LFI leaks trigger the [+] echo.",
      match: "grep -q '200' (status-only)",
    };
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
  try { mk = require("/app/soc/model-knowledge-tools"); }
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
  try { mk = require("/app/soc/model-knowledge-tools"); }
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

// dir_1782251824781 Fix 2 — shared outcome_notes sanitizer.
// Redacts CVE IDs, raw IPs, exploit keywords, and credential-file references
// from any string before it lands in offense_telemetry.outcome_notes.
// Mirrors the membrane patterns in membrane-audit.js (read-side) but catches
// leaks at write-time so the DB stays clean from the start.
const { sanitizeOutcomeNotes } = require("/app/soc/telemetry-sanitize");

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
      const enforcer = require("/app/soc/permission-enforcer");
      const pEng = {
        permission_mode: item.permission_mode,
        scope:           item.scope,
      };
      const verdict = enforcer.enforceAll(pEng, item.intent_class, item.command);
      // dir_1780845861190: pre_queue_dispatch hooks fire AFTER enforcer.allowed
      // (no point hooking blocked items) but BEFORE the SSH spawn. A hook can
      // veto with allow:false → queue item failed with [HOOK_DENIED].
      if (verdict.allowed) {
        try {
          const hooks = require("/app/soc/hooks");
          const hr = await hooks.runEvent({
            engagementId: item.engagement_id,
            event: hooks.HOOK_EVENTS.PRE_QUEUE_DISPATCH,
            payload: {
              queue_item_id: item.id,
              command: item.command,
              intent_class: item.intent_class,
              command_intent: verdict.command_intent,
              permission_mode: pEng.permission_mode,
            },
          });
          if (!hr.allowed) {
            const diag = `[HOOK_DENIED — dir_1780845861190]\n${hr.final_deny_reason}\nhooks_fired=${hr.hooks_fired}`;
            await db.withBypass("autonomous_hook_deny", (client) => client.query(
              `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
              [diag, item.id]));
            try {
              await db.query(
                `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
                 VALUES ($1, $2, 'hooks', 'pre_dispatch', 0, 0, false, true, 0, 0, 'hook_denied', $3)`,
                [item.engagement_id, item.id, (hr.final_deny_reason || "").slice(0, 200)]);
            } catch (_) {}
            return { autoExecuted: false, reason: "hook_denied", hint: hr.final_deny_reason };
          }
        } catch (e) {
          console.error(`[autonomous-executor] pre_queue_dispatch hooks failed:`, e.message);
        }
      }
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
             sanitizeOutcomeNotes(`${verdict.layer}: ${(verdict.denied_reason || "").slice(0, 200)}`, "outcome_notes", item.engagement_id)]);
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
      const body = (() => { try { return require("/app/soc/autonomous-executor").__bodyForLint?.(item.command); } catch (_) { return item.command; } })() || item.command;
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
            [item.engagement_id, item.id, sanitizeOutcomeNotes(sploitusEnrich.hint.slice(0, 200), "outcome_notes", item.engagement_id)]);
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
          [item.engagement_id, item.id, autoVerifyHit.rule.slice(0, 24),
           sanitizeOutcomeNotes(`${autoVerifyHit.rule}; matched=${autoVerifyHit.match}`, "outcome_notes", item.engagement_id)]);
      } catch (_) {}
      return { autoExecuted: false, reason: `autoverify:${autoVerifyHit.rule}`, hint: autoVerifyHit.hint };
    }

    let commandForExecution = item.command;
    const preflightCheck = lintCommandPreflight(commandForExecution, { executor_host: item.executor_host });
    if (preflightCheck) {
      // dir_1782234450321: LINT AUTO-REPAIR — for KNOWN mechanical failures, fix
      // the command in-place and retry the preflight once instead of just rejecting.
      // dir_1782251824781 Fix 4: EXTENDED auto-repair rules to push step_queued above 50%.
      // Repaired categories:
      //   1. nmap missing -Pn -sT on tablet executor — inject flags after 'nmap'
      //   2. curl with invalid --requests flag — strip the bad flag
      //   3. ssh_quoted_empty_user — strip the wrapping quotes from 'user@'host
      //      (pattern: ssh 'user@' host → ssh user@host; this is the most common
      //      form that appears in 353 telemetry)
      //   4. nse_script_not_in_allowlist with a single unknown script name — replace
      //      the unknown name with the 'safe' category alias, which is always in the
      //      allowlist and covers the vast majority of informational scripts.
      //   5. nmap on Linux bridge missing -Pn flag (sT already present but -Pn absent)
      //      — the tablet rule only fires on applies_when=tablet but the Linux bridge
      //      executor also needs -Pn when crossing the WG relay; auto-inject it.
      // Android-only commands (dumpsys, getprop, pm, settings, adb shell app_process)
      // are NOT auto-repaired — they are fundamentally wrong on the Linux bridge and
      // a clean rejection with a clear note is more useful.
      const ANDROID_ONLY_RE = /\b(dumpsys|getprop|am\s+start|pm\s+install|pm\s+list|settings\s+(?:get|put|list)|app_process\b)/;
      let repairedCommand = null;
      let repairNote = null;

      if (preflightCheck.rule === "nmap_missing_pn_st_on_tablet") {
        // Inject -Pn -sT immediately after 'nmap' (with any leading sudo).
        const fixed = commandForExecution.replace(/\bnmap\b/, "nmap -Pn -sT");
        if (fixed !== commandForExecution) {
          repairedCommand = fixed;
          repairNote = "auto-repaired: injected -Pn -sT after nmap (dir_1782234450321)";
        }
      } else if (preflightCheck.rule === "ssh_quoted_empty_user") {
        // dir_1782251824781 Fix 4 — auto-repair quoted user@host.
        // Pattern: ssh 'user@' host or ssh "user@" host (empty host inside quotes).
        // The model wraps "user@host" in quotes and bash splits it into 'user@' + 'host',
        // producing an empty user or empty host depending on where the shell breaks.
        // Repair: strip the outer quotes so `ssh 'user@host'` → `ssh user@host`.
        const fixed = commandForExecution.replace(/ssh\s+'([^']*@[^']*)'/g, "ssh $1")
          .replace(/ssh\s+"([^"]*@[^"]*)"/g, "ssh $1");
        if (fixed !== commandForExecution) {
          repairedCommand = fixed;
          repairNote = "auto-repaired: stripped quotes from ssh user@host (dir_1782251824781 Fix 4)";
        }
        // If repair fails (pattern didn't match), fall through to rejection.
      } else if (preflightCheck.rule === "nse_script_not_in_allowlist" && preflightCheck.match) {
        // dir_1782251824781 Fix 4 — auto-repair unknown NSE script by replacing with 'safe' category.
        // The model frequently hallucinates NSE script names (e.g. 'hikvision-info', 'rtsp-info').
        // Replace the specific unknown script name with the 'safe' category alias which covers
        // the broadest set of safe informational probes and is always in the allowlist.
        // Only repair SINGLE script names — multi-script comma-lists are too ambiguous to fix safely.
        const badScript = String(preflightCheck.match || "").trim();
        const isMultiScript = badScript.includes(",");
        if (!isMultiScript && badScript && !/^(all|default|safe|vuln|discovery|auth)$/.test(badScript)) {
          // Replace --script=<bad> or --script <bad> with --script safe
          const fixed = commandForExecution
            .replace(new RegExp(`--script[=\\s]+${badScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"),
              "--script safe");
          if (fixed !== commandForExecution) {
            repairedCommand = fixed;
            repairNote = `auto-repaired: replaced unknown NSE script '${badScript}' with 'safe' category (dir_1782251824781 Fix 4)`;
          }
        }
      } else if (ANDROID_ONLY_RE.test(commandForExecution)) {
        // Android-only command on the Linux bridge — don't auto-repair, but give
        // a clear rejection note rather than the generic preflight hint.
        const androidDiag = `[PREFLIGHT_LINT_BLOCKED — dir_1780794595572]\nrule=android_only_command_on_linux_bridge\nmatched=${commandForExecution.match(ANDROID_ONLY_RE)[0]}\nhint=This command is Android-only (dumpsys/getprop/pm/settings). The executor is a Linux bridge — use standard Linux tools instead (e.g. nmap, curl, ssh). Do NOT wrap in adb shell here; adb commands run on a different path.`;
        await db.withBypass("autonomous_preflight_block", (client) => client.query(
          `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
          [androidDiag, item.id]));
        try {
          await db.query(
            `INSERT INTO offense_telemetry
               (engagement_id, queue_item_id, model_used, intent_category,
                n_hosts, n_findings, step_queued, in_scope, n_references,
                latency_ms, outcome, outcome_notes)
             VALUES ($1, $2, 'lint', 'cmd_preflight', 0, 0, false, true, 0, 0,
                     'preflight_lint_fail', $3)`,
            [item.engagement_id, item.id, sanitizeOutcomeNotes(`rule=android_only_on_linux; matched=${commandForExecution.match(ANDROID_ONLY_RE)[0]}`, "outcome_notes", item.engagement_id)]);
        } catch (_) {}
        return { autoExecuted: false, reason: "preflight_lint:android_only_command_on_linux_bridge", hint: "Android-only command rejected on Linux bridge executor" };
      }

      // Curl flag typo: --requests is not a valid curl flag (should be -X or --request).
      // Strip it so the rest of the command runs. (Must not be in Android-only path.)
      if (!repairedCommand && /\bcurl\b.*--requests\b/i.test(commandForExecution)) {
        const fixed = commandForExecution.replace(/\s*--requests\s+\S+/gi, "");
        if (fixed !== commandForExecution) {
          repairedCommand = fixed;
          repairNote = "auto-repaired: removed invalid --requests flag from curl (dir_1782234450321)";
        }
      }

      // dir_1782251824781 Fix 4 — nmap missing -Pn on Linux bridge executor.
      // The nmap_missing_pn_st_on_tablet rule only fires for applies_when=tablet.
      // The Linux bridge executor (the primary executor for SKYLINE runs) also needs
      // -Pn because it reaches lab targets over the WG relay — ICMP pings never
      // cross the relay and always cause nmap host-discovery to silently skip hosts.
      // Detect the pattern ourselves and inject -Pn when nmap has -sT but no -Pn.
      //
      // adversarial-review fix: prior code used replace(/\bnmap\b/, "nmap -Pn") on the
      // whole string — in a pipe like `echo nmap | nmap -sT ...` it patches "echo nmap"
      // first, producing "echo nmap -Pn | nmap -sT ..." (wrong token). Fix: split on
      // pipe/semicolon/newline boundaries, find the segment where nmap is the LEADING
      // command, and patch only that segment.
      if (!repairedCommand && /\bnmap\b/.test(commandForExecution)) {
        const hasPN = /\bnmap\b[^;\n|]*-Pn\b/.test(commandForExecution);
        const hasST = /\bnmap\b[^;\n|]*(-sT|-sV|--open)\b/.test(commandForExecution);
        if (!hasPN && hasST) {
          // Split on pipe/semicolons/newlines, patch only the segment whose LEADING
          // command is nmap (i.e. nmap is the first non-whitespace non-flag token).
          const SEP_RE = /([|;&\n])/;
          const parts = commandForExecution.split(SEP_RE);
          let patched = false;
          const patchedParts = parts.map(seg => {
            if (patched) return seg;
            // Skip separator tokens (single |, ;, &, \n chars)
            if (SEP_RE.test(seg) && seg.trim().length <= 1) return seg;
            // Does nmap lead this segment? (after optional sudo/env-prefix)
            const leadToken = seg.trimStart().replace(/^(sudo\s+|nice\s+|timeout\s+\S+\s+)*/, "").split(/\s+/)[0];
            if (leadToken === "nmap" || leadToken.endsWith("/nmap")) {
              patched = true;
              return seg.replace(/\bnmap\b/, "nmap -Pn");
            }
            return seg;
          });
          if (patched) {
            const fixed = patchedParts.join("");
            if (fixed !== commandForExecution) {
              repairedCommand = fixed;
              repairNote = "auto-repaired: injected -Pn into nmap invocation segment (WG-relay host discovery; dir_1782251824781 Fix 4)";
            }
          }
        }
      }

      if (repairedCommand) {
        // Retry the preflight on the repaired command
        const recheck = lintCommandPreflight(repairedCommand, { executor_host: item.executor_host });
        if (!recheck) {
          // Repair worked — persist the fixed command and log the repair
          await db.withBypass("autonomous_lint_autorepair", (client) => client.query(
            `UPDATE soc_queue_items SET command=$1 WHERE id=$2`,
            [repairedCommand, item.id]));
          try {
            await db.query(
              `INSERT INTO offense_telemetry
                 (engagement_id, queue_item_id, model_used, intent_category,
                  n_hosts, n_findings, step_queued, in_scope, n_references,
                  latency_ms, outcome, outcome_notes)
               VALUES ($1, $2, 'lint', 'cmd_autorepair', 0, 0, true, true, 0, 0,
                       'preflight_autorepaired', $3)`,
              [item.engagement_id, item.id, `${repairNote}; original_rule=${preflightCheck.rule}`]);
          } catch (_) {}
          console.log(`[autonomous-executor] lint auto-repair: ${repairNote} for q#${item.id}`);
          item.command = repairedCommand; // use repaired command for execution below
          commandForExecution = repairedCommand;
          // Continue past the preflight block — repair succeeded
        } else {
          // Even repaired command fails — fall through to normal rejection
          const diag = `[PREFLIGHT_LINT_BLOCKED — dir_1780794595572 + auto-repair attempted]\nrule=${recheck.rule}\nmatched=${recheck.match}\nhint=${recheck.hint}\nauto_repair_note=${repairNote} (repair did not fully fix the command)`;
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
              [item.engagement_id, item.id, sanitizeOutcomeNotes(`rule=${recheck.rule}; matched=${recheck.match}; repair_attempted=${repairNote}`, "outcome_notes", item.engagement_id)]);
          } catch (_) {}
          return { autoExecuted: false, reason: `preflight_lint:${recheck.rule}`, hint: recheck.hint };
        }
      } else {
        // No auto-repair possible — original rejection path
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
            [item.engagement_id, item.id, sanitizeOutcomeNotes(`rule=${preflightCheck.rule}; matched=${preflightCheck.match}`, "outcome_notes", item.engagement_id)]);
        } catch (_) { /* telemetry never breaks lint */ }
        return { autoExecuted: false, reason: `preflight_lint:${preflightCheck.rule}`, hint: preflightCheck.hint };
      }
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
      // dir_1782238863765 Part 1: write terminal status so waitForOutcome unblocks.
      // A bad intent_class is a model error — mark the row 'failed' with a clear
      // diagnostic; the agent reads it on the next poll and self-corrects.
      const diag = `[PERMISSION_DENIED — dir_1782238863765]\nlayer=intent_class_invalid\nreason=intent_class='${claimed}' is not a recognized intent. Valid values: ${[...VALID_INTENTS].join(", ")}\nAgent: fix the intent_class and retry.`;
      await db.withBypass("autonomous_intent_invalid", (client) => client.query(
        `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
        [diag, item.id]));
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
        // dir_1782238863765 Part 1: write terminal status so waitForOutcome unblocks.
        // Intent mismatch is a model-error signal; mark failed so the agent sees
        // the diagnostic on the next poll and picks a corrected intent_class.
        const diagMismatch = `[PERMISSION_DENIED — dir_1782238863765]\nlayer=intent_mismatch\nreason=declared intent_class='${claimed}' but command content suggests='${inferred}'. One of these is gated — step blocked. Retry with the correct (and honest) intent_class.\nAgent: review the queue_step tool description: claiming a benign intent for a gated command is logged as a model-behavior signal.`;
        await db.withBypass("autonomous_intent_mismatch", (client) => client.query(
          `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2`,
          [diagMismatch, item.id]));
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

    // dir_1782311308515: FINAL recon-discovery normalization before execution.
    // The lab is reached over the wg0→tablet L3 relay. ICMP crosses it (verified);
    // ARP does not, and -Pn (skip discovery → scan all 254) times out before any
    // host is recorded — that's why recon returned 0 hosts while the hosts were up.
    // Force ICMP discovery (--disable-arp-ping, strip -Pn) so the scan actually finds
    // the live hosts that the /run deterministic parser then writes to recon_hosts.
    // Persist the normalized command because /soc/queue/:id/run reads it from the DB.
    try {
      const { normalizeNmapDiscovery } = require("/app/soc/recon-discovery-normalize");
      const normalized = normalizeNmapDiscovery(commandForExecution);
      if (normalized !== commandForExecution) {
        commandForExecution = normalized;
        item.command = normalized;
        await db.withBypass("autonomous_recon_discovery_norm", (client) => client.query(
          `UPDATE soc_queue_items SET command=$1 WHERE id=$2`, [normalized, item.id]));
        console.log(`[autonomous-executor] recon-discovery normalize q#${item.id}: stripped -Pn, forced ICMP (--disable-arp-ping)`);
      }
    } catch (e) { console.error(`[autonomous-executor] recon-discovery normalize failed:`, e.message); }

    // All checks passed — auto-execute.
    await db.query(`UPDATE soc_queue_items SET auto_executed=true WHERE id=$1`, [item.id]);

    const apiKey = process.env.BRIDGE_API_KEY || "";
    try {
      const resp = await fetch(`http://localhost:3333/soc/queue/${item.id}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const okBody = resp.ok ? await resp.json().catch(() => null) : null;
      if (!resp.ok) {
        // dir_1782243745921 Fix 2: run endpoint returned a non-2xx status — the item
        // will never reach 'running' on its own. Mark it 'failed' immediately so
        // waitForOutcome unblocks in milliseconds instead of waiting the full
        // OUTCOME_TIMEOUT_MS. Leave a diagnostic in the output column.
        const diag = `[RUN_ENDPOINT_FAILED — dir_1782243745921 Fix 2]\nrun endpoint returned HTTP ${resp.status} for queue_item ${item.id}. Item auto-marked failed (would otherwise stay 'pending' for ${Math.round(120)}s until watchdog fires).`;
        try {
          await db.withBypass("autonomous_run_endpoint_fail", (client) => client.query(
            `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2 AND status='pending'`,
            [diag, item.id]));
          await db.query(
            `INSERT INTO offense_telemetry
               (engagement_id, queue_item_id, model_used, intent_category,
                n_hosts, n_findings, step_queued, in_scope, n_references,
                latency_ms, outcome, outcome_notes)
             VALUES ($1, $2, 'auto_executor', 'run_endpoint', 0, 0, false, true, 0, 0,
                     'run_endpoint_failed', $3)`,
            [item.engagement_id, item.id, `HTTP ${resp.status}`]);
        } catch (dbErr) {
          console.error(`[autonomous-executor] failed to mark item ${item.id} failed after run-endpoint error:`, dbErr.message);
        }
      }
      return {
        autoExecuted: resp.ok,
        reason: resp.ok ? "ssh-spawned" : `run endpoint returned ${resp.status}`,
        session_id: okBody && okBody.session_id,
        inferred,
      };
    } catch (e) {
      console.error(`[autonomous-executor] run-endpoint call failed for item ${item.id}:`, e.message);
      // dir_1782243745921 Fix 2: network/fetch error means execution never started.
      // Mark the item 'failed' so it doesn't sit 'pending' until the watchdog fires.
      const diag = `[RUN_ENDPOINT_ERROR — dir_1782243745921 Fix 2]\nfetch to run endpoint threw: ${e.message}. Item auto-marked failed — cannot start execution.`;
      try {
        await db.withBypass("autonomous_run_endpoint_error", (client) => client.query(
          `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2 AND status='pending'`,
          [diag, item.id]));
        await db.query(
          `INSERT INTO offense_telemetry
             (engagement_id, queue_item_id, model_used, intent_category,
              n_hosts, n_findings, step_queued, in_scope, n_references,
              latency_ms, outcome, outcome_notes)
           VALUES ($1, $2, 'auto_executor', 'run_endpoint', 0, 0, false, true, 0, 0,
                   'run_endpoint_error', $3)`,
          [item.engagement_id, item.id, sanitizeOutcomeNotes(e.message.slice(0, 200), "outcome_notes", item.engagement_id)]);
      } catch (dbErr) {
        console.error(`[autonomous-executor] failed to mark item ${item.id} failed after fetch error:`, dbErr.message);
      }
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

// ── Reconciliation sweep (dir_1782243745921 Fix 3) ──
// Finds any queue item for this engagement that has been 'pending' longer than
// ORPHAN_TIMEOUT_SEC with no corresponding 'running' row. These are items whose
// execution was never started (synthesis hung, run endpoint failed silently, or
// maybeAutoExecute returned autoExecuted=false without marking the row failed).
// Marks them 'failed' with reason 'orphaned — never executed'.
//
// Safety: items that ARE 'running' are never touched. The sweep only targets
// items that have NEVER had their status leave 'pending', identified by:
//   - status = 'pending'
//   - created_at older than ORPHAN_TIMEOUT_SEC (2 minutes — matches OUTCOME_TIMEOUT_MS)
// This is conservative: a freshly-inserted pending item that hasn't had time to
// reach the run endpoint yet will not be swept (it's < 2 min old).
const ORPHAN_TIMEOUT_SEC = 120; // matches OUTCOME_TIMEOUT_MS / 1000

async function reconcilePendingItems(engagementId) {
  let resolved = 0;
  try {
    const r = await db.withBypass("reconcile_pending", (client) => client.query(
      `UPDATE soc_queue_items
          SET status='failed',
              output = COALESCE(output, '') ||
                       '[ORPHAN_RESOLVED — dir_1782243745921 Fix 3]\n' ||
                       'Item stayed pending for >' || $2 || 's with no execution. ' ||
                       'Likely cause: command synthesis timed out before queue_step ' ||
                       'could call maybeAutoExecute, or run endpoint failed without ' ||
                       'writing a terminal status. Resolved by reconciliation sweep.',
              completed_at = NOW()
        WHERE engagement_id = $1
          AND status = 'pending'
          AND created_at < NOW() - ($2 || ' seconds')::interval
        RETURNING id`,
      [engagementId, ORPHAN_TIMEOUT_SEC]));
    resolved = r.rows.length;
    if (resolved > 0) {
      console.log(`[autonomous-executor] reconcile: resolved ${resolved} orphaned pending item(s) for engagement ${engagementId} (dir_1782243745921 Fix 3)`);
      // Emit telemetry for each resolved item so analyze_engagement_telemetry
      // can surface 'orphan_resolved' as a WARNING.
      for (const row of r.rows) {
        try {
          await db.query(
            `INSERT INTO offense_telemetry
               (engagement_id, queue_item_id, model_used, intent_category,
                n_hosts, n_findings, step_queued, in_scope, n_references,
                latency_ms, outcome, outcome_notes)
             VALUES ($1, $2, 'reconcile', 'pending_sweep', 0, 0, false, true, 0, 0,
                     'orphan_resolved', $3)`,
            [engagementId, row.id,
             `queue_item ${row.id} stayed pending >${ORPHAN_TIMEOUT_SEC}s — resolved by sweep (dir_1782243745921 Fix 3)`]);
        } catch (_) { /* telemetry never blocks resolution */ }
      }
    }
  } catch (e) {
    // Sweep failure must never crash the agent loop — it's a best-effort guard.
    console.error(`[autonomous-executor] reconcile sweep failed for ${engagementId}:`, e.message);
  }
  return { resolved };
}

module.exports = {
  maybeAutoExecute,
  onPhaseAdvance,
  pushOnGatedIntent,
  reconcilePendingItems,
  roeLint,
  inferIntentFromCommand,
  lintCommandPreflight,
  autoVerifyCves,
  autoCheckNseNames,
  autoEnrichSploitus,
  AUTO_RUN_PHASES,
  GATE_PHASES,
  AUTO_RUN_INTENTS,
  GATE_INTENTS,
  VALID_INTENTS,
  ORPHAN_TIMEOUT_SEC,
};
