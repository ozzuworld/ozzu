// agent-spawner.js — Event-driven agent subprocess manager for directives
// Spawns `claude` CLI processes when directives transition to planning/approved status

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const BRIDGE = "http://localhost:3333";
const WORKDIR = "/home/gcp/ozzu";
const LOG_DIR = "/tmp/ozzu-bridge";
const SIGKILL_GRACE_MS = 5000; // 5s grace after SIGTERM before SIGKILL
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB — rotate log files exceeding this
const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — delete older log files

// ── Runtime-configurable settings (mutable via GET/PATCH /config) ──
const _config = {
  MAX_CONCURRENT_AGENTS: 2,     // Max simultaneous agent processes (~500MB-1GB each)
  AGENT_TIMEOUT_MS: 60 * 60 * 1000, // 1 hour
  WATCHDOG_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
  STALL_THRESHOLD_MS: 15 * 60 * 1000,  // 15 minutes without directive activity = stalled
  LOG_LEVEL: process.env.LOG_LEVEL || "debug",
};

function getConfig() { return { ..._config }; }
function setConfig(key, value) {
  if (!(key in _config)) return false;
  _config[key] = value;
  return true;
}

// Running agents: directiveId → { process, type, startedAt, pid, timeout, logFile }
const runningAgents = new Map();

// WebSocket broadcast function — injected by server.js via setBroadcast()
let _broadcastToAll = null;
function setBroadcast(fn) { _broadcastToAll = fn; }

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    return; // Fresh directory, nothing to clean
  }

  // Clean up log files older than 7 days
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(LOG_DIR)) {
      if (!file.startsWith("agent-")) continue;
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > LOG_MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        log(`Cleaned up old log: ${file}`);
      }
    }
  } catch (err) {
    log(`Log cleanup error: ${err.message}`);
  }
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[agent-spawner ${ts}] ${msg}`);
}

// Build the planning prompt for a directive
function buildPlanningPrompt(directive) {
  // Quick/explore directives get full implementation instructions since they skip the planning→approval flow
  const isImmediate = directive.type === "quick" || directive.type === "explore";
  const immediateInstructions = isImmediate ? `
${directive.type === "quick" ? "QUICK" : "EXPLORE"} DIRECTIVE — ${directive.type === "quick" ? "IMPLEMENT NOW" : "RESEARCH AND REPORT"}:
${directive.type === "quick"
  ? "Skip planning. Implement the changes immediately."
  : "Research the codebase and report findings. No code changes needed unless the description says otherwise."}

COMPLETION CHECKLIST:
1. ${directive.type === "quick" ? "Implement the changes" : "Research and gather findings"}
2. ${directive.type === "quick" ? "Verify: node -c <file> for JS, test endpoints if applicable" : "Write findings as detailed markdown"}
3. ${directive.type === "quick" ? `Commit: git add <specific files> && git commit -m "descriptive message\\n\\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"` : "Skip commit (no code changes)"}
4. ${directive.type === "quick" ? "Push: git push origin main" : "Skip push"}
5. Mark complete: curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"completed"${directive.type === "explore" ? ',"plan":"<your findings in markdown>"' : ""}}'

CRITICAL RULES:
- You MUST commit and push before marking complete. Uncommitted changes are lost.
- Do NOT restart the bridge yourself — smartDeploy handles it automatically after you mark the directive completed.
- Do NOT deploy manually — smartDeploy detects what changed and deploys appropriately (OTA for JS, CI build for native).
- Just commit, push, and mark complete. The pipeline handles the rest.
- If another agent may be editing the same files, check git status first. If files have uncommitted changes, use git stash before editing and git stash pop after.
- Always git pull --rebase origin main before pushing if the push fails.
` : "";

  return `You are Cipher, the autonomous dev agent for the ozzu project.
Read CLAUDE.md at /home/gcp/ozzu/CLAUDE.md FIRST — it has all project context.

SYSTEM ARCHITECTURE:
- GCP VM (10.128.0.8) runs all services. Bridge at :3333, HA at :8123, Postgres :5432, Redis :6379
- Home LAN (172.168.0.0/24) via VPN tunnel. Devices: tablets (.53, .57), TV (.56), dev-01 (.59)
- Bridge runs in Docker. Do NOT restart it yourself — smartDeploy auto-restarts after you mark complete.
- Frontend: Expo React Native. CI builds on push to main. smartDeploy auto-deploys after you mark complete.
- Bridge API: /directives, /status, /notify, /approvals, /health, /dashboard

A new ${directive.type} directive:
- Title: ${directive.title}
- Description: ${directive.description}
- Directive ID: ${directive.id}
${immediateInstructions}
${!isImmediate ? `YOUR TASK:
1. Research the codebase to understand what's needed
2. Create a detailed implementation plan
3. Submit the plan via: curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"planned","plan":"<your plan>"}'

For 'feature' type: create a thorough plan and submit it. Needs PIN approval before implementation.` : ""}

