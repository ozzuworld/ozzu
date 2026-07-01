// routes/soc.js — SOC pentest engagement mobile interface
"use strict";

const { spawn } = require('child_process');
const fs = require('fs');
const { parseReconOutput } = require('../soc/soc-recon-parser');

// In-memory registry of running SSH children, keyed by session_id.
// Entry shape: { proc, itemId, timeoutHandle, timedOut }
const runningProcs = new Map();

// Postgres TEXT columns reject NUL bytes (0x00) with "invalid byte sequence for
// encoding UTF8". Remote commands like `cat` on binary configs will emit NULs,
// which wedged queue items in 'running' when the UPDATE threw. Strip them so
// hex dumps/logs remain legible but the write always succeeds.
function sanitizeOutput(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\x00/g, '\\x00');
}

// Parse recon scan stdout into structured recon_hosts rows at ingest (dir_1780530175588).
// WHY: raw nmap/nc dumps pasted into chat trip the usage-policy classifier; structured
// rows don't. The raw blob is already safely stored in agent_audit_log for the
// app/evidence — this is purely additive. It is BEST-EFFORT and FULLY error-isolated:
// a parser/DB hiccup here must never disturb the execution state machine or wedge a
// queue item. Cipher reads these rows via get_recon; the raw dump never enters context.
async function parseAndStoreRecon(db, engagementId, sessionId, rawOutput) {
  if (!engagementId || typeof rawOutput !== 'string' || !rawOutput) return;
  let records;
  try {
    records = parseReconOutput(rawOutput);
  } catch (err) {
    console.error('[soc recon] parse failed:', err && err.message);
    return;
  }
  if (!records || !records.length) return;
  for (const rec of records) {
    if (!rec.ip) continue; // need an IP to key the (engagement_id, ip) upsert
    try {
      await db.query(
        `INSERT INTO recon_hosts (engagement_id, session_id, ip, mac, vendor, hostname, status, ports, raw_excerpt, discovered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW())
         ON CONFLICT (engagement_id, ip) DO UPDATE SET
           session_id    = EXCLUDED.session_id,
           mac           = COALESCE(EXCLUDED.mac, recon_hosts.mac),
           vendor        = COALESCE(EXCLUDED.vendor, recon_hosts.vendor),
           hostname      = COALESCE(EXCLUDED.hostname, recon_hosts.hostname),
           status        = COALESCE(EXCLUDED.status, recon_hosts.status),
           ports         = CASE WHEN jsonb_array_length(EXCLUDED.ports) > 0 THEN EXCLUDED.ports ELSE recon_hosts.ports END,
           raw_excerpt   = EXCLUDED.raw_excerpt,
           discovered_at = NOW()`,
        [
          engagementId,
          sessionId || null,
          rec.ip,
          rec.mac || null,
          rec.vendor || null,
          rec.hostname || null,
          rec.status || null,
          JSON.stringify(rec.ports || []),
          rec.raw ? sanitizeOutput(rec.raw).slice(0, 2000) : null,
        ]
      );
    } catch (err) {
      console.error(`[soc recon] upsert failed for ${rec.ip} (eng ${engagementId}):`, err && err.message);
    }
  }
}

// Run PhoneInfoga OSINT on a list of phone numbers and store results
async function runCallOsint(db, numbers) {
  for (const num of numbers) {
    try {
      const result = await new Promise((resolve, reject) => {
        const proc = spawn('phoneinfoga', ['scan', '-n', num], {
          timeout: 30000,
          env: { ...process.env },
        });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('close', code => {
          if (code !== 0) reject(new Error(`phoneinfoga exit ${code}: ${stderr.slice(0, 200)}`));
          else resolve(stdout);
        });
        proc.on('error', reject);
      });

      // parse phoneinfoga output
      const parsed = parsePhoneInfoga(result, num);
      await db.query(
        `INSERT INTO call_osint (phone_number, carrier, line_type, country, country_code,
           local_format, international_format, is_voip, raw_result, last_scanned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (phone_number) DO UPDATE SET
           carrier = COALESCE(EXCLUDED.carrier, call_osint.carrier),
           line_type = COALESCE(EXCLUDED.line_type, call_osint.line_type),
           country = COALESCE(EXCLUDED.country, call_osint.country),
           country_code = COALESCE(EXCLUDED.country_code, call_osint.country_code),
           local_format = COALESCE(EXCLUDED.local_format, call_osint.local_format),
           international_format = COALESCE(EXCLUDED.international_format, call_osint.international_format),
           is_voip = COALESCE(EXCLUDED.is_voip, call_osint.is_voip),
           raw_result = EXCLUDED.raw_result,
           last_scanned = NOW()`,
        [num, parsed.carrier, parsed.line_type, parsed.country, parsed.country_code,
         parsed.local_format, parsed.international_format, parsed.is_voip,
         JSON.stringify({ raw: result.slice(0, 4000), parsed })]
      );
      console.log(`[call-osint] scanned ${num}: ${parsed.carrier || 'unknown'} / ${parsed.line_type || 'unknown'} / ${parsed.country || 'unknown'}`);
    } catch (err) {
      console.error(`[call-osint] failed for ${num}:`, err.message);
    }
  }
}

function parsePhoneInfoga(output, number) {
  const r = { carrier: null, line_type: null, country: null, country_code: null,
              local_format: null, international_format: null, is_voip: null };
  const lines = output.split('\n');
  for (const line of lines) {
    const l = line.toLowerCase();
    if (l.includes('carrier:') || l.includes('operator:'))
      r.carrier = line.split(/:\s*/)[1]?.trim() || null;
    if (l.includes('country:'))
      r.country = line.split(/:\s*/)[1]?.trim() || null;
    if (l.includes('country code:'))
      r.country_code = line.split(/:\s*/)[1]?.trim() || null;
    if (l.includes('local:') || l.includes('local format:'))
      r.local_format = line.split(/:\s*/)[1]?.trim() || null;
    if (l.includes('international:') || l.includes('e164:') || l.includes('international format:'))
      r.international_format = line.split(/:\s*/)[1]?.trim() || null;
    if (l.includes('line type:') || l.includes('line_type:'))
      r.line_type = line.split(/:\s*/)[1]?.trim() || null;
    if (l.includes('voip') && (l.includes('true') || l.includes('yes')))
      r.is_voip = true;
    if (l.includes('voip') && (l.includes('false') || l.includes('no')))
      r.is_voip = false;
  }
  return r;
}

