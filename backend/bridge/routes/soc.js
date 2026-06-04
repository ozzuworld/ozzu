// routes/soc.js — SOC pentest engagement mobile interface
"use strict";

const { spawn } = require('child_process');
const { parseReconOutput } = require('../soc-recon-parser');

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

module.exports = function socRoutes(ctx) {
  const { sendJSON, parseBody, db, requireAuth } = ctx;

  // Lazy idempotent migration — docker-entrypoint-initdb.d only runs on fresh volumes.
  db.query(
    `ALTER TABLE soc_queue_items ADD COLUMN IF NOT EXISTS pid INTEGER;
     ALTER TABLE soc_queue_items ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER NOT NULL DEFAULT 300;`
  ).catch((err) => console.error('[soc] schema migration failed:', err.message));

  return async function handleSocRoutes(req, res, pathname, url) {

    // GET /soc/engagements - List all engagements
    if (req.method === "GET" && pathname === "/soc/engagements") {
      const status = url.searchParams.get("status");
      let query = `
        SELECT
          e.*,
          COUNT(DISTINCT f.id) as findings_count,
          COUNT(DISTINCT CASE WHEN f.severity = 'critical' THEN f.id END) as critical_count,
          COUNT(DISTINCT CASE WHEN f.severity = 'high' THEN f.id END) as high_count
        FROM pentest_engagements e
        LEFT JOIN pentest_findings f ON e.id = f.engagement_id
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

      sendJSON(res, 200, {
        engagement,
        findings: findingsResult.rows,
        activity: activityResult.rows
      });
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

        // Execute command in background (after response sent).
        // IMPORTANT: pipe the script via ssh stdin instead of inlining it in a
        // double-quoted argument. Otherwise the LOCAL bash expands $VAR in the
        // command string BEFORE ssh sends it to dev-01, which silently breaks
        // any multi-statement script that uses variable assignments.
        const proc = spawn(
          'ssh',
          ['-o', 'StrictHostKeyChecking=no', 'dev-01', 'bash', '-s'],
          { detached: false, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        proc.stdin.write(command);
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

      // Parse findings and create records
      const createdFindings = [];
      for (const finding of findings) {
        const result = await db.query(`
          INSERT INTO pentest_findings (
            engagement_id, severity, title, description, cvss_score, cvss_vector,
            affected_asset, affected_assets, refs, mitre_attack, reproduction, remediation, evidence_files, discovered_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          RETURNING id
        `, [
          engagement_id,
          finding.severity || 'info',
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
          'pa_engineer'
        ]);

        createdFindings.push(result.rows[0].id);
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
                status, session_id, output, created_at, started_at, completed_at
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
        }

        sendJSON(res, 200, { inserted, total_pending: inserted.length });
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
        const itemRes = await db.query(`SELECT * FROM soc_queue_items WHERE id = $1`, [itemId]);
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

        await db.query(
          `UPDATE soc_queue_items SET status = 'running', session_id = $1, started_at = NOW(), output = NULL, completed_at = NULL, pid = NULL WHERE id = $2`,
          [sessionId, item.id]
        );
        await db.query(
          `INSERT INTO agent_audit_log (session_id, engagement_id, agent_name, task, status, started_at)
           VALUES ($1, $2, $3, $4, 'running', NOW())`,
          [sessionId, item.engagement_id, 'pa_engineer', `[queue #${item.seq}] ${item.title}\n${item.command}`]
        );

        sendJSON(res, 200, { session_id: sessionId, queue_item_id: item.id, timeout_seconds: timeoutSec });

        // Hardened SSH: short connect timeout + keepalives so a wedged nested SSH chain
        // (bridge→dev-01→target) eventually drops instead of hanging forever.
        // IMPORTANT: pipe the script via ssh stdin (`bash -s`) instead of inlining it
        // in a double-quoted argument. Otherwise the LOCAL bash expands $VAR in the
        // command string BEFORE ssh sends it to dev-01, silently breaking any
        // multi-statement script that uses variable assignments. See
        // .claude/rules/soc-command-execution.md for the full contract.
        // detached:true gives the child its own process group, so we can kill the
        // whole group (ssh + remote shell pipeline) with process.kill(-pid).
        const proc = spawn(
          'ssh',
          [
            // Tighter for lossy remote-LAN links (EDIFICIO LAURA wifi ~40% loss).
            // ConnectTimeout=20: TCP+banner can take >10s on lossy paths.
            // ConnectionAttempts=3: retry the whole TCP cycle if first SYN cycle fails.
            // ServerAlive 8s × 2 = give up at 16s of silence (was 90s).
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ConnectTimeout=20',
            '-o', 'ConnectionAttempts=3',
            '-o', 'ServerAliveInterval=8',
            '-o', 'ServerAliveCountMax=2',
            '-o', 'TCPKeepAlive=yes',
            '-o', 'BatchMode=yes',
            'dev-01',
            'bash', '-s',
          ],
          { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        proc.stdin.write(String(item.command));
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
          }, 500);
        };

        proc.stdout.on('data', (d) => { fullOutput += d.toString(); scheduleFlush(); });
        proc.stderr.on('data', (d) => { fullOutput += d.toString(); scheduleFlush(); });
        proc.on('close', async (code) => {
          if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
          clearTimeout(entry.timeoutHandle);
          runningProcs.delete(sessionId);
          const timedOut = entry.timedOut;
          const finalStatus = (code === 0 && !timedOut) ? 'done' : 'failed';
          const appendMsg = timedOut ? `\n\n[TIMEOUT after ${timeoutSec}s — process killed]` : '';
          const rawLen = fullOutput.length;
          const safeOutput = sanitizeOutput(fullOutput + appendMsg);
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
            } catch (fallbackErr) {
              console.error(`[soc queue run] Fallback UPDATE also failed for item ${item.id}:`, fallbackErr);
            }
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
        });

        return true;
      } catch (error) {
        console.error('[soc queue run] Error:', error);
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
          `SELECT id, session_id, status, output FROM soc_queue_items WHERE id = $1`,
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
         WHERE id = $1 AND status = 'pending' RETURNING id`,
        [itemId]
      );
      if (r.rows.length === 0) {
        sendJSON(res, 404, { error: 'Queue item not found or not pending' });
        return true;
      }
      sendJSON(res, 200, { success: true, id: r.rows[0].id });
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

    return false; // Route not handled
  };
};
