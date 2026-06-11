#!/usr/bin/env node
// dir_1781203380739 — Rebuild SFT training data with FULL output context.
//
// The harvested play data stored 500-char output excerpts, which truncated multi-host
// nmap and blinded the model to host-targeting. We can't re-excerpt the past harvest
// without re-running Opus (= Max quota), so instead we REPLAY each winning trajectory's
// recorded commands on the lab, capture full (2500-char) output, and emit {scenario,best}
// records whose queue_history shows the model the FULL context it had at each decision.
// Free: lab SSH only, no Opus.
//
// The training TARGET (best.command) is always the original Opus command; only the
// history's output is refreshed. Sharded for parallelism: --shard M/N processes the
// winning trajectories where index % N === M.
//
// Usage: node replay-rebuild-sft.js <play.jsonl> [--shard M/N] > scenarios.jsonl

const fs = require("fs");
const readline = require("readline");
const { spawn } = require("child_process");

const SSH_HOST = process.env.LAB_SSH_HOST || "dev-01";
const TIMEOUT_S = 25;          // cap slow gobuster; partial output is fine for history
const EXCERPT = 2500;
const SCOPES = {
  v1: { allowed: ["10.10.20.10", "10.10.20.20", "10.10.20.30"], prohibited: ["10.10.20.1"] },
  v2: { allowed: ["10.10.21.10", "10.10.21.20", "10.10.21.30"], prohibited: ["10.10.21.1"] },
};

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }

function runOnDev01(cmd) {
  return new Promise((res) => {
    const proc = spawn("ssh", ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", SSH_HOST, "bash", "-s"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    const t = setTimeout(() => { killed = true; try { proc.kill("SIGKILL"); } catch (_) {} }, TIMEOUT_S * 1000);
    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => err += d.toString());
    proc.on("close", code => { clearTimeout(t); res({ exit_code: code, output: (out + (err ? "\n[stderr]\n" + err : "")).slice(0, 8000) }); });
    proc.on("error", e => { clearTimeout(t); res({ exit_code: -1, output: `[ssh-error] ${e.message}` }); });
    try { proc.stdin.write(cmd); proc.stdin.end(); } catch (_) {}
  });
}

async function main() {
  const input = process.argv[2];
  if (!input) { console.error("usage: replay-rebuild-sft.js <play.jsonl> [--shard M/N]"); process.exit(2); }
  const [shardM, shardN] = arg("shard", "0/1").split("/").map(Number);

  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  const all = [];
  for await (const line of rl) { if (line.trim()) { try { const t = JSON.parse(line); if (t.flag_captured && Array.isArray(t.iters)) all.push(t); } catch {} } }
  const mine = all.filter((_, i) => i % shardN === shardM);
  console.error(`[replay shard ${shardM}/${shardN}] ${mine.length} of ${all.length} winning trajectories`);

  let pairs = 0, done = 0;
  for (const t of mine) {
    const scope = SCOPES[t.variant] || { allowed: [], prohibited: [] };
    const maxIter = t.total_iters || t.iters.length;
    const history = [];
    for (const it of t.iters) {
      if (it.command && it.oracle_reasoning) {
        const scenario = { engagement_id: t.engagement_id, objective: t.objective, allowed: scope.allowed, prohibited: scope.prohibited, synthetic_lab: true, iter: it.iter, max_iter: maxIter, queue_history: history.slice() };
        const best = { command: it.command, reasoning: it.oracle_reasoning, intent: it.oracle_intent, expected_artifact: it.oracle_expected };
        process.stdout.write(JSON.stringify({ scenario, best }) + "\n");
        pairs++;
      }
      const exec = await runOnDev01(it.command || "true");   // refresh history output with full context
      history.push({ id: it.iter, status: exec.exit_code === 0 ? "done" : "failed", intent: it.oracle_intent, command: it.command, output_excerpt: (exec.output || "").slice(0, EXCERPT) });
    }
    done++;
    if (done % 5 === 0) console.error(`[replay shard ${shardM}/${shardN}] ${done}/${mine.length}`);
  }
  console.error(`[replay shard ${shardM}/${shardN}] DONE: ${pairs} pairs`);
}

main();
