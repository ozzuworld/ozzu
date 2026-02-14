// agent-spawner.js — Event-driven agent subprocess manager for directives
// Spawns `claude` CLI processes when directives transition to planning/approved status

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const BRIDGE = "http://localhost:3333";
const WORKDIR = "/home/gcp/ozzu";
const LOG_DIR = "/tmp/ozzu-bridge";
const AGENT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const SIGKILL_GRACE_MS = 5000; // 5s grace after SIGTERM before SIGKILL
const MAX_CONCURRENT_AGENTS = 2; // Max simultaneous agent processes (~500MB-1GB each)

// Running agents: directiveId → { process, type, startedAt, pid, timeout, logFile }
const runningAgents = new Map();

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
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
5. ${directive.type === "quick" ? "If bridge code changed: docker compose -f /home/gcp/ozzu/backend/docker-compose.yml restart bridge" : ""}
6. Mark complete: curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"completed"${directive.type === "explore" ? ',"plan":"<your findings in markdown>"' : ""}}'

CRITICAL RULES:
- You MUST commit and push before marking complete. Uncommitted changes are lost.
- Do NOT restart the bridge if you're running inside it — your process will die. Only restart if your changes are committed and pushed.
- If another agent may be editing the same files, check git status first. If files have uncommitted changes, use git stash before editing and git stash pop after.
- Always git pull --rebase origin main before pushing if the push fails.
` : "";

  return `You are Cipher, the autonomous dev agent for the ozzu project.
Read CLAUDE.md at /home/gcp/ozzu/CLAUDE.md FIRST — it has all project context.

SYSTEM ARCHITECTURE:
- GCP VM (10.128.0.8) runs all services. Bridge at :3333, HA at :8123, Postgres :5432, Redis :6379
- Home LAN (172.168.0.0/24) via VPN tunnel. Devices: tablets (.53, .57), TV (.56), dev-01 (.59)
- Bridge runs in Docker — restart: docker compose -f /home/gcp/ozzu/backend/docker-compose.yml restart bridge
- Frontend: Expo React Native. CI builds on push to main. Deploy: ./scripts/deploy.sh
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

TROUBLESHOOTING:
- File not found? Search with Glob/Grep before assuming it doesn't exist
- Command failed? Read the error, try a different approach
- git push failed? Run: git pull --rebase origin main && git push origin main
- Build failed? Read the actual error output, don't guess

AUTONOMY RULES:
- You have FULL autonomy. Just do it — read, write, edit, git, docker, SSH.
- DO NOT give up. Try alternatives before escalating.
- Only escalate via POST ${BRIDGE}/notify for: infrastructure changes, missing credentials, irreversible destructive operations.`;
}

// Build the implementation prompt for an approved directive
function buildImplementationPrompt(directive) {
  return `You are Cipher, the autonomous dev agent for the ozzu project.
Read CLAUDE.md at /home/gcp/ozzu/CLAUDE.md FIRST — it has all project context.

SYSTEM ARCHITECTURE:
- GCP VM (10.128.0.8) runs: Home Assistant (:8123), Bridge server (:3333), PostgreSQL (:5432), Redis (:6379)
- Home LAN (172.168.0.0/24) via VPN: tablets (.53, .57), TV (.56), dev-01 (.59)
- dev-01 is a Linux server at 172.168.0.59, reachable via SSH from this VM
- Bridge runs in Docker container "bridge" — restart: docker compose -f /home/gcp/ozzu/backend/docker-compose.yml restart bridge
- Frontend is Expo React Native, builds via GitHub Actions, deploys with ./scripts/deploy.sh
- Bridge API at ${BRIDGE} has endpoints: /directives, /status, /notify, /approvals, /health

Implement this approved directive:
- Title: ${directive.title}
- Directive ID: ${directive.id}
- Approved Plan:
${directive.plan || "(no plan — quick directive)"}