ENGINEERING MINDSET — How to approach every problem:

1. READ BEFORE WRITING: Always read the full file you're about to change. Understand existing
   patterns, state machines, and flows before touching anything. Don't assume you know the
   structure — it changes frequently.

2. ROOT CAUSE, NOT SURFACE FIX: When you find a bug, trace the full flow. Example: a "broken
   interrupt" isn't just about the interrupt function — it's about what happens to in-flight
   responses, mic state, and message queues AFTER the interrupt fires. Fix the cause, not
   the symptom.

3. UNDERSTAND STATE INTERACTIONS: This codebase has interacting state machines. The cipher
   pipeline has: _turn (cipher/user), _ttsActive, _ttsFlushing, _interrupted, _turnReady.
   Every change must consider ALL states. Ask yourself: "What state is the system in when
   this code runs? What other states could it be in?"

4. MEASURE, DON'T GUESS: Add logging with concrete numbers. "Latency: 340ms (thinking: 280ms,
   TTS: 60ms)" is useful. "Latency seems high" is not. Use counters, timestamps, and metrics.

5. SMALL TARGETED CHANGES: One problem, one fix. Don't refactor surrounding code. Don't add
   features that weren't asked for. Don't add docstrings to code you didn't change.

6. DEFENSIVE BUT NOT OVER-ENGINEERED: Add guards where races can occur (e.g., check queue
   before opening mic). Don't add error handling for impossible cases. Trust internal code
   and framework guarantees.

CODEBASE PATTERNS — Key architecture decisions:
- server.js (~5400 lines): Monolithic but well-organized. Has Gemini, Cipher, directives, HA proxy, dashboard. Search before adding new code — it might already exist.
- cipher-pipeline.js: Turn-based voice state machine. STT → Claude Agent SDK → TTS. CRITICAL: mic and speaker never overlap. Every code path must respect _turn state.
- agent-spawner.js: Event-driven subprocess manager. Agents are claude CLI processes. They communicate via HTTP to localhost:3333 (PATCH /directives).
- db.js: PG pool with auto-reconnect. Non-critical queries use .catch(() => {}) to avoid crashing the pipeline.
- Bridge runs in Docker (network_mode: host). Restarting kills all running agents.

CONCURRENT EDITING — Multiple agents may edit the same files:
- ALWAYS check git status before editing. If files have uncommitted changes from another agent, stash first.
- ALWAYS git add <specific files>, never git add . or git add -A (you'll commit another agent's WIP).
- If git push fails: git stash && git pull --rebase origin main && git stash pop && git push origin main

TROUBLESHOOTING:
- File not found? Search with Glob/Grep before assuming it doesn't exist
- Command failed? Read the error, try a different approach
- git push failed? Run: git pull --rebase origin main && git push origin main
- Build failed? Read the actual error output, don't guess
- Syntax error? Always run: node -c <file> BEFORE committing
- Bridge/frontend changes? Do NOT restart or deploy manually — smartDeploy handles it automatically after you mark complete.

KNOWN PATTERNS TO FOLLOW:
- Race conditions: this codebase has multiple interacting async systems (Gemini, Cipher, persona
  switching, device registration). When modifying flow control, check all callers and timers.
  Set mutex flags BEFORE async operations, not after (see ensureWasherConnected pattern).
