#!/usr/bin/env node
// Sprint 2c-v2: Opus plays a full engagement end-to-end against OzzuLab.
//
// Why this exists: the original Sprint 2c asked Opus "given this state, what's
// the next command?" 866 times in isolation. Opus answered "more recon" 99% of
// the time because single-step prompting biases toward conservative moves. The
// dataset that resulted had zero flag captures, which is why the SFT'd model
// can't capture flags.
//
// This script lets Opus PLAY the engagement: it picks command 1, we run it,
// feed Opus the output, it picks command 2 with full context, etc. Up to
// max_iter, or until flag captured. Engagements that DO capture the flag
// become the new training data — real (state, command, outcome) trajectories
// that actually win.
//
// Run as: node play-engagement.js [--variant v1|v2] [--max-iter 15]
//                                  [--out trajectory.jsonl]

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { askOracle } = require("./oracle");

const VARIANT_SCOPES = {
  v1: {
    allowed: ["10.10.20.10", "10.10.20.20", "10.10.20.30"],
    prohibited: ["10.10.20.1"],
    targets:   ["10.10.20.0/24"],
    objective: "Find OZZULAB{...} flag on the lab. The flag is in a file somewhere on these hosts — likely under /var/www/, /home/, or via LFI-readable paths. Recon, then exploit, then exfiltrate the flag. Do not stop at recon.",
  },
  v2: {
    allowed: ["10.10.21.10", "10.10.21.20", "10.10.21.30"],
    prohibited: ["10.10.21.1"],
    targets:   ["10.10.21.0/24"],
    objective: "Find OZZULAB{...} flag on the lab. The flag is on the file system of one of the target hosts — exploit a service, get a shell or LFI, exfiltrate. Do not stop at recon.",
  },
};

const FLAG_RE = /OZZULAB\{[^}]+\}/;
const PER_CMD_TIMEOUT_S = 60;
const SSH_HOST = "dev-01";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function runOnDev01(command) {
  return new Promise((resolve) => {
    const start = Date.now();
    const proc = spawn("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=5",
      SSH_HOST, "bash", "-s"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGKILL"); } catch (_) {}
    }, PER_CMD_TIMEOUT_S * 1000);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        timed_out: killed,
        duration_s: (Date.now() - start) / 1000,
        output: (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).slice(0, 8000),
      });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exit_code: -1, timed_out: false, duration_s: 0, output: `[ssh-error] ${e.message}` });
    });

    try { proc.stdin.write(command); proc.stdin.end(); } catch (_) {}
  });
}

async function playEngagement({ variant, max_iter, engagement_id }) {
  const scope = VARIANT_SCOPES[variant];
  if (!scope) throw new Error(`unknown variant: ${variant}`);

  const trajectory = {
    engagement_id,
    variant,
    started_at: new Date().toISOString(),
    objective: scope.objective,
    iters: [],
    flag_captured: false,
    flag_value: null,
    end_reason: null,
  };

  // Bridge-style state object — same shape askOracle() expects.
  const state = {
    objective: scope.objective,
    allowed: scope.allowed,
    prohibited: scope.prohibited,
    synthetic_lab: true,
    queue_history: [],
    iter: 0,
    max_iter,
  };

  for (let i = 1; i <= max_iter; i++) {
    state.iter = i;

    // Ask Opus what to do given current state + history.
    const t_oracle = Date.now();
    const r = await askOracle(state);
    const oracle_dur = (Date.now() - t_oracle) / 1000;

    if (!r.ok) {
      trajectory.iters.push({ iter: i, oracle_error: r.error, raw: r.raw });
      trajectory.end_reason = `oracle_parse_fail_iter_${i}`;
      break;
    }

    const cmd = r.oracle_command;
    if (!cmd || !cmd.trim()) {
      trajectory.end_reason = `oracle_empty_command_iter_${i}`;
      break;
    }

    // Execute the candidate.
    const exec = await runOnDev01(cmd);
    const flagMatch = (exec.output || "").match(FLAG_RE);

    const iterRecord = {
      iter: i,
      oracle_reasoning: r.oracle_reasoning,
      oracle_intent: r.oracle_intent,
      oracle_expected: r.oracle_expected,
      command: cmd,
      output_excerpt: (exec.output || "").slice(0, 2500),   // dir_1781203380739: was 500 — truncated multi-host nmap, blinding host-targeting
      exit_code: exec.exit_code,
      timed_out: exec.timed_out,
      duration_s: Number(exec.duration_s.toFixed(2)),
      oracle_dur_s: Number(oracle_dur.toFixed(2)),
      flag_captured: !!flagMatch,
      // dir_1781203380739: record WHICH model answered + token cost so a harvest is
      // never again un-auditable ("was that Opus or Fable, and what did it spend?").
      oracle_model: r.model || null,
      oracle_usage: r.usage || null,
    };
    trajectory.iters.push(iterRecord);

    // Update state.queue_history so next iter sees full context.
    state.queue_history.push({
      id: i,
      status: exec.exit_code === 0 ? "done" : "failed",
      intent: r.oracle_intent,
      command: cmd,
      output_excerpt: (exec.output || "").slice(0, 2500),   // dir_1781203380739: match iter record + eval excerpt
    });

    if (flagMatch) {
      trajectory.flag_captured = true;
      trajectory.flag_value = flagMatch[0];
      trajectory.end_reason = "flag_captured";
      break;
    }
  }

  if (!trajectory.end_reason) trajectory.end_reason = "max_iter_reached";
  trajectory.finished_at = new Date().toISOString();
  trajectory.total_iters = trajectory.iters.length;
  return trajectory;
}

async function main() {
  const variant = arg("variant", "v1");
  const max_iter = parseInt(arg("max-iter", "15"), 10);
  const outFile = arg("out", null);
  const engagement_id = arg("id", `OPUS-${variant}-${Date.now()}`);

  console.error(`[play] variant=${variant} max_iter=${max_iter} id=${engagement_id}`);

  const traj = await playEngagement({ variant, max_iter, engagement_id });

  const out = JSON.stringify(traj) + "\n";
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.appendFileSync(outFile, out);
    console.error(`[play] wrote → ${outFile}`);
  } else {
    process.stdout.write(out);
  }

  console.error(`[play] DONE iters=${traj.total_iters} flag_captured=${traj.flag_captured} flag=${traj.flag_value || "-"}`);
  process.exit(traj.flag_captured ? 0 : 1);
}

if (require.main === module) {
  main().catch(e => { console.error("[play] fatal:", e); process.exit(2); });
}
