#!/usr/bin/env node
// agent-smoke.js — Step 8.1 (dir_1780596473288)
//
// Validate the multi-agent runAgent pipeline (offense-agent.js + offense-
// orchestrator.js + offense-aggregator.js) MECHANICALLY without needing a
// real GPU/model. Spins up a mock Ollama on a free port, runs the agent
// against a freshly-created test engagement, asserts the flow:
//
//   Orchestrator → Synthesizer → queue_step → wait_for_outcome → Aggregator → loop
//
// On failure, prints what broke so the bug is caught BEFORE we burn a
// $0.78/hr GPU rental finding it.
//
// Usage:
//   docker exec bridge node /home/gcp/ozzu/tools/tests/agent-smoke.js

"use strict";

const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// We need to point offense-agent at our mock BEFORE requiring it (its
// MODEL_URL is captured at module load). Set env then require fresh.
const MOCK_PORT = 11434 + Math.floor(Math.random() * 1000); // avoid colliding with real Ollama tunnel
process.env.OFFENSE_MODEL_URL  = `http://127.0.0.1:${MOCK_PORT}/v1`;
process.env.OFFENSE_MODEL_NAME = "mock-qwen3";
process.env.OFFENSE_MODEL_KEY  = "";

// Force-clear the require cache so a previous import doesn't bind to the
// old env values.
for (const m of ["./bridge/offense-agent", "./bridge/offense-orchestrator", "./bridge/offense-aggregator", "./bridge/offense-engine"]) {
  try { delete require.cache[require.resolve(`/app${m}`)]; } catch {}
}

const db = require("/app/db");
const agent = require("/app/offense-agent");

// ───────────────────────────── mock Ollama ─────────────────────────────

// Each call gets logged; tests assert counts.
const callLog = [];

function detectRole(systemContent) {
  if (!systemContent) return "unknown";
  // Match on the opening "You are the X" — each prompt mentions the other agent
  // names elsewhere so a plain substring search misclassifies.
  if (/You are the COMMAND SYNTHESIZER/i.test(systemContent)) return "synthesizer";
  if (/You are the INFORMATION AGGREGATOR/i.test(systemContent)) return "aggregator";
  if (/You are the TASK ORCHESTRATOR/i.test(systemContent)) return "orchestrator";
  return "unknown";
}

const mockState = {
  orchestratorCalls: 0,
  selectedIds: new Set(),  // remember what we've picked so we move forward
};