- Security: use escapeHtml(escapeJsString(x)) for inline JS handlers, path.resolve() for file paths,
  whitelist valid enum values (don't accept arbitrary strings from API/agents).
- Async: never use readFileSync/existsSync/execSync in request handlers. Use fs.promises and
  promisified exec. Always add timeouts (AbortController) to fetch() calls.
- Memory: clean up Map entries on disconnect, removeAllListeners() before reconnect,
  cap buffers and queues, store setInterval IDs for shutdown cleanup.
- Frontend: use useRef() to avoid stale closures in useEffect callbacks. Clean up animations
  (return () => anim.stop()). Hooks must be called BEFORE early returns (Rules of Hooks).
  Check that all BridgeCallbacks interface properties are implemented.
- Wrap WebSocket message handlers in try-catch to prevent callback errors from crashing.

AUTONOMY RULES:
- You have FULL autonomy. Just do it — read, write, edit, git, docker, SSH.
- DO NOT give up. Try alternatives before escalating.
- Only escalate via POST ${BRIDGE}/notify for: infrastructure changes, missing credentials, irreversible destructive operations.

REAL-TIME STATUS UPDATES — Post status at each major step so progress is visible in /dashboard:
  curl -s -X POST ${BRIDGE}/status -H 'Content-Type: application/json' -d '{"message":"<what you are doing>","directiveId":"${directive.id}"}'
Examples of when to post: starting research, reading key files, beginning implementation, running tests, committing, deploying.`;
}

// Build the implementation prompt for an approved directive
function buildImplementationPrompt(directive) {
  return `You are Cipher, the autonomous dev agent for the ozzu project.
Read CLAUDE.md at /home/gcp/ozzu/CLAUDE.md FIRST — it has all project context.

SYSTEM ARCHITECTURE:
- GCP VM (10.128.0.8) runs: Home Assistant (:8123), Bridge server (:3333), PostgreSQL (:5432), Redis (:6379)
- Home LAN (172.168.0.0/24) via VPN: tablets (.53, .57), TV (.56), dev-01 (.59)
- dev-01 is a Linux server at 172.168.0.59, reachable via SSH from this VM
- Bridge runs in Docker. Do NOT restart it yourself — smartDeploy auto-restarts after you mark complete.
- Frontend: Expo React Native. Do NOT deploy manually — smartDeploy auto-deploys after you mark complete.
- Bridge API at ${BRIDGE} has endpoints: /directives, /status, /notify, /approvals, /health

Implement this approved directive:
- Title: ${directive.title}
- Directive ID: ${directive.id}
- Approved Plan:
${directive.plan || "(no plan — quick directive)"}

IMPLEMENTATION CHECKLIST — Follow this order:
1. Read CLAUDE.md for project context
2. RESEARCH FIRST: Read the FULL files you'll modify (Glob, Grep, Read). Understand existing
   patterns before writing code. Check for recent changes: git log --oneline -5 -- <file>
3. CHECK FOR CONCURRENT EDITS: Run git status. If files have uncommitted changes, another agent
   is working. Use git stash before editing, git stash pop after.
4. Implement the changes — match existing code style and patterns
5. VERIFY before committing:
   - JS files: node -c <file> (syntax check — catches most errors)
   - Bridge endpoints: curl -s localhost:3333/<endpoint> (smoke test)
   - Frontend: npx tsc --noEmit (type check) if touching .ts files
6. Commit: git add <SPECIFIC files only> && git commit -m "descriptive message\\n\\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
   NEVER use git add . or git add -A — you will commit another agent's work-in-progress
7. Push: git push origin main (if fails: git stash && git pull --rebase origin main && git stash pop && git push)
8. Post status: curl -s -X POST ${BRIDGE}/status -H 'Content-Type: application/json' -d '{"message":"<summary>","directiveId":"${directive.id}"}'
9. Mark complete: curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"completed"}'

CRITICAL: Steps 6-9 are MANDATORY. You MUST commit and push before marking complete. Uncommitted changes are LOST when you exit.
After you mark complete, smartDeploy handles everything: OTA deploy for JS changes, CI build for native changes, bridge restart if server code changed. You do NOT need to do any of that.

ENGINEERING PATTERNS — Think like an expert:

UNDERSTAND STATE BEFORE CHANGING IT:
- cipher-pipeline.js has a turn-based state machine: _turn (cipher/user), _ttsActive,
  _ttsFlushing, _interrupted, _turnReady. Every change must consider all states.
- server.js has: persona state (june/cipher), connection state (geminiWs, cipherPipeline),
  mic arbitration (activeMic, activeMicSilenceSince). Don't break these.
- Ask: "What state is the system in when this code runs? What other states could it be in?"

TRACE THE FULL FLOW:
- Audio: tablet mic → WS → server (getPeakAmplitude, amplify) → cipherPipeline.sendAudio() →
  Deepgram STT → UtteranceEnd → _enqueueUserMessage → Claude SDK → text deltas → Deepgram TTS →
  Audio events → _emitBufferedAudio → WS → tablet speaker
- Directives: voice/API → POST /directives → spawnPlanningAgent → claude CLI → PATCH status →
  PIN approval → spawnImplementationAgent → claude CLI → PATCH completed → smartDeploy
- When fixing a bug in one stage, check what upstream sends and what downstream expects.

COMMON MISTAKES TO AVOID:
- Editing server.js without checking git status → overwrites another agent's uncommitted work
- Using git add . → commits .env, node_modules, or WIP from concurrent agents
- Trying to restart bridge or deploy manually → smartDeploy handles this, your process dies if you restart
- Adding error handling for impossible cases → over-engineering, adds noise
- Refactoring surrounding code → scope creep, merge conflicts with concurrent agents
- Not syntax-checking → breaks the bridge on restart, requires manual recovery
- Guessing at file locations → use Glob/Grep to find the actual path first

RACE CONDITIONS — Known patterns:
- Persona switching: personaSwitchPending, _geminiReconnectTimer, and cipherPipeline="starting"
  sentinel must all be managed together. A failed switchPersona can leave flags stuck.
- Gemini reconnect: auto-reconnect fires 2s after close. Persona switch MUST cancel the timer
  or the old persona reconnects after switching.
- Device registration: new devices connecting during persona switch can trigger wrong backend.
  Check personaSwitchPending before starting AI sessions.
- Bulk operations: modifying arrays during iteration shifts indices. Collect changes, apply once.
- Washer reconnect: set washerReconnectInProgress BEFORE the async ping check, not after.
  Multiple callers can enter between check and flag-set if flag is set late.

