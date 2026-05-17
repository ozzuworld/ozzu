// agent-spawner.js — Directive infrastructure: merge, deploy, cleanup utilities
// Worker agent spawning is DISABLED — Cipher handles directives directly.
// Kept: smartDeploy, mergeWorktreeToMain, cleanupWorktree, cleanupStaleBranches

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const metrics = require("./metrics-tracker");
const { getDevice } = require("./lib/devices");

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

// Branches awaiting merge — prevents cleanupStaleBranches from deleting them
// between agent exit (runningAgents.delete) and merge completion
const pendingMerges = new Set();

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
3. ${directive.type === "quick" ? `Commit: git add <specific files> && git commit -m "descriptive message\\n\\nDirective: ${directive.id}\\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"` : "Skip commit (no code changes)"}
4. ${directive.type === "quick" ? "Push: git push origin HEAD" : "Skip push"}
5. VERIFY SUCCESS CRITERIA: Re-read the directive description. Check EVERY success criterion listed. If any criterion is not met, you MUST NOT mark as completed.
6. VERIFY BUILD: curl -s -X POST ${BRIDGE}/directives/${directive.id}/verify -H 'Content-Type: application/json' -d '{}' — You MUST run this and it MUST return "success":true before marking completed. The server REJECTS completion without verification.
7. Mark complete: curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"completed"${directive.type === "explore" ? ',"plan":"<your findings in markdown>"' : ""}}'

CRITICAL RULES:
- You MUST commit and push before marking complete. Uncommitted changes are lost.
- Do NOT restart the bridge yourself — smartDeploy handles it automatically after you mark the directive completed.
- Do NOT deploy manually — smartDeploy detects what changed and deploys appropriately (OTA for JS, CI build for native).
- Just commit, push, and mark complete. The pipeline handles the rest.
- Always git pull --rebase before pushing if the push fails.

BLOCKED DIRECTIVE RULE — READ THIS CAREFULLY:
- If you hit a blocker you CANNOT resolve yourself (missing credentials, needs manual OAuth/browser auth, needs physical access, needs King Kazuma's intervention), mark the directive as BLOCKED — not completed:
  curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"blocked","failureReason":"<what is blocking and what King Kazuma needs to do>"}'
- NEVER mark a directive as "completed" while listing "remaining manual steps." That is a contradiction. If steps remain, it is NOT completed.
- Do as much as you CAN, commit and push that work, then mark blocked with a clear explanation.
- Also escalate via POST ${BRIDGE}/notify so King Kazuma is alerted immediately.
` : "";

  return `You are Cipher, the autonomous dev agent for the ozzu project.
Read CLAUDE.md at /home/gcp/ozzu/CLAUDE.md FIRST — it has all project context.

SYSTEM ARCHITECTURE:
- Infra topology: canonical at /home/gcp/ozzu/infra/devices.json (machine-readable). Prose context: ~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md. READ ONE OF THESE before assuming any IP/hostname.
- Bridge runs in Docker. Do NOT restart it yourself — smartDeploy auto-restarts after you mark complete.
- Frontend: Expo React Native. CI builds on push to main. smartDeploy auto-deploys after you mark complete.
- Bridge API: /directives, /status, /notify, /approvals, /health, /dashboard

A new ${directive.type} directive:
- Title: ${directive.title}
- Description: ${directive.description}${directive.context ? `\n- User Context (King Kazuma's original words and intent): ${directive.context}` : ""}
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

GIT WORKTREE — You are running in an ISOLATED worktree with your own branch:
- Your working directory is a git worktree, NOT the main repo. You have your own branch.
- Commit and push normally: git add <specific files> && git commit && git push origin HEAD
- Do NOT push to origin/main directly. The system merges your branch to main after you finish.
- Do NOT worry about concurrent edits from other agents — worktrees provide full isolation.
- If git push fails: git pull --rebase origin HEAD && git push origin HEAD

TROUBLESHOOTING:
- File not found? Search with Glob/Grep before assuming it doesn't exist
- Command failed? Read the error, try a different approach
- git push failed? Run: git pull --rebase && git push origin HEAD
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
- Infra topology: canonical at /home/gcp/ozzu/infra/devices.json (machine-readable). Prose context: ~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md. READ ONE OF THESE before assuming any IP/hostname.
- Bridge runs in Docker. Do NOT restart it yourself — smartDeploy auto-restarts after you mark complete.
- Frontend: Expo React Native. Do NOT deploy manually — smartDeploy auto-deploys after you mark complete.
- Bridge API at ${BRIDGE} has endpoints: /directives, /status, /notify, /approvals, /health

Implement this approved directive:
- Title: ${directive.title}
- Directive ID: ${directive.id}${directive.context ? `\n- User Context (King Kazuma's original words and intent): ${directive.context}` : ""}
- Approved Plan:
${directive.plan || "(no plan — quick directive)"}

IMPLEMENTATION CHECKLIST — Follow this order:
1. Read CLAUDE.md for project context
2. RESEARCH FIRST: Read the FULL files you'll modify (Glob, Grep, Read). Understand existing
   patterns before writing code. Check for recent changes: git log --oneline -5 -- <file>
3. Implement the changes — match existing code style and patterns
4. VERIFY before committing:
   - JS files: node -c <file> (syntax check — catches most errors)
   - Bridge endpoints: curl -s localhost:3333/<endpoint> (smoke test)
   - Frontend: npx tsc --noEmit (type check) if touching .ts files
5. Commit: git add <SPECIFIC files only> && git commit -m "descriptive message\\n\\nDirective: ${directive.id}\\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
6. Push: git push origin HEAD (if fails: git pull --rebase && git push origin HEAD)
7. VERIFY BUILD: curl -s -X POST ${BRIDGE}/directives/${directive.id}/verify -H 'Content-Type: application/json' -d '{}'
   You MUST run this and it MUST return "success":true before marking completed. The server REJECTS completion without verification.
8. VERIFY SUCCESS CRITERIA: Re-read the directive description. Check EVERY success criterion. If any criterion is not met and you cannot fix it, use "blocked" status (see below), NOT "completed".
9. Post status: curl -s -X POST ${BRIDGE}/status -H 'Content-Type: application/json' -d '{"message":"<summary>","directiveId":"${directive.id}"}'
10. Mark complete: curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"completed"}'

CRITICAL: Steps 5-6 are MANDATORY. You MUST commit and push before marking complete. Uncommitted changes are LOST when your worktree is deleted.
After you mark complete, the system merges your branch to main, then smartDeploy handles everything: OTA deploy for JS changes, CI build for native changes, bridge restart if server code changed. You do NOT need to do any of that.

BLOCKED DIRECTIVE RULE — READ THIS CAREFULLY:
- If you hit a blocker you CANNOT resolve (missing credentials, needs manual OAuth/browser auth, needs physical device access, needs King Kazuma's action), mark the directive as BLOCKED:
  curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"blocked","failureReason":"<what is blocking and what King Kazuma needs to do>"}'
- NEVER mark a directive as "completed" while listing "remaining manual steps." If there are steps you can't do, the directive is BLOCKED, not completed.
- Do as much as you CAN (code, commit, push), then mark blocked with a clear explanation of what remains.
- Also escalate via: curl -s -X POST ${BRIDGE}/notify -H 'Content-Type: application/json' -d '{"message":"<directive title> needs your help: <what to do>"}'

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