// Parse the user message the orchestrator receives to find real unblocked
// task IDs. The user prompt (from offense-orchestrator.serializeGraphForPrompt)
// includes lines like:
//   "  task=37 parents=root phase=recon status=pending [unblocked] directive=..."
// and a summary line:
//   "  unblocked_pending: 37, 38"
function findUnblockedTaskIds(userContent) {
  if (!userContent) return [];
  const m = userContent.match(/unblocked_pending:\s*([\d,\s]+)/i);
  if (!m) return [];
  return m[1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
}

function orchestratorReply(userContent) {
  mockState.orchestratorCalls++;
  const n = mockState.orchestratorCalls;
  if (n === 1) return { select: null, add: [
    { directive: "Sweep ports on the target subnet", parent_ids: [], phase: "recon" },
    { directive: "Banner-grab discovered services",   parent_ids: [], phase: "recon" },
  ], advance_phase: null, end: null };
  // Pick a real unblocked task id we haven't selected yet
  const unblocked = findUnblockedTaskIds(userContent);
  const next = unblocked.find((id) => !mockState.selectedIds.has(id));
  if (next != null) {
    mockState.selectedIds.add(next);
    return { select: next, add: [], advance_phase: null, end: null };
  }
  // No more unblocked tasks — end the engagement
  return { select: null, add: [], advance_phase: null, end: "smoke test complete — no unblocked tasks remain" };
}

function synthesizerReply(userContent) {
  // Echo the directive into a plausible command.
  const m = userContent && userContent.match(/Task directive[^:]*:\s*(.+?)\n/i);
  const directive = m ? m[1].slice(0, 80) : "unknown task";
  return {
    title: `[smoke] ${directive}`,
    command: `echo 'smoke command for: ${directive.replace(/'/g, "")}'`,
    expected_artifact: "test output",
    references: [],
  };
}

function aggregatorReply() {
  // Always success in the mock, with a tiny synthetic signal.
  return {
    success: true,
    key_signals: ["host responded", "service banner captured"],
    new_findings: [],
    new_hosts: [],
    followup: [],
    error_category: null,
  };
}

function mockHandler(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const j = JSON.parse(body);
      const sysMsg = (j.messages || []).find((m) => m.role === "system");
      const usrMsg = (j.messages || []).reverse().find((m) => m.role === "user");
      const role = detectRole(sysMsg && sysMsg.content);
      callLog.push({ role, ts: Date.now() });

      let payload;
      if (role === "orchestrator") payload = orchestratorReply(usrMsg && usrMsg.content);
      else if (role === "synthesizer") payload = synthesizerReply(usrMsg && usrMsg.content);
      else if (role === "aggregator") payload = aggregatorReply();
      else payload = { error: `unknown role for system content: ${(sysMsg && sysMsg.content || "").slice(0, 80)}` };

      const reply = {
        id: "mock-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "mock-qwen3",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(payload) },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ───────────────────────────── test fixture ─────────────────────────────

const TEST_ENGAGEMENT_ID = `SMOKE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

// Sweep prior leaked SMOKE-* engagements at startup so a crashed earlier run
// doesn't pollute the fleet diagnostic. Idempotent.
async function sweepLeakedSmokeEngagements() {
  const r = await db.query(`SELECT id FROM pentest_engagements WHERE id LIKE 'SMOKE-%' AND engagement_type = 'smoke_test'`);
  for (const row of r.rows) {
    await db.query(`DELETE FROM engagement_tasks   WHERE engagement_id = $1`, [row.id]);
    await db.query(`DELETE FROM soc_queue_items    WHERE engagement_id = $1`, [row.id]);
    await db.query(`DELETE FROM offense_telemetry  WHERE engagement_id = $1`, [row.id]);
    await db.query(`DELETE FROM pentest_engagements WHERE id = $1`, [row.id]);
  }
  if (r.rows.length > 0) console.log(`[smoke] swept ${r.rows.length} leaked SMOKE-* engagements`);
}

async function createTestEngagement() {
  await sweepLeakedSmokeEngagements();
  await db.query(
    `INSERT INTO pentest_engagements (id, client_name, engagement_type, status, scope, roe, executor_host, executor_tools, engagement_phase, agent_status, agent_run_state)
     VALUES ($1, 'smoke-test-client', 'smoke_test', 'in_progress', $2::jsonb, $3::jsonb, 'dev-01', $4::jsonb, 'recon', 'idle', '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET agent_status='idle', agent_run_state='{}'::jsonb, engagement_phase='recon'`,
    [
      TEST_ENGAGEMENT_ID,
      JSON.stringify({ test: "smoke-test scope" }),
      JSON.stringify({ note: "authorized smoke test only" }),
      JSON.stringify(["echo", "sh", "test"]),
    ]
  );
  // Clean any prior task rows for this id (idempotency on re-run)
  await db.query(`DELETE FROM engagement_tasks WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
  await db.query(`DELETE FROM soc_queue_items WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
}

async function teardownTestEngagement() {
  await db.query(`DELETE FROM engagement_tasks WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
  await db.query(`DELETE FROM soc_queue_items WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
  await db.query(`DELETE FROM offense_telemetry WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
  await db.query(`DELETE FROM pentest_engagements WHERE id = $1`, [TEST_ENGAGEMENT_ID]);
}

// Simulate the PA — a background poller that immediately marks any
// pending queue_items in our test engagement as done. The real
// wait_for_outcome polls every 5s, so this kicks faster than that.
// (Cleaner than monkey-patching dispatch — offense-agent.js destructures
// it at module load, so the patch wouldn't take effect anyway.)
function startPASimulator() {
  return setInterval(async () => {
    try {
      await db.query(
        `UPDATE soc_queue_items
            SET status = 'done',
                completed_at = NOW(),
                output = 'smoke output: host=up port=80 service=http banner=Apache/2.4.41'
          WHERE engagement_id = $1 AND status = 'pending'`,
        [TEST_ENGAGEMENT_ID]
      );
    } catch (_) { /* ignore — agent may have torn down */ }
  }, 1000);
}

// ───────────────────────────── assertions ─────────────────────────────

function assert(cond, msg) {
  if (!cond) { console.error(`✗ ASSERT FAILED: ${msg}`); process.exit(1); }
  else       console.log(`✓ ${msg}`);
}

async function runSmoke() {
  const server = http.createServer(mockHandler);
  await new Promise((r) => server.listen(MOCK_PORT, "127.0.0.1", r));
  console.log(`[smoke] mock Ollama listening on ${MOCK_PORT}`);

  try {
    await createTestEngagement();
    console.log(`[smoke] created test engagement ${TEST_ENGAGEMENT_ID}`);
    const paTimer = startPASimulator();
    console.log(`[smoke] PA simulator started — pending queue items auto-complete at 1Hz`);

    // Run the agent with a short wait timeout (real impl defaults to 30 min)
    let result;
    try {
      result = await agent.runAgent(TEST_ENGAGEMENT_ID, { max_iter: 10, wait_timeout_sec: 30 });
    } finally {
      clearInterval(paTimer);
    }
    console.log(`[smoke] runAgent returned:`, JSON.stringify(result, null, 2));

    // Assertions
    assert(result.ok === true, "runAgent returned ok=true");
    assert(result.iter >= 3, `iter ≥ 3 (got ${result.iter}) — orchestrator should have driven multiple iterations`);
    assert(result.ended_by_orchestrator === true || result.iter >= 10, "orchestrator ended OR hit cap");
    assert(result.steps_queued >= 2, `at least 2 steps queued (got ${result.steps_queued})`);
    assert(result.tasks_added >= 2, `at least 2 tasks added to DAG (got ${result.tasks_added})`);

    // Call distribution: at least one orchestrator + one synthesizer + one aggregator
    const byRole = callLog.reduce((acc, c) => { acc[c.role] = (acc[c.role] || 0) + 1; return acc; }, {});
    console.log("[smoke] mock call distribution:", JSON.stringify(byRole));
    assert(byRole.orchestrator >= 3, `orchestrator called ≥3× (got ${byRole.orchestrator || 0})`);
    assert(byRole.synthesizer  >= 2, `synthesizer  called ≥2× (got ${byRole.synthesizer  || 0})`);
    assert(byRole.aggregator   >= 2, `aggregator   called ≥2× (got ${byRole.aggregator   || 0})`);

    // DB state
    const tasks = await db.query(`SELECT status, queue_item_id, outcome_summary IS NOT NULL AS has_summary FROM engagement_tasks WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
    const queue = await db.query(`SELECT status FROM soc_queue_items WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
    const eng   = await db.query(`SELECT agent_status, engagement_phase FROM pentest_engagements WHERE id = $1`, [TEST_ENGAGEMENT_ID]);

    const done_tasks = tasks.rows.filter((t) => t.status === "done").length;
    assert(done_tasks >= 2, `≥2 engagement_tasks transitioned to done (got ${done_tasks})`);
    assert(tasks.rows.every((t) => t.has_summary || t.status === "pending"), "every completed task has an outcome_summary");
    assert(queue.rows.length >= 2, `≥2 soc_queue_items inserted (got ${queue.rows.length})`);
    assert(["completed", "idle"].includes(eng.rows[0].agent_status), `final agent_status is completed|idle (got '${eng.rows[0].agent_status}')`);

    console.log("\n🎯 SMOKE TEST PASSED — multi-agent runAgent wiring is mechanically correct.");
  } finally {
    server.close();
    await teardownTestEngagement();
    console.log(`[smoke] teardown done — test engagement removed`);
    try { db.pool && db.pool.end && await db.pool.end(); } catch {}
  }
}

runSmoke().catch((e) => {
  console.error("[smoke] CRASH:", e.message);
  console.error(e.stack);
  process.exit(1);
});