IMPLEMENTATION CHECKLIST — Follow this order:
1. Read CLAUDE.md for project context
2. Research the codebase (Glob, Grep, Read) before writing any code
3. Implement the changes
4. Verify your changes work (syntax check: node -c file.js, test endpoints, etc.)
5. If bridge code changed: docker compose -f /home/gcp/ozzu/backend/docker-compose.yml restart bridge
6. Commit: git add <specific files> && git commit -m "descriptive message"
7. Push: git push origin main
8. Post status: curl -s -X POST ${BRIDGE}/status -H 'Content-Type: application/json' -d '{"message":"<summary>"}'
9. Mark complete: curl -s -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"completed"}'

CRITICAL: Steps 6-9 are MANDATORY. You MUST commit and push before marking complete. Uncommitted changes are lost when you exit.

TROUBLESHOOTING PATTERNS:
- If a file doesn't exist where expected, search for it with Glob/Grep
- If a command fails, read the error and try a different approach
- If a build fails, check the actual build output (don't guess the error)
- If SSH/network fails, check VPN: ping 10.8.0.2
- If git push fails, check for conflicts: git pull --rebase origin main
- If you need to restart the bridge after code changes, always syntax-check first

AUTONOMY RULES — You have FULL autonomy:
- Read/write/edit files, git operations, npm/pip, builds, docker, SSH — just do it
- Do NOT ask for approval. Do NOT give up. Find a way.
- Only escalate via POST ${BRIDGE}/notify for: infrastructure changes, missing credentials, irreversible destructive operations
- DO NOT tell King Kazuma to "do it manually." Handle it yourself.`;
}

// Spawn a claude CLI subprocess for a directive
function spawnAgent(directive, type) {
  // Guard: don't double-spawn
  if (runningAgents.has(directive.id)) {
    log(`SKIP: Agent already running for ${directive.id} (${runningAgents.get(directive.id).type})`);
    return null;
  }

  // Guard: concurrency limit — directive stays in current state, picked up when a slot opens
  if (runningAgents.size >= MAX_CONCURRENT_AGENTS) {
    log(`QUEUED: Concurrency limit reached (${runningAgents.size}/${MAX_CONCURRENT_AGENTS}), deferring ${directive.id} "${directive.title}"`);
    return null;
  }

  ensureLogDir();
  const logFile = path.join(LOG_DIR, `agent-${directive.id}.log`);
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

  const child = spawn("claude", args, {
    cwd: WORKDIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Pipe output to log file
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  // Set timeout
  const timeoutHandle = setTimeout(() => {
    log(`TIMEOUT: Killing ${type} agent for ${directive.id} (exceeded ${AGENT_TIMEOUT_MS / 60000}min)`);
    logStream.write(`\n=== TIMEOUT: Agent killed after ${AGENT_TIMEOUT_MS / 60000} minutes ===\n`);
    const info = runningAgents.get(directive.id);
    if (info) info.killReason = `timeout: exceeded ${AGENT_TIMEOUT_MS / 60000}min`;
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
  }, AGENT_TIMEOUT_MS);

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

  // Handle process exit
  child.on("close", (code, signal) => {
    clearTimeout(timeoutHandle);
    runningAgents.delete(directive.id);
    logStream.write(`\n=== Agent exited: code=${code} signal=${signal} ===\n`);
    logStream.end();

    log(`Agent exited for ${directive.id}: code=${code} signal=${signal}`);

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
  if (runningAgents.size >= MAX_CONCURRENT_AGENTS) return;

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
          if (runningAgents.size >= MAX_CONCURRENT_AGENTS) break;
          if (runningAgents.has(d.id)) continue;

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
}

// ── Watchdog: periodic liveness check for running agents ──

const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALL_THRESHOLD_MS = 15 * 60 * 1000;  // 15 minutes without directive activity = stalled

function startWatchdog() {
  log("Watchdog started (interval: 5min, stall threshold: 15min)");
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
              if (idleMs > STALL_THRESHOLD_MS) {
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
  }, WATCHDOG_INTERVAL_MS);
}

module.exports = {
  spawnPlanningAgent,
  spawnImplementationAgent,
  getRunningAgents,
  killAgent,
  killAllAgents,
  startWatchdog,
  MAX_CONCURRENT_AGENTS,
};
