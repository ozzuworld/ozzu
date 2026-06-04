#!/usr/bin/env node
// agent-toolcall-smoke.js — Step 8.2 (dir_1780598839834)
//
// Mechanical smoke test for the LEGACY runAgentToolCall path (Step 5 — single-loop
// Ollama function-calling agent). Mirrors tools/tests/agent-smoke.js (Step 8.1)
// but for the tool-call agent shape instead of multi-agent.
//
// Mocks Ollama on a random local port, returns Ollama-style tool_calls responses
// (not structured JSON), drives runAgentToolCall against a synthetic test
// engagement, asserts the expected DB transitions and call counts.

"use strict";

const http = require("http");
const fs = require("fs");

// Point offense-agent at our mock BEFORE requiring it (env captured at load).
const MOCK_PORT = 12000 + Math.floor(Math.random() * 1000);
process.env.OFFENSE_MODEL_URL  = `http://127.0.0.1:${MOCK_PORT}/v1`;
process.env.OFFENSE_MODEL_NAME = "mock-qwen3";
process.env.OFFENSE_MODEL_KEY  = "";

for (const m of ["./bridge/offense-agent", "./bridge/offense-orchestrator", "./bridge/offense-aggregator", "./bridge/offense-engine"]) {
  try { delete require.cache[require.resolve(`/app${m}`)]; } catch {}
}

const db = require("/app/db");
const agent = require("/app/offense-agent");

// ──────────── mock Ollama with tool_calls responses ────────────

const callLog = [];
const mockState = { iter: 0 };

