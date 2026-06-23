"use strict";
// offense-aggregator.js — Step 8 of OFFENSE-AGENT-DESIGN.md (dir_1780594102051)
//
// The xOffense pattern's Information Aggregator. After a queue_item completes,
// the Aggregator takes the raw output (potentially 10s of KB) and condenses it
// into a STRUCTURED summary that the Orchestrator can absorb without context
// bloat. Critically: raw tool output never re-enters the Orchestrator's prompt.
//
// Output schema (the JSON the model produces):
//   {
//     success:        bool,
//     key_signals:    [strings],       // 3-8 bullet points of what mattered
//     new_findings:   [{title, severity, refs[], affected_asset, evidence}],
//     new_hosts:      [{ip, hostname?, ports?: [{port, service, version}]}],
//     followup:       [strings],       // suggestions to feed back to Orchestrator
//     error_category: string|null,     // "tool_missing"|"no_route"|"auth_fail"|"timeout"|"unexpected"|null
//   }
//
// Membrane: aggregator output is STRUCTURED data only — no raw command bytes,
// no exploit-source-code, no offensive narrative. The Orchestrator consumes
// only this structured form on subsequent iterations.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const db = require("./db");

const MODEL_URL  = process.env.OFFENSE_MODEL_URL  || "http://127.0.0.1:11434/v1";
const MODEL_NAME = process.env.OFFENSE_MODEL_NAME || "qwen3:32b";
const MODEL_KEY  = process.env.OFFENSE_MODEL_KEY  || "";

const AGGREGATOR_SYSTEM_PROMPT = [
  "You are the INFORMATION AGGREGATOR of an offensive-research multi-agent system for an AUTHORIZED penetration test.",
  "",
  "You receive: (a) the task's directive (what was attempted), (b) the EXPECTED artifact (what success looks like), (c) the RAW output of the executed command.",
  "",
  "Your job: condense the raw output into a structured summary that lets the next iteration of the Orchestrator reason WITHOUT seeing the raw bytes.",
  "",
  "Specifically extract:",
  "  - success: did this task achieve its expected_artifact?",
  "  - key_signals: 3-8 concise bullet points of what mattered (open ports, banner versions, error categories, auth indicators)",
  "  - new_findings: any pentest findings worth storing in pentest_findings — service+version vulns, exposed admin interfaces, default-credentialed services, etc.",
  "  - new_hosts: any newly-discovered hosts/services/versions worth merging into recon_hosts",
  "  - followup: suggested next directives the Orchestrator should consider",
  "  - error_category: if it failed, one of: tool_missing | no_route | auth_fail | timeout | parse_error | scope_block | unexpected (null on success)",
  "",
  "Respond STRICT JSON, no prose, no code fences. Schema:",
  '{"success": <bool>, "key_signals": [<string>...], "new_findings": [{"title": "...", "severity": "info|low|medium|high|critical", "refs": [], "affected_asset": "...", "evidence": "..."}], "new_hosts": [{"ip": "...", "hostname": "...", "ports": [{"port": 80, "service": "http", "version": "..."}]}], "followup": [<string>...], "error_category": <string>|null}',
  "Do not invent data not present in the raw output. If a field has nothing, return [] or null.",
  "",
  "RECON_HOSTS POLICY — dir_1780926990535 (do not violate):",
  "- new_hosts ONLY includes IPs with CONFIRMED port detail or service banner.",
  "- An nmap CIDR sweep that scans 254 IPs and reports 3 hosts up + 251 silent: new_hosts is the 3 hosts WITH the port table, NOT all 254 probed IPs.",
  "- Skip any IP that appears only in 'Skipping host X', 'No response', or 'Nmap scan report for X' with NO subsequent PORT/STATE/SERVICE table.",
  "- Do not invent IPs from CIDR notation expansion. The /24 doesn't mean 254 hosts exist.",
  "- A host with 0 ports detected is NOT a recon win unless nmap explicitly says 'Host is up' AND you saw service activity (NSE script output, ICMP reply with timing).",
  "",
  "FINDING POLARITY RULES — dir_1780854805127 (do not violate these):",
  "- HTTP 401/403/404 status on a path means the file is HIDDEN, NOT exposed. Do NOT emit 'Sensitive File Exposure' findings for paths returning 403/404.",
  "- A 'Sensitive File Exposure' finding REQUIRES HTTP 200 OK on the path AND a snippet of the actual FILE CONTENT in the evidence field.",
  "- .htaccess / .htpasswd / .hta returning 403 is Apache standard hardening — IGNORE these from gobuster/dirb output.",
  "- server-status returning 403 is mod_status hardening — IGNORE.",
  "- /admin/, /login/, /config/ returning 200 with a real login page IS a legitimate finding (severity info or low: 'Admin interface exposed'). The same paths returning 403 are HARDENED, not exposed.",
  "- A directory listing finding (severity info) requires HTTP 200 + an HTML index showing real filenames (not a custom error page).",
  "- DEFAULT credentials finding requires authentication SUCCESS evidence (200 OK on an authenticated endpoint, or the service returning a session token). A 401/403 to a cred-test means creds FAILED.",
  "- When in doubt, emit severity='info' with the literal status code in evidence rather than inventing a severity from the path name.",
].join("\n");