SECURITY PATTERNS:
- HTML attributes: escapeHtml() for content, escapeHtml(escapeJsString()) for inline JS handlers
- Command validation: redirect targets (> and >>) must be path-whitelisted
- File serving: use path.resolve() not path.join() for traversal prevention
- Status validation: whitelist valid values, don't accept arbitrary strings from agents/API
- Auth: all mutating dashboard endpoints need requireAuth(req, res)

ASYNC/SYNC TRAPS:
- fs.readFileSync/existsSync block the event loop — use fs.promises.readFile/access in request handlers
- execSync blocks ALL connections (audio, WebSocket, HTTP) — use promisified exec/execFile
- setInterval callbacks that call async functions: wrap in try/catch or sync errors kill the timer
- fetch() without AbortController: can hang forever if API is down
- Tool calls from Claude SDK have no built-in timeout — wrap in Promise.race with timeout

MEMORY LEAK PATTERNS:
- Maps tracking per-device state (audioStats, devices): must be cleaned up in ws.on("close")
- Event listeners on Deepgram STT/TTS: removeAllListeners() before creating new connection
- Audio buffers: enforce maximum size (48KB = 1s of audio) to prevent OOM during TTS flood
- setInterval: always store return value in _intervals array so graceful shutdown can clear them
- Pending message queues (frontend): cap at max size (20) and drop oldest when full

REACT PATTERNS:
- Rules of Hooks: useWindowDimensions() must be called BEFORE any early return statement.
  if (!visible) return null AFTER the hook call, not before.
- Animation cleanup: store Animated.parallel/sequence result, return () => anim.stop() from useEffect
- Stale closures: use useRef() to shadow state values captured in useEffect([], [])
- Frontend fetch: add AbortController timeout to all bridge-api calls (15s)
- WebSocket callbacks: wrap in try-catch to prevent handler crash on callback error

MEASURE YOUR IMPACT:
- Add logging with concrete numbers: "[cipher] Latency: 340ms" not "latency improved"
- When modifying performance-sensitive code, log before/after metrics
- For database changes, estimate row counts and query cost

AUTONOMY RULES — You have FULL autonomy:
- Read/write/edit files, git operations, npm/pip, builds, docker, SSH — just do it
- Do NOT ask for approval. Do NOT give up. Find a way.
- Only escalate via POST ${BRIDGE}/notify for: infrastructure changes, missing credentials, irreversible destructive operations
- DO NOT tell King Kazuma to "do it manually." Handle it yourself.

REAL-TIME STATUS UPDATES — Post status at each major step so progress is visible in /dashboard:
  curl -s -X POST ${BRIDGE}/status -H 'Content-Type: application/json' -d '{"message":"<what you are doing>","directiveId":"${directive.id}"}'