function buildToolCall(name, args, id) {
  return {
    id: id || `call-${name}-${Date.now()}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args || {}) },
  };
}

// Extract the latest queue_id from the conversation history (tool messages
// emitted by the bridge after our previous queue_step calls). The real
// runAgentToolCall passes the full message log on every iteration.
function latestQueueIdFromMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  // Walk in reverse — most recent tool result first
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "tool" && typeof m.content === "string") {
      const match = m.content.match(/"queue_id"\s*:\s*(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return 0;
}

function mockReplyForIter(n, engagementId, messages) {
  // 7-iteration script:
  //   1: get_engagement_state
  //   2: queue_step
  //   3: wait_for_outcome (queue_id from iter 2's tool result)
  //   4: queue_step (second one)
  //   5: wait_for_outcome (queue_id from iter 4's tool result)
  //   6: advance_phase → enumeration
  //   7: end_engagement
  if (n === 1) {
    return [buildToolCall("get_engagement_state", { engagement_id: engagementId })];
  }
  if (n === 2) {
    return [buildToolCall("queue_step", {
      engagement_id: engagementId,
      title: "[toolcall-smoke] recon ping",
      command: "echo 'smoke ping' && true",
      references: [],
      expected_artifact: "host_responds",
    })];
  }
  if (n === 3 || n === 5) {
    const queueId = latestQueueIdFromMessages(messages);
    return [buildToolCall("wait_for_outcome", { queue_item_id: queueId, timeout_sec: 30 })];
  }
  if (n === 4) {
    return [buildToolCall("queue_step", {
      engagement_id: engagementId,
      title: "[toolcall-smoke] banner grab",
      command: "echo 'smoke banner: Apache/2.4'",
      references: [],
      expected_artifact: "service_version",
    })];
  }
  if (n === 6) {
    return [buildToolCall("advance_phase", { engagement_id: engagementId, new_phase: "enumeration" })];
  }
  if (n === 7) {
    return [buildToolCall("end_engagement", { engagement_id: engagementId, reason: "smoke test complete" })];
  }
  return []; // no tool_calls → loop exits as "model bailed"
}

function mockHandler(engagementId) {
  return function (req, res) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        // runAgentToolCall sends `tools: TOOL_SCHEMAS` in the payload
        if (!Array.isArray(j.tools) || j.tools.length === 0) {
          // shouldn't happen — toolcall path always passes tools
          callLog.push({ kind: "MISSING_TOOLS" });
        }
        mockState.iter++;
        const toolCalls = mockReplyForIter(mockState.iter, engagementId, j.messages);
        callLog.push({
          iter: mockState.iter,
          returned: toolCalls.map((tc) => tc.function.name),
          args: toolCalls.map((tc) => tc.function.arguments),
        });

        const reply = {
          id: "mock-toolcall-" + Date.now(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "mock-qwen3",
          choices: [{
            index: 0,
            finish_reason: toolCalls.length ? "tool_calls" : "stop",
            message: {
              role: "assistant",
              content: toolCalls.length ? "" : "(done)",
              tool_calls: toolCalls.length ? toolCalls : undefined,
            },
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
  };
}

// ──────────── fixture: test engagement + queue-id tracker ────────────

const TEST_ENGAGEMENT_ID = `TC-SMOKE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

async function createTestEngagement() {
  await db.query(
    `INSERT INTO pentest_engagements (id, client_name, engagement_type, status, scope, roe,
        executor_host, executor_tools, engagement_phase, agent_status, agent_run_state)
     VALUES ($1, 'toolcall-smoke', 'smoke_test', 'in_progress',
        $2::jsonb, $3::jsonb, 'dev-01', $4::jsonb, 'recon', 'idle', '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET agent_status='idle', agent_run_state='{}'::jsonb, engagement_phase='recon'`,
    [TEST_ENGAGEMENT_ID,
     JSON.stringify({ test: "toolcall smoke" }),
     JSON.stringify({ note: "authorized smoke test only" }),
     JSON.stringify(["echo", "sh", "true"])]);
  await db.query(`DELETE FROM soc_queue_items WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
}

async function teardownTestEngagement() {
  await db.query(`DELETE FROM soc_queue_items WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
  await db.query(`DELETE FROM offense_telemetry WHERE engagement_id = $1`, [TEST_ENGAGEMENT_ID]);
  await db.query(`DELETE FROM pentest_engagements WHERE id = $1`, [TEST_ENGAGEMENT_ID]);
}

// PA simulator + queue-id tracker — wraps the queue_step insertion to learn
// the most recent queue_id so the mock can reference it in wait_for_outcome.
function startPASimulator() {
  return setInterval(async () => {
    try {
      // Mark any pending items done
      await db.query(
        `UPDATE soc_queue_items SET status='done', completed_at=NOW(),
            output='toolcall-smoke output: service responding, banner=Apache/2.4'
         WHERE engagement_id = $1 AND status = 'pending'`,
        [TEST_ENGAGEMENT_ID]);
      // Track the latest queue id so the mock's wait_for_outcome can reference it
      const r = await db.query(
        `SELECT id FROM soc_queue_items WHERE engagement_id = $1 ORDER BY id DESC LIMIT 1`,
        [TEST_ENGAGEMENT_ID]);
      if (r.rows[0]) mockState.lastQueueId = r.rows[0].id;
    } catch (_) {}
  }, 500);
}

// ──────────── assertions ────────────

function assert(cond, msg) {
  if (!cond) { console.error(`✗ ASSERT FAILED: ${msg}`); process.exit(1); }
  else       console.log(`✓ ${msg}`);
}

async function runSmoke() {
  const server = http.createServer(mockHandler(TEST_ENGAGEMENT_ID));
  await new Promise((r) => server.listen(MOCK_PORT, "127.0.0.1", r));
  console.log(`[smoke-toolcall] mock Ollama listening on ${MOCK_PORT}`);

  try {
    await createTestEngagement();
    console.log(`[smoke-toolcall] created test engagement ${TEST_ENGAGEMENT_ID}`);
    const paTimer = startPASimulator();
    console.log(`[smoke-toolcall] PA simulator started @ 2 Hz`);

    let result;
    try {
      result = await agent.runAgentToolCall(TEST_ENGAGEMENT_ID, { max_iter: 12 });
    } finally {
      clearInterval(paTimer);
    }
    console.log(`[smoke-toolcall] runAgentToolCall returned:`, JSON.stringify(result, null, 2));

    assert(result.ok === true, "runAgentToolCall returned ok=true");
    assert(result.iter >= 5, `iter ≥ 5 (got ${result.iter}) — agent stepped through the planned script`);
    assert(result.ended_by_model === true, `agent ended_by_model=true (called end_engagement)`);
    assert(result.steps_queued >= 2, `steps_queued ≥ 2 (got ${result.steps_queued})`);

    const names = callLog.flatMap((c) => c.returned || []);
    console.log("[smoke-toolcall] tool-call sequence:", names.join(" → "));
    assert(names.includes("get_engagement_state"), "called get_engagement_state");
    assert(names.includes("queue_step"),           "called queue_step");
    assert(names.includes("wait_for_outcome"),     "called wait_for_outcome");
    assert(names.includes("advance_phase"),        "called advance_phase");
    assert(names.includes("end_engagement"),       "called end_engagement");

    const queue = await db.query(`SELECT id, status FROM soc_queue_items WHERE engagement_id = $1 ORDER BY id`, [TEST_ENGAGEMENT_ID]);
    const eng   = await db.query(`SELECT agent_status, engagement_phase FROM pentest_engagements WHERE id = $1`, [TEST_ENGAGEMENT_ID]);
    console.log("[smoke-toolcall] queue items:", queue.rows.map((q) => `#${q.id}=${q.status}`).join(", "));
    assert(queue.rows.length >= 2, `≥2 soc_queue_items inserted (got ${queue.rows.length})`);
    const doneCount = queue.rows.filter((q) => q.status === "done").length;
    assert(doneCount >= 2, `≥2 queue items reached 'done' status (got ${doneCount} done out of ${queue.rows.length})`);
    assert(eng.rows[0].engagement_phase === "enumeration", `final engagement_phase = enumeration (got '${eng.rows[0].engagement_phase}')`);
    assert(["completed", "idle"].includes(eng.rows[0].agent_status), `final agent_status ∈ {completed, idle} (got '${eng.rows[0].agent_status}')`);

    console.log("\n🎯 SMOKE TEST PASSED — runAgentToolCall (legacy Step 5 path) is mechanically correct.");
  } finally {
    server.close();
    await teardownTestEngagement();
    console.log(`[smoke-toolcall] teardown done`);
    try { db.pool && db.pool.end && await db.pool.end(); } catch {}
  }
}

runSmoke().catch((e) => {
  console.error("[smoke-toolcall] CRASH:", e.message);
  console.error(e.stack);
  process.exit(1);
});