function chatCompletion(messages, modelOverride) {
  return new Promise((resolve, reject) => {
    const base = MODEL_URL.replace(/\/+$/, "");
    const url = new URL(base + "/chat/completions");
    const lib = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify({ model: modelOverride || MODEL_NAME, messages, temperature: 0.1, stream: false });
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (MODEL_KEY) headers.Authorization = `Bearer ${MODEL_KEY}`;
    // dir_1780786724856: see note in offense-orchestrator.js
    const reqAgent = new lib.Agent({ keepAlive: false });
    const req = lib.request(url, { method: "POST", headers, timeout: 180000, agent: reqAgent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`aggregator HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          const j = JSON.parse(body);
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!content) return reject(new Error("aggregator returned no content"));
          resolve(content);
        } catch (e) { reject(new Error(`aggregator parse error: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("aggregator timeout")));
    req.write(payload);
    req.end();
  });
}

// dir_1780930740964: tech-stack tags from port version strings. Used by the
// orchestrator prompt to remind the model which attack techniques apply.
function inferTechStack(portList) {
  const tags = new Set();
  for (const p of portList || []) {
    const v = String(p && p.version || "").toLowerCase();
    const svc = String(p && p.service || "").toLowerCase();
    if (v.includes("nginx") || svc === "nginx") tags.add("nginx-static");
    if (v.includes("apache") || svc === "apache") tags.add("apache-php");
    if (v.includes("php") || /php/i.test(v)) { tags.add("apache-php"); tags.delete("nginx-static"); }
    if (v.includes("openssh") || svc === "ssh") tags.add("ssh");
    if (v.includes("mysql") || svc === "mysql") tags.add("mysql");
    if (v.includes("mariadb")) tags.add("mariadb");
    if (v.includes("postgres") || svc === "postgresql") tags.add("postgres");
    if (v.includes("microsoft-iis") || svc === "iis") tags.add("iis-aspnet");
    if (v.includes("tomcat") || /^.*tomcat/i.test(v)) tags.add("tomcat");
    if (v.includes("jetty")) tags.add("jetty");
    if (v.includes("wordpress")) tags.add("wordpress");
    if (v.includes("joomla")) tags.add("joomla");
  }
  return [...tags];
}

function parseJSON(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : raw);
}