GIT WORKTREE — You are running in an ISOLATED worktree with your own branch:
- Your working directory is a git worktree, NOT the main repo. You have your own branch.
- Commit and push normally: git add <specific files> && git commit && git push origin HEAD
- Do NOT push to origin/main directly. The system merges your branch to main after you finish.
- Do NOT worry about concurrent edits from other agents — worktrees provide full isolation.

COMMON MISTAKES TO AVOID:
- Trying to restart bridge or deploy manually → smartDeploy handles this, your process dies if you restart
- Adding error handling for impossible cases → over-engineering, adds noise
- Refactoring surrounding code → scope creep
- Not syntax-checking → breaks the bridge on restart, requires manual recovery
- Guessing at file locations → use Glob/Grep to find the actual path first
- Pushing to origin/main directly → push to origin HEAD, the system merges your branch

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

// ── Git worktree isolation ──
// Each agent gets its own worktree so they never conflict with each other or the main tree.
// Flow: create worktree → agent works in isolation → merge to main → delete worktree
// CRITICAL: If worktree creation fails, agents must NOT run — they'd commit directly to main.

const WORKTREE_DIR = "/tmp/ozzu-worktrees";

// Prune stale worktree references (dead dirs, orphaned lock files)
function pruneWorktrees() {
  const { execSync } = require("child_process");
  try {
    execSync("git worktree prune", { cwd: WORKDIR, timeout: 10000, stdio: "ignore" });
  } catch (err) {
    log(`Worktree prune failed: ${err.message}`);
  }
}