Examples of when to post: starting research, reading key files, beginning implementation, running tests, committing, deploying.`;
}

// Spawn a claude CLI subprocess for a directive
function spawnAgent(directive, type) {
  // Guard: don't double-spawn (optimistic lock — placeholder set immediately to prevent races)
  if (runningAgents.has(directive.id)) {
    log(`SKIP: Agent already running for ${directive.id} (${runningAgents.get(directive.id).type})`);
    return null;
  }

  // Guard: concurrency limit — directive stays in current state, picked up when a slot opens
  if (runningAgents.size >= _config.MAX_CONCURRENT_AGENTS) {
    log(`QUEUED: Concurrency limit reached (${runningAgents.size}/${_config.MAX_CONCURRENT_AGENTS}), deferring ${directive.id} "${directive.title}"`);
    return null;
  }

  // Optimistic lock: claim the slot immediately to prevent double-spawn between
  // the guard check above and the actual runningAgents.set() below
  runningAgents.set(directive.id, { type, startedAt: new Date().toISOString(), pid: null, placeholder: true });

  ensureLogDir();
  const logFile = path.join(LOG_DIR, `agent-${directive.id}.log`);

  // Rotate log if it exceeds MAX_LOG_SIZE
  try {
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile);
      if (stat.size > MAX_LOG_SIZE) {
        const oldFile = logFile + ".old";
        fs.renameSync(logFile, oldFile);
        log(`Rotated log for ${directive.id} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      }
    }
  } catch (err) {
    log(`Log rotation error for ${directive.id}: ${err.message}`);
  }

  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  const prompt = type === "planning"
    ? buildPlanningPrompt(directive)
    : buildImplementationPrompt(directive);

  // All directive agents use Opus for strongest reasoning
  const model = "opus";
  const args = [
    "--model", model,
    "--allowedTools", "Bash Read Write Edit Glob Grep WebFetch WebSearch",
    "-p", prompt,
  ];

  log(`Spawning ${type} agent for "${directive.title}" (${directive.id}) [model: ${model}]`);
  logStream.write(`\n=== ${type} agent started at ${new Date().toISOString()} ===\n`);

  // Unset CLAUDECODE to prevent nested session issues (same as cipher-watcher.sh line 114)
  const env = { ...process.env };
  delete env.CLAUDECODE;

  let child;
  try {
    child = spawn("claude", args, {
      cwd: WORKDIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    log(`SPAWN FAILED for ${directive.id}: ${err.message}`);
    runningAgents.delete(directive.id); // Release optimistic lock
    logStream.end();
    return null;
  }

  // Handle spawn errors (e.g., ENOENT, EACCES)
  child.on("error", (err) => {
    log(`SPAWN ERROR for ${directive.id}: ${err.message}`);
    logStream.write(`\n=== Spawn error: ${err.message} ===\n`);
  });

  // Pipe output to log file
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  // Set timeout
  const agentTimeout = _config.AGENT_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => {
    log(`TIMEOUT: Killing ${type} agent for ${directive.id} (exceeded ${agentTimeout / 60000}min)`);
    logStream.write(`\n=== TIMEOUT: Agent killed after ${agentTimeout / 60000} minutes ===\n`);
    const info = runningAgents.get(directive.id);
    if (info) info.killReason = `timeout: exceeded ${agentTimeout / 60000}min`;
    child.kill("SIGTERM");

    // SIGKILL fallback if SIGTERM doesn't work
    // Note: child.killed is true immediately after .kill() call, so we use
    // process.kill(pid, 0) to check if the process is actually still alive
    setTimeout(() => {
      try {
        process.kill(child.pid, 0); // throws ESRCH if process is gone
        child.kill("SIGKILL");
        log(`SIGKILL sent to ${type} agent for ${directive.id}`);
      } catch (e) { /* process already gone (ESRCH) or no permission */ }
    }, SIGKILL_GRACE_MS);
  }, agentTimeout);

  const agentInfo = {
    process: child,
    type,
    startedAt: new Date().toISOString(),
    pid: child.pid,
    timeout: timeoutHandle,
    logFile,
    killReason: null, // Set by timeout/watchdog before kill, read by close handler
  };

  runningAgents.set(directive.id, agentInfo);

  // Broadcast agent spawn event
  if (_broadcastToAll) {
    _broadcastToAll({
      type: "agentUpdate",
      directiveId: directive.id,
      event: "spawned",
      pid: child.pid,
    });
  }

  // Handle process exit
  child.on("close", (code, signal) => {
    clearTimeout(timeoutHandle);
    runningAgents.delete(directive.id);
    logStream.write(`\n=== Agent exited: code=${code} signal=${signal} ===\n`);
    logStream.end();

    log(`Agent exited for ${directive.id}: code=${code} signal=${signal}`);

    // Broadcast agent exit event
    if (_broadcastToAll) {
      _broadcastToAll({
        type: "agentUpdate",
        directiveId: directive.id,
        event: "exited",
        pid: agentInfo.pid,
      });
    }

    // Slot opened — check for deferred directives after a short delay
    // (delay lets the directive status reset complete first)
    setTimeout(() => drainQueue(), 2000);

    // On non-zero exit (crash/timeout), reset directive to recoverable state
    if (code !== 0) {
      const failStatus = type === "planning" ? "pending" : "stale";
      // Determine failure reason from killReason (set by timeout/watchdog) or exit code
      const failureReason = agentInfo.killReason
        || (signal === "SIGTERM" ? "killed: SIGTERM" : `crash: exit code ${code}`);
      const errorNote = signal === "SIGTERM" ? "Agent timed out" : `Agent crashed (exit ${code})`;
      log(`Resetting ${directive.id} to ${failStatus}: ${errorNote} (reason: ${failureReason})`);

      // PATCH the directive back to recoverable state with failure reason
      const payload = JSON.stringify({ status: failStatus, failureReason });
      const req = require("http").request(
        `${BRIDGE}/directives/${directive.id}`,
        { method: "PATCH", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
        (res) => {
          let body = "";
          res.on("data", (d) => body += d);
          res.on("end", () => log(`Reset ${directive.id} → ${failStatus}: ${res.statusCode}`));
        }
      );
      req.on("error", (err) => log(`Failed to reset ${directive.id}: ${err.message}`));
      req.write(payload);
      req.end();
    } else {
      // Agent exited cleanly (code 0) — verify directive was properly completed.
      // If still in a transient state, the agent forgot to PATCH it.
      const http = require("http");
      http.get(`${BRIDGE}/directives`, (res) => {
        let body = "";
        res.on("data", (d) => body += d);
        res.on("end", () => {
          try {
            const directives = JSON.parse(body);
            const current = directives.find(d => d.id === directive.id);
            if (!current) return;

            if (current.status === "in_progress" || current.status === "planning") {
              const resetTo = current.status === "planning" ? "pending" : "stale";
              const failureReason = "crash: agent exited without completing (exit code 0)";
              log(`Post-exit check: ${directive.id} still "${current.status}" after clean exit → resetting to "${resetTo}"`);
              const payload = JSON.stringify({ status: resetTo, failureReason });
              const req = http.request(
                `${BRIDGE}/directives/${directive.id}`,
                { method: "PATCH", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
                (patchRes) => {
                  let b = "";
                  patchRes.on("data", (d) => b += d);
                  patchRes.on("end", () => log(`Post-exit reset ${directive.id} → ${resetTo}: ${patchRes.statusCode}`));
                }
              );
              req.on("error", (e) => log(`Post-exit reset failed for ${directive.id}: ${e.message}`));
              req.write(payload);
              req.end();
            } else if (current.status === "completed" && type === "implementation") {
              // Properly completed — trigger smart deploy
              smartDeploy(directive);
            }
          } catch (e) {
            log(`Post-exit check parse error for ${directive.id}: ${e.message}`);
          }
        });
      }).on("error", (e) => log(`Post-exit check failed for ${directive.id}: ${e.message}`));
    }
  });

  return child;
}

// After an agent exits and a slot opens, look for pending/approved directives to spawn
function drainQueue() {
  if (runningAgents.size >= _config.MAX_CONCURRENT_AGENTS) return;

  const http = require("http");
  http.get(`${BRIDGE}/directives`, (res) => {
    let body = "";
    res.on("data", (d) => body += d);
    res.on("end", () => {
      try {
        const directives = JSON.parse(body);
        // Sort by priority (lower = higher priority)
        directives.sort((a, b) => (a.priority || 3) - (b.priority || 3));

        for (const d of directives) {
          if (runningAgents.size >= _config.MAX_CONCURRENT_AGENTS) break;
          if (runningAgents.has(d.id)) continue;

          // Enforce dependency chain — skip directives whose deps aren't completed
          if (Array.isArray(d.dependsOn) && d.dependsOn.length > 0) {
            const unmetDeps = d.dependsOn.filter(depId => {
              const dep = directives.find(dd => dd.id === depId);
              return !dep || dep.status !== "completed";
            });
            if (unmetDeps.length > 0) {
              continue; // Skip — dependencies not yet satisfied
            }
          }

          if (d.status === "planning") {
            log(`Drain: picking up deferred planning directive ${d.id} "${d.title}"`);
            spawnAgent(d, "planning");
          } else if (d.status === "approved") {
            log(`Drain: picking up deferred approved directive ${d.id} "${d.title}"`);
            spawnAgent(d, "implementation");
          }
        }
      } catch (e) {
        log(`Drain: failed to parse directives: ${e.message}`);
      }
    });
  }).on("error", (e) => log(`Drain: failed to fetch directives: ${e.message}`));
}

function spawnPlanningAgent(directive) {
  // For quick directives, mark as planning first (they'll self-transition)
  return spawnAgent(directive, "planning");
}

function spawnImplementationAgent(directive) {
  return spawnAgent(directive, "implementation");
}

function getRunningAgents() {
  const result = [];
  for (const [directiveId, info] of runningAgents) {
    result.push({
      directiveId,
      type: info.type,
      startedAt: info.startedAt,
      pid: info.pid,
      logFile: info.logFile,
    });
  }
  return result;
}

function killAgent(directiveId) {
  const agent = runningAgents.get(directiveId);
  if (!agent) return false;

  log(`Killing agent for ${directiveId} (pid ${agent.pid})`);
  agent.process.kill("SIGTERM");

  // SIGKILL fallback — use process.kill(pid, 0) to check if still alive
  // (agent.process.killed is true immediately after .kill() call)
  setTimeout(() => {
    try {
      process.kill(agent.pid, 0); // throws ESRCH if process is gone
      agent.process.kill("SIGKILL");
    } catch (e) { /* already gone (ESRCH) or no permission */ }
  }, SIGKILL_GRACE_MS);

  return true;
}

// Kill all running agents (called on server shutdown)
function killAllAgents() {
  for (const [directiveId] of runningAgents) {
    killAgent(directiveId);
  }
}

// ── Smart deploy (ported from cipher-watcher.sh) ──

// Returns { android: bool, ios: bool, any: bool } indicating which platforms have native changes
function detectNativeChanges() {
  try {
    const { execSync } = require("child_process");
    const changed = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: WORKDIR, encoding: "utf8", timeout: 10000,
    }).trim();

    if (!changed) return { android: false, ios: false, any: false };

    const lines = changed.split("\n");
    let android = false, ios = false;

    // Patterns that affect only one platform
    const androidOnly = [/frontend\/modules\/.*\/android\//, /frontend\/android\//];
    const iosOnly = [/frontend\/modules\/.*\/ios\//, /frontend\/ios\//];
    // Patterns that affect both platforms
    const both = [/frontend\/app\.json/, /frontend\/plugins\//];

    for (const line of lines) {
      for (const p of androidOnly) { if (p.test(line)) android = true; }
      for (const p of iosOnly) { if (p.test(line)) ios = true; }
      for (const p of both) { if (p.test(line)) { android = true; ios = true; } }
    }

    // Native dependency added = both platforms
    if (changed.includes("frontend/package.json")) {
      const pkgDiff = execSync("git diff HEAD~1 HEAD -- frontend/package.json", {
        cwd: WORKDIR, encoding: "utf8", timeout: 10000,
      });
      if (/^\+.*"(expo-|react-native-|@react-native)/m.test(pkgDiff)) {
        android = true;
        ios = true;
      }
    }

    return { android, ios, any: android || ios };
  } catch {
    return { android: false, ios: false, any: false };
  }
}

function detectBridgeChanges() {
  try {
    const { execSync } = require("child_process");
    const changed = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: WORKDIR, encoding: "utf8", timeout: 10000,
    }).trim();
    if (!changed) return false;
    const bridgePatterns = [/backend\/bridge\/server\.js/, /backend\/bridge\/cipher-pipeline\.js/, /backend\/bridge\/agent-spawner\.js/, /backend\/bridge\/db\.js/];
    return changed.split("\n").some(line => bridgePatterns.some(p => p.test(line)));
  } catch {
    return false;
  }
}

function smartDeploy(directive) {
  const { execSync, exec } = require("child_process");
  const http = require("http");

  const notify = (message) => {
    const payload = JSON.stringify({ message });
    const req = http.request(
      `${BRIDGE}/notify`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
    );
    req.on("error", () => {});
    req.write(payload);
    req.end();
  };

  // Check if bridge server code changed — needs restart
  const bridgeChanged = detectBridgeChanges();

  const native = detectNativeChanges();
  if (native.any) {
    const platforms = [native.android && "Android", native.ios && "iOS"].filter(Boolean).join(" + ");
    log(`Native changes detected (${platforms}) — triggering CI builds`);
    notify(`Native changes detected (${platforms}) — CI builds started, ~10 minutes.`);

    // Android APK build + deploy (with artifact verification)
    if (native.android) {
      const androidCmd = [
        `sleep 15`,
        `cd ${WORKDIR}`,
        `RUN_ID=$(gh run list --workflow=build-android.yml --limit 1 --json databaseId --jq '.[0].databaseId')`,
        `gh run watch "$RUN_ID" --exit-status`,
        // Verify artifact can be downloaded and is valid before deploying
        `rm -rf /tmp/ozzu-apk-verify`,
        `gh run download "$RUN_ID" --name ozzu-android --dir /tmp/ozzu-apk-verify -R ozzuworld/ozzu`,
        `test -f /tmp/ozzu-apk-verify/app-debug.apk || { echo "ERROR: APK artifact not found after download"; exit 1; }`,
        `APK_SIZE=$(stat -c%s /tmp/ozzu-apk-verify/app-debug.apk 2>/dev/null || echo 0)`,
        `test "$APK_SIZE" -gt 1000000 || { echo "ERROR: APK too small ($APK_SIZE bytes), likely corrupt"; exit 1; }`,
        `rm -rf /tmp/ozzu-apk-verify`,
        `./scripts/deploy.sh`,
      ].join(" && ");

      exec(androidCmd, {
        cwd: WORKDIR,
        timeout: 30 * 60 * 1000,
      }, (err) => {
        if (err) {
          log(`Android deploy failed: ${err.message}`);
          notify(`Android CI build/deploy failed: ${err.message}`);
        } else {
          log("Android APK deployed successfully");
          notify("Android APK deployed! Update installed on all tablets.");
        }
      });
    }

    // iOS IPA build + deploy via dev-01 (with artifact verification)
    if (native.ios) {
      const iosCmd = [
        `cd ${WORKDIR}`,
        `gh workflow run build-ios.yml`,
        `sleep 20`,
        `RUN_ID=$(gh run list --workflow=build-ios.yml --limit 1 --json databaseId --jq '.[0].databaseId')`,
        `gh run watch "$RUN_ID" --exit-status`,
        // Verify artifact can be downloaded and is valid before deploying
        `rm -rf /tmp/ozzu-ios-verify`,
        `gh run download "$RUN_ID" --name ozzu-ios --dir /tmp/ozzu-ios-verify -R ozzuworld/ozzu`,
        `test -f /tmp/ozzu-ios-verify/ozzu.ipa || { echo "ERROR: IPA artifact not found after download"; exit 1; }`,
        `IPA_SIZE=$(stat -c%s /tmp/ozzu-ios-verify/ozzu.ipa 2>/dev/null || echo 0)`,
        `test "$IPA_SIZE" -gt 1000000 || { echo "ERROR: IPA too small ($IPA_SIZE bytes), likely corrupt"; exit 1; }`,
        `rm -rf /tmp/ozzu-ios-verify`,
        `./scripts/deploy-ios.sh`,
      ].join(" && ");

      exec(iosCmd, {
        cwd: WORKDIR,
        timeout: 30 * 60 * 1000,
      }, (err) => {
        if (err) {
          log(`iOS deploy failed: ${err.message}`);
          notify(`iOS CI build/deploy failed: ${err.message}`);
        } else {
          log("iOS IPA deployed successfully");
          notify("iOS app deployed! Update installed on iPhone.");
        }
      });
    }
  } else {
    log("JS-only changes — deploying via OTA");
    notify("JS-only changes — deploying instantly via OTA update...");

    exec(`cd ${WORKDIR} && ./scripts/ota-deploy.sh --restart`, {
      cwd: WORKDIR,
      timeout: 5 * 60 * 1000, // 5 min max
    }, (err) => {
      if (err) {
        log(`OTA deploy failed: ${err.message}`);
        notify("OTA deploy failed. May need a full APK rebuild.");
      } else {
        log("OTA deploy complete");
        notify("OTA update deployed! All devices are restarting with the new version now.");
      }
    });
  }

  // Bridge restart — do this LAST (kills this process, Docker auto-restarts)
  if (bridgeChanged) {
    const restartDelay = native.any ? 5000 : 3000; // Wait for deploy to start first
    log(`Bridge code changed — scheduling restart in ${restartDelay}ms`);
    notify("Bridge server code was updated — restarting to load changes...");
    setTimeout(() => {
      log("Triggering bridge restart via POST /restart");
      const payload = JSON.stringify({});
      const key = process.env.BRIDGE_API_KEY || "";
      const req = http.request(
        `${BRIDGE}/restart`,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...(key ? { Authorization: `Bearer ${key}` } : {}) } },
        (res) => { res.on("data", () => {}); }
      );
      req.on("error", (e) => log(`Bridge restart request failed: ${e.message}`));
      req.write(payload);
      req.end();
    }, restartDelay);
  }
}

