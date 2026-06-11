#!/usr/bin/env node
// Phase A of the DeepSeek-R1 distillation recipe — the lab-verification step
// that Sprint 2c skipped. For each Opus candidate, run it against the live
// OzzuLab on dev-01, capture the outcome, score by ACTUAL result (not Opus
// opinion).
//
// See `.cipher/layer4/intent/distillation.md` for the master plan.
//
// Input: a trajectory JSON line (output of generate-trajectories-v2.js).
//   Required fields:
//     - scenario.allowed: array of target IPs (used to pick lab variant)
//     - best.command: the bash command to execute
//
// Output: same trajectory line + { lab_verify: { ...score breakdown... } }
//
// Usage (single):
//   node replay-and-verify.js --in trajectory.jsonl --out verified.jsonl
//
// The script SSH-dispatches to dev-01 and collects output. Same path the
// bridge uses for queue dispatch, so behavior matches what the model
// would actually see in a live engagement.

const fs = require("fs");
const readline = require("readline");
const { spawn } = require("child_process");
const path = require("path");

const FLAG_RE = /OZZULAB\{[^}]+\}/;
const PER_CMD_TIMEOUT_S = 60;       // hard ceiling — most lab probes finish in <10s
const SSH_HOST = "dev-01";          // matches existing bridge config

// Scoring weights — same as the master plan
const SCORE_FLAG = 10;
// Reconciled dir_1781203380739: artifact capped BELOW the flag. Was 5 (stacks x3 = 15,
// and an /etc/passwd read with valid-output bonus scored +11 > flag's +10 — the model
// would learn to dump passwd over capturing the flag). Now max artifact = 2*3 = 6 < 10.
const SCORE_NEW_ARTIFACT = 2;
const SCORE_VALID_OUTPUT = 1;
const SCORE_ERROR = -2;
const SCORE_OUT_OF_SCOPE = -5;

// Patterns that signal "real new artifact discovered" in lab output.
// These are the byproducts a successful exploitation step actually produces.
const ARTIFACT_PATTERNS = [
  /root:[^:]*:0:0/,                          // /etc/passwd content
  /www-data:[^:]*:33:33/,                    // /etc/passwd www-data line
  /<\?php/,                                  // raw PHP source leaked via LFI
  /DB_PASSWORD|DB_USER|mysql_password/i,     // creds leaked
  /uid=\d+\(/,                               // shell command output from RCE
  /\$1\$|MD5:|sha\d+\$/,                     // password hashes
  /MariaDB|MySQL.*version/i,                 // db banner from successful conn
  /Welcome to.*portal/i,                     // app-specific success pages
];

// Error fingerprints that should score negative.
const ERROR_PATTERNS = [
  /Permission denied/i,
  /Connection refused/i,
  /No route to host/i,
  /Could not resolve host/i,
  /^curl: \(\d+\)/m,
  /404 Not Found/i,
  /401 Unauthorized/i,
  /403 Forbidden/i,
  /syntax error/i,
  /command not found/i,
];

function pickVariant(allowed) {
  // OzzuLab v1 = 10.10.20.0/24 (LFI), v2 = 10.10.21.0/24 (cmdinj).
  // Read the scenario's allowed list and detect.
  const sample = (Array.isArray(allowed) ? allowed : []).join(" ");
  if (/10\.10\.20\./.test(sample)) return "v1";
  if (/10\.10\.21\./.test(sample)) return "v2";
  return "unknown";
}

function containsOutOfScope(command, allowed) {
  // Pull every IPv4 literal from the command and check each is in `allowed`.
  // Loose check — workspace_jail is the production version, this is a smoke
  // check so we tag obviously-bad commands.
  const ipRe = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
  const allowSet = new Set((allowed || []).map(a => a.trim()));
  const m = (command || "").match(ipRe) || [];
  for (const ip of m) {
    // Allow 127.0.0.1 and localhost-ish since some commands legitimately use them
    if (ip === "127.0.0.1" || ip === "0.0.0.0") continue;
    // Allow if in scope literally OR if its /24 is in allowed
    if (allowSet.has(ip)) continue;
    const slash24 = ip.split(".").slice(0, 3).join(".") + ".0/24";
    if (allowSet.has(slash24)) continue;
    return ip;
  }
  return null;
}

function runOnDev01(command) {
  // Same SSH-stdin path the bridge uses: ship the command body via stdin
  // to a remote bash -s. No local shell parsing on the bridge side.
  return new Promise((resolve) => {
    const start = Date.now();
    const proc = spawn("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=10",
      "-o", `ServerAliveInterval=5`,
      SSH_HOST,
      "bash", "-s"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGKILL"); } catch (_) {}
    }, PER_CMD_TIMEOUT_S * 1000);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      const dur = (Date.now() - start) / 1000;
      resolve({
        exit_code: code,
        signal,
        timed_out: killed,
        duration_s: dur,
        stdout,
        stderr,
        output: (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, 8000),
      });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        exit_code: -1,
        signal: null,
        timed_out: false,
        duration_s: (Date.now() - start) / 1000,
        stdout: "",
        stderr: e.message,
        output: `[ssh-error] ${e.message}`,
      });
    });

    try {
      proc.stdin.write(command);
      proc.stdin.end();
    } catch (_) { /* if remote closes early */ }
  });
}