// Force-remove a branch, even if checked out in a stale worktree
function forceRemoveBranch(branchName) {
  const { execSync } = require("child_process");
  try {
    execSync(`git branch -D "${branchName}"`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" });
  } catch {
    // Branch might be checked out in a worktree — find and remove that worktree first
    try {
      const list = execSync("git worktree list --porcelain", { cwd: WORKDIR, timeout: 10000, encoding: "utf8" });
      let currentWtDir = null;
      for (const line of list.split("\n")) {
        if (line.startsWith("worktree ")) currentWtDir = line.slice(9);
        if (line.startsWith("branch refs/heads/") && line.slice(18) === branchName && currentWtDir) {
          log(`Branch ${branchName} checked out in stale worktree ${currentWtDir} — removing`);
          try { execSync(`git worktree remove --force "${currentWtDir}"`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" }); } catch {}
          try { fs.rmSync(currentWtDir, { recursive: true, force: true }); } catch {}
        }
      }
      // Prune after removing stale worktree, then retry branch delete
      pruneWorktrees();
      execSync(`git branch -D "${branchName}"`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" });
    } catch {
      // Branch may not exist at all — that's fine
    }
  }
}

function createWorktree(directiveId) {
  const { execSync } = require("child_process");
  const wtDir = path.join(WORKTREE_DIR, directiveId);

  try {
    // Prune stale worktree references first
    pruneWorktrees();

    // Clean up stale worktree directory if it exists
    if (fs.existsSync(wtDir)) {
      try { execSync(`git worktree remove --force "${wtDir}"`, { cwd: WORKDIR, timeout: 10000 }); } catch {}
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
    }

    // Ensure worktree parent dir exists
    if (!fs.existsSync(WORKTREE_DIR)) fs.mkdirSync(WORKTREE_DIR, { recursive: true });

    // Force-remove the branch (handles stale worktree checkouts)
    const branchName = `agent/${directiveId}`;
    forceRemoveBranch(branchName);

    // Use --no-checkout to avoid git-crypt smudge filter failures on encrypted files
    execSync(`git worktree add --no-checkout -b "${branchName}" "${wtDir}" HEAD`, { cwd: WORKDIR, timeout: 30000 });
    // Checkout with git-crypt filter disabled — agents don't need decrypted secrets
    execSync(`git -c filter.git-crypt.smudge=cat -c filter.git-crypt.clean=cat -c filter.git-crypt.required=false checkout HEAD -- .`, { cwd: wtDir, timeout: 30000 });
    log(`Worktree created: ${wtDir} (branch: ${branchName})`);
    return { dir: wtDir, branch: branchName };
  } catch (err) {
    // Last resort: try with a unique suffix to avoid any name collision
    const suffix = Date.now().toString(36);
    const uniqueBranch = `agent/${directiveId}-${suffix}`;
    const uniqueDir = `${wtDir}-${suffix}`;
    try {
      log(`Worktree creation failed for ${directiveId} (${err.message}), retrying with unique name: ${uniqueBranch}`);
      execSync(`git worktree add --no-checkout -b "${uniqueBranch}" "${uniqueDir}" HEAD`, { cwd: WORKDIR, timeout: 30000 });
      execSync(`git -c filter.git-crypt.smudge=cat -c filter.git-crypt.clean=cat -c filter.git-crypt.required=false checkout HEAD -- .`, { cwd: uniqueDir, timeout: 30000 });
      log(`Worktree created (retry): ${uniqueDir} (branch: ${uniqueBranch})`);
      return { dir: uniqueDir, branch: uniqueBranch };
    } catch (err2) {
      log(`Worktree creation FAILED for ${directiveId} (both attempts): ${err.message} / ${err2.message}`);
      return null;
    }
  }
}

function cleanupWorktree(directiveId, branch) {
  const { execSync } = require("child_process");
  // Derive worktree dir from branch name (handles unique suffix: agent/dir_xxx-abc → dir_xxx-abc)
  const branchSuffix = branch ? branch.replace("agent/", "") : directiveId;
  const wtDir = path.join(WORKTREE_DIR, branchSuffix);
  // Also try the base dir (without suffix) in case branch has suffix but dir doesn't
  const baseDir = path.join(WORKTREE_DIR, directiveId);
  for (const dir of new Set([wtDir, baseDir])) {
    try { execSync(`git worktree remove --force "${dir}"`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" }); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  try {
    if (branch) execSync(`git branch -D "${branch}"`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" });
  } catch {}
  // Delete remote branch too (prevents stale agent branches piling up)
  try {
    if (branch) execSync(`git push origin --delete "${branch}"`, { cwd: WORKDIR, timeout: 15000, stdio: "ignore" });
  } catch {}
  pruneWorktrees();
  log(`Worktree cleaned up: ${wtDir}`);
}

// Scan for orphaned agent branches not linked to any active directive
// Called periodically and on startup to prevent stale branch accumulation
function cleanupStaleBranches(getDirectives) {
  const { execSync } = require("child_process");
  try {
    // Get all local agent branches
    const localBranches = execSync("git branch", { cwd: WORKDIR, encoding: "utf8", timeout: 10000 })
      .split("\n")
      .map(b => b.trim().replace(/^\* /, ""))
      .filter(b => b.startsWith("agent/"));

    // Get all remote agent branches
    const remoteBranches = execSync("git branch -r", { cwd: WORKDIR, encoding: "utf8", timeout: 10000 })
      .split("\n")
      .map(b => b.trim())
      .filter(b => b.startsWith("origin/agent/"))
      .map(b => b.replace("origin/", ""));

    const allBranches = [...new Set([...localBranches, ...remoteBranches])];
    if (allBranches.length === 0) return 0;

    const directives = getDirectives();
    // Active = has a running agent or is in a non-terminal status that might still use the branch
    const activeDirectiveIds = new Set();
    const branchesInUse = new Set();

    for (const d of directives) {
      // Keep branches for deploy_failed (may need retry-merge)
      if (d.status === "deploy_failed" && d.mergeBranch) {
        branchesInUse.add(d.mergeBranch);
      }
      // Keep branches for directives with running agents
      if (["in_progress", "planning"].includes(d.status)) {
        activeDirectiveIds.add(d.id);
      }
    }

    // Also keep branches for currently running agents
    for (const [directiveId, info] of runningAgents) {
      if (info.worktree && info.worktree.branch) {
        branchesInUse.add(info.worktree.branch);
      }
      activeDirectiveIds.add(directiveId);
    }

    let cleaned = 0;
    for (const branch of allBranches) {
      // Extract directive ID from branch name: agent/dir_xxx or agent/dir_xxx-suffix
      const match = branch.match(/^agent\/(dir_\d+)/);
      if (!match) continue;
      const directiveId = match[1];

      // Skip if branch is explicitly in use, directive is active, or merge is pending
      if (branchesInUse.has(branch)) continue;
      if (activeDirectiveIds.has(directiveId)) continue;
      if (pendingMerges.has(branch)) continue;

      // This branch is orphaned — clean it up
      log(`Stale branch cleanup: ${branch} (directive ${directiveId} is terminal or missing)`);
      try { execSync(`git branch -D "${branch}"`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" }); } catch {}
      try { execSync(`git push origin --delete "${branch}"`, { cwd: WORKDIR, timeout: 15000, stdio: "ignore" }); } catch {}
      cleaned++;
    }

    if (cleaned > 0) {
      log(`Stale branch cleanup: removed ${cleaned} orphaned agent branch(es)`);
      pruneWorktrees();
    }
    return cleaned;
  } catch (err) {
    log(`Stale branch cleanup error: ${err.message}`);
    return 0;
  }
}

function mergeWorktreeToMain(directiveId, branch) {
  const { execSync } = require("child_process");
  const MAX_RETRIES = 3;

  // Safety helper: verify HEAD is on main before running destructive resets
  const ensureOnMain = () => {
    const currentBranch = execSync(`git rev-parse --abbrev-ref HEAD`, { cwd: WORKDIR, encoding: "utf8", timeout: 5000 }).trim();
    if (currentBranch !== "main") {
      log(`SAFETY: expected to be on main but on ${currentBranch} — switching to main first`);
      execSync(`git checkout main`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" });
    }
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 1. Fetch latest refs from origin
      execSync(`git fetch origin`, { cwd: WORKDIR, timeout: 30000, stdio: "ignore" });

      // 2. Ensure we're on main and up to date
      execSync(`git checkout main`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" });
      ensureOnMain(); // Double-check before destructive reset
      execSync(`git reset --hard origin/main`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" });

      // 2b. Ensure local branch exists — may have been pruned by worktree cleanup or race condition
      // If missing locally but exists on origin, recreate it from the remote tracking branch
      try {
        execSync(`git rev-parse --verify "${branch}"`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" });
      } catch {
        // Local branch missing — check if it exists on origin
        try {
          execSync(`git rev-parse --verify "origin/${branch}"`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" });
          log(`Local branch ${branch} missing — recreating from origin/${branch}`);
          execSync(`git branch "${branch}" "origin/${branch}"`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" });
        } catch {
          log(`Branch ${branch} not found locally or on origin — nothing to merge`);
          return true;
        }
      }

      // 3. Check if there are any commits on the agent branch beyond main
      const ahead = execSync(`git rev-list main..${branch} --count`, { cwd: WORKDIR, encoding: "utf8", timeout: 5000 }).trim();
      if (ahead === "0") {
        log(`No new commits on ${branch} — skipping merge`);
        return true;
      }

      // 4. Rebase agent branch onto current main (makes FF possible)
      try {
        execSync(`git rebase main "${branch}"`, { cwd: WORKDIR, timeout: 60000, stdio: "ignore" });
      } catch (rebaseErr) {
        // Rebase conflict — abort and fall back to merge commit
        log(`Rebase conflict for ${branch} — falling back to merge commit`);
        try { execSync(`git rebase --abort`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" }); } catch {}
        execSync(`git checkout main`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" });
        execSync(`git merge "${branch}" --no-edit`, { cwd: WORKDIR, timeout: 30000, env: { ...process.env, OZZU_MERGE_AND_DEPLOY: "1" } });
        execSync(`git push origin main`, { cwd: WORKDIR, timeout: 60000 });
        log(`Merge-committed ${branch} to main (attempt ${attempt}) and pushed`);
        return true;
      }

      // 5. Fast-forward merge (guaranteed to work after successful rebase)
      execSync(`git checkout main`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" });
      execSync(`git merge --ff-only "${branch}"`, { cwd: WORKDIR, timeout: 10000, env: { ...process.env, OZZU_MERGE_AND_DEPLOY: "1" } });

      // 6. Push to origin
      execSync(`git push origin main`, { cwd: WORKDIR, timeout: 60000 });
      log(`Merged ${branch} to main (${ahead} commit(s), attempt ${attempt}) and pushed`);
      return true;
    } catch (err) {
      const msg = err.message || "";
      // Push rejected (another agent pushed between our fetch and push) — retry
      if (msg.includes("non-fast-forward") || msg.includes("fetch first") || msg.includes("rejected")) {
        log(`Push rejected for ${branch} (attempt ${attempt}/${MAX_RETRIES}) — retrying after fetch`);
        try { execSync(`git merge --abort`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" }); } catch {}
        try { execSync(`git rebase --abort`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" }); } catch {}
        if (attempt < MAX_RETRIES) {
          // Brief delay before retry to avoid hammering
          execSync(`sleep 2`, { timeout: 5000 });
          continue;
        }
      }
      // Real conflict or final retry exhausted — clean up but NEVER reset a non-main branch
      log(`Merge completely failed for ${branch} (attempt ${attempt}): ${msg}`);
      try { execSync(`git merge --abort`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" }); } catch {}
      try { execSync(`git rebase --abort`, { cwd: WORKDIR, timeout: 5000, stdio: "ignore" }); } catch {}
      // CRITICAL: Only reset if we are actually on main — never destroy a feature branch
      try {
        const currentBranch = execSync(`git rev-parse --abbrev-ref HEAD`, { cwd: WORKDIR, encoding: "utf8", timeout: 5000 }).trim();
        if (currentBranch === "main") {
          execSync(`git reset --hard origin/main`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" });
        } else {
          log(`SAFETY: on branch ${currentBranch} after failure — NOT resetting (would destroy commits). Switching to main.`);
          execSync(`git checkout main`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" });
          execSync(`git reset --hard origin/main`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" });
        }
      } catch (resetErr) {
        log(`Cleanup failed: ${resetErr.message} — repo may need manual intervention`);
      }
      return false;
    }
  }
  return false;
}

// Wrap an orchestrator-crafted prompt with infrastructure boilerplate
function wrapWorkerPrompt(directive, type, orchestratorPrompt) {
  const isImmediate = directive.type === "quick" || directive.type === "explore";
  return `You are Cipher, the autonomous dev agent for the ozzu project.
Read CLAUDE.md at /home/gcp/ozzu/CLAUDE.md FIRST — it has all project context.

Directive: ${directive.title} (${directive.id})
Type: ${directive.type} | Agent role: ${type}
${directive.plan ? `Approved Plan:\n${directive.plan}\n` : ""}
ORCHESTRATOR INSTRUCTIONS (from Cipher orchestrator — follow these precisely):
${orchestratorPrompt}

GIT WORKTREE — You are running in an ISOLATED worktree with your own branch:
- Commit and push normally: git add <specific files> && git commit && git push origin HEAD
- Do NOT push to origin/main directly. The system merges your branch after you finish.

COMPLETION CHECKLIST:
1. Implement the changes as instructed above
2. Verify: node -c <file> for JS, test endpoints if applicable
3. Commit: git add <specific files> && git commit -m "descriptive message\\n\\nDirective: ${directive.id}\\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
4. Push: git push origin HEAD (if fails: git pull --rebase && git push origin HEAD)
5. VERIFY BUILD: curl -s -X POST ${BRIDGE}/directives/${directive.id}/verify -H 'Content-Type: application/json' -d '{}'
   You MUST run this and it MUST return "success":true before marking completed. The server REJECTS completion without verification.
6. VERIFY SUCCESS CRITERIA: Re-read the directive description. Check EVERY success criterion is met. If any is not met, use "blocked" status.
7. Post status: curl -s -X POST ${BRIDGE}/status -H 'Content-Type: application/json' -d '{"message":"<summary>","directiveId":"${directive.id}"}'
8. Mark complete: curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"completed"}'

CRITICAL: You MUST commit and push before marking complete. Uncommitted changes are LOST.
Do NOT restart the bridge or deploy manually — smartDeploy handles it automatically.

BLOCKED DIRECTIVE RULE:
- If you hit a blocker you CANNOT resolve (missing credentials, needs OAuth, needs physical access, needs human), mark as BLOCKED:
  curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"blocked","failureReason":"<blocker description>"}'
- NEVER mark "completed" with "remaining manual steps." That is blocked, not completed.
- Commit your partial work first, then mark blocked. Also POST ${BRIDGE}/notify to alert King Kazuma.

REAL-TIME STATUS UPDATES:
  curl -s -X POST ${BRIDGE}/status -H 'Content-Type: application/json' -d '{"message":"<what you are doing>","directiveId":"${directive.id}"}'`;
}

// Spawn a claude CLI subprocess for a directive
// customPrompt: optional orchestrator-crafted prompt (bypasses generic template)
function spawnAgent(directive, type, customPrompt) {
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

  // Create isolated worktree for this agent — MANDATORY, no fallback to shared dir
  const worktree = createWorktree(directive.id);
  if (!worktree) {
    log(`ABORT: Cannot spawn ${type} agent for ${directive.id} — worktree creation failed. Directive stays queued for retry.`);
    runningAgents.delete(directive.id); // Release optimistic lock so drainQueue can retry
    logStream.write(`\n=== ABORT: Worktree creation failed — agent not started ===\n`);
    logStream.end();
    return null;
  }
  const agentWorkdir = worktree.dir;

  const prompt = customPrompt
    ? wrapWorkerPrompt(directive, type, customPrompt)
    : (type === "planning" ? buildPlanningPrompt(directive) : buildImplementationPrompt(directive));

  // All directive agents use Opus for strongest reasoning
  const model = "opus";
  const args = [
    "--model", model,
    "--allowedTools", "Bash Read Write Edit Glob Grep WebFetch WebSearch",
    "-p", prompt,
  ];

  log(`Spawning ${type} agent for "${directive.title}" (${directive.id}) [model: ${model}] [worktree: ${agentWorkdir}]`);
  logStream.write(`\n=== ${type} agent started at ${new Date().toISOString()} ===\n`);
  logStream.write(`Worktree: ${agentWorkdir} (branch: ${worktree.branch})\n`);

  // Unset CLAUDECODE to prevent nested session issues (same as cipher-watcher.sh line 114)
  const env = { ...process.env };
  delete env.CLAUDECODE;

  let child;
  try {
    child = spawn("claude", args, {
      cwd: agentWorkdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    log(`SPAWN FAILED for ${directive.id}: ${err.message}`);
    runningAgents.delete(directive.id); // Release optimistic lock
    if (worktree) cleanupWorktree(directive.id, worktree.branch);
    logStream.end();
    return null;
  }

  // Handle spawn errors (e.g., ENOENT, EACCES)
  child.on("error", (err) => {
    log(`SPAWN ERROR for ${directive.id}: ${err.message}`);
    logStream.write(`\n=== Spawn error: ${err.message} ===\n`);
  });

  // Buffer stdout to capture final JSON result (contains token usage)
  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    const str = chunk.toString();
    stdoutBuffer += str;
    // Keep only last 8KB to avoid memory growth on long-running agents
    if (stdoutBuffer.length > 8192) {
      stdoutBuffer = stdoutBuffer.slice(-8192);
    }
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
    worktree, // { dir, branch } or null — used by exit handler to merge/cleanup
  };

  runningAgents.set(directive.id, agentInfo);

  // Broadcast agent spawn event
  metrics.trackAgentSpawn();
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
      metrics.trackAgentFailure();
      // Clean up worktree on failure (don't merge — work is incomplete)
      if (agentInfo.worktree) {
        log(`Cleaning up worktree for failed agent ${directive.id}`);
        cleanupWorktree(directive.id, agentInfo.worktree.branch);
      }

      const failStatus = type === "planning" ? "pending" : "stale";
      // Determine failure reason from killReason (set by timeout/watchdog) or exit code
      const failureReason = agentInfo.killReason
        || (signal === "SIGTERM" ? "killed: SIGTERM" : `crash: exit code ${code}`);
      const errorNote = signal === "SIGTERM" ? "Agent timed out" : `Agent crashed (exit ${code})`;
      log(`Resetting ${directive.id} to ${failStatus}: ${errorNote} (reason: ${failureReason})`);

      // Notify orchestrator about the failure (async, non-blocking)
      notifyOrchestratorFailure(directive, code, failureReason, agentInfo.logFile);

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
      metrics.trackAgentComplete();

      // Parse token usage from claude CLI stdout (JSON result at end of output)
      try {
        // Claude CLI outputs a JSON result as the last line(s) of stdout
        const lines = stdoutBuffer.trim().split("\n");
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
          const line = lines[i].trim();
          if (line.startsWith("{") && line.includes("total_cost")) {
            const result = JSON.parse(line);
            if (result.total_cost_usd || result.usage) {
              metrics.trackTokenUsage(result.usage, result.model_usage, result.total_cost_usd);
              log(`Token usage for ${directive.id}: cost=$${(result.total_cost_usd || 0).toFixed(4)} in=${result.usage?.input_tokens || 0} out=${result.usage?.output_tokens || 0}`);
            }
            break;
          }
        }
      } catch (e) {
        // Token parsing is best-effort — don't fail on parse errors
      }

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

            if (current.status === "blocked") {
              // Agent properly marked as blocked — merge partial work, keep blocked status
              log(`Post-exit check: ${directive.id} is "blocked" — merging partial work, keeping blocked`);
              if (agentInfo.worktree) {
                mergeWorktreeToMain(directive.id, agentInfo.worktree.branch);
                cleanupWorktree(directive.id, agentInfo.worktree.branch);
              }
            } else if (current.status === "in_progress" || current.status === "planning") {
              // Agent didn't complete — clean up worktree without merging
              if (agentInfo.worktree) {
                log(`Cleaning up worktree for incomplete agent ${directive.id}`);
                cleanupWorktree(directive.id, agentInfo.worktree.branch);
              }

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
            } else if (current.status === "completed") {
              // Properly completed (implementation agent OR quick directive planning agent)
              // Protect branch from cleanupStaleBranches during merge window
              if (agentInfo.worktree?.branch) pendingMerges.add(agentInfo.worktree.branch);
              // Send to orchestrator for review before merging
              reviewAndMerge(directive, agentInfo);
            } else if (current.status === "planned" && type === "planning") {
              // Planning agent completed — clean up worktree
              // IMPORTANT: Do NOT merge planning agent commits to main.
              // Planning agents should only produce plans, not code.
              // If a planning agent committed code, it stays on the branch
              // until the directive is approved and an implementation agent runs.
              if (agentInfo.worktree) {
                cleanupWorktree(directive.id, agentInfo.worktree.branch);
              }
            } else {
              // Any other terminal state — clean up worktree
              if (agentInfo.worktree) {
                cleanupWorktree(directive.id, agentInfo.worktree.branch);
              }
            }
          } catch (e) {
            log(`Post-exit check parse error for ${directive.id}: ${e.message}`);
            // Clean up worktree on error
            if (agentInfo.worktree) cleanupWorktree(directive.id, agentInfo.worktree.branch);
          }
        });
      }).on("error", (e) => {
        log(`Post-exit check failed for ${directive.id}: ${e.message}`);
        if (agentInfo.worktree) cleanupWorktree(directive.id, agentInfo.worktree.branch);
      });
    }
  });

  return child;
}

// Notify orchestrator about a worker failure (fire-and-forget)
function notifyOrchestratorFailure(directive, exitCode, failureReason, logFile) {
  const orchestrator = require("./orchestrator");
  if (!orchestrator.isAvailable()) return;

  let logTail = "";
  if (logFile) {
    try {
      const content = fs.readFileSync(logFile, "utf8");
      const lines = content.split("\n");
      logTail = lines.slice(-30).join("\n");
    } catch {}
  }

  orchestrator.sendMessage(`WORKER_FAILED: ${JSON.stringify({
    directiveId: directive.id,
    title: directive.title,
    exitCode,
    error: failureReason,
    logTail: logTail || "(no log captured)",
  })}`).catch(err => {
    log(`Failed to notify orchestrator of failure for ${directive.id}: ${err.message}`);
  });
}

// ── Post-completion verification ──
// Runs automated smoke tests on the worker's branch BEFORE merge.
// If verification fails, auto-reverts to "blocked" with failure reason.

async function runPostCompletionVerification(directive, agentInfo) {
  if (!agentInfo.worktree) return { passed: true, details: "No worktree (nothing to verify)" };

  const { execSync } = require("child_process");
  const wtDir = agentInfo.worktree.dir;
  const results = [];
  let allPassed = true;

  try {
    // Determine what files changed on this branch
    const changed = execSync(`git diff --name-only main...HEAD`, {
      cwd: wtDir, encoding: "utf8", timeout: 10000,
    }).trim();

    if (!changed) return { passed: true, details: "No files changed" };

    const files = changed.split("\n");
    const hasFrontendJS = files.some(f => f.startsWith("frontend/") && (f.endsWith(".js") || f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".jsx")));
    const hasFrontendNative = files.some(f => /^frontend\/(android|ios|plugins\/|app\.json)/.test(f));
    const hasBridgeJS = files.some(f => f.startsWith("backend/bridge/") && f.endsWith(".js"));
    const hasPlugins = files.some(f => f.startsWith("frontend/plugins/") && f.endsWith(".js"));

    // 1. Syntax-check all modified JS files
    const jsFiles = files.filter(f => f.endsWith(".js"));
    for (const file of jsFiles) {
      try {
        execSync(`node -c "${file}"`, { cwd: wtDir, timeout: 10000, stdio: "pipe" });
        results.push(`PASS: node -c ${file}`);
      } catch (err) {
        results.push(`FAIL: node -c ${file}: ${err.stderr?.toString().trim() || err.message}`);
        allPassed = false;
      }
    }

    // 2. Frontend JS changes: verify expo export
    if (hasFrontendJS && !hasFrontendNative) {
      try {
        execSync("npx expo export --platform android", {
          cwd: path.join(wtDir, "frontend"), timeout: 120000, stdio: "pipe",
        });
        results.push("PASS: expo export (frontend JS)");
      } catch (err) {
        results.push(`FAIL: expo export: ${err.stderr?.toString().trim().slice(-200) || err.message}`);
        allPassed = false;
      }
    }

    // 3. Config plugins: syntax-check
    if (hasPlugins) {
      const pluginFiles = files.filter(f => f.startsWith("frontend/plugins/") && f.endsWith(".js"));
      for (const pf of pluginFiles) {
        try {
          execSync(`node -c "${pf}"`, { cwd: wtDir, timeout: 10000, stdio: "pipe" });
          results.push(`PASS: plugin ${pf}`);
        } catch (err) {
          results.push(`FAIL: plugin ${pf}: ${err.stderr?.toString().trim() || err.message}`);
          allPassed = false;
        }
      }
    }

    if (results.length === 0) {
      return { passed: true, details: "No verifiable changes detected" };
    }

    return { passed: allPassed, details: results.join("\n") };
  } catch (err) {
    // Verification infrastructure error — log warning but don't block
    log(`Verification error for ${directive.id}: ${err.message}`);
    return { passed: true, details: `Verification skipped (error: ${err.message})` };
  }
}

// Send completed worker results to orchestrator for review, then merge if approved
async function reviewAndMerge(directive, agentInfo) {
  const orchestrator = require("./orchestrator");

  // ── Post-completion verification: run smoke tests BEFORE merge ──
  const verification = await runPostCompletionVerification(directive, agentInfo);
  log(`Post-completion verification for ${directive.id}: ${verification.passed ? "PASSED" : "FAILED"}\n${verification.details}`);

  if (!verification.passed) {
    log(`Verification FAILED for ${directive.id} — auto-reverting to "blocked"`);

    // Log verification failure to activity_log
    const http = require("http");
    const statusPayload = JSON.stringify({
      message: `Verification FAILED for "${directive.title}": ${verification.details.split("\n").filter(l => l.startsWith("FAIL")).join("; ")}`,
      directiveId: directive.id,
    });
    const statusReq = http.request(`${BRIDGE}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(statusPayload) },
    });
    statusReq.on("error", () => {});
    statusReq.write(statusPayload);
    statusReq.end();

    // Revert directive to "blocked" with failure reason
    const failureReason = `Post-completion verification failed: ${verification.details.split("\n").filter(l => l.startsWith("FAIL")).join("; ")}`;
    const payload = JSON.stringify({ status: "blocked", failureReason });
    const req = http.request(`${BRIDGE}/directives/${directive.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => log(`Auto-reverted ${directive.id} to blocked: ${res.statusCode}`));
    });
    req.on("error", (e) => log(`Failed to revert ${directive.id}: ${e.message}`));
    req.write(payload);
    req.end();

    // Clean up worktree (don't merge broken code) and release pending merge lock
    if (agentInfo.worktree) {
      if (agentInfo.worktree.branch) pendingMerges.delete(agentInfo.worktree.branch);
      cleanupWorktree(directive.id, agentInfo.worktree.branch);
    }

    // Notify orchestrator about verification failure
    notifyOrchestratorFailure(directive, 0, failureReason, agentInfo.logFile);
    return;
  }

  // Capture git diff and log tail for orchestrator review
  let gitDiff = "";
  let logTail = "";

  if (agentInfo.worktree) {
    try {
      const { execSync } = require("child_process");
      gitDiff = execSync(`git diff main...${agentInfo.worktree.branch}`, {
        cwd: WORKDIR, encoding: "utf8", timeout: 15000,
      });
      // Truncate to 5KB to stay within reasonable prompt size
      if (gitDiff.length > 5000) gitDiff = gitDiff.slice(0, 5000) + "\n... (truncated)";
    } catch (err) {
      log(`Failed to capture diff for ${directive.id}: ${err.message}`);
    }
  }

  if (agentInfo.logFile) {
    try {
      const content = fs.readFileSync(agentInfo.logFile, "utf8");
      const lines = content.split("\n");
      logTail = lines.slice(-50).join("\n");
    } catch {}
  }

  // If orchestrator is unavailable, proceed with direct merge (fallback)
  if (!orchestrator.isAvailable()) {
    log(`Orchestrator unavailable — direct merge for ${directive.id}`);
    doMergeAndDeploy(directive, agentInfo);
    return;
  }

  try {
    const message = `WORKER_COMPLETED: ${JSON.stringify({
      directiveId: directive.id,
      title: directive.title,
      exitCode: 0,
      gitDiff: gitDiff || "(no diff captured)",
      logTail: logTail || "(no log captured)",
    })}`;

    const response = await orchestrator.sendMessage(message);
    log(`Orchestrator review for ${directive.id}: action=${response.action}, merge_approved=${response.merge_approved}`);

    if (response.action === "merge_approved" || response.merge_approved === true) {
      log(`Orchestrator approved merge for ${directive.id}: ${response.merge_feedback || "OK"}`);
      doMergeAndDeploy(directive, agentInfo);
    } else if (response.action === "needs_changes") {
      log(`Orchestrator rejected merge for ${directive.id}: ${response.merge_feedback || "needs changes"}`);
      // Release pending merge lock
      if (agentInfo.worktree?.branch) pendingMerges.delete(agentInfo.worktree.branch);
      // Spawn a fix worker with the orchestrator's feedback
      if (response.worker_prompt && agentInfo.worktree) {
        // Clean up old worktree first
        cleanupWorktree(directive.id, agentInfo.worktree.branch);
        // Reset directive to approved so a new worker can pick it up
        const payload = JSON.stringify({ status: "approved" });
        const http = require("http");
        const req = http.request(
          `${BRIDGE}/directives/${directive.id}`,
          { method: "PATCH", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
        );
        req.on("error", () => {});
        req.write(payload);
        req.end();
        // Spawn fix worker after brief delay
        setTimeout(() => spawnAgent(directive, "implementation", response.worker_prompt), 3000);
      } else {
        // No fix instructions — merge anyway (don't block forever)
        log(`No fix instructions from orchestrator — merging anyway for ${directive.id}`);
        doMergeAndDeploy(directive, agentInfo);
      }
    } else {
      // Unknown response — merge anyway
      doMergeAndDeploy(directive, agentInfo);
    }
  } catch (err) {
    log(`Orchestrator review failed for ${directive.id}: ${err.message} — proceeding with merge`);
    doMergeAndDeploy(directive, agentInfo);
  }
}

// Perform the actual merge + deploy (extracted from the old inline handler)
function doMergeAndDeploy(directive, agentInfo) {
  // Release pending merge lock (set before orchestrator review)
  if (agentInfo.worktree?.branch) pendingMerges.delete(agentInfo.worktree.branch);

  let mergeOk = true;
  if (agentInfo.worktree) {
    mergeOk = mergeWorktreeToMain(directive.id, agentInfo.worktree.branch);
    if (mergeOk) {
      cleanupWorktree(directive.id, agentInfo.worktree.branch);
    } else {
      log(`WARNING: Merge failed for ${directive.id} — branch ${agentInfo.worktree.branch} preserved for manual merge`);
      const wtDir = path.join(WORKTREE_DIR, directive.id);
      try { require("child_process").execSync(`git worktree remove --force "${wtDir}"`, { cwd: WORKDIR, timeout: 10000, stdio: "ignore" }); } catch {}

      // PATCH directive to deploy_failed so dashboard shows it + enables retry
      const http = require("http");
      const patchData = JSON.stringify({
        status: "deploy_failed",
        failureReason: `Merge failed for branch ${agentInfo.worktree.branch} — manual merge or retry needed`,
        mergeBranch: agentInfo.worktree.branch,
        actor: "Cipher",
      });
      const patchReq = http.request(`${BRIDGE}/directives/${directive.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.BRIDGE_SECRET || ""}`, "Content-Length": Buffer.byteLength(patchData) },
      }, (res) => {
        let body = "";
        res.on("data", (d) => body += d);
        res.on("end", () => {
          if (res.statusCode !== 200) log(`Failed to PATCH deploy_failed for ${directive.id}: ${body}`);
        });
      });
      patchReq.on("error", (err) => log(`PATCH error for ${directive.id}: ${err.message}`));
      patchReq.write(patchData);
      patchReq.end();

      // Notify June so King Kazuma knows about the failure
      const notifyData = JSON.stringify({
        message: `Merge failed for directive "${directive.title || directive.id}" on branch ${agentInfo.worktree.branch}. The code is ready but couldn't be merged to main. King Kazuma can retry from the dashboard.`,
      });
      const notifyReq = http.request(`${BRIDGE}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(notifyData) },
      }, () => {});
      notifyReq.on("error", (err) => log(`Notify error for merge failure ${directive.id}: ${err.message}`));
      notifyReq.write(notifyData);
      notifyReq.end();
    }
  }
  if (mergeOk) {
    smartDeploy(directive);
  }
}

// Route a directive through the orchestrator (with fallback to direct spawn)
async function routeThroughOrchestrator(directive, type) {
  const orchestrator = require("./orchestrator");
  if (!orchestrator.isAvailable()) {
    spawnAgent(directive, type);
    return;
  }
  try {
    const message = `NEW_DIRECTIVE: ${JSON.stringify({
      id: directive.id, type: directive.type, title: directive.title,
      description: directive.description, priority: directive.priority,
      status: directive.status, plan: directive.plan || null,
      failureReason: directive.failureReason || null,
    })}`;
    const response = await orchestrator.sendMessage(message);
    await orchestrator.handleResponse(directive, response);
  } catch (err) {
    log(`Orchestrator routing failed for ${directive.id}: ${err.message} — direct spawn`);
    spawnAgent(directive, type);
  }
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
            routeThroughOrchestrator(d, "planning");
          } else if (d.status === "approved") {
            log(`Drain: picking up deferred approved directive ${d.id} "${d.title}"`);
            routeThroughOrchestrator(d, "implementation");
          }
        }
      } catch (e) {
        log(`Drain: failed to parse directives: ${e.message}`);
      }
    });
  }).on("error", (e) => log(`Drain: failed to fetch directives: ${e.message}`));
}

// Worker spawn functions disabled — Cipher handles directives directly (no disposable agents)
function spawnPlanningAgent(directive) {
  log(`DISABLED: spawnPlanningAgent called for ${directive.id} "${directive.title}" — Cipher handles directly`);
  return null;
}

function spawnImplementationAgent(directive) {
  log(`DISABLED: spawnImplementationAgent called for ${directive.id} "${directive.title}" — Cipher handles directly`);
  return null;
}

function spawnWorkerWithPrompt(directive, type, orchestratorPrompt) {
  log(`DISABLED: spawnWorkerWithPrompt called for ${directive.id} "${directive.title}" — Cipher handles directly`);
  return null;
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
  for (const [directiveId, info] of runningAgents) {
    killAgent(directiveId);
    // Don't cleanup worktrees on shutdown — agent may resume after restart
    // Stale worktrees are cleaned up by createWorktree() on next spawn for same directive
  }
}

// ── Smart deploy (ported from cipher-watcher.sh) ──

// Returns { android: bool, ios: bool, any: bool } indicating which platforms have native changes
// Returns { native: bool, jsOnly: bool, any: bool } for tv/ path changes
function detectTvChanges() {
  try {
    const { execSync } = require("child_process");
    const changed = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: WORKDIR, encoding: "utf8", timeout: 10000,
    }).trim();

    if (!changed) return { native: false, jsOnly: false, any: false };

    const lines = changed.split("\n");
    const tvLines = lines.filter(l => l.startsWith("tv/"));
    if (tvLines.length === 0) return { native: false, jsOnly: false, any: false };

    // Native: app.json, plugins/, modules/, package.json with native deps
    const nativePatterns = [/tv\/app\.json/, /tv\/plugins\//, /tv\/modules\//];
    let native = tvLines.some(l => nativePatterns.some(p => p.test(l)));

    // Check if package.json added native deps
    if (!native && changed.includes("tv/package.json")) {
      const pkgDiff = execSync("git diff HEAD~1 HEAD -- tv/package.json", {
        cwd: WORKDIR, encoding: "utf8", timeout: 10000,
      });
      if (/^\+.*"(expo-|react-native-|@react-native)/m.test(pkgDiff)) {
        native = true;
      }
    }

    return { native, jsOnly: !native, any: true };
  } catch {
    return { native: false, jsOnly: false, any: false };
  }
}

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
    const bridgePatterns = [/backend\/bridge\/server\.js/, /backend\/bridge\/cipher-pipeline\.js/, /backend\/bridge\/agent-spawner\.js/, /backend\/bridge\/orchestrator\.js/, /backend\/bridge\/db\.js/];
    return changed.split("\n").some(line => bridgePatterns.some(p => p.test(line)));
  } catch {
    return false;
  }
}

// Returns true if ESP32 firmware source files changed
function detectFirmwareChanges() {
  try {
    const { execSync } = require("child_process");
    const changed = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: WORKDIR, encoding: "utf8", timeout: 10000,
    }).trim();
    if (!changed) return false;
    const fwPatterns = [/hardware\/positioning\/esp32-csi\/main\//, /hardware\/positioning\/esp32-csi\/partitions\.csv/, /hardware\/positioning\/esp32-csi\/sdkconfig/];
    return changed.split("\n").some(line => fwPatterns.some(p => p.test(line)));
  } catch {
    return false;
  }
}

// Spawn a deploy command as a detached process that survives bridge restarts.
// Writes a wrapper script to /tmp, runs it with nohup, logs to /tmp/ozzu-bridge/.
// On completion, POSTs a notification to the bridge.
function spawnDetachedDeploy(platform, command) {
  const fs = require("fs");
  const { spawn } = require("child_process");
  const scriptPath = `/tmp/ozzu-bridge/deploy-${platform}-${Date.now()}.sh`;
  const logPath = `/tmp/ozzu-bridge/deploy-${platform}.log`;
  const notifyUrl = `${BRIDGE}/notify`;

  const successMsg = platform === "ios"
    ? "iOS build done — download the IPA from the directive dashboard."
    : "Android update's live on all tablets.";
  const failMsg = platform === "ios"
    ? "iOS build failed — check GitHub Actions."
    : "Android update failed — check deploy log.";

  const script = `#!/bin/bash
exec > "${logPath}" 2>&1
echo "=== ${platform} deploy started at $(date -u) ==="
${command}
EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  echo "=== ${platform} deploy SUCCESS at $(date -u) ==="
  curl -s -X POST ${notifyUrl} -H 'Content-Type: application/json' -d '{"message":"${successMsg}"}' || true
else
  echo "=== ${platform} deploy FAILED at $(date -u) ==="
  curl -s -X POST ${notifyUrl} -H 'Content-Type: application/json' -d '{"message":"${failMsg}"}' || true
fi
rm -f "${scriptPath}"
`;

  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  const child = spawn("bash", [scriptPath], {
    cwd: WORKDIR,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  log(`Detached ${platform} deploy started (pid ${child.pid}, log: ${logPath})`);
}

function smartDeploy(directive) {
  const { execSync, exec } = require("child_process");
  const http = require("http");

  // Track when smartDeploy runs (used by post-merge safety net to avoid double-trigger)
  module.exports._lastSmartDeployTime = Date.now();

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

  // ────────────────────────────────────────────────────────────────
  // Deploy Pipeline — Three Tiers
  //
  // HOT  (~25s OTA + ~10m iOS CI in parallel) — JS-only changes.
  //               iPhone is King Kazuma's PRIMARY device — iOS is built every deploy.
  //               No manual /stage-ios required.
  //
  // WARM (~10m) — Native changes → Android CI + iOS CI in parallel.
  //               Both platforms need full rebuild.
  //
  // STAGING     — Recovery only: rebuild iOS if HOT CI failed/cancelled.
  //               Caches IPA to artifacts/ozzu-latest.ipa for AltStore.
  //
  // Each product (phone, TV, firmware) has independent detection.
  // ────────────────────────────────────────────────────────────────

  const bridgeChanged = detectBridgeChanges();
  const native = detectNativeChanges();
  const tvChanges = detectTvChanges();
  const firmwareChanged = detectFirmwareChanges();

  // Log what was detected
  const detections = [];
  if (native.any) detections.push(`phone:native(android=${native.android},ios=${native.ios})`);
  else detections.push("phone:js-only");
  if (tvChanges.any) detections.push(tvChanges.native ? "tv:native" : "tv:js-only");
  if (firmwareChanged) detections.push("firmware");
  if (bridgeChanged) detections.push("bridge");
  log(`smartDeploy: ${detections.join(", ")}`);

  // ── PHONE APP ──

  if (native.any) {
    // WARM tier — native changes, full CI rebuild for both platforms
    const platforms = [native.android && "Android", native.ios && "iOS"].filter(Boolean).join(" + ");
    log(`WARM deploy: ${platforms} native CI builds`);
    notify(`Native update — full rebuild for ${platforms}, ~10 minutes.`);

    if (native.android) {
      spawnDetachedDeploy("android", [
        `cd ${WORKDIR}`,
        `gh workflow run build-android.yml`,
        `sleep 20`,
        `RUN_ID=$(gh run list --workflow=build-android.yml --limit 1 --json databaseId --jq '.[0].databaseId')`,
        `gh run watch "$RUN_ID" --exit-status`,
        `rm -rf /tmp/ozzu-apk-verify`,
        `gh run download "$RUN_ID" --name ozzu-android --dir /tmp/ozzu-apk-verify -R ozzuworld/ozzu`,
        `test -f /tmp/ozzu-apk-verify/app-release.apk || { echo "ERROR: APK artifact not found"; exit 1; }`,
        `APK_SIZE=$(stat -c%s /tmp/ozzu-apk-verify/app-release.apk 2>/dev/null || echo 0)`,
        `test "$APK_SIZE" -gt 1000000 || { echo "ERROR: APK too small ($APK_SIZE bytes)"; exit 1; }`,
        `rm -rf /tmp/ozzu-apk-verify`,
        `./scripts/deploy.sh`,
        `echo "Caching APK artifact locally..."`,
        `gh run download "$RUN_ID" --name ozzu-android --dir /tmp/ozzu-apk-cache -R ozzuworld/ozzu`,
        `test -f /tmp/ozzu-apk-cache/app-release.apk && cp /tmp/ozzu-apk-cache/app-release.apk ${WORKDIR}/artifacts/ozzu-latest.apk && echo "APK cached" || echo "APK cache skipped"`,
        `rm -rf /tmp/ozzu-apk-cache`,
      ].join(" && "));
    }

    // iOS CI — only on native changes (WARM), never on JS-only (HOT)
    spawnDetachedDeploy("ios", buildIosDeployCommand(directive));
  } else {
    // HOT tier — JS-only. Android OTA (~25s) + iOS CI build (~10 min) in parallel.
    // iPhone is King Kazuma's PRIMARY device — iOS is built every deploy. No manual /stage-ios.
    log("HOT deploy: Android OTA + iOS CI build (parallel — iPhone is primary)");
    notify("Quick update going out — tablets ~25s, iPhone IPA ~10 min.");

    exec(`cd ${WORKDIR} && ./scripts/ota-deploy.sh --restart`, {
      cwd: WORKDIR,
      timeout: 5 * 60 * 1000,
    }, (err) => {
      if (err) {
        log(`HOT deploy failed: ${err.message}`);
        notify("Tablet update failed — might need a full rebuild.");
      } else {
        log("HOT deploy complete — tablets updated");
        notify("Tablets updated. iPhone IPA still building — will land at artifacts/ozzu-latest.ipa.");
      }
    });

    // iOS CI in parallel — iPhone is the primary device, always build
    spawnDetachedDeploy("ios", buildIosDeployCommand(directive));
  }

  // ── TV APP ──

  if (tvChanges.any) {
    if (tvChanges.jsOnly) {
      log("TV HOT deploy: OTA");
      notify("TV update going out — live on next app launch.");
      exec(`cd ${WORKDIR} && ./scripts/ota-deploy-tv.sh`, {
        cwd: WORKDIR,
        timeout: 5 * 60 * 1000,
      }, (err) => {
        if (err) {
          log(`TV OTA deploy failed: ${err.message}`);
          notify("TV update failed — might need a full rebuild.");
        } else {
          log("TV OTA deploy complete");
          notify("TV update published — picks it up on next launch.");
        }
      });
    } else {
      log("TV WARM deploy: native CI build");
      notify("TV native update building — will auto-install when done.");
      spawnDetachedDeploy("tv", [
        `cd ${WORKDIR}`,
        `gh workflow run build-tv.yml`,
        `sleep 20`,
        `RUN_ID=$(gh run list --workflow=build-tv.yml --limit 1 --json databaseId --jq '.[0].databaseId')`,
        `gh run watch "$RUN_ID" --exit-status`,
        `rm -rf /tmp/ozzu-tv-release`,
        `gh run download "$RUN_ID" --name ozzu-tv --dir /tmp/ozzu-tv-release -R ozzuworld/ozzu`,
        `mkdir -p /tmp/ozzu-bridge/tv-releases`,
        `test -f /tmp/ozzu-tv-release/app-release.apk && cp /tmp/ozzu-tv-release/app-release.apk /tmp/ozzu-bridge/tv-releases/ozzu-tv.apk || echo "APK not found"`,
        `test -f /tmp/ozzu-tv-release/latest.json && cp /tmp/ozzu-tv-release/latest.json /tmp/ozzu-bridge/tv-releases/latest.json || echo "metadata not found"`,
        `rm -rf /tmp/ozzu-tv-release`,
      ].join(" && "));
    }
  }

  // ── FIRMWARE ──

  if (firmwareChanged) {
    log("Firmware deploy: Docker build + SCP + OTA broadcast");
    notify("Firmware update building — ESP32 nodes will update automatically.");
    const _rockpi = getDevice("rockpi");
    const _rockpiSsh = `${_rockpi.ssh_user}@${_rockpi.lan_ip}`;
    const _jumpFlag = _rockpi.ssh_jump ? `-o ProxyJump=${_rockpi.ssh_jump}` : "";
    const _sshJumpFlag = _rockpi.ssh_jump ? `-J ${_rockpi.ssh_jump}` : "";
    spawnDetachedDeploy("firmware", [
      `cd ${WORKDIR}/hardware/positioning/esp32-csi`,
      `docker run --rm -v "$(pwd):/project" -w /project espressif/idf:v5.2.3 bash -c "idf.py build" 2>&1 | tail -20`,
      `scp ${_jumpFlag} build/ozzu-room-node.bin ${_rockpiSsh}:/opt/ozzu-positioning/ota/firmware.bin`,
      `ssh ${_sshJumpFlag} ${_rockpiSsh} "python3 -c \\"import socket,struct;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);s.sendto(struct.pack('<I',0x4F544155),('10.0.50.255',5502));s.close();print('OTA trigger sent')\\""`,
    ].join(" && "));
  }

  // ── BRIDGE RESTART ──
  // Must be LAST — kills this process, Docker auto-restarts
  if (bridgeChanged) {
    const restartDelay = native.any ? 10000 : 60000; // 60s for OTA (was 90s, now faster without iOS export)
    log(`Bridge code changed — scheduling restart in ${restartDelay / 1000}s`);
    notify("Server code changed — will restart after the update finishes.");
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

// Helper: build iOS CI deploy command (shared by WARM tier and /stage-ios)
function buildIosDeployCommand(directive) {
  return [
    `cd ${WORKDIR}`,
    `gh workflow run build-ios.yml`,
    `sleep 20`,
    `RUN_ID=$(gh run list --workflow=build-ios.yml --limit 1 --json databaseId --jq '.[0].databaseId')`,
    `echo "iOS build started: run $RUN_ID"`,
    directive && directive.id ? `curl -s -X POST ${BRIDGE}/directives/${directive.id}/build-run -H 'Content-Type: application/json' -d "{\\"platform\\":\\"ios\\",\\"runId\\":$RUN_ID,\\"url\\":\\"https://github.com/ozzuworld/ozzu/actions/runs/$RUN_ID\\"}" || true` : `echo "No directive ID — skipping build-run registration"`,
    `gh run watch "$RUN_ID" --exit-status`,
    `echo "Caching IPA artifact locally..."`,
    `rm -rf /tmp/ozzu-ipa-cache && gh run download "$RUN_ID" --name ozzu-ios --dir /tmp/ozzu-ipa-cache -R ozzuworld/ozzu`,
    `IPA_FILE=$(find /tmp/ozzu-ipa-cache -name "*.ipa" 2>/dev/null | head -1)`,
    `test -n "$IPA_FILE" && cp "$IPA_FILE" ${WORKDIR}/artifacts/ozzu-latest.ipa && echo "IPA cached: $IPA_FILE" || echo "IPA cache skipped — no .ipa found"`,
    `rm -rf /tmp/ozzu-ipa-cache`,
  ].join(" && ");
}

// STAGING tier — explicit iOS build, callable from MCP tool
function stageIos(directive) {
  log("STAGING: iOS CI build triggered explicitly");
  const http = require("http");
  const payload = JSON.stringify({ message: "iOS build started — IPA will be ready in ~10 minutes." });
  const req = http.request(
    `${BRIDGE}/notify`,
    { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
  );
  req.on("error", () => {});
  req.write(payload);
  req.end();

  spawnDetachedDeploy("ios", buildIosDeployCommand(directive));
}

// ── Watchdog: periodic liveness check for running agents ──

function startWatchdog() {
  // Startup cleanup: prune stale worktree references from previous bridge runs
  pruneWorktrees();
  log("Startup: pruned stale worktree references");
  log("Watchdog started (agent monitoring disabled — Cipher handles directives directly)");
}

module.exports = {
  spawnPlanningAgent,
  spawnImplementationAgent,
  spawnWorkerWithPrompt,
  getRunningAgents,
  killAgent,
  killAllAgents,
  startWatchdog,
  setBroadcast,
  getConfig,
  setConfig,
  mergeWorktreeToMain,
  cleanupWorktree,
  cleanupStaleBranches,
  smartDeploy,
  stageIos,
  _lastSmartDeployTime: 0,
};