// ── Watchdog: periodic liveness check for running agents ──

function startWatchdog() {
  log(`Watchdog started (interval: ${_config.WATCHDOG_INTERVAL_MS / 60000}min, stall threshold: ${_config.STALL_THRESHOLD_MS / 60000}min)`);
  setInterval(() => {
    for (const [directiveId, info] of runningAgents) {
      try {
        process.kill(info.pid, 0); // signal 0 = check existence
        const runtime = Math.round((Date.now() - new Date(info.startedAt).getTime()) / 60000);
        log(`Watchdog: ${directiveId} (${info.type}) alive — pid ${info.pid}, ${runtime}min`);

        // Stall detection: check if directive has had recent activity
        const http = require("http");
        http.get(`${BRIDGE}/directives`, (res) => {
          let body = "";
          res.on("data", (d) => body += d);
          res.on("end", () => {
            try {
              const directives = JSON.parse(body);
              const d = directives.find(x => x.id === directiveId);
              if (!d || !d.lastActivity) return;
              const idleMs = Date.now() - d.lastActivity;
              if (idleMs > _config.STALL_THRESHOLD_MS) {
                const stallMin = Math.round(idleMs / 60000);
                log(`Watchdog: ${directiveId} STALLED — pid ${info.pid} alive but no activity for ${stallMin}min, killing`);
                info.killReason = `watchdog: stalled for ${stallMin}min`;
                info.process.kill("SIGTERM");
                // SIGKILL fallback — use process.kill(pid, 0) to check if still alive
                setTimeout(() => {
                  try {
                    process.kill(info.pid, 0); // throws ESRCH if gone
                    info.process.kill("SIGKILL");
                  } catch (e) { /* already gone */ }
                }, SIGKILL_GRACE_MS);
              }
            } catch (e) { /* parse error, skip */ }
          });
        }).on("error", () => {});
      } catch (err) {
        if (err.code === "ESRCH") {
          log(`Watchdog: ${directiveId} (${info.type}) DEAD — pid ${info.pid} gone, cleaning up`);
          clearTimeout(info.timeout);
          runningAgents.delete(directiveId);

          // Reset directive to recoverable state with failure reason
          const resetStatus = info.type === "planning" ? "pending" : "stale";
          const failureReason = info.killReason || "crash: process disappeared";
          const payload = JSON.stringify({ status: resetStatus, failureReason });
          const req = require("http").request(
            `${BRIDGE}/directives/${directiveId}`,
            { method: "PATCH", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
            (res) => {
              let body = "";
              res.on("data", (d) => body += d);
              res.on("end", () => log(`Watchdog: reset ${directiveId} → ${resetStatus}: ${res.statusCode}`));
            }
          );
          req.on("error", (e) => log(`Watchdog: failed to reset ${directiveId}: ${e.message}`));
          req.write(payload);
          req.end();
        }
      }
    }
  }, _config.WATCHDOG_INTERVAL_MS);
}

module.exports = {
  spawnPlanningAgent,
  spawnImplementationAgent,
  getRunningAgents,
  killAgent,
  killAllAgents,
  startWatchdog,
  setBroadcast,
  getConfig,
  setConfig,
};