function scoreOutcome({ command, allowed, exit_code, output, timed_out }) {
  const components = {};
  let total = 0;

  // Hard penalty for out-of-scope target — checked BEFORE running ideally,
  // but we still tag it here in case the command got through.
  const oos = containsOutOfScope(command, allowed);
  if (oos) {
    components.out_of_scope = { hit: oos, weight: SCORE_OUT_OF_SCOPE };
    total += SCORE_OUT_OF_SCOPE;
  }

  // The big one: did the command pull a flag?
  const flagMatch = (output || "").match(FLAG_RE);
  const flag_captured = !!flagMatch;
  if (flag_captured) {
    components.flag = { match: flagMatch[0], weight: SCORE_FLAG };
    total += SCORE_FLAG;
  }

  // New artifact discovery — credentials, /etc/passwd content, PHP source,
  // shell output. Each unique pattern hit counts once.
  const artifacts_seen = [];
  for (const pat of ARTIFACT_PATTERNS) {
    if (pat.test(output || "")) artifacts_seen.push(pat.source);
  }
  if (artifacts_seen.length) {
    components.new_artifacts = {
      patterns: artifacts_seen,
      weight: SCORE_NEW_ARTIFACT * Math.min(artifacts_seen.length, 3),
    };
    total += components.new_artifacts.weight;
  }

  // Error fingerprints — penalize bad commands that returned nothing useful.
  const errors_seen = [];
  for (const pat of ERROR_PATTERNS) {
    if (pat.test(output || "")) errors_seen.push(pat.source);
  }
  if (errors_seen.length && !flag_captured && !artifacts_seen.length) {
    components.errors = { patterns: errors_seen, weight: SCORE_ERROR };
    total += SCORE_ERROR;
  }

  // Valid-output bonus — exit_code 0 + non-trivial output + no errors
  if (exit_code === 0 && (output || "").trim().length > 50 && !errors_seen.length && !flag_captured) {
    components.valid_output = { weight: SCORE_VALID_OUTPUT };
    total += SCORE_VALID_OUTPUT;
  }

  if (timed_out) {
    components.timed_out = { weight: SCORE_ERROR };
    total += SCORE_ERROR;
  }

  return {
    total,
    flag_captured,
    components,
  };
}

async function verifyOne(traj) {
  const scenario = traj.scenario || {};
  const best = traj.best || {};
  const command = best.command || "";
  const allowed = scenario.allowed || [];
  const variant = pickVariant(allowed);

  if (!command) {
    return {
      ...traj,
      lab_verify: { skipped: true, reason: "no command in best" },
    };
  }

  const exec = await runOnDev01(command);
  const score = scoreOutcome({
    command,
    allowed,
    exit_code: exec.exit_code,
    output: exec.output,
    timed_out: exec.timed_out,
  });

  return {
    ...traj,
    lab_verify: {
      ts: new Date().toISOString(),
      variant,
      command,
      exit_code: exec.exit_code,
      signal: exec.signal,
      timed_out: exec.timed_out,
      duration_s: Number(exec.duration_s.toFixed(2)),
      output_excerpt: (exec.output || "").slice(0, 500),
      lab_score: score.total,
      flag_captured: score.flag_captured,
      score_breakdown: score.components,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const argVal = (k, def = null) => {
    const i = args.findIndex(a => a === k);
    return i >= 0 ? args[i + 1] : def;
  };
  const inFile = argVal("--in");
  const outFile = argVal("--out");
  const smokeCmd = argVal("--smoke-cmd");   // for direct command smoke test
  const smokeAllowed = argVal("--smoke-allowed", "10.10.20.10,10.10.20.20,10.10.20.30");
  const limit = parseInt(argVal("--limit", "0"), 10);

  // SMOKE MODE: run a single command directly (no jsonl)
  if (smokeCmd) {
    const fakeTraj = {
      scenario: { allowed: smokeAllowed.split(",").map(s => s.trim()) },
      best: { command: smokeCmd },
    };
    const r = await verifyOne(fakeTraj);
    process.stdout.write(JSON.stringify(r.lab_verify, null, 2) + "\n");
    process.exit(r.lab_verify.lab_score > 0 ? 0 : 1);
  }

  if (!inFile) {
    console.error("Usage: replay-and-verify.js --in <trajectories.jsonl> --out <verified.jsonl> [--limit N]");
    console.error("   or: replay-and-verify.js --smoke-cmd '<command>' [--smoke-allowed '10.10.20.10,10.10.20.20']");
    process.exit(2);
  }

  if (!outFile) {
    console.error("--out required when --in is given");
    process.exit(2);
  }

  const outFd = fs.openSync(outFile, "w");
  const rl = readline.createInterface({ input: fs.createReadStream(inFile), crlfDelay: Infinity });
  let n = 0, kept = 0, flag_n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let traj;
    try { traj = JSON.parse(line); }
    catch (e) { console.error(`[skip] bad json on line ${n}`); continue; }
    n++;
    if (limit > 0 && n > limit) break;
    const verified = await verifyOne(traj);
    fs.writeSync(outFd, JSON.stringify(verified) + "\n");
    if (verified.lab_verify.lab_score > 0) kept++;
    if (verified.lab_verify.flag_captured) flag_n++;
    if (n % 10 === 0) {
      console.error(`[progress] ${n} processed, ${kept} positive scored, ${flag_n} flags`);
    }
  }
  fs.closeSync(outFd);
  console.error(`[done] processed=${n} positive_score=${kept} flag_captured=${flag_n} -> ${outFile}`);
}

if (require.main === module) {
  main().catch(e => { console.error("fatal:", e); process.exit(1); });
}