module.exports = function socRoutes(ctx) {
  const { sendJSON, parseBody, db, requireAuth } = ctx;

  // dir_1780760826635 — push SOC state changes to the app via the existing WS bus
  // so the engagement screen drops its 2s setInterval. Best-effort: a broadcast
  // failure (no listeners, send error) must never disturb the SQL write path.
  function broadcast(msg) {
    try {
      const fn = ctx.broadcastToAll;
      if (typeof fn === 'function') fn(msg);
    } catch (err) {
      console.warn('[soc] broadcast failed:', err && err.message);
    }
  }

  // Lazy idempotent migration — docker-entrypoint-initdb.d only runs on fresh volumes.
  db.query(
    `ALTER TABLE soc_queue_items ADD COLUMN IF NOT EXISTS pid INTEGER;
     ALTER TABLE soc_queue_items ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER NOT NULL DEFAULT 300;`
  ).catch((err) => console.error('[soc] schema migration failed:', err.message));

  // dir_1782336880206: startup sweep — no runAgent loop survives a bridge restart.
  // 1) Mark any 'running' queue items as failed (the process is gone).
  // 2) Reset ALL 'running' agent_status to idle (the loop is gone regardless of
  //    whether it had running queue items at the moment of crash).
  Promise.all([
    db.query(`UPDATE soc_queue_items SET status = 'failed', completed_at = NOW()
              WHERE status = 'running' RETURNING id, engagement_id, seq`),
    db.query(`UPDATE pentest_engagements SET agent_status = 'idle'
              WHERE agent_status = 'running' RETURNING id`),
  ]).then(([qi, eng]) => {
    if (qi.rows.length > 0)
      console.log(`[soc] startup: cleaned ${qi.rows.length} ghost-running queue item(s):`,
        qi.rows.map(x => `${x.engagement_id}/Q${x.seq}`).join(", "));
    if (eng.rows.length > 0)
      console.log(`[soc] startup: reset ${eng.rows.length} ghost-running engagement(s) to idle:`,
        eng.rows.map(x => x.id).join(", "));
  }).catch(err => console.error('[soc] startup ghost cleanup failed:', err.message));

  // Step 2 of OFFENSE-AGENT-DESIGN.md (dir_1780588442941) — when a queue item
  // finalizes, sync the outcome onto the most recent offense_telemetry row
  // pointing at that queue_item_id. Closes the audit loop and gives the next
  // advance_offense prompt feedback about what actually happened. Wrapped in
  // its own try — telemetry sync NEVER breaks the queue's state machine.
  async function syncOffenseOutcome(itemId, outcome) {
    try {
      await db.query(
        `UPDATE offense_telemetry
            SET outcome = $1
          WHERE id = (
            SELECT id FROM offense_telemetry
             WHERE queue_item_id = $2
             ORDER BY id DESC LIMIT 1
          )`,
        [outcome, itemId]
      );
    } catch (telErr) {
      console.error(`[soc] telemetry outcome sync failed for item ${itemId}:`, telErr.message);
    }
  }

  return async function handleSocRoutes(req, res, pathname, url) {

    // GET /soc/engagements - List all engagements
    // dir_1780764341980 — added medium/low/info finding counts + queue totals so
    // the list card can render severity buckets and a real progress bar without
    // an N+1 per-card fetch. Strictly additive aggregate columns; no schema change.
    if (req.method === "GET" && pathname === "/soc/engagements") {
      const status = url.searchParams.get("status");
      let query = `
        SELECT
          e.*,
          COUNT(DISTINCT f.id) as findings_count,
          COUNT(DISTINCT CASE WHEN f.severity = 'critical' THEN f.id END) as critical_count,
          COUNT(DISTINCT CASE WHEN f.severity = 'high' THEN f.id END) as high_count,
          COUNT(DISTINCT CASE WHEN f.severity = 'medium' THEN f.id END) as medium_count,
          COUNT(DISTINCT CASE WHEN f.severity = 'low' THEN f.id END) as low_count,
          COUNT(DISTINCT CASE WHEN f.severity = 'info' THEN f.id END) as info_count,
          COUNT(DISTINCT q.id) as queue_total,
          COUNT(DISTINCT CASE WHEN q.status = 'done' THEN q.id END) as queue_done,
          COUNT(DISTINCT CASE WHEN q.status = 'running' THEN q.id END) as queue_running,
          COUNT(DISTINCT CASE WHEN q.status = 'pending' THEN q.id END) as queue_pending,
          COUNT(DISTINCT CASE WHEN q.status = 'failed' THEN q.id END) as queue_failed,
          MAX(q.started_at) as last_activity_at,
          MAX(q.completed_at) as last_completed_at,
          (SELECT ot.outcome FROM offense_telemetry ot WHERE ot.engagement_id = e.id ORDER BY ot.created_at DESC LIMIT 1) as latest_telemetry_outcome
        FROM pentest_engagements e
        LEFT JOIN pentest_findings f ON e.id = f.engagement_id
        LEFT JOIN soc_queue_items q ON e.id = q.engagement_id
      `;
      const params = [];

      if (status) {
        query += ` WHERE e.status = $1`;
        params.push(status);
      }

      query += ` GROUP BY e.id ORDER BY e.created_at DESC`;

      const result = await db.query(query, params);
      sendJSON(res, 200, { engagements: result.rows });
      return true;
    }

    // GET /soc/executors — live status of physical devices for the engagement-creation
    // wizard's executor picker (dir_1782136917098). Reads device_state (heartbeat +
    // wg-poll maintained) so devices are LIVE, never hardcoded. Read-only. Powers the
    // device status cards AND the Wi-Fi/reachability gate (the wizard compares a device's
    // wifi_ssid / lan_subnet against the target network).
    if (req.method === "GET" && pathname === "/soc/executors") {
      const r = await db.query(`SELECT * FROM device_state ORDER BY device_id`);
      const STALE_WG_S = 180; // WG handshake older than this = tunnel not live
      const executors = r.rows.map((d) => {
        const wgAge = d.wg_handshake_age_s;
        const wgUp = wgAge != null && wgAge < STALE_WG_S;
        // Derive the /24 the device sits on, from its LAN ip (for reachability checks).
        let subnet = null;
        if (d.lan_ip && /^\d+\.\d+\.\d+\.\d+$/.test(d.lan_ip)) {
          subnet = d.lan_ip.split(".").slice(0, 3).join(".") + ".0/24";
        }
        return {
          device_id: d.device_id,
          status: d.status,                 // online | stale | offline
          online: d.status === "online",
          wifi_ssid: d.wifi_ssid || null,
          lan_ip: d.lan_ip || null,
          lan_subnet: subnet,
          wg_ip: d.wg_ip || null,
          wg_up: wgUp,
          wg_handshake_age_s: wgAge ?? null,
          battery_pct: d.battery_pct ?? null,
          last_seen: d.last_seen,
          // WG-reachable devices act as the relay/doorway into a physical lab (the bridge holds
          // the toolkit). Heuristic only — the wizard still gates on reachability.
          executor_capable: !!d.wg_ip,
          // iPhone devices use SOCKS5 relay (can't do L3 forwarding like rooted Android).
          // The Ozzu app runs a SOCKS5 server on port 1080; bridge wraps commands with proxychains.
          proxy_mode: /iphone|ios/i.test(d.device_id || "") ? "socks5" : null,
        };
      });
      // dev-01 REMOVED from the offense pipeline (King Kazuma 2026-06-23) — no longer surfaced as
      // an executor. Offense runs LOCAL on the bridge, routing the lab /24 via wg0 → tablet relay.
      sendJSON(res, 200, { executors });
      return true;
    }

    // POST /soc/executors/:device_id/wifi-scan — run a LIVE Wi-Fi scan ON the chosen device
    // and return the networks it actually sees, so the creation wizard NEVER makes the operator
    // type an SSID (dir_1782156946277). dev-01 + any Linux relay scan via ssh+nmcli; the rooted
    // tablet scans via adb -> `cmd wifi`. The device's CURRENT ssid is flagged in the same
    // response so the Wi-Fi gate knows on-network vs needs-access without a second call.
    if (req.method === "POST" && pathname.startsWith("/soc/executors/") && pathname.endsWith("/wifi-scan")) {
      if (!requireAuth(req, res)) return true;
      const deviceId = decodeURIComponent(pathname.split("/")[3] || "");
      try {
        const dr = await db.query(`SELECT * FROM device_state WHERE device_id = $1`, [deviceId]);
        // dev-01 is the always-available local executor — allow scanning it even when it isn't
        // heartbeating into device_state (its joined SSID is read from nmcli's IN-USE marker).
        const dev = dr.rows[0] || (deviceId === "dev-01" ? { device_id: "dev-01", wifi_ssid: null, wg_ip: null, executor_adb_target: null } : null);
        if (!dev) { sendJSON(res, 404, { error: `unknown device ${deviceId}` }); return true; }

        // If the device self-reports its scan via heartbeat (the tablet's reporter runs `iw scan`
        // locally and posts meta.wifi_networks), serve THAT — no ssh/adb chain. This is how the
        // tablet is scannable at all: the bridge's adb isn't authorized on it, only dev-01's is.
        const selfScan = dev.meta && Array.isArray(dev.meta.wifi_networks) ? dev.meta.wifi_networks : null;
        if (selfScan && selfScan.length) {
          const cur0 = (dev.wifi_ssid || "").trim().toLowerCase();
          const networks = selfScan.filter((n) => n && n.ssid).map((n) => ({
            ssid: String(n.ssid),
            signal: Math.max(0, Math.min(100, Math.round(2 * ((Number(n.signal_dbm) || -100) + 100)))),
            security: n.security || "secured",
            current: !!cur0 && String(n.ssid).trim().toLowerCase() === cur0,
          })).sort((a, b) => b.signal - a.signal);
          sendJSON(res, 200, { device_id: deviceId, current_ssid: dev.wifi_ssid || null, count: networks.length, networks, source: "device-reported" });
          return true;
        }

        // Pick the scan transport + command for this device.
        const NMCLI = "nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY dev wifi list --rescan yes 2>/dev/null";
        let cmd, args, kind;
        if (deviceId === "dev-01") {
          kind = "nmcli"; cmd = "ssh";
          args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "dev-01", NMCLI];
        } else if (/tab|p610|android|phone/i.test(deviceId)) {
          const target = dev.executor_adb_target || (dev.wg_ip ? `${dev.wg_ip}:5555` : null);
          if (!target) { sendJSON(res, 422, { error: `${deviceId} has no adb target / wg_ip to scan` }); return true; }
          kind = "android"; cmd = "bash";
          args = ["-c", `adb connect ${target} >/dev/null 2>&1; adb -s ${target} shell "su -c 'cmd wifi start-scan >/dev/null 2>&1; sleep 2; cmd wifi list-scan-results 2>/dev/null'"`];
        } else if (dev.wg_ip) {
          kind = "nmcli"; cmd = "ssh";
          args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", `root@${dev.wg_ip}`, NMCLI];
        } else {
          sendJSON(res, 422, { error: `${deviceId} is not Wi-Fi-scan capable (no ssh/adb path)` });
          return true;
        }

        const { stdout: out, stderr: scanStderr } = await new Promise((resolve, reject) => {
          const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
          let o = "", e = "";
          const t = setTimeout(() => p.kill("SIGKILL"), 25000);
          p.stdout.on("data", (d) => (o += d));
          p.stderr.on("data", (d) => (e += d));
          p.on("error", (err) => { clearTimeout(t); reject(err); });
          p.on("close", () => { clearTimeout(t); resolve({ stdout: o || "", stderr: e || "" }); });
        });
        // dir_1782865268116: detect ADB authorization failure — without this, an
        // unauthorized ADB returns 200 with empty networks and the frontend
        // auto-scan useEffect loops infinitely.
        if (kind === "android" && /unauthorized|not found|cannot connect|error/i.test(scanStderr) && !out.trim()) {
          sendJSON(res, 502, { error: `ADB scan failed on ${deviceId}: ${scanStderr.trim().split("\n")[0]}` });
          return true;
        }

        // Normalize to [{ ssid, signal(0-100), security }], strongest first, deduped by SSID.
        const byssid = new Map();
        const nmcliJoined = new Set();   // SSIDs nmcli marks IN-USE ('*') — the joined network
        if (kind === "android") {
          // `cmd wifi list-scan-results`: BSSID Frequency RSSI Age SSID Flags...
          for (const line of out.split("\n")) {
            const m = line.trim().match(/^([0-9a-fA-F:]{17})\s+\d+\s+(-?\d+)\s+\d+\s+(.*?)\s*(\[[^\]]*\].*)?$/);
            if (!m) continue;
            const ssid = (m[3] || "").trim();
            if (!ssid) continue;
            const signal = Math.max(0, Math.min(100, 2 * (parseInt(m[2], 10) + 100)));
            const security = /WPA|WEP|EAP|PSK|SAE/i.test(m[4] || "") ? "secured" : "open";
            const prev = byssid.get(ssid);
            if (!prev || signal > prev.signal) byssid.set(ssid, { ssid, signal, security });
          }
        } else {
          // nmcli -t: IN-USE:SSID:SIGNAL:SECURITY ('*' in IN-USE = the joined network; escaped
          // colons inside an SSID arrive as \:).
          for (const line of out.split("\n")) {
            if (!line.trim()) continue;
            const parts = line.split(/(?<!\\):/);
            const ssid = (parts[1] || "").replace(/\\:/g, ":").trim();
            if (!ssid) continue;
            if ((parts[0] || "").trim() === "*") nmcliJoined.add(ssid);
            const signal = parseInt(parts[2] || "0", 10) || 0;
            const security = (parts[3] || "").trim() || "open";
            const prev = byssid.get(ssid);
            if (!prev || signal > prev.signal) byssid.set(ssid, { ssid, signal, security });
          }
        }
        const networks = [...byssid.values()].sort((a, b) => b.signal - a.signal);
        // "current" = the JOINED network: nmcli IN-USE (Linux) or the heartbeat's wifi_ssid
        // (Android tablet — the scan output doesn't flag the joined network).
        const hbCur = (dev.wifi_ssid || "").trim().toLowerCase();
        for (const n of networks) {
          n.current = kind === "android"
            ? (!!hbCur && n.ssid.trim().toLowerCase() === hbCur)
            : nmcliJoined.has(n.ssid);
        }

        sendJSON(res, 200, { device_id: deviceId, current_ssid: dev.wifi_ssid || null, count: networks.length, networks });
      } catch (error) {
        console.error("[soc/wifi-scan] Error:", error);
        sendJSON(res, 502, { error: "wifi scan failed", details: error.message });
      }
      return true;
    }

    // POST /soc/engagements/:id/report?kind=mid|final — generate the engagement's report(s) from
    // its postgres trajectory via the proven DeepSeek two-report writer (tools/oracle/report-via-
    // model.js). kind=mid => sanitized DEBRIEF only (safe mid-run); kind=final => FULL operator
    // report + DEBRIEF. The offensive bytes flow postgres -> temp file -> DeepSeek -> report files;
    // never back through Claude. The app only ever reads the sanitized DEBRIEF. dir_1782171502039.
    if (req.method === "POST" && /^\/soc\/engagements\/[^/]+\/report$/.test(pathname)) {
      if (!requireAuth(req, res)) return true;
      const eid = decodeURIComponent(pathname.split("/")[3] || "");
      let kind = "mid";
      try { kind = new URL(req.url, "http://x").searchParams.get("kind") === "final" ? "final" : "mid"; } catch {}
      try {
        const er = await db.query(`SELECT * FROM pentest_engagements WHERE id = $1`, [eid]);
        if (er.rows.length === 0) { sendJSON(res, 404, { error: "engagement not found" }); return true; }
        const eng = er.rows[0];
        const qr = await db.query(`SELECT seq, command, output, status, intent_class FROM soc_queue_items WHERE engagement_id = $1 ORDER BY seq`, [eid]);
        if (qr.rows.length === 0) { sendJSON(res, 422, { error: "no run trajectory yet — launch a run first, then there's something to report on" }); return true; }
        const iters = qr.rows.map((q) => ({
          iter: q.seq,
          intent_class: q.intent_class || null,
          exit_code: q.status === "done" ? 0 : (q.status === "failed" ? 1 : null),
          flag_captured: /OZZULAB\{/.test(q.output || ""),
          command: q.command || "",
          output_excerpt: (q.output || "").slice(0, 4000),
        }));
        const scopeObj = { id: eng.id, client_name: eng.client_name, engagement_type: eng.engagement_type, scope: eng.scope, executor_host: eng.executor_host };
        const dir = `/home/gcp/ozzu/private/soc-reports/${eid.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${dir}/trajectory.jsonl`, JSON.stringify({ engagement_id: eid, iters }) + "\n");
        fs.writeFileSync(`${dir}/scope.json`, JSON.stringify(scopeObj, null, 1));
        const fullPath = kind === "final" ? `${dir}/report-FULL.md` : "none";
        const debriefPath = `${dir}/report-DEBRIEF.md`;
        const child = spawn("node", ["/home/gcp/ozzu/tools/oracle/report-via-model.js", `${dir}/trajectory.jsonl`, `${dir}/scope.json`, fullPath, debriefPath], {
          env: { ...process.env, REPORT_MODEL: process.env.OFFENSE_MODEL_NAME || "deepseek/deepseek-v4-pro" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let log = "";
        child.stdout.on("data", (d) => (log += d));
        child.stderr.on("data", (d) => (log += d));
        child.on("close", () => {
          const debrief = fs.existsSync(debriefPath) ? fs.readFileSync(debriefPath, "utf8") : null;
          const hasFull = kind === "final" && fs.existsSync(fullPath);
          db.query(`UPDATE pentest_engagements SET metadata = COALESCE(metadata,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
            [eid, JSON.stringify({ last_report_kind: kind, last_report_has_full: hasFull })]).catch(() => {});
          if (!res.headersSent) {
            if (debrief) sendJSON(res, 200, { kind, debrief, has_full: hasFull });
            else sendJSON(res, 502, { error: "report produced no debrief", log: log.slice(-300) });
          }
        });
        child.on("error", (e) => { if (!res.headersSent) sendJSON(res, 500, { error: "report spawn failed", details: e.message }); });
      } catch (error) {
        console.error("[soc/report] Error:", error);
        if (!res.headersSent) sendJSON(res, 500, { error: "report failed", details: error.message });
      }
      return true;
    }

    // GET /soc/engagements/:id/report — the last sanitized DEBRIEF for the app (operator FULL stays on disk).
    if (req.method === "GET" && /^\/soc\/engagements\/[^/]+\/report$/.test(pathname)) {
      const eid = decodeURIComponent(pathname.split("/")[3] || "").replace(/[^A-Za-z0-9_-]/g, "_");
      const dpath = `/home/gcp/ozzu/private/soc-reports/${eid}/report-DEBRIEF.md`;
      if (fs.existsSync(dpath)) sendJSON(res, 200, { debrief: fs.readFileSync(dpath, "utf8"), has_full: fs.existsSync(`/home/gcp/ozzu/private/soc-reports/${eid}/report-FULL.md`) });
      else sendJSON(res, 404, { error: "no report generated yet" });
      return true;
    }

    // GET /soc/queue/:id/report — structured step report for Cipher analysis.
    // Returns all metadata + sanitized output for a single queue item.
    if (req.method === "GET" && /^\/soc\/queue\/\d+\/report$/.test(pathname)) {
      const qid = pathname.split("/")[3];
      try {
        const r = await db.query(
          `SELECT q.id, q.engagement_id, q.seq, q.title, q.description,
                  q.command, q.output, q.expected_artifact,
                  q.status, q.intent_class, q.auto_executed,
                  q.started_at, q.completed_at, q.created_at,
                  EXTRACT(EPOCH FROM (q.completed_at - q.started_at))::int AS duration_sec
           FROM soc_queue_items q WHERE q.id = $1`, [qid]);
        if (r.rows.length === 0) { sendJSON(res, 404, { error: "queue item not found" }); return true; }
        const row = r.rows[0];
        const tel = await db.query(
          `SELECT outcome, outcome_notes, intent_category, created_at
           FROM offense_telemetry WHERE queue_item_id = $1 ORDER BY created_at`, [qid]);
        sendJSON(res, 200, {
          step: {
            id: row.id,
            engagement_id: row.engagement_id,
            seq: row.seq,
            title: row.title,
            description: row.description,
            command: row.command,
            output: row.output,
            expected_artifact: row.expected_artifact,
            status: row.status,
            intent_class: row.intent_class,
            auto_executed: row.auto_executed,
            started_at: row.started_at,
            completed_at: row.completed_at,
            duration_sec: row.duration_sec,
          },
          telemetry: tel.rows,
        });
      } catch (error) {
        sendJSON(res, 500, { error: "failed to load step report", details: error.message });
      }
      return true;
    }

    // POST /soc/engagements/:id/run — operator-fired launch of the autonomous DeepSeek run. RULE 3:
    // the operator executes via the app; this is the trigger the app was missing. Kicks off
    // offense-agent.runAgent in the BACKGROUND (long-running loop) and returns at once; the Now tab
    // observes via postgres. Cipher builds the control; the operator is the one who fires it.
    if (req.method === "POST" && /^\/soc\/engagements\/[^/]+\/run$/.test(pathname)) {
      if (!requireAuth(req, res)) return true;
      const eid = decodeURIComponent(pathname.split("/")[3] || "");
      try {
        const er = await db.query(`SELECT id, agent_status FROM pentest_engagements WHERE id = $1`, [eid]);
        if (er.rows.length === 0) { sendJSON(res, 404, { error: "engagement not found" }); return true; }
        if (er.rows[0].agent_status === "running") { sendJSON(res, 409, { error: "a run is already in progress" }); return true; }
        let maxIter = 60;
        let modelOverride = null;
        try { const b = await parseBody(req); if (b) { if (b.max_iter) maxIter = Math.max(1, Math.min(200, parseInt(b.max_iter, 10) || 60)); if (b.model_override) modelOverride = String(b.model_override); } } catch {}
        // Fall back to the engagement's stored model preference if not passed in the request
        if (!modelOverride) {
          try {
            const engMeta = await db.query(`SELECT metadata FROM pentest_engagements WHERE id = $1`, [eid]);
            const meta = engMeta.rows[0]?.metadata;
            if (meta && typeof meta === "object" && meta.model_override) modelOverride = meta.model_override;
          } catch {}
        }
        // clear any leftover abort flag so the new run isn't halted on its first iteration,
        // and enable autonomous execution (same as the autonomy toggle — without this the
        // executor refuses to run queued steps with "engagement opt-out")
        await db.query(`UPDATE pentest_engagements SET agent_run_state = COALESCE(agent_run_state,'{}'::jsonb) - 'abort_requested', autonomous_execution_enabled = true, autonomous_paused = false WHERE id = $1`, [eid]).catch(() => {});
        const agent = require("../soc/offense-agent");
        // dir_1782339906899: v2 model-driven loop (DeepSeek drives via tool calls).
        // v1 (runAgent) kept as fallback — set SOC_LOOP_VERSION=v1 in env to revert.
        const loopVersion = process.env.SOC_LOOP_VERSION || "v2";
        const runOpts = { max_iter: maxIter };
        if (modelOverride) runOpts.model_override = modelOverride;
        if (loopVersion === "v2" && agent.runAgentV2) {
          agent.runAgentV2(eid, runOpts).catch((e) => console.error("[soc/run] runAgentV2:", e && e.message));
        } else {
          agent.runAgent(eid, runOpts).catch((e) => console.error("[soc/run] runAgent:", e && e.message));
        }
        sendJSON(res, 202, { ok: true, status: "launching", engagement_id: eid, max_iter: maxIter, loop: loopVersion, model: modelOverride || process.env.OFFENSE_MODEL_NAME || "deepseek-reasoner" });
      } catch (error) {
        console.error("[soc/run] Error:", error);
        sendJSON(res, 500, { error: "launch failed", details: error.message });
      }
      return true;
    }

    // POST /soc/engagements/:id/stop — operator stop. Sets the abort flag the run loop honors at its
    // next iteration boundary (halts cleanly after the current step finishes).
    if (req.method === "POST" && /^\/soc\/engagements\/[^/]+\/stop$/.test(pathname)) {
      if (!requireAuth(req, res)) return true;
      const eid = decodeURIComponent(pathname.split("/")[3] || "");
      try {
        await db.query(`UPDATE pentest_engagements SET agent_run_state = COALESCE(agent_run_state,'{}'::jsonb) || '{"abort_requested":true}'::jsonb WHERE id = $1`, [eid]);
        sendJSON(res, 200, { ok: true, status: "stopping", engagement_id: eid });
      } catch (error) {
        console.error("[soc/stop] Error:", error);
        sendJSON(res, 500, { error: "stop failed", details: error.message });
      }
      return true;
    }

    // POST /soc/engagements/:id/autonomy {enabled} — the OPERATOR's switch between human-in-the-loop
    // (model proposes, operator runs each step) and AUTO (queued steps auto-execute through the
    // membrane: ROE block-list / permission verdict / auto-verify / preflight). Cipher builds this
    // switch; the operator throws it. On enable, kick any pending steps so the run un-sticks.
    if (req.method === "POST" && /^\/soc\/engagements\/[^/]+\/autonomy$/.test(pathname)) {
      if (!requireAuth(req, res)) return true;
      const eid = decodeURIComponent(pathname.split("/")[3] || "");
      let enabled = true;
      try { const b = await parseBody(req); if (b && typeof b.enabled === "boolean") enabled = b.enabled; } catch {}
      try {
        const er = await db.query(`SELECT id, agent_status FROM pentest_engagements WHERE id = $1`, [eid]);
        if (er.rows.length === 0) { sendJSON(res, 404, { error: "engagement not found" }); return true; }
        await db.query(
          `UPDATE pentest_engagements SET autonomous_execution_enabled = $2,
             autonomous_paused = CASE WHEN $2 THEN false ELSE autonomous_paused END
           WHERE id = $1`,
          [eid, enabled]);
        let kicked = 0, launched = false;
        if (enabled) {
          try {
            const autoEx = require("../soc/autonomous-executor");
            const pend = await db.query(`SELECT id FROM soc_queue_items WHERE engagement_id = $1 AND status = 'pending' ORDER BY seq`, [eid]);
            for (const row of pend.rows) {
              try { const r = await autoEx.maybeAutoExecute(row.id); if (r && r.autoExecuted) kicked++; } catch (_) {}
            }
          } catch (e) { console.error("[soc/autonomy] kick:", e && e.message); }
          // Autorun: "Auto on" means run autonomously. If no loop is active, START one — it queues
          // steps and (auto_exec=true) auto-runs them through the membrane. The operator's toggle is
          // the trigger (same hand-on-the-switch as Launch).
          if (er.rows[0].agent_status !== "running") {
            const agent = require("../soc/offense-agent");
            const loopV = process.env.SOC_LOOP_VERSION || "v2";
            let engModel = null;
            try {
              const em = await db.query(`SELECT metadata FROM pentest_engagements WHERE id = $1`, [eid]);
              const m = em.rows[0]?.metadata;
              if (m && typeof m === "object" && m.model_override) engModel = m.model_override;
            } catch {}
            const runOpts = { max_iter: 60 };
            if (engModel) runOpts.model_override = engModel;
            if (loopV === "v2" && agent.runAgentV2) {
              agent.runAgentV2(eid, runOpts).catch((e) => console.error("[soc/autonomy] runAgentV2:", e && e.message));
            } else {
              agent.runAgent(eid, runOpts).catch((e) => console.error("[soc/autonomy] runAgent:", e && e.message));
            }
            launched = true;
          }
        }
        sendJSON(res, 200, { ok: true, autonomous_execution_enabled: enabled, kicked, launched });
      } catch (error) {
        console.error("[soc/autonomy] Error:", error);
        sendJSON(res, 500, { error: "autonomy toggle failed", details: error.message });
      }
      return true;
    }

    // POST /soc/engagements — create an engagement from the in-app wizard
    // (dir_1782136917098). Mirrors the create_engagement MCP tool's id + INSERT, plus the
    // wizard's device-aware fields: executor_host / executor_adb_target, the structured
    // target_networks (kept inside scope), and the Wi-Fi-gate outcome — when the chosen
    // executor is online but NOT on the target SSID, the wizard sets
    // first_objective='gain_wifi_access' + wifi_target, persisted in metadata so the
    // autonomous run opens with a Wi-Fi-access phase before the real targets.
    if (req.method === "POST" && pathname === "/soc/engagements") {
      if (!requireAuth(req, res)) return true; // writes a new engagement row
      try {
        const body = await parseBody(req);
        if (!body.client_name || !body.engagement_type) {
          sendJSON(res, 400, { error: "client_name and engagement_type are required" });
          return true;
        }
        const engagementId = `SKYLINE-SOC-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`;

        // Classic scope shape (targets/allowed/prohibited/credentials) + the wizard's
        // structured target_networks carried alongside it.
        const scope = body.scope && typeof body.scope === "object" ? body.scope : {};
        if (Array.isArray(body.target_networks)) scope.target_networks = body.target_networks;

        const metadata = (body.metadata && typeof body.metadata === "object") ? body.metadata : {};
        if (body.first_objective) metadata.first_objective = body.first_objective; // 'gain_wifi_access'
        if (body.wifi_target) metadata.wifi_target = body.wifi_target;             // SSID to join
        if (body.model_override) metadata.model_override = body.model_override;
        metadata.created_via = "wizard";

        await db.query(
          `INSERT INTO pentest_engagements (
             id, client_name, engagement_type, scope, roe, start_date, end_date,
             lead_engineer, sow_url, status, executor_host, executor_adb_target, metadata,
             permission_mode, autonomous_full_access
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            engagementId,
            body.client_name,
            body.engagement_type,
            JSON.stringify(scope),
            JSON.stringify(body.roe || {}),
            body.start_date || null,
            body.end_date || null,
            body.lead_engineer || null,
            body.sow_url || null,
            "scoping",
            body.executor_host || null,
            body.executor_adb_target || null,
            JSON.stringify(metadata),
            // No-membrane posture by default (King Kazuma 2026-06-23): the wizard's choice if given,
            // else full_engagement + full access — so engagements aren't born gated/capped.
            body.permission_mode || metadata.permission_mode || "full_engagement",
            body.autonomous_full_access !== undefined ? body.autonomous_full_access : true,
          ]
        );

        broadcast({ type: "socQueueChanged", engagement_id: engagementId, change: "created", ts: Date.now() });
        sendJSON(res, 201, {
          id: engagementId,
          status: "scoping",
          executor_host: body.executor_host || null,
          first_objective: metadata.first_objective || null,
        });
        return true;
      } catch (error) {
        console.error("[soc create] Error:", error);
        if (!res.headersSent) sendJSON(res, 500, { error: "Internal server error", details: error.message });
        return true;
      }
    }

    // GET /soc/engagements/:id - Get engagement details
    if (req.method === "GET" && pathname.startsWith("/soc/engagements/") && pathname.split("/").length === 4) {
      const id = pathname.split("/")[3];

      // Get engagement
      const engResult = await db.query(
        `SELECT * FROM pentest_engagements WHERE id = $1`,
        [id]
      );

      if (engResult.rows.length === 0) {
        sendJSON(res, 404, { error: 'Engagement not found' });
        return true;
      }

      const engagement = engResult.rows[0];

      // Get findings with severity breakdown
      const findingsResult = await db.query(
        `SELECT
          severity,
          COUNT(*) as count,
          json_agg(json_build_object(
            'id', id,
            'title', title,
            'affected_asset', affected_asset,
            'cvss_score', cvss_score,
            'discovered_at', discovered_at
          ) ORDER BY discovered_at DESC) as items
        FROM pentest_findings
        WHERE engagement_id = $1
        GROUP BY severity`,
        [id]
      );

      // Get recent activity
      const activityResult = await db.query(
        `SELECT agent_name, task, status, started_at, completed_at, output
         FROM agent_audit_log
         WHERE engagement_id = $1
         ORDER BY started_at DESC
         LIMIT 20`,
        [id]
      );

      // Staleness signals: most recent completed queue step + last 3 telemetry outcomes.
      // No schema change — reading existing columns.
      const stalenessResult = await db.query(
        `SELECT
           MAX(q.completed_at) as last_completed_at,
           (SELECT json_agg(sub.* ORDER BY sub.created_at DESC)
            FROM (SELECT outcome, created_at FROM offense_telemetry
                  WHERE engagement_id = $1 ORDER BY created_at DESC LIMIT 3) sub
           ) as recent_telemetry
         FROM soc_queue_items q
         WHERE q.engagement_id = $1`,
        [id]
      );
      const staleness = stalenessResult.rows[0] || {};

      const meta = typeof engagement.metadata === "object" ? engagement.metadata : {};
      sendJSON(res, 200, {
        engagement: {
          ...engagement,
          model_override: meta.model_override || null,
          last_completed_at: staleness.last_completed_at ?? null,
          recent_telemetry: staleness.recent_telemetry ?? [],
        },
        findings: findingsResult.rows,
        activity: activityResult.rows
      });
      return true;
    }

    // GET /soc/engagements/:id/task-graph — Step 6 (dir_1780597565542): expose the
    // L3 agent's Task Coordination Graph to the SOC app. Returns engagement_tasks
    // rows in DAG order. Includes outcome_summary (jsonb) so the UI can show key
    // signals + error categories. Read-only.
    if (req.method === "GET" && pathname.match(/^\/soc\/engagements\/[^\/]+\/task-graph$/)) {
      const id = pathname.split("/")[3];
      const r = await db.query(
        `SELECT id, engagement_id, parent_ids, directive, phase, prerequisites,
                status, queue_item_id, outcome_summary, iteration,
                created_at, updated_at, completed_at
           FROM engagement_tasks
          WHERE engagement_id = $1
          ORDER BY id ASC`,
        [id]
      );
      // Compute unblocked-set: pending tasks whose parents are all done/skipped.
      const byId = Object.create(null);
      for (const t of r.rows) byId[t.id] = t;
      const isResolved = (t) => t.status === "done" || t.status === "skipped";
      const unblocked = [];
      for (const t of r.rows) {
        if (t.status !== "pending") continue;
        const parents = t.parent_ids || [];
        if (parents.every((pid) => byId[pid] && isResolved(byId[pid]))) unblocked.push(t.id);
      }
      sendJSON(res, 200, { tasks: r.rows, unblocked, total: r.rows.length });
      return true;
    }

    // GET /soc/engagements/:id/finding-graph — dir_1780781999942: attack-graph
    // rendering of pentest_findings + pending probes, with informed_by edges and
    // open-frontier hypotheses. Mirror of the data the offense agent sees on each
    // iter when graph_mode_enabled=true. Membrane-safe (sanitized titles, no raw
    // commands/payloads). Powers the SOC app's findings page.
    if (req.method === "GET" && pathname.match(/^\/soc\/engagements\/[^\/]+\/finding-graph$/)) {
      const id = pathname.split("/")[3];
      try {
        const { materializeFindingGraph } = require("../soc/finding-graph");
        const graph = await materializeFindingGraph(id);
        sendJSON(res, 200, graph);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    // GET /soc/engagements/:id/scripts - Get scripts for engagement
    if (req.method === "GET" && pathname.match(/^\/soc\/engagements\/[^\/]+\/scripts$/)) {
      const id = pathname.split("/")[3];

      // Get engagement to determine which scripts to show
      const engResult = await db.query(
        `SELECT * FROM pentest_engagements WHERE id = $1`,
        [id]
      );

      if (engResult.rows.length === 0) {
        sendJSON(res, 404, { error: 'Engagement not found' });
        return true;
      }

      const engagement = engResult.rows[0];
      const scope = engagement.scope;
      const targets = scope.targets || [];

      // Define script templates based on engagement phases
      const scripts = [
        {
          id: 'phase1_recon',
          phase: 'Phase 1: Reconnaissance',
          name: 'Network Discovery',
          description: 'Discover live hosts and open ports',
          command: `nmap -sn ${targets.join(' ')} && nmap -p- -sV ${targets.join(' ')}`,
          status: 'ready'
        },
        {
          id: 'phase2_vuln_scan',
          phase: 'Phase 2: Vulnerability Assessment',
          name: 'Vulnerability Scan',
          description: 'Identify known vulnerabilities',
          command: `nmap --script vuln ${targets.join(' ')}`,
          status: 'ready'
        },
        {
          id: 'phase3_exploit',
          phase: 'Phase 3: Exploitation',
          name: 'Exploit Execution',
          description: 'Execute authorized exploits',
          command: `# Manual exploitation - PA engineer guided`,
          status: 'manual'
        }
      ];

      // Check which scripts have been executed
      const executedScripts = await db.query(
        `SELECT DISTINCT task FROM agent_audit_log WHERE engagement_id = $1`,
        [id]
      );
      const executedTasks = new Set(executedScripts.rows.map(r => r.task));

      scripts.forEach(script => {
        if (executedTasks.has(script.command)) {
          script.status = 'completed';
        }
      });

      sendJSON(res, 200, { scripts });
      return true;
    }

    // POST /soc/execute - Execute script on dev-01 (background execution)
    if (req.method === "POST" && pathname === "/soc/execute") {
      if (!requireAuth(req, res)) return true; // D2: ships commands to dev-01 over ssh
      try {
        const body = await parseBody(req);
        const { engagement_id, script_id, command } = body;

        if (!engagement_id || !command) {
          sendJSON(res, 400, { error: 'Missing required fields' });
          return true;
        }

        // Verify engagement exists
        const engResult = await db.query(
          `SELECT * FROM pentest_engagements WHERE id = $1`,
          [engagement_id]
        );

        if (engResult.rows.length === 0) {
          sendJSON(res, 404, { error: 'Engagement not found' });
          return true;
        }

        // Create audit log entry
        const sessionId = `pa_exec_${Date.now()}`;
        await db.query(`
          INSERT INTO agent_audit_log (
            session_id, engagement_id, agent_name, task, status, started_at
          ) VALUES ($1, $2, $3, $4, $5, NOW())
        `, [sessionId, engagement_id, 'pa_engineer', command, 'running']);

        // Return immediately with session_id
        sendJSON(res, 200, {
          session_id: sessionId,
          message: 'Execution started in background. Check audit log for results.'
        });

        // Execute command in background (after response sent). Honor engagement's
        // executor_host (dir_1780756261315) — bridge-local for tablet-mediated
        // engagements, ssh dev-01 otherwise. Pipe via stdin in both branches.
        // dev-01 REMOVED from the offense pipeline (King Kazuma 2026-06-23). Always run LOCAL on the
        // bridge: it's host-networked and routes the lab /24 via wg0 → tablet → EDIFICIO, so the
        // engagement's executor_host names the RELAY into the lab, not an ssh target. The bridge
        // holds the toolkit; the tablet is the doorway; dev-01 is unplugged from this job.
        //
        // Anti-cloud pre-flight: never let a command actively target cloud infra (the GCP metadata
        // IP or an *.internal host), so a mis-scoped scan can't hit GCP/dev-01 instead of the lab.
        const CLOUD_TARGET = /169\.254\.169\.254|metadata\.google|metadata\.goog|\b[a-z0-9-]+\.internal\b/i;
        if (CLOUD_TARGET.test(String(command))) {
          await db.query(
            `UPDATE agent_audit_log SET status='failed', completed_at=NOW(), output=$1 WHERE session_id=$2`,
            ["BLOCKED by anti-cloud pre-flight: this command targets cloud infrastructure (metadata IP / *.internal). The lab is 192.168.1.0/24 reached via the tablet relay — not the cloud. Re-scope the target to the lab subnet.", sessionId],
          ).catch((e) => console.error(`[soc/execute] anti-cloud log fail ${sessionId}:`, e.message));
          return true;
        }
        const execEng = engResult.rows[0];
        const execMeta = typeof execEng.metadata === 'string' ? JSON.parse(execEng.metadata) : (execEng.metadata || {});
        const execProxy = (execMeta.proxy_mode === 'socks5' && execEng.executor_host) ? execEng.executor_host : null;
        let execCmd = String(command);
        if (execProxy) {
          const fs = require('fs');
          const confPath = `/tmp/ozzu-bridge/proxychains-${engagement_id}.conf`;
          const proxyPort = execMeta.proxy_port || 1080;
          const template = fs.readFileSync('/app/proxychains-iphone.conf', 'utf8');
          fs.mkdirSync('/tmp/ozzu-bridge', { recursive: true });
          fs.writeFileSync(confPath, template.replace('IPHONE_WG_IP', execProxy).replace('1080', String(proxyPort)));
          execCmd = `proxychains4 -q -f ${confPath} bash -s <<'PROXYCMD'\n${execCmd}\nPROXYCMD`;
        }
        const proc = spawn('bash', ['-s'], { detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.write(execCmd);
        proc.stdin.end();

        let fullOutput = '';

        proc.stdout.on('data', (data) => {
          fullOutput += data.toString();
        });

        proc.stderr.on('data', (data) => {
          fullOutput += data.toString();
        });

        proc.on('close', async (code) => {
          // Update audit log when execution completes
          try {
            await db.query(`
              UPDATE agent_audit_log
              SET status = $1, completed_at = NOW(), output = $2
              WHERE session_id = $3
            `, [code === 0 ? 'completed' : 'failed', fullOutput, sessionId]);
          } catch (err) {
            console.error(`Failed to update audit log for ${sessionId}:`, err);
          }
          // Raw blob is now safely in the audit log; parse it into structured
          // recon_hosts so Cipher analyzes rows, not the raw dump (dir_1780530175588).
          await parseAndStoreRecon(db, engagement_id, sessionId, fullOutput);
        });

        proc.on('error', async (err) => {
          try {
            await db.query(`
              UPDATE agent_audit_log
              SET status = 'failed', completed_at = NOW(), output = $1
              WHERE session_id = $2
            `, [`Process error: ${err.message}`, sessionId]);
          } catch (dbErr) {
            console.error(`Failed to log process error for ${sessionId}:`, dbErr);
          }
        });

        return true;
      } catch (error) {
        console.error('[soc/execute] Error:', error);
        // Only send error if headers not sent yet
        if (!res.headersSent) {
          sendJSON(res, 500, { error: 'Internal server error', details: error.message });
        }
        return true;
      }
    }

    // POST /soc/submit-results - Submit execution results
    // NOTE: This ONLY stores results. PA engineer manually notifies Cipher in active session.
    // DO NOT auto-trigger Cipher analysis - would lose conversation context.
    if (req.method === "POST" && pathname === "/soc/submit-results") {
      if (!requireAuth(req, res)) return true; // D2
      const body = await parseBody(req);
      const { engagement_id, session_id, findings } = body;

      if (!engagement_id || !findings) {
        sendJSON(res, 400, { error: 'Missing required fields' });
        return true;
      }

      // Parse findings and create records.
      // FIX 2 (dir_1782255739233): run the shared synchronous pre-insert gate so this
      // path cannot bypass verification. Only the stateless exposure-with-403
      // check is applied here (no active probe — that needs a DB id). A clean
      // human-authored finding with no self-contradicting evidence passes through
      // unchanged (gate returns verdict:'skip').
      // MINOR 1: applyPreInsertGate emits telemetry on BOTH a floor (VERIFY_GATE_FAIL)
      // and a gate-internal throw (gate_failed_open); the catch below covers the one
      // case the gate cannot self-report — its own module failing to load — by
      // emitting a gate_failed_open row so a broken gate is still countable.
      let _gate = null;
      try { _gate = require('/app/soc/claim-verifier').applyPreInsertGate; } catch (_) {}
      if (!_gate) {
        try {
          await db.query(
            `INSERT INTO offense_telemetry
               (engagement_id, queue_item_id, model_used, intent_category,
                n_hosts, n_findings, step_queued, in_scope, n_references,
                latency_ms, outcome, outcome_notes)
             VALUES ($1, NULL, 'claim-verifier', 'manual_gate',
                     0, $2, false, true, 0, 0, 'gate_failed_open', $3)`,
            [engagement_id, Array.isArray(findings) ? findings.length : 1,
             'source=submit_results; claim-verifier module failed to load; findings inserted at claimed severity']);
        } catch (_) { /* telemetry never blocks manual submission */ }
      }
      const createdFindings = [];
      for (const finding of findings) {
        let insertSeverity = finding.severity || 'info';
        let insertKind     = 'confirmed';
        if (_gate) {
          try {
            const gated = await _gate(finding, { db, engagementId: engagement_id, source: 'submit_results' });
            insertSeverity = gated.severity;
            insertKind     = gated.kind;
          } catch (_) { /* applyPreInsertGate self-reports throws; never fatal for manual submissions */ }
        }
        const result = await db.query(`
          INSERT INTO pentest_findings (
            engagement_id, severity, title, description, cvss_score, cvss_vector,
            affected_asset, affected_assets, refs, mitre_attack, reproduction, remediation, evidence_files, discovered_by, kind
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING id
        `, [
          engagement_id,
          insertSeverity,
          finding.title,
          finding.description,
          finding.cvss_score || null,
          finding.cvss_vector || null,
          finding.affected_asset || null,
          JSON.stringify(finding.affected_assets || []),
          JSON.stringify(finding.refs || []),
          JSON.stringify(finding.mitre_attack || []),
          JSON.stringify(finding.reproduction || {}),
          finding.remediation || null,
          JSON.stringify(finding.evidence_files || []),
          'pa_engineer',
          insertKind,
        ]);

        const findingId = result.rows[0].id;
        createdFindings.push(findingId);
        broadcast({
          type: 'socFindingAdded',
          engagement_id,
          finding_id: findingId,
          severity: insertSeverity,
          title: finding.title,
          ts: Date.now(),
        });
      }

      sendJSON(res, 200, {
        success: true,
        findings_created: createdFindings.length,
        message: 'Results stored. Notify Cipher manually in active session for analysis.'
      });
      return true;
    }

    // GET /soc/engagements/:id/queue - Get queued steps for engagement
    if (req.method === "GET" && pathname.match(/^\/soc\/engagements\/[^\/]+\/queue$/)) {
      const id = pathname.split("/")[3];
      const result = await db.query(
        `SELECT id, engagement_id, seq, title, description, command, expected_artifact,
                status, session_id, output, created_at, started_at, completed_at,
                intent_class, auto_executed
         FROM soc_queue_items
         WHERE engagement_id = $1
         ORDER BY seq ASC`,
        [id]
      );
      sendJSON(res, 200, { queue: result.rows });
      return true;
    }

    // POST /soc/engagements/:id/queue - Replace pending queue items (Cipher pushes a new queue)
    // Body: { items: [{title, description, command, expected_artifact}], replace_pending?: bool (default true) }
    // done/failed/running items are preserved; pending items are replaced unless replace_pending=false.
    if (req.method === "POST" && pathname.match(/^\/soc\/engagements\/[^\/]+\/queue$/)) {
      if (!requireAuth(req, res)) return true; // D2
      try {
        const id = pathname.split("/")[3];
        const body = await parseBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        const replacePending = body.replace_pending !== false;

        const engResult = await db.query(`SELECT 1 FROM pentest_engagements WHERE id = $1`, [id]);
        if (engResult.rows.length === 0) {
          sendJSON(res, 404, { error: 'Engagement not found' });
          return true;
        }

        if (replacePending) {
          await db.query(`DELETE FROM soc_queue_items WHERE engagement_id = $1 AND status = 'pending'`, [id]);
        }

        const maxSeqRes = await db.query(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM soc_queue_items WHERE engagement_id = $1`,
          [id]
        );
        let seq = parseInt(maxSeqRes.rows[0].max_seq, 10) || 0;

        const inserted = [];
        for (const item of items) {
          if (!item || !item.title || !item.command) continue;
          seq += 1;
          const r = await db.query(
            `INSERT INTO soc_queue_items (engagement_id, seq, title, description, command, expected_artifact, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id, seq`,
            [id, seq, item.title, item.description || null, item.command, item.expected_artifact || null]
          );
          inserted.push(r.rows[0]);
          broadcast({
            type: 'socQueueChanged',
            engagement_id: id,
            item_id: r.rows[0].id,
            change: 'added',
            status: 'pending',
            seq: r.rows[0].seq,
            title: item.title,
            ts: Date.now(),
          });
        }

        sendJSON(res, 200, { inserted, total_pending: inserted.length });

        try {
          const ae = require("../soc/autonomous-executor");
          for (const ins of inserted) {
            ae.maybeAutoExecute(ins.id).catch(e =>
              console.error(`[soc queue POST] maybeAutoExecute(${ins.id}) error:`, e.message));
          }
        } catch (e) {
          console.error(`[soc queue POST] autonomous-executor import error:`, e.message);
        }
        return true;
      } catch (error) {
        console.error('[soc queue POST] Error:', error);
        if (!res.headersSent) sendJSON(res, 500, { error: 'Internal server error', details: error.message });
        return true;
      }
    }

    // POST /soc/queue/:itemId/run - Execute a queued item on dev-01 (background, same pattern as /soc/execute)
    if (req.method === "POST" && pathname.match(/^\/soc\/queue\/\d+\/run$/)) {
      if (!requireAuth(req, res)) return true; // D2: runs queued command on dev-01 over ssh
      try {
        const itemId = parseInt(pathname.split("/")[3], 10);
        const itemRes = await db.query(
          `SELECT q.*, e.executor_host, e.metadata AS eng_metadata
             FROM soc_queue_items q
             JOIN pentest_engagements e ON q.engagement_id = e.id
            WHERE q.id = $1`,
          [itemId]
        );
        if (itemRes.rows.length === 0) {
          sendJSON(res, 404, { error: 'Queue item not found' });
          return true;
        }
        const item = itemRes.rows[0];
        if (item.status === 'running') {
          sendJSON(res, 409, { error: 'Item already running' });
          return true;
        }

        const sessionId = `pa_queue_${item.id}_${Date.now()}`;
        const timeoutSec = Number.isInteger(item.timeout_seconds) && item.timeout_seconds > 0
          ? item.timeout_seconds
          : 300;

        // dir_1782246387821: Strip output/completed_at from this SET clause.
        // The membrane trigger fires on UPDATE OF command,output — including
        // output=NULL here caused it to run check_cipher_exploit_write() and
        // raise P0001 for any queue item whose command contains exploit patterns
        // (default creds, curl -u ...). Items arriving here always have
        // status='pending' (enforced above), so output and completed_at are
        // already NULL from insertion — clearing them here is a no-op anyway.
        await db.query(
          `UPDATE soc_queue_items SET status = 'running', session_id = $1, started_at = NOW(), pid = NULL WHERE id = $2`,
          [sessionId, item.id]
        );
        await db.query(
          `INSERT INTO agent_audit_log (session_id, engagement_id, agent_name, task, status, started_at)
           VALUES ($1, $2, $3, $4, 'running', NOW())`,
          [sessionId, item.engagement_id, 'pa_engineer', `[queue #${item.seq}] ${item.title}\n${item.command}`]
        );
        broadcast({
          type: 'socQueueChanged',
          engagement_id: item.engagement_id,
          item_id: item.id,
          change: 'status',
          status: 'running',
          session_id: sessionId,
          ts: Date.now(),
        });

        sendJSON(res, 200, { session_id: sessionId, queue_item_id: item.id, timeout_seconds: timeoutSec });

        // Executor selection (dir_1780756261315): bridge-local for tablet-mediated
        // engagements (executor_host != 'dev-01'), ssh dev-01 otherwise. Bridge has
        // adb in PATH and direct WG reach to tablet adb-target, so adb-wrapped
        // commands run locally without the dev-01 hop poisoning v1.4 training data.
        // Pipe script via stdin (`bash -s`) in both branches — see
        // .claude/rules/soc-command-execution.md for why inlining breaks $VAR.
        // detached:true → own process group, killable with process.kill(-pid).
        const execHost = item.executor_host || null; // dev-01 removed from offense pipeline (2026-06-23) — always local below

        // HTTP executor agent path (dir_1781019523885) — when EXEC_AGENT_URL is set
        // and target is dev-01, route through dev-01:8888 instead of SSH. Removes
        // per-command sshd handshake cost; enables 30+ concurrent runs.
        // No incremental streaming (acceptable for autonomous Sprint 2b runs);
        // operator-driven engagements without the env var still use SSH below.
        if (execHost === 'dev-01' && process.env.EXEC_AGENT_URL) {
          (async () => {
            const t0 = Date.now();
            let httpResp;
            try {
              httpResp = await fetch(`${process.env.EXEC_AGENT_URL}/exec`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${process.env.EXEC_AGENT_TOKEN || ''}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  command: String(item.command),
                  timeout_seconds: timeoutSec,
                  engagement_id: item.engagement_id,
                }),
                // node fetch has its own keep-alive pool; no per-request socket setup
              });
            } catch (e) {
              const errMsg = `[exec-agent network error: ${e.message}]`;
              try {
                await db.query(
                  `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2 AND status='running'`,
                  [errMsg, item.id]
                );
                await db.query(
                  `UPDATE agent_audit_log SET status='failed', completed_at=NOW(), output=$1 WHERE session_id=$2 AND status='running'`,
                  [errMsg, sessionId]
                );
                await syncOffenseOutcome(item.id, 'failed');
              } catch (_) { /* swallow */ }
              broadcast({ type: 'socStepDone', engagement_id: item.engagement_id, item_id: item.id, session_id: sessionId, status: 'failed', timed_out: false, ts: Date.now() });
              return;
            }
            let result;
            try { result = await httpResp.json(); }
            catch (e) {
              result = { exit_code: -1, stdout: '', stderr: `[exec-agent invalid JSON: ${e.message}]`, timed_out: false };
            }
            const fullOutput = (result.stdout || '') + (result.stderr ? `\n[stderr]\n${result.stderr}` : '');
            // dir_1782329692909: step status = "did the process run?" not "did a regex
            // parser like the output?" The model reads its own output and decides success.
            // Only genuine timeouts are 'failed'; everything else is 'done' (ran to completion).
            const finalStatus = result.timed_out ? 'failed' : 'done';
            const appendMsg = result.timed_out ? `\n\n[TIMEOUT after ${timeoutSec}s — exec-agent killed]` : '';
            const safeOutput = sanitizeOutput(fullOutput + appendMsg);
            try {
              await db.query(
                `UPDATE soc_queue_items SET status=$1, output=$2, completed_at=NOW() WHERE id=$3 AND status='running'`,
                [finalStatus, safeOutput, item.id]
              );
              await db.query(
                `UPDATE agent_audit_log SET status=$1, completed_at=NOW(), output=$2 WHERE session_id=$3 AND status='running'`,
                [finalStatus === 'done' ? 'completed' : 'failed', safeOutput, sessionId]
              );
              await syncOffenseOutcome(item.id, finalStatus === 'done' ? 'success' : 'failed');
            } catch (err) {
              console.error(`[soc queue run http] DB write failed for item ${item.id}:`, err.message);
            }
            broadcast({
              type: 'socStepDone',
              engagement_id: item.engagement_id,
              item_id: item.id,
              session_id: sessionId,
              status: finalStatus,
              timed_out: !!result.timed_out,
              ts: Date.now(),
              latency_ms: Date.now() - t0,
              transport: 'http',
            });
          })();
          return true; // HTTP path handled — skip the SSH spawn block below.
        }

        // Anti-cloud pre-flight (2026-06-23): never run a command that actively targets cloud infra
        // (the GCP metadata IP or an *.internal host) — the lab is 192.168.1.0/24 via the tablet
        // relay, so a mis-scoped scan must never hit GCP/dev-01 instead.
        const CLOUD_TARGET = /169\.254\.169\.254|metadata\.google|metadata\.goog|\b[a-z0-9-]+\.internal\b/i;
        if (CLOUD_TARGET.test(String(item.command))) {
          const blk = "BLOCKED by anti-cloud pre-flight: command targets cloud infrastructure (metadata IP / *.internal). The lab is 192.168.1.0/24 via the tablet relay — re-scope to the lab subnet.";
          try {
            await db.query(`UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2 AND status='running'`, [blk, item.id]);
            await db.query(`UPDATE agent_audit_log SET status='failed', completed_at=NOW(), output=$1 WHERE session_id=$2 AND status='running'`, [blk, sessionId]);
            await syncOffenseOutcome(item.id, 'failed').catch(() => {});
          } catch (_) { /* swallow */ }
          broadcast({ type: 'socStepDone', engagement_id: item.engagement_id, item_id: item.id, session_id: sessionId, status: 'failed', timed_out: false, ts: Date.now() });
          return true;
        }
        // dev-01 REMOVED from the offense pipeline (King Kazuma 2026-06-23). Always run LOCAL on the
        // bridge — it's host-networked and routes the lab /24 via wg0 → tablet → EDIFICIO, so the
        // engagement's executor_host names the relay/doorway, not an ssh target. Bridge holds the
        // toolkit; tablet is the doorway. detached:true → own process group (killable via -pid).
        //
        // iPhone SOCKS5 relay (dir_1782498638510): when the engagement's metadata.proxy_mode is
        // 'socks5', route TCP traffic through the iPhone's SOCKS5 relay via proxychains4. The
        // iPhone runs a NWListener SOCKS5 server on its WG IP. Commands are wrapped:
        //   proxychains4 -f <config> bash -s <<< command
        // This covers TCP connect scans, HTTP tools, and most exploitation — but NOT raw SYN
        // scans or UDP. The engagement scope should note this limitation.
        const engMeta = typeof item.eng_metadata === 'string' ? JSON.parse(item.eng_metadata) : (item.eng_metadata || {});
        const proxyMode = (engMeta.proxy_mode === 'socks5' && execHost) ? execHost : null;
        let cmdToRun = String(item.command);
        const env = { ...process.env };
        if (proxyMode) {
          const fs = require('fs');
          const confPath = `/tmp/ozzu-bridge/proxychains-${item.engagement_id}.conf`;
          const proxyPort = engMeta.proxy_port || 1080;
          const template = fs.readFileSync('/app/proxychains-iphone.conf', 'utf8');
          fs.mkdirSync('/tmp/ozzu-bridge', { recursive: true });
          fs.writeFileSync(confPath, template.replace('IPHONE_WG_IP', proxyMode).replace('1080', String(proxyPort)));
          cmdToRun = `proxychains4 -q -f ${confPath} bash -s <<'PROXYCMD'\n${cmdToRun}\nPROXYCMD`;
        }
        const proc = spawn('bash', ['-s'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env });
        proc.stdin.write(cmdToRun);
        proc.stdin.end();
        let fullOutput = '';
        const entry = { proc, itemId: item.id, timeoutHandle: null, timedOut: false, flushTimer: null };
        runningProcs.set(sessionId, entry);

        entry.timeoutHandle = setTimeout(() => {
          entry.timedOut = true;
          try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {}
        }, timeoutSec * 1000);

        try {
          await db.query(`UPDATE soc_queue_items SET pid = $1 WHERE id = $2`, [proc.pid, item.id]);
        } catch (_) { /* non-fatal */ }

        // Incremental output streaming to DB: the frontend polls the queue every 2s and
        // displays running output in the hero card. Without this, output column stays NULL
        // until proc.on('close') fires, and the user sees a spinner with no feedback for
        // anything that runs more than a few seconds. Debounced at 500ms so we don't
        // hammer the DB on chatty scripts (nmap can emit thousands of lines/sec).
        const scheduleFlush = () => {
          if (entry.flushTimer) return;
          entry.flushTimer = setTimeout(async () => {
            entry.flushTimer = null;
            if (!runningProcs.has(sessionId)) return; // proc closed — final write owns it
            try {
              await db.query(
                `UPDATE soc_queue_items SET output = $1 WHERE id = $2 AND status = 'running'`,
                [sanitizeOutput(fullOutput), item.id]
              );
            } catch (err) {
              console.error(`[soc queue run] incremental flush failed for item ${item.id}:`, err.message);
            }
            // 500ms throttle on the DB write naturally throttles the broadcast too,
            // and a client that misses one tick recovers on the next chunk or the
            // terminal `socStepDone` event. We send the full buffer (not a delta)
            // so handlers can do `setOutput(msg.output)` without splice logic.
            broadcast({
              type: 'socExecOutput',
              engagement_id: item.engagement_id,
              item_id: item.id,
              session_id: sessionId,
              output: fullOutput,
              ts: Date.now(),
            });
          }, 500);
        };

        proc.stdout.on('data', (d) => { fullOutput += d.toString(); scheduleFlush(); });
        proc.stderr.on('data', (d) => { fullOutput += d.toString(); scheduleFlush(); });
        proc.on('close', async (code) => {
          if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
          clearTimeout(entry.timeoutHandle);
          runningProcs.delete(sessionId);
          const timedOut = entry.timedOut;
          // dir_1782329692909: step status = "did the process run?" not "did the exit code
          // or a regex parser say it succeeded?" The model reads its own output and decides.
          // Only genuine timeouts are 'failed'; any completed process is 'done'.
          const finalStatus = timedOut ? 'failed' : 'done';
          const appendMsg = timedOut ? `\n\n[TIMEOUT after ${timeoutSec}s — process killed]` : '';
          const rawLen = fullOutput.length;
          const safeOutput = sanitizeOutput(fullOutput + appendMsg);
          let broadcastStatus = finalStatus;
          try {
            // Conditional update — if /cancel already wrote 'failed', don't overwrite.
            await db.query(
              `UPDATE soc_queue_items SET status = $1, output = $2, completed_at = NOW() WHERE id = $3 AND status = 'running'`,
              [finalStatus, safeOutput, item.id]
            );
            await db.query(
              `UPDATE agent_audit_log SET status = $1, completed_at = NOW(), output = $2 WHERE session_id = $3 AND status = 'running'`,
              [finalStatus === 'done' ? 'completed' : 'failed', safeOutput, sessionId]
            );
            await syncOffenseOutcome(item.id, finalStatus === 'done' ? 'success' : 'failed');
          } catch (err) {
            console.error(`[soc queue run] DB update failed for item ${item.id}:`, err);
            // Fallback: row MUST leave 'running'. Write a diagnostic-only payload
            // so we never wedge the queue on UTF-8 / size / constraint errors.
            const diag = `[DB write failed: ${err && err.code ? err.code : 'unknown'} — ${err && err.message ? err.message : String(err)}]\n[raw output was ${rawLen} bytes; dropped to unblock queue]`;
            try {
              await db.query(
                `UPDATE soc_queue_items SET status = 'failed', output = $1, completed_at = NOW() WHERE id = $2 AND status = 'running'`,
                [diag, item.id]
              );
              await db.query(
                `UPDATE agent_audit_log SET status = 'failed', completed_at = NOW(), output = $1 WHERE session_id = $2 AND status = 'running'`,
                [diag, sessionId]
              );
              await syncOffenseOutcome(item.id, 'failed');
              broadcastStatus = 'failed';
            } catch (fallbackErr) {
              console.error(`[soc queue run] Fallback UPDATE also failed for item ${item.id}:`, fallbackErr);
            }
          }
          broadcast({
            type: 'socStepDone',
            engagement_id: item.engagement_id,
            item_id: item.id,
            session_id: sessionId,
            status: broadcastStatus,
            timed_out: timedOut,
            ts: Date.now(),
          });
          // dir_1780845861190: post_queue_complete hooks fire here. Advisory —
          // hook return value is logged but doesn't change the queue status.
          try {
            const hooks = require('../soc/hooks');
            await hooks.runEvent({
              engagementId: item.engagement_id,
              event: hooks.HOOK_EVENTS.POST_QUEUE_COMPLETE,
              payload: {
                queue_item_id: item.id,
                session_id: sessionId,
                final_status: finalStatus,
                exit_code: code,
                timed_out: timedOut,
                output_bytes: safeOutput.length,
                output_preview: safeOutput.slice(0, 800),
                command_preview: (item.command || '').slice(0, 400),
                intent_class: item.intent_class || null,
              },
            });
          } catch (hookErr) {
            console.error(`[soc queue run] post_queue_complete hook error for item ${item.id}:`, hookErr.message);
          }
          // Parse recon output into structured rows (dir_1780530175588). Raw blob
          // already persisted above; additive and fully error-isolated so it can
          // never wedge the queue item's state machine.
          await parseAndStoreRecon(db, item.engagement_id, sessionId, fullOutput);
        });
        proc.on('error', async (err) => {
          clearTimeout(entry.timeoutHandle);
          runningProcs.delete(sessionId);
          const errMsg = sanitizeOutput(`Process error: ${err.message}`);
          try {
            await db.query(
              `UPDATE soc_queue_items SET status = 'failed', output = $1, completed_at = NOW() WHERE id = $2 AND status = 'running'`,
              [errMsg, item.id]
            );
            await db.query(
              `UPDATE agent_audit_log SET status = 'failed', completed_at = NOW(), output = $1 WHERE session_id = $2 AND status = 'running'`,
              [errMsg, sessionId]
            );
            await syncOffenseOutcome(item.id, 'failed');
          } catch (dbErr) {
            console.error(`[soc queue run] Error logging failure for item ${item.id}:`, dbErr);
            // Last-ditch: ensure row leaves 'running' with a minimal diagnostic.
            try {
              await db.query(
                `UPDATE soc_queue_items SET status = 'failed', output = $1, completed_at = NOW() WHERE id = $2 AND status = 'running'`,
                [`[process error + DB write failed: ${dbErr && dbErr.code ? dbErr.code : 'unknown'}]`, item.id]
              );
            } catch (_) { /* give up */ }
          }
          broadcast({
            type: 'socStepDone',
            engagement_id: item.engagement_id,
            item_id: item.id,
            session_id: sessionId,
            status: 'failed',
            error: err && err.message,
            ts: Date.now(),
          });
        });

        return true;
      } catch (error) {
        console.error('[soc queue run] Error:', error);
        // dir_1782246387821: CIPHER_EXPLOIT_WRITE_BLOCKED (P0001) means the DB
        // membrane trigger rejected a write. Return 403 with a clear reason
        // (not a generic 500) and mark the item failed so it doesn't stay pending.
        if (error && error.code === 'P0001' && String(error.message).includes('CIPHER_EXPLOIT_WRITE_BLOCKED')) {
          const diagMsg = `[MEMBRANE_BLOCKED — dir_1782246387821]\nDB trigger check_cipher_exploit_write() rejected this step: ${error.message}\nThis is a structural safeguard — Cipher cannot author exploit content. The offense engine should queue steps via withBypass.`;
          try {
            const { itemId: bid } = (() => {
              try { return { itemId: parseInt(pathname.split("/")[3], 10) }; } catch (_) { return { itemId: null }; }
            })();
            if (bid) {
              await db.query(
                `UPDATE soc_queue_items SET status='failed', output=$1, completed_at=NOW() WHERE id=$2 AND status IN ('pending','running')`,
                [diagMsg, bid]);
            }
          } catch (_) { /* best-effort — don't let cleanup throw propagate */ }
          if (!res.headersSent) sendJSON(res, 403, { error: 'Membrane blocked: exploit-write guard triggered', details: error.message });
          return true;
        }
        if (!res.headersSent) sendJSON(res, 500, { error: 'Internal server error', details: error.message });
        return true;
      }
    }

    // POST /soc/queue/:itemId/cancel - Kill a running queue item
    if (req.method === "POST" && pathname.match(/^\/soc\/queue\/\d+\/cancel$/)) {
      if (!requireAuth(req, res)) return true; // D2
      try {
        const itemId = parseInt(pathname.split("/")[3], 10);
        const itemRes = await db.query(
          `SELECT id, engagement_id, session_id, status, output FROM soc_queue_items WHERE id = $1`,
          [itemId]
        );
        if (itemRes.rows.length === 0) {
          sendJSON(res, 404, { error: 'Queue item not found' });
          return true;
        }
        const row = itemRes.rows[0];
        if (row.status !== 'running') {
          sendJSON(res, 409, { error: `Item is ${row.status}, not running` });
          return true;
        }

        const entry = runningProcs.get(row.session_id);
        const cancelMsg = '\n\n[CANCELLED by user]';
        // Mark DB 'failed' FIRST so the 'close' handler (which uses WHERE status='running')
        // won't overwrite our cancellation message with a natural-exit result.
        await db.query(
          `UPDATE soc_queue_items SET status = 'failed', output = COALESCE(output, '') || $1, completed_at = NOW() WHERE id = $2`,
          [cancelMsg, itemId]
        );
        await db.query(
          `UPDATE agent_audit_log SET status = 'failed', completed_at = NOW(), output = COALESCE(output, '') || $1 WHERE session_id = $2`,
          [cancelMsg, row.session_id]
        );
        await syncOffenseOutcome(itemId, 'cancelled');
        broadcast({
          type: 'socStepDone',
          engagement_id: row.engagement_id,
          item_id: itemId,
          session_id: row.session_id,
          status: 'cancelled',
          ts: Date.now(),
        });

        if (entry) {
          clearTimeout(entry.timeoutHandle);
          try { process.kill(-entry.proc.pid, 'SIGKILL'); } catch (_) {}
          runningProcs.delete(row.session_id);
          sendJSON(res, 200, { success: true, id: itemId, killed: true });
        } else {
          // Stale 'running' state with no tracked process (e.g. bridge restarted).
          sendJSON(res, 200, { success: true, id: itemId, killed: false, reason: 'no tracked process; state cleared' });
        }
        return true;
      } catch (error) {
        console.error('[soc queue cancel] Error:', error);
        if (!res.headersSent) sendJSON(res, 500, { error: 'Internal server error', details: error.message });
        return true;
      }
    }

    // POST /soc/queue/:itemId/skip - Mark queued item as skipped
    if (req.method === "POST" && pathname.match(/^\/soc\/queue\/\d+\/skip$/)) {
      if (!requireAuth(req, res)) return true; // D2
      const itemId = parseInt(pathname.split("/")[3], 10);
      const r = await db.query(
        `UPDATE soc_queue_items SET status = 'skipped', completed_at = NOW()
         WHERE id = $1 AND status = 'pending' RETURNING id, engagement_id`,
        [itemId]
      );
      if (r.rows.length === 0) {
        sendJSON(res, 404, { error: 'Queue item not found or not pending' });
        return true;
      }
      broadcast({
        type: 'socStepDone',
        engagement_id: r.rows[0].engagement_id,
        item_id: r.rows[0].id,
        status: 'skipped',
        ts: Date.now(),
      });
      sendJSON(res, 200, { success: true, id: r.rows[0].id });
      return true;
    }

    // GET /soc/engagements/:id/findings - flat list of all findings for an engagement.
    // dir_1780764341980 — fed to the new FindingsTab + Now-tab recent-findings list.
    // Existing engagement-detail endpoint returns these grouped by severity which is
    // awkward to flatten; this endpoint is the canonical source for the redesigned UI.
    if (req.method === "GET" && pathname.match(/^\/soc\/engagements\/[^\/]+\/findings$/)) {
      const engagementId = pathname.split("/")[3];
      const result = await db.query(
        `SELECT id, severity, title, description, cvss_score, cvss_vector,
                affected_asset, affected_assets, refs, mitre_attack,
                reproduction, remediation, evidence_files, discovered_by, discovered_at
           FROM pentest_findings
          WHERE engagement_id = $1
          ORDER BY
            CASE severity
              WHEN 'critical' THEN 1
              WHEN 'high' THEN 2
              WHEN 'medium' THEN 3
              WHEN 'low' THEN 4
              WHEN 'info' THEN 5
              ELSE 6
            END,
            discovered_at DESC`,
        [engagementId]
      );
      sendJSON(res, 200, { findings: result.rows });
      return true;
    }

    // GET /soc/engagements/:id/observations — pending + answered observations for an engagement
    if (req.method === "GET" && pathname.match(/^\/soc\/engagements\/[^\/]+\/observations$/)) {
      const engagementId = pathname.split("/")[3];
      const result = await db.query(
        `SELECT id, question, context, response, status, created_at, responded_at
           FROM engagement_observations WHERE engagement_id = $1 ORDER BY created_at`, [engagementId]);
      sendJSON(res, 200, { observations: result.rows });
      return true;
    }

    // POST /soc/engagements/:id/observations/:obsId/respond — operator answers an observation
    if (req.method === "POST" && pathname.match(/^\/soc\/engagements\/[^\/]+\/observations\/\d+\/respond$/)) {
      const parts = pathname.split("/");
      const obsId = parts[5];
      const body = await parseBody(req);
      if (!body.response) { sendJSON(res, 400, { error: "response required" }); return true; }
      await db.query(
        `UPDATE engagement_observations SET response = $1, status = 'answered', responded_at = NOW() WHERE id = $2`,
        [body.response, obsId]);
      sendJSON(res, 200, { ok: true });
      return true;
    }

    // GET /soc/audit-log/:engagement_id - Get execution history
    if (req.method === "GET" && pathname.match(/^\/soc\/audit-log\/[^\/]+$/)) {
      const engagementId = pathname.split("/")[3];

      const result = await db.query(`
        SELECT
          session_id,
          agent_name,
          task,
          status,
          started_at,
          completed_at,
          output
        FROM agent_audit_log
        WHERE engagement_id = $1
        ORDER BY started_at DESC
        LIMIT 20
      `, [engagementId]);

      sendJSON(res, 200, { executions: result.rows });
      return true;
    }

    // GET /soc/:id/recon - Structured recon hosts parsed server-side from scan output.
    // This is the app/evidence view and DOES include raw_excerpt. Cipher instead uses
    // the get_recon MCP tool (which omits raw_excerpt) so raw scan dumps never enter chat.
    if (req.method === "GET" && pathname.match(/^\/soc\/[^\/]+\/recon$/)) {
      const engagementId = pathname.split("/")[2];
      const result = await db.query(
        `SELECT ip, mac, vendor, hostname, status, ports, raw_excerpt, session_id, discovered_at
         FROM recon_hosts
         WHERE engagement_id = $1
         ORDER BY ip`,
        [engagementId]
      );
      sendJSON(res, 200, { engagement_id: engagementId, hosts: result.rows, total: result.rows.length });
      return true;
    }

    // ──────────────────────────────────────────────
    // Call Investigation API
    // ──────────────────────────────────────────────

    // POST /soc/calls — bulk import call log entries
    if (req.method === "POST" && pathname === "/soc/calls") {
      const { calls } = body; // [{phone_number, direction?, call_time?, duration_sec?, answered?, label?}]
      if (!Array.isArray(calls) || !calls.length) {
        sendJSON(res, 400, { error: "calls array required" });
        return true;
      }
      let imported = 0;
      const newNumbers = new Set();
      for (const c of calls) {
        if (!c.phone_number) continue;
        const num = c.phone_number.replace(/[^\d+]/g, '');
        if (!num) continue;
        try {
          await db.query(
            `INSERT INTO call_log (phone_number, direction, call_time, duration_sec, answered, label)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (phone_number, call_time) DO NOTHING`,
            [num, c.direction || 'incoming', c.call_time || new Date(), c.duration_sec || null, c.answered || false, c.label || null]
          );
          imported++;
          const exists = await db.query('SELECT 1 FROM call_osint WHERE phone_number=$1', [num]);
          if (!exists.rows.length) newNumbers.add(num);
        } catch (err) {
          console.error('[call-log] insert error:', err.message);
        }
      }
      // kick off async OSINT for new numbers
      if (newNumbers.size > 0) {
        runCallOsint(db, [...newNumbers]).catch(err =>
          console.error('[call-osint] batch error:', err.message)
        );
      }
      sendJSON(res, 200, { imported, osint_queued: newNumbers.size });
      return true;
    }

    // POST /soc/calls/incoming — GSM gateway live call notification + VoIP push
    // POST /soc/calls/number — add a single number for investigation
    if (req.method === "POST" && (pathname === "/soc/calls/number" || pathname === "/soc/calls/incoming")) {
      const body = await parseBody(req);
      const num = (body.phone_number || '').replace(/[^\d+]/g, '');
      if (!num) {
        sendJSON(res, 400, { error: "phone_number required" });
        return true;
      }
      await db.query(
        `INSERT INTO call_log (phone_number, direction, call_time, label)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (phone_number, call_time) DO NOTHING`,
        [num, body.direction || 'incoming', body.label || null]
      );
      // Push incoming call to the VoIP-connected iPhone (CallKit)
      if (pathname === "/soc/calls/incoming") {
        // Hand the caller number to June, keyed by the AudioSocket UUID, so her
        // per-number rate-limit + briefing use the real caller (not "unknown").
        try { require('../june-voice').setPendingCaller(body.audiosocket_uuid, num); } catch {}
        const voipWs = global.__voipClientWs;
        if (voipWs && voipWs.readyState === 1) {
          voipWs.send(JSON.stringify({
            type: 'incoming_call',
            caller: num,
            caller_name: body.caller_name || '',
          }));
          console.log(`[voip] pushed incoming call ${num} to iPhone`);
        } else {
          console.log(`[voip] no VoIP client connected — call from ${num} not pushed`);
        }
      }
      const exists = await db.query('SELECT 1 FROM call_osint WHERE phone_number=$1', [num]);
      if (!exists.rows.length) {
        runCallOsint(db, [num]).catch(err =>
          console.error('[call-osint] single error:', err.message)
        );
      }
      sendJSON(res, 200, { ok: true, osint_queued: !exists.rows.length, voip_pushed: pathname === "/soc/calls/incoming" });
      return true;
    }

    // POST /soc/calls/briefing — June AI stores a call briefing
    if (req.method === "POST" && pathname === "/soc/calls/briefing") {
      const body = await parseBody(req);
      const { caller_name, caller_number, wants_to_reach, reason, urgency, call_uuid } = body;
      await db.query(
        `INSERT INTO call_briefings (call_uuid, caller_name, caller_number, wants_to_reach, reason, urgency)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (call_uuid) DO UPDATE SET reason = $5, urgency = $6`,
        [call_uuid, caller_name || 'Unknown', caller_number || 'Unknown', wants_to_reach || '', reason || '', urgency || 'normal']
      );
      // Push to VoIP WebSocket for app display
      if (global.__voipClientWs?.readyState === 1) {
        global.__voipClientWs.send(JSON.stringify({ type: 'call_briefing', ...body }));
      }
      sendJSON(res, 200, { ok: true });
      return true;
    }

    // POST /soc/calls/decision — app sends accept/decline for a June-screened call
    if (req.method === "POST" && pathname === "/soc/calls/decision") {
      const body = await parseBody(req);
      const { call_uuid, decision } = body;
      const june = require('../june-voice');
      const handled = june.handleCallDecision(call_uuid, decision);
      sendJSON(res, 200, { ok: handled, call_uuid, decision });
      return true;
    }

    // POST /soc/calls/transfer — June signals transfer (internal, called by june-voice.js)
    if (req.method === "POST" && pathname === "/soc/calls/transfer") {
      const body = await parseBody(req);
      // Signal Asterisk to bridge the call via AMI or channel redirect
      // For now, log — the AudioSocket session ending triggers Asterisk's next priority
      console.log(`[June] Transfer requested for call ${body.call_uuid}`);
      sendJSON(res, 200, { ok: true, status: 'transfer_initiated' });
      return true;
    }

    // POST /soc/calls/message — June saves a voicemail/message
    if (req.method === "POST" && pathname === "/soc/calls/message") {
      const body = await parseBody(req);
      const { caller_name, caller_number, message, callback_requested, call_uuid } = body;
      await db.query(
        `INSERT INTO call_messages (call_uuid, caller_name, caller_number, message, callback_requested)
         VALUES ($1, $2, $3, $4, $5)`,
        [call_uuid, caller_name || 'Unknown', caller_number || 'Unknown', message || '', callback_requested || false]
      );
      // Push to app
      if (global.__voipClientWs?.readyState === 1) {
        global.__voipClientWs.send(JSON.stringify({ type: 'voicemail', ...body }));
      }
      sendJSON(res, 200, { ok: true });
      return true;
    }

    // GET /soc/calls — list all calls with OSINT data joined
    if (req.method === "GET" && pathname === "/soc/calls") {
      const result = await db.query(`
        SELECT
          cl.phone_number,
          cl.direction,
          COUNT(*)::int AS call_count,
          MIN(cl.call_time) AS first_call,
          MAX(cl.call_time) AS last_call,
          SUM(CASE WHEN cl.answered THEN 1 ELSE 0 END)::int AS answered_count,
          co.carrier, co.line_type, co.country, co.is_voip,
          co.spam_score, co.spam_reports, co.international_format,
          co.last_scanned
        FROM call_log cl
        LEFT JOIN call_osint co ON cl.phone_number = co.phone_number
        GROUP BY cl.phone_number, cl.direction,
                 co.carrier, co.line_type, co.country, co.is_voip,
                 co.spam_score, co.spam_reports, co.international_format, co.last_scanned
        ORDER BY MAX(cl.call_time) DESC
      `);
      sendJSON(res, 200, { numbers: result.rows, total: result.rows.length });
      return true;
    }

    // GET /soc/calls/analysis — pattern analysis of all calls
    if (req.method === "GET" && pathname === "/soc/calls/analysis") {
      const totals = await db.query(`
        SELECT
          COUNT(DISTINCT phone_number)::int AS unique_numbers,
          COUNT(*)::int AS total_calls,
          COUNT(DISTINCT DATE(call_time))::int AS active_days,
          MIN(call_time) AS first_call,
          MAX(call_time) AS last_call
        FROM call_log
      `);
      const byType = await db.query(`
        SELECT
          COALESCE(co.line_type, 'unknown') AS line_type,
          co.is_voip,
          COUNT(DISTINCT cl.phone_number)::int AS number_count,
          COUNT(*)::int AS call_count
        FROM call_log cl
        LEFT JOIN call_osint co ON cl.phone_number = co.phone_number
        GROUP BY co.line_type, co.is_voip
        ORDER BY call_count DESC
      `);
      const byCountry = await db.query(`
        SELECT
          COALESCE(co.country, 'unknown') AS country,
          COUNT(DISTINCT cl.phone_number)::int AS number_count,
          COUNT(*)::int AS call_count
        FROM call_log cl
        LEFT JOIN call_osint co ON cl.phone_number = co.phone_number
        GROUP BY co.country
        ORDER BY call_count DESC
      `);
      const byHour = await db.query(`
        SELECT
          EXTRACT(HOUR FROM call_time)::int AS hour,
          COUNT(*)::int AS call_count
        FROM call_log
        GROUP BY EXTRACT(HOUR FROM call_time)
        ORDER BY hour
      `);
      const byCarrier = await db.query(`
        SELECT
          COALESCE(co.carrier, 'unknown') AS carrier,
          co.is_voip,
          COUNT(DISTINCT cl.phone_number)::int AS number_count
        FROM call_log cl
        LEFT JOIN call_osint co ON cl.phone_number = co.phone_number
        GROUP BY co.carrier, co.is_voip
        ORDER BY number_count DESC
        LIMIT 20
      `);
      const prefixClusters = await db.query(`
        SELECT
          SUBSTRING(phone_number, 1, 7) AS prefix,
          COUNT(DISTINCT phone_number)::int AS number_count,
          COUNT(*)::int AS call_count
        FROM call_log
        GROUP BY SUBSTRING(phone_number, 1, 7)
        HAVING COUNT(DISTINCT phone_number) > 1
        ORDER BY number_count DESC
        LIMIT 20
      `);
      sendJSON(res, 200, {
        summary: totals.rows[0] || {},
        by_type: byType.rows,
        by_country: byCountry.rows,
        by_hour: byHour.rows,
        by_carrier: byCarrier.rows,
        prefix_clusters: prefixClusters.rows,
      });
      return true;
    }

    // POST /soc/calls/rescan — re-run OSINT on all numbers (or specific ones)
    if (req.method === "POST" && pathname === "/soc/calls/rescan") {
      const numbers = body.numbers; // optional: specific numbers to rescan
      let targets;
      if (Array.isArray(numbers) && numbers.length) {
        targets = numbers.map(n => n.replace(/[^\d+]/g, '')).filter(Boolean);
      } else {
        const all = await db.query('SELECT DISTINCT phone_number FROM call_log');
        targets = all.rows.map(r => r.phone_number);
      }
      if (!targets.length) {
        sendJSON(res, 200, { rescanned: 0 });
        return true;
      }
      runCallOsint(db, targets).catch(err =>
        console.error('[call-osint] rescan error:', err.message)
      );
      sendJSON(res, 200, { rescanning: targets.length });
      return true;
    }

    // GET /soc/calls/:number — detailed OSINT for a single number
    if (req.method === "GET" && pathname.match(/^\/soc\/calls\/\+?[\d]+$/)) {
      const num = pathname.split("/soc/calls/")[1];
      const osint = await db.query('SELECT * FROM call_osint WHERE phone_number=$1', [num]);
      const calls = await db.query(
        'SELECT * FROM call_log WHERE phone_number=$1 ORDER BY call_time DESC LIMIT 100',
        [num]
      );
      sendJSON(res, 200, {
        phone_number: num,
        osint: osint.rows[0] || null,
        calls: calls.rows,
        call_count: calls.rows.length,
      });
      return true;
    }

    return false; // Route not handled
  };
};
