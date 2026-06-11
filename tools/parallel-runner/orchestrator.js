#!/usr/bin/env node
// Parallel engagement orchestrator — Sprint 2b data harvester.
//
// Keeps N OzzuLab engagements running concurrently, picks lab variant at random,
// auto-restarts a fresh engagement as soon as one finishes, runs for TARGET_HOURS
// then waits for tail to drain.
//
// Used to scale (state → trajectory) collection from ~70 (Run #13) toward 5K+.
//
// Designed to run INSIDE the bridge container so it can require() runAgent directly:
//   docker exec -d -w /app -e NODE_PATH=/app/node_modules \
//     -e CONCURRENCY=5 -e TARGET_HOURS=1 bridge \
//     node /home/gcp/ozzu/tools/parallel-runner/orchestrator.js
//
// Env knobs:
//   CONCURRENCY        — parallel engagements, default 5
//   TARGET_HOURS       — wall-clock cap (default 1)
//   MAX_ITER           — per-engagement max iter (default 25)
//   LAB_VARIANTS       — comma list, default "v1,v2"
//   PROGRESS_LOG       — JSONL output, default /home/gcp/ozzu/private/oracle-trajectories/orchestrator.log
//   POLL_SEC           — poll interval, default 20

const fs = require("fs");
const path = require("path");
const db = require("/app/db");

const { runAgent } = require("/app/offense-agent");

const CONCURRENCY    = parseInt(process.env.CONCURRENCY || "5", 10);
const TARGET_HOURS   = parseFloat(process.env.TARGET_HOURS || "1");
const MAX_ITER       = parseInt(process.env.MAX_ITER || "25", 10);
const LAB_VARIANTS   = (process.env.LAB_VARIANTS || "v1,v2").split(",").map(s => s.trim()).filter(Boolean);
const PROGRESS_LOG   = process.env.PROGRESS_LOG || "/home/gcp/ozzu/private/oracle-trajectories/orchestrator.log";
const POLL_SEC       = parseInt(process.env.POLL_SEC || "20", 10);

const VARIANT_SCOPES = {
  v1: {
    allowed: ["10.10.20.10", "10.10.20.20", "10.10.20.30"],
    prohibited: ["10.10.20.1"],
    targets:   ["10.10.20.0/24"],
    objective: "Find OZZULAB{...} flag on any of the three target hosts at 10.10.20.x.",
  },
  v2: {
    allowed: ["10.10.21.10", "10.10.21.20", "10.10.21.30"],
    prohibited: ["10.10.21.1"],
    targets:   ["10.10.21.0/24"],
    objective: "Find OZZULAB{...} flag on any of the three target hosts at 10.10.21.x.",
  },
};

const ROE = {
  destructive_actions_allowed: false,
  hours: "any",
  cidr_sweep_allowed: false,
  outbound_to_internet: false,
  max_iterations: MAX_ITER,
};

function nowIso() { return new Date().toISOString(); }

function log(obj) {
  const line = JSON.stringify({ ts: nowIso(), ...obj });
  console.log(line);
  try { fs.mkdirSync(path.dirname(PROGRESS_LOG), { recursive: true }); } catch (_) {}
  try { fs.appendFileSync(PROGRESS_LOG, line + "\n"); } catch (e) { console.error("log append failed:", e.message); }
}

function genEngagementId() {
  // Same format as bridge's create_engagement: SKYLINE-SOC-YYYY-NNN
  const year = new Date().getUTCFullYear();
  const num  = Math.floor(Math.random() * 900) + 100;
  return `SKYLINE-SOC-${year}-${num}`;
}

async function createEngagement(variant, runIndex) {
  const scope = {
    ...VARIANT_SCOPES[variant],
    credentials: {},
    synthetic_lab: true,
  };
  let id;
  for (let attempt = 0; attempt < 8; attempt++) {
    id = genEngagementId();
    try {
      await db.query(
        `INSERT INTO pentest_engagements
           (id, client_name, engagement_type, start_date, end_date, lead_engineer,
            scope, roe, status, agent_status, autonomous_paused,
            autonomous_execution_enabled, autonomous_full_access, created_at)
         VALUES ($1, 'OzzuLab', 'internal_pentest', $2, $2, 'Cipher',
                 $3, $4, 'in_progress', 'idle', false, true, true, NOW())`,
        [id, new Date().toISOString().slice(0, 10),
         JSON.stringify(scope), JSON.stringify(ROE)]);
      log({ event: "create_ok", id, variant, run_index: runIndex });
      return id;
    } catch (e) {
      if (/duplicate key/i.test(e.message)) continue; // collision — try again
      log({ event: "create_fail", id, variant, error: e.message });
      return null;
    }
  }
  log({ event: "create_fail_collisions", variant });
  return null;
}

