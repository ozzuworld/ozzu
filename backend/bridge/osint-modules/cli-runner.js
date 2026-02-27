// Shared CLI tool runner for OSINT modules
// Wraps child_process.execFile with timeout, temp files, error handling
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TEMP_DIR = "/tmp/ozzu-bridge/osint-cli";

function ensureTempDir() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function tempPath(prefix, ext = "json") {
  const id = crypto.randomBytes(8).toString("hex");
  return path.join(TEMP_DIR, `${prefix}-${id}.${ext}`);
}

// Run a CLI tool and return stdout
function run(cmd, args, opts = {}) {
  const timeout = opts.timeout || 120000;
  const env = { ...process.env, ...(opts.env || {}) };

  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { timeout, env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Timeout or non-zero exit
        if (err.killed) {
          reject(new Error(`CLI tool timed out after ${timeout}ms: ${cmd}`));
        } else {
          // Some tools exit non-zero but still produce useful output
          if (opts.allowNonZero && stdout) {
            resolve(stdout);
          } else {
            reject(new Error(`CLI tool failed (exit ${err.code}): ${stderr || err.message}`));
          }
        }
      } else {
        resolve(stdout);
      }
    });
  });
}

// Run a CLI tool that writes JSON to a file
async function runWithJsonFile(cmd, args, outputPath, opts = {}) {
  ensureTempDir();
  try {
    await run(cmd, args, opts);
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, "utf8").trim();
      if (!content) return null;
      return JSON.parse(content);
    }
    return null;
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

// Run a CLI tool that outputs NDJSON (one JSON per line)
async function runNdjson(cmd, args, opts = {}) {
  const stdout = await run(cmd, args, opts);
  if (!stdout || !stdout.trim()) return [];
  return stdout.trim().split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Check if a binary exists
function binaryExists(cmd) {
  try {
    require("child_process").execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

module.exports = { run, runWithJsonFile, runNdjson, tempPath, binaryExists, TEMP_DIR };