// Fold a queue_item's raw output into structured signal. Returns the parsed
// summary. Also side-effects: writes new pentest_findings + new recon_hosts
// when the model emits them. NEVER throws to break the loop — on parse fail,
// returns a minimal summary marking success=false + error_category=parse_error.
async function fold(engagementId, taskDirective, expectedArtifact, rawOutput, modelOverride) {
  // Cap raw at ~16KB so we don't blow the model's context with megabytes of nmap output.
  const cappedRaw = (rawOutput || "").slice(0, 16000);
  const userMsg = [
    `Engagement: ${engagementId}`,
    `Task directive: ${taskDirective || "(none)"}`,
    `Expected artifact: ${expectedArtifact || "(none — judge from raw output and directive)"}`,
    `Raw command output (truncated to 16KB):`,
    "```",
    cappedRaw || "(empty)",
    "```",
    "Condense as strict JSON per the schema.",
  ].join("\n");

  let summary;
  let raw;
  try {
    raw = await chatCompletion([
      { role: "system", content: AGGREGATOR_SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ], modelOverride);
    summary = parseJSON(raw);
  } catch (e) {
    // dir_1780841672508: Reflector recovery for aggregator prose
    let recovered = false;
    if (raw) {
      try {
        const { performReflector } = require("/app/execution-monitor");
        const corrected = await performReflector({
          rawText: raw,
          expectedFormat: "JSON",
          schemaHint: '{"success": <bool>, "key_signals": [<string>], "new_findings": [{"title","severity","evidence_excerpt","cve"}], "new_hosts": [{"ip","ports","services"}], "followup": [<string>], "error_category": <string|null>}',
        });
        summary = parseJSON(corrected);
        recovered = true;
        try {
          const dbMod = require("/app/db");
          await dbMod.query(
            `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
             VALUES ($1, NULL, 'reflector', 'aggregator', 0, 0, false, true, 0, 0, 'reflector_invoked', $2)`,
            [engagementId || null, `parse_err=${(e.message||"").slice(0,80)}; recovered=true`]);
        } catch (_) {}
      } catch (_) { /* swallow → fall through to error path */ }
    }
    if (!recovered) {
      return {
        success: false,
        key_signals: [`aggregator failed: ${e.message}`],
        new_findings: [],
        new_hosts: [],
        followup: [],
        error_category: "parse_error",
      };
    }
  }

  // Defensive defaults so downstream code doesn't crash on missing keys.
  const out = {
    success:        !!summary.success,
    key_signals:    Array.isArray(summary.key_signals) ? summary.key_signals.slice(0, 8) : [],
    new_findings:   Array.isArray(summary.new_findings) ? summary.new_findings : [],
    new_hosts:      Array.isArray(summary.new_hosts)    ? summary.new_hosts    : [],
    followup:       Array.isArray(summary.followup)     ? summary.followup     : [],
    error_category: (typeof summary.error_category === "string") ? summary.error_category : null,
  };

  // Side-effects: persist new findings + new hosts. Best-effort — failures
  // are swallowed so they never break the agent loop.
  for (const f of out.new_findings) {
    try {
      if (!f || !f.title) continue;
      // dir_1780781999942: optional graph fields. informed_by/enables/kind let the
      // model author findings that already wire into the attack graph. Backward-
      // compatible — defaults are confirmed/empty when absent.
      let kind = ["confirmed", "hypothesis", "refuted"].includes(f.kind) ? f.kind : "confirmed";
      let finalSeverity = (["info","low","medium","high","critical"].includes(f.severity)) ? f.severity : "low";
      let finalEvidence = f.evidence ? String(f.evidence).slice(0, 2000) : null;
      let preVerifyResolved = false; // true when pre-insert check already resolved the verdict

      // Pre-insert gate: run the synchronous exposure-with-403 check BEFORE writing.
      // If the evidence already shows a hidden-status code, floor severity and mark
      // unverified instead of inserting at the model's claimed severity.
      // Cred-test verification stays post-insert (needs DB id for the active probe).
      try {
        const { verifyFindingDataSync } = require("/app/claim-verifier");
        const preCheck = verifyFindingDataSync({ title: f.title, evidence: f.evidence, evidence_summary: f.evidence, affected_asset: f.affected_asset });
        if (preCheck.verdict === "fail") {
          finalSeverity = "info";
          kind = "unverified";
          finalEvidence = (finalEvidence || "") + `\n\n[PRE-INSERT GATE: severity floored to info — ${preCheck.notes || "verify_fail"}]`;
          preVerifyResolved = true;
          try {
            await db.query(
              `INSERT INTO offense_telemetry
                 (engagement_id, queue_item_id, model_used, intent_category,
                  n_hosts, n_findings, step_queued, in_scope, n_references,
                  latency_ms, outcome, outcome_notes)
               VALUES ($1, NULL, 'claim-verifier', 'pre_insert_gate',
                       0, 1, false, true, 0, 0, 'verify_gate_fail', $2)`,
              [engagementId, `title="${String(f.title).slice(0,80)}"; code=${preCheck.code || "?"}; floored_to=info`]);
          } catch (_) {}
        }
      } catch (_) { /* verifier module load failure — continue with original values */ }

      const ins = await db.query(
        `INSERT INTO pentest_findings
           (engagement_id, title, severity, status, affected_asset, refs, evidence_summary,
            informed_by, enables, kind)
         VALUES ($1, $2, $3, 'open', $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          engagementId,
          String(f.title).slice(0, 240),
          finalSeverity,
          f.affected_asset ? String(f.affected_asset).slice(0, 240) : null,
          JSON.stringify(Array.isArray(f.refs) ? f.refs : []),
          finalEvidence ? finalEvidence.slice(0, 2000) : null,
          JSON.stringify(Array.isArray(f.informed_by) ? f.informed_by : []),
          JSON.stringify(Array.isArray(f.enables) ? f.enables : []),
          kind,
        ]);
      // dir_1780789196002: fire-and-forget claim verifier for cred_test claims.
      // Only fires when the pre-insert gate did NOT already resolve the verdict
      // (pre-insert handles exposure-with-403; post-insert handles cred_test probes).
      if (!preVerifyResolved && ins.rows && ins.rows.length > 0) {
        const newId = ins.rows[0].id;
        try {
          const { verifyFinding } = require("/app/claim-verifier");
          setImmediate(() => verifyFinding(newId).catch(e =>
            console.error(`[claim-verifier] verify ${newId} crashed: ${e.message}`)));
        } catch (_) { /* module load failure — skip silently */ }
      }
    } catch (e) {
      console.error(`[aggregator] add_finding swallowed: ${e.message}`);
    }
  }
  for (const h of out.new_hosts) {
    try {
      if (!h || !h.ip) continue;
      const portList = Array.isArray(h.ports) ? h.ports : [];
      const hasPorts = portList.length > 0;
      // dir_1780930740964: infer tech stack from port version strings.
      // Apache → apache-php (Apache typically serves PHP), nginx → nginx-static (LFI/SSTI not applicable unless explicit PHP-FPM seen).
      const techStack = inferTechStack(portList);
      if (techStack.length > 0) {
        h.tech_stack = techStack;
        for (const p of portList) p.tech_stack = techStack;
      }
      // dir_1780926990535: skip "bare host with no port detail" entries unless
      // an existing row exists (allow updates that add ports to known hosts).
      if (!hasPorts) {
        const existing = await db.query(
          `SELECT 1 FROM recon_hosts WHERE engagement_id = $1 AND ip = $2 LIMIT 1`,
          [engagementId, String(h.ip).slice(0, 45)]);
        if (existing.rows.length === 0) {
          continue; // no prior recon row + no ports → likely a CIDR-sweep false positive
        }
      }
      await db.query(
        `INSERT INTO recon_hosts (engagement_id, ip, hostname, status, ports)
         VALUES ($1, $2, $3, 'up', $4::jsonb)
         ON CONFLICT (engagement_id, ip) DO UPDATE
            SET ports = COALESCE(recon_hosts.ports, '[]'::jsonb) || EXCLUDED.ports,
                hostname = COALESCE(recon_hosts.hostname, EXCLUDED.hostname),
                discovered_at = COALESCE(recon_hosts.discovered_at, NOW())`,
        [
          engagementId,
          String(h.ip).slice(0, 45),
          h.hostname ? String(h.hostname).slice(0, 240) : null,
          JSON.stringify(portList),
        ]);
    } catch (e) {
      console.error(`[aggregator] recon_hosts upsert swallowed: ${e.message}`);
    }
  }

  return out;
}

module.exports = { fold };
