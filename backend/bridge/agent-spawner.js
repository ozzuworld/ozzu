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
  return `You are Cipher, the autonomous dev agent for the ozzu project.

A new ${directive.type} directive needs planning:
- Title: ${directive.title}
- Description: ${directive.description}
- Directive ID: ${directive.id}

Your task:
1. Research the codebase to understand what's needed
2. Create a detailed implementation plan
3. Submit the plan by running: curl -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d with a JSON body containing "status": "planned" and "plan": "<your plan text>"

For 'quick' type directives: skip planning, set status directly to 'approved' and implement immediately.
For 'feature' type directives: create a thorough plan and submit it. It will need PIN approval before you can implement.
For 'explore' type directives: research and report findings, then set status to 'completed' with findings in the plan field.

You have full autonomy to read any files, search code, and run non-destructive commands to understand the codebase. Just do it — no need to ask permission for research.`;
}

// Build the implementation prompt for an approved directive
function buildImplementationPrompt(directive) {
  return `You are Cipher, the autonomous dev agent for the ozzu project.

Implement this approved directive:
- Title: ${directive.title}
- Directive ID: ${directive.id}
- Approved Plan:
${directive.plan || "(no plan — quick directive)"}

Your task:
1. Implement the changes described in the plan
2. Commit with a clear message and push to main
3. If an APK rebuild is needed, the CI will handle it automatically on push
4. When done, mark the directive complete: curl -X PATCH ${BRIDGE}/directives/${directive.id} -H 'Content-Type: application/json' -d '{"status":"completed"}'
5. Post a completion status update to ${BRIDGE}/status

AUTONOMY RULES — You have FULL autonomy for all normal development work:
- Reading, writing, editing, creating, deleting code files — just do it
- Running git commands (add, commit, push, branch, merge) — just do it
- Installing npm/pip packages — just do it
- Running builds, tests, linters — just do it
- Creating/modifying configs, scripts, components — just do it
- File operations (cp, mv, mkdir, rm of project files) — just do it
- Curl calls to the bridge API — just do it
- Do NOT ask for approval for any of the above. Just execute.

ONLY escalate to King Kazuma (via POST ${BRIDGE}/notify) for:
- Infrastructure changes: shutting down hosts, modifying DNS, domain changes, firewall rules
- Architectural decisions NOT covered by the approved plan
- Deleting entire services/databases or irreversible destructive operations outside the codebase
- Anything that affects production systems beyond this codebase (cloud config, network, etc.)

For escalations, post to ${BRIDGE}/notify with a clear description of what you need. Do NOT create approvals for routine dev work.`;
}

// Spawn a claude CLI subprocess for a directive
function spawnAgent(directive, type) {
  // Guard: don't double-spawn
  if (runningAgents.has(directive.id)) {
    log(`SKIP: Agent already running for ${directive.id} (${runningAgents.get(directive.id).type})`);
    return null;
  }

  ensureLogDir();
  const logFile = path.join(LOG_DIR, `agent-${directive.id}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  const prompt = type === "planning"
    ? buildPlanningPrompt(directive)
    : buildImplementationPrompt(directive);

  const args = [
    "--allowedTools", "Bash Read Write Edit Glob Grep WebFetch WebSearch",
    "-p", prompt,
  ];

  log(`Spawning ${type} agent for "${directive.title}" (${directive.id})`);
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
    child.kill("SIGTERM");

    // SIGKILL fallback if SIGTERM doesn't work
    setTimeout(() => {
      try {
        if (!child.killed) {
          child.kill("SIGKILL");
          log(`SIGKILL sent to ${type} agent for ${directive.id}`);
        }
      } catch (e) { /* process may already be gone */ }
    }, SIGKILL_GRACE_MS);
  }, AGENT_TIMEOUT_MS);

  const agentInfo = {
    process: child,
    type,
    startedAt: new Date().toISOString(),
    pid: child.pid,
    timeout: timeoutHandle,
    logFile,
  };

  runningAgents.set(directive.id, agentInfo);

  // Handle process exit
  child.on("close", (code, signal) => {
    clearTimeout(timeoutHandle);
    runningAgents.delete(directive.id);
    logStream.write(`\n=== Agent exited: code=${code} signal=${signal} ===\n`);
    logStream.end();

    log(`Agent exited for ${directive.id}: code=${code} signal=${signal}`);

    // On non-zero exit (crash/timeout), reset directive to recoverable state
    if (code !== 0) {
      const failStatus = type === "planning" ? "pending" : "stale";
      const errorNote = signal === "SIGTERM" ? "Agent timed out" : `Agent crashed (exit ${code})`;
      log(`Resetting ${directive.id} to ${failStatus}: ${errorNote}`);

      // PATCH the directive back to recoverable state
      const payload = JSON.stringify({ status: failStatus });
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
    } else if (type === "implementation") {
      // Successful implementation — trigger smart deploy
      smartDeploy(directive);
    }
  });

  return child;
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

  // SIGKILL fallback
  setTimeout(() => {
    try {
      if (!agent.process.killed) agent.process.kill("SIGKILL");
    } catch (e) { /* already gone */ }
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

function hasNativeChanges() {
  try {
    const { execSync } = require("child_process");
    const changed = execSync("git diff --name-only HEAD~1 HEAD", {
      cwd: WORKDIR, encoding: "utf8", timeout: 10000,
    }).trim();

    if (!changed) return false;

    const nativePatterns = [
      /frontend\/modules\/.*\/android\//,
      /frontend\/modules\/.*\/ios\//,
      /frontend\/app\.json/,
      /frontend\/plugins\//,
      /frontend\/android\//,
      /frontend\/ios\//,
    ];

    for (const line of changed.split("\n")) {
      for (const pattern of nativePatterns) {
        if (pattern.test(line)) return true;
      }
    }

    // Check if package.json added a native dependency
    if (changed.includes("frontend/package.json")) {
      const pkgDiff = execSync("git diff HEAD~1 HEAD -- frontend/package.json", {
        cwd: WORKDIR, encoding: "utf8", timeout: 10000,
      });
      if (/^\+.*"(expo-|react-native-|@react-native)/m.test(pkgDiff)) return true;
    }

    return false;
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

  if (hasNativeChanges()) {
    log("Native changes detected — CI will handle APK build + deploy");
    notify("Native changes detected — a full APK rebuild is needed. CI build started, this will take about 10 minutes.");

    // Watch CI run in background
    exec(`sleep 15 && cd ${WORKDIR} && RUN_ID=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') && gh run watch "$RUN_ID" --exit-status && ./scripts/deploy.sh`, {
      cwd: WORKDIR,
      timeout: 30 * 60 * 1000, // 30 min max
    }, (err) => {
      if (err) {
        log(`APK deploy failed: ${err.message}`);
        notify(`CI build/deploy failed: ${err.message}`);
      } else {
        log("APK deployed successfully");
        notify("APK deployed! The new update has been installed on all devices.");
      }
    });
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

module.exports = {
  spawnPlanningAgent,
  spawnImplementationAgent,
  getRunningAgents,
  killAgent,
  killAllAgents,
};
