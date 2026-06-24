// hooks.js — dir_1780845861190
//
// Cross-cutting event hook system for the SOC pipeline. Port of claw-code
// rust/crates/runtime/src/hooks.rs adapted to our queue-item-centric flow.
//
// Hooks are operator-configured shell commands stored in engagement_hooks.
// On each registered event the bridge spawns `sh -c <command>` with the event
// payload as JSON on stdin. The hook may return JSON on stdout to influence
// the calling flow (allow=true/false, modified_command, messages).
//
// Events:
//   pre_queue_dispatch   — before ssh+queue-item runs (allow=false → block)
//   post_queue_complete  — after queue-item finishes (advisory, not blocking)
//   pre_finding_write    — before a finding is persisted (allow=false → cancel)
//   post_phase_advance   — after engagement phase changes (advisory)

"use strict";

const { spawn } = require("child_process");
const db = require("./db");

const HOOK_EVENTS = {
  PRE_QUEUE_DISPATCH:  "pre_queue_dispatch",
  POST_QUEUE_COMPLETE: "post_queue_complete",
  PRE_FINDING_WRITE:   "pre_finding_write",
  POST_PHASE_ADVANCE:  "post_phase_advance",
};
const ALL_EVENTS = Object.values(HOOK_EVENTS);

// Hooks scoped to a SPECIFIC engagement OR engagement_id=NULL (global).
// runEvent fetches both and runs each in registration order.
async function loadHooksForEvent(engagementId, event) {
  if (!ALL_EVENTS.includes(event)) return [];
  const r = await db.query(
    `SELECT id, engagement_id, event, command, timeout_ms
       FROM engagement_hooks
      WHERE event = $1
        AND enabled = true
        AND (engagement_id IS NULL OR engagement_id = $2)
      ORDER BY id ASC`,
    [event, engagementId]);
  return r.rows;
}

// Spawn `sh -c <command>` with JSON payload on stdin. Returns the hook's stdout
// (possibly empty). Times out after hook.timeout_ms; on timeout returns null
// (caller treats as fail-open / allow).
function executeHook(hook, payload) {
  return new Promise((resolve) => {
    const jsonIn = JSON.stringify(payload);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const proc = spawn("sh", ["-c", hook.command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOOK_EVENT: hook.event, HOOK_ID: String(hook.id) },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch (_) {}
    }, Math.max(500, hook.timeout_ms || 10000));

    proc.stdout.on("data", (c) => { stdout += String(c); });
    proc.stderr.on("data", (c) => { stderr += String(c); });

    proc.on("error", (e) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      resolve({ stdout: "", stderr: e.message, exit_code: -1, timed_out: false, spawn_error: true });
    });
    proc.on("close", (code) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exit_code: code, timed_out: timedOut, spawn_error: false });
    });

    try {
      proc.stdin.write(jsonIn);
      proc.stdin.end();
    } catch (_) {}
  });
}

function parseHookReturn(stdout) {
  if (!stdout || !stdout.trim()) return null;
  try {
    // Allow JSON anywhere in the output — hook may also log to stderr
    const m = stdout.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : stdout);
  } catch (_) { return null; }
}

// runEvent fires every applicable hook in order and aggregates results.
// Returns:
//   { allowed, hooks_fired, hook_results: [{id, exit_code, allow, messages, timed_out, spawn_error}],
//     final_deny_reason }
// Semantics:
//   - allowed=true unless ANY hook explicitly returns {allow:false}.
//   - First explicit allow:false wins; subsequent hooks still run for telemetry
//     (advisory side-effects like notification webhooks) but don't change the verdict.
//   - Timeout / spawn error / no JSON return → treated as ALLOW (fail-open).
async function runEvent({ engagementId, event, payload }) {
  if (!ALL_EVENTS.includes(event)) {
    return { allowed: true, hooks_fired: 0, hook_results: [] };
  }
  let hooks;
  try { hooks = await loadHooksForEvent(engagementId, event); }
  catch (e) { return { allowed: true, hooks_fired: 0, hook_results: [], load_error: e.message }; }
  if (hooks.length === 0) return { allowed: true, hooks_fired: 0, hook_results: [] };

  const evtPayload = { event, engagement_id: engagementId, ts: new Date().toISOString(), ...payload };
  let finalAllowed = true;
  let finalDenyReason = null;
  const hookResults = [];

  for (const hook of hooks) {
    const exec = await executeHook(hook, evtPayload);
    const parsed = parseHookReturn(exec.stdout);
    const allow = !parsed || parsed.allow !== false;        // default ALLOW
    const messages = (parsed && Array.isArray(parsed.messages)) ? parsed.messages : [];
    if (!allow && finalAllowed) {
      finalAllowed = false;
      finalDenyReason = `hook#${hook.id}: ${(parsed && parsed.deny_reason) || "no reason given"}`;
    }
    // Bump fire counters
    try {
      await db.query(
        `UPDATE engagement_hooks
            SET last_fired_at = NOW(),
                last_outcome = $2,
                fire_count = COALESCE(fire_count, 0) + 1
          WHERE id = $1`,
        [hook.id,
         exec.timed_out ? "timeout" :
         exec.spawn_error ? "spawn_error" :
         allow ? "allow" : "deny"]);
    } catch (_) {}
    hookResults.push({
      id: hook.id,
      event: hook.event,
      exit_code: exec.exit_code,
      allow,
      messages,
      timed_out: exec.timed_out,
      spawn_error: exec.spawn_error,
      modified_command: parsed && parsed.modified_command,
      stderr_preview: (exec.stderr || "").slice(0, 200),
    });
  }
  return {
    allowed: finalAllowed,
    hooks_fired: hookResults.length,
    hook_results: hookResults,
    final_deny_reason: finalDenyReason,
  };
}

// Registration helpers (used by the MCP tools)
async function registerHook({ engagement_id, event, command, timeout_ms, created_by }) {
  if (!ALL_EVENTS.includes(event)) {
    return { error: `invalid event: ${event}. Valid: ${ALL_EVENTS.join(", ")}` };
  }
  if (!command || typeof command !== "string" || !command.trim()) {
    return { error: "command required" };
  }
  const r = await db.query(
    `INSERT INTO engagement_hooks (engagement_id, event, command, timeout_ms, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, engagement_id, event, command, timeout_ms, enabled, created_at`,
    [engagement_id || null, event, command.trim(), timeout_ms || 10000, created_by || "operator"]);
  return r.rows[0];
}

async function listHooks(engagementId) {
  const r = await db.query(
    `SELECT id, engagement_id, event, command, enabled, timeout_ms, created_at, created_by,
            last_fired_at, last_outcome, fire_count
       FROM engagement_hooks
      WHERE engagement_id IS NULL OR engagement_id = $1
      ORDER BY id ASC`,
    [engagementId || null]);
  return r.rows;
}

async function setHookEnabled(hookId, enabled) {
  const r = await db.query(
    `UPDATE engagement_hooks SET enabled = $2 WHERE id = $1 RETURNING id, enabled`,
    [hookId, !!enabled]);
  return r.rows[0] || null;
}

async function deleteHook(hookId) {
  const r = await db.query(`DELETE FROM engagement_hooks WHERE id = $1 RETURNING id`, [hookId]);
  return r.rows[0] || null;
}

module.exports = {
  HOOK_EVENTS,
  ALL_EVENTS,
  runEvent,
  registerHook,
  listHooks,
  setHookEnabled,
  deleteHook,
};