function fireRun(id, variant) {
  const targets = VARIANT_SCOPES[variant].allowed.join(" ");
  const intent = `Sprint 2b autonomous batch (variant=${variant}). Find OZZULAB{} flag on these three hosts: ${targets}. ` +
    `IMPORTANT: pass target IPs directly as command-line arguments. DO NOT use 'nmap -iL /tmp/targets.txt' — that file does NOT exist. ` +
    `Use 'nmap -sV ${targets}' style invocations. No CIDR sweeps. Use valid NSE category names (safe, vuln, discovery, etc).`;
  // Detached — never await. runAgent loops on its own; orchestrator polls DB.
  runAgent(id, { intent, max_iter: MAX_ITER })
    .then(r => log({ event: "run_returned", id, variant, summary: JSON.stringify(r).slice(0, 300) }))
    .catch(e => log({ event: "run_threw", id, variant, error: e.message }));
}

async function isEngagementDone(id) {
  const r = await db.query(
    `SELECT agent_status, autonomous_paused, (agent_run_state->>'iter')::int AS iter,
            COALESCE((agent_run_state->>'max_iter')::int, $2) AS max_iter
       FROM pentest_engagements WHERE id=$1`, [id, MAX_ITER]);
  if (!r.rows[0]) return { done: true, reason: "row-missing" };
  const row = r.rows[0];
  if (row.autonomous_paused) return { done: true, reason: "paused", iter: row.iter };
  if (row.agent_status === "idle" && row.iter >= row.max_iter) return { done: true, reason: "max-iter", iter: row.iter };
  if (row.agent_status === "idle" && row.iter >= 1) return { done: true, reason: "idle-finished", iter: row.iter };
  return { done: false, agent_status: row.agent_status, iter: row.iter };
}

async function flagCaptured(id) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM soc_queue_items WHERE engagement_id=$1 AND output ~ 'OZZULAB\\{'`, [id]);
  return (r.rows[0] && r.rows[0].n) > 0;
}

async function runStats(id) {
  const r = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status='done')    AS done,
            COUNT(*) FILTER (WHERE status='failed')  AS failed,
            COUNT(*) FILTER (WHERE status='pending') AS pending
       FROM soc_queue_items WHERE engagement_id=$1`, [id]);
  return r.rows[0] || { done: 0, failed: 0, pending: 0 };
}

async function main() {
  log({ event: "orchestrator_start", concurrency: CONCURRENCY, target_hours: TARGET_HOURS, max_iter: MAX_ITER, variants: LAB_VARIANTS });

  const slots = new Array(CONCURRENCY).fill(null).map(() => ({
    engagement_id: null, variant: null, started_at: null,
  }));
  let runIndex = 0;
  let completedRuns = 0;
  let flagsCaptured = 0;
  const T0 = Date.now();
  const deadline = T0 + TARGET_HOURS * 3600 * 1000;

  while (true) {
    const now = Date.now();
    const shouldSpawn = now < deadline;

    for (let i = 0; i < slots.length; i++) {
      if (!shouldSpawn) break;
      if (slots[i].engagement_id) continue;
      const variant = LAB_VARIANTS[runIndex % LAB_VARIANTS.length];
      runIndex++;
      const id = await createEngagement(variant, runIndex);
      if (!id) { await new Promise(r => setTimeout(r, 2000)); continue; }
      fireRun(id, variant);
      slots[i] = { engagement_id: id, variant, started_at: Date.now() };
    }

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s.engagement_id) continue;
      const done = await isEngagementDone(s.engagement_id);
      if (done.done) {
        const stats = await runStats(s.engagement_id);
        const flag  = await flagCaptured(s.engagement_id);
        if (flag) flagsCaptured++;
        completedRuns++;
        log({
          event: "engagement_complete",
          id: s.engagement_id, variant: s.variant,
          reason: done.reason, iter: done.iter,
          elapsed_s: Math.round((Date.now() - s.started_at) / 1000),
          done: Number(stats.done), failed: Number(stats.failed),
          flag_captured: flag,
        });
        slots[i] = { engagement_id: null, variant: null, started_at: null };
      }
    }

    const inFlight = slots.filter(s => s.engagement_id).length;
    const elapsedMin = Math.round((Date.now() - T0) / 60000);
    log({
      event: "heartbeat", elapsed_min: elapsedMin, in_flight: inFlight,
      total_started: runIndex, total_completed: completedRuns, flags_captured: flagsCaptured,
      deadline_remaining_min: Math.max(0, Math.round((deadline - Date.now()) / 60000)),
    });

    if (!shouldSpawn && inFlight === 0) break;

    await new Promise(r => setTimeout(r, POLL_SEC * 1000));
  }

  log({
    event: "orchestrator_done",
    total_started: runIndex,
    total_completed: completedRuns,
    flags_captured: flagsCaptured,
    elapsed_min: Math.round((Date.now() - T0) / 60000),
  });
}

if (require.main === module) {
  main().catch(e => { console.error("orchestrator fatal:", e); log({ event: "fatal", error: e.message }); process.exit(1); });
}
