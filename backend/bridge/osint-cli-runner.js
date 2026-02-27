// CLI tool orchestrator — runs OSINT tools via docker exec osint-tools
const { execFile } = require("child_process");
const path = require("path");

const CONTAINER_NAME = "osint-tools";
const DEFAULT_TIMEOUT = 120000; // 2 minutes
const MAX_CONCURRENT = 2;

let _activeTasks = 0;
const _queue = [];
const _toolHealth = {};

// Semaphore for concurrency control
function _acquireSlot() {
  return new Promise((resolve) => {
    const tryRun = () => {
      if (_activeTasks < MAX_CONCURRENT) {
        _activeTasks++;
        resolve();
      } else {
        _queue.push(tryRun);
      }
    };
    tryRun();
  });
}

function _releaseSlot() {
  _activeTasks--;
  if (_queue.length > 0) {
    const next = _queue.shift();
    if (typeof next === "function") next();
  }
}

/**
 * Run a CLI tool inside the osint-tools container.
 * @param {string} toolName - Tool binary name (e.g., "maigret", "exiftool")
 * @param {string[]} args - Arguments to pass
 * @param {object} opts - { timeout, parseJson }
 * @returns {Promise<{ stdout: string, stderr: string, parsed: any|null }>}
 */
async function runTool(toolName, args = [], opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT;

  await _acquireSlot();
  try {
    return await new Promise((resolve, reject) => {
      const dockerArgs = ["exec", CONTAINER_NAME, toolName, ...args];
      const child = execFile("docker", dockerArgs, {
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: "utf8",
      }, (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error(`${toolName} timed out after ${timeout}ms`));
          return;
        }
        // Some tools exit non-zero but still produce output
        const output = { stdout: stdout || "", stderr: stderr || "", parsed: null };

        // Try to parse JSON output
        if (opts.parseJson !== false) {
          try {
            // Try full stdout as JSON
            output.parsed = JSON.parse(output.stdout);
          } catch {
            // Try NDJSON (newline-delimited JSON)
            const lines = output.stdout.trim().split("\n").filter(Boolean);
            const jsonLines = [];
            for (const line of lines) {
              try { jsonLines.push(JSON.parse(line)); } catch { /* not JSON */ }
            }
            if (jsonLines.length > 0) {
              output.parsed = jsonLines;
            }
          }
        }

        resolve(output);
      });
    });
  } finally {
    _releaseSlot();
  }
}

/**
 * Check if a specific tool is available in the container.
 */
async function isToolAvailable(toolName) {
  try {
    const result = await runTool("which", [toolName], { timeout: 5000, parseJson: false });
    const available = result.stdout.trim().length > 0;
    _toolHealth[toolName] = { available, checkedAt: Date.now() };
    return available;
  } catch {
    _toolHealth[toolName] = { available: false, checkedAt: Date.now() };
    return false;
  }
}

/**
 * Check if the osint-tools container is running.
 */
async function isContainerRunning() {
  return new Promise((resolve) => {
    execFile("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER_NAME], {
      timeout: 5000,
    }, (error, stdout) => {
      resolve(!error && stdout.trim() === "true");
    });
  });
}

/**
 * Run health checks for all known tools. Returns status map.
 */
async function healthCheck() {
  const tools = [
    "maigret", "holehe", "phoneinfoga", "amass", "nuclei",
    "exiftool", "h8mail", "theHarvester", "sherlock",
  ];

  const containerRunning = await isContainerRunning();
  if (!containerRunning) {
    for (const t of tools) {
      _toolHealth[t] = { available: false, checkedAt: Date.now(), reason: "container_not_running" };
    }
    return { containerRunning: false, tools: { ..._toolHealth } };
  }

  await Promise.all(tools.map((t) => isToolAvailable(t)));
  return { containerRunning: true, tools: { ..._toolHealth } };
}

/**
 * Get cached tool health status.
 */
function getToolStatus() {
  return { ..._toolHealth };
}

module.exports = {
  runTool,
  isToolAvailable,
  isContainerRunning,
  healthCheck,
  getToolStatus,
  CONTAINER_NAME,
};
