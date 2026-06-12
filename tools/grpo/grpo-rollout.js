#!/usr/bin/env node
// dir_1781203380739 — GRPO rollout generator (the missing K-candidate piece).
//
// For each scenario, plays the POLICY model (the pilot) K times end-to-end against the lab,
// recording each trajectory in the shape train_grpo.py + reward.py consume. K trajectories
// from the same scenario form one GRPO group; group-relative advantage over their outcomes
// (captured / didn't) reinforces the whole path that won — which is what teaches the *game*
// (plan -> read feedback -> commit -> exfiltrate), the gap SFT can't close.
//
// Format-consistent with SFT: reuses format-sft.js's SYSTEM_PROMPT + buildUserContent, and
// records the EXACT prompt + the model's raw completion per step (so the trainer doesn't
// re-render with a mismatched format). Calls the self-hosted vLLM only — zero Max quota.
//
// Usage: node grpo-rollout.js --model qwen3-coder-30b-pilot --variants v1,v2 --k 8
//                             --max-iter 15 --out rollouts.jsonl [--variants-config f.json]

const fs = require("fs");
const { spawn } = require("child_process");
const { SYSTEM_PROMPT, buildUserContent } = require("../oracle/format-sft");

const MODEL_URL = process.env.OFFENSE_MODEL_URL || "http://107.170.49.159:8000/v1";
const SSH_HOST = process.env.LAB_SSH_HOST || "dev-01";
const PER_CMD_TIMEOUT_S = 60;
const FLAG_RE = /OZZULAB\{[^}]+\}/;
const EXCERPT = 2500;

// reward.py uses engagement_phase for phase_advance shaping; derive it from intent.
const PHASE = { recon: "recon", service_version: "recon", banner_grab: "recon", enum: "enum",
  cred_test: "exploit", exploit_probe: "exploit", tool_setup: "exploit", post_exploit: "post_exploit", lateral: "post_exploit" };

const VARIANT_SCOPES = {
  v1: { allowed: ["10.10.20.10", "10.10.20.20", "10.10.20.30"], prohibited: ["10.10.20.1"],
        objective: "Find OZZULAB{...} flag on the lab. The flag is in a file somewhere on these hosts — likely under /var/www/, /home/, or via LFI-readable paths. Recon, then exploit, then exfiltrate the flag. Do not stop at recon." },
  v2: { allowed: ["10.10.21.10", "10.10.21.20", "10.10.21.30"], prohibited: ["10.10.21.1"],
        objective: "Find OZZULAB{...} flag on the lab. The flag is on the file system of one of the target hosts — exploit a service, get a shell or LFI, exfiltrate. Do not stop at recon." },
};

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }

function runOnDev01(command) {
  return new Promise((resolve) => {
    const start = Date.now();
    const proc = spawn("ssh", ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", SSH_HOST, "bash", "-s"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    const t = setTimeout(() => { killed = true; try { proc.kill("SIGKILL"); } catch (_) {} }, PER_CMD_TIMEOUT_S * 1000);
    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => err += d.toString());
    proc.on("close", code => { clearTimeout(t); resolve({ exit_code: code, timed_out: killed, output: (out + (err ? "\n[stderr]\n" + err : "")).slice(0, 8000) }); });
    proc.on("error", e => { clearTimeout(t); resolve({ exit_code: -1, timed_out: false, output: `[ssh-error] ${e.message}` }); });
    try { proc.stdin.write(command); proc.stdin.end(); } catch (_) {}
  });
}

async function askModel(model, messages, temp, maxTokens = 2560) {
  const res = await fetch(`${MODEL_URL}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: temp, stream: false, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`vllm ${res.status}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "";
}

function extractField(s, field) {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(s);
  if (!m) return null;
  const rest = s.slice(m.index + m[0].length);
  const close = rest.match(/"\s*[,}]/);
  const val = (close ? rest.slice(0, close.index) : rest.replace(/"\s*$/, ""))
    .replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\").trim();
  return val || null;
}
function parseAction(raw) {
  let s = (raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try { return JSON.parse(s); }
  catch (e) {
    const cmd = extractField(s, "command");
    if (cmd) return { command: cmd, intent_class: extractField(s, "intent_class") || "exploit_probe", reasoning: extractField(s, "reasoning") || "" };
    throw e;
  }
}

// One full rollout: policy plays the engagement; record the GRPO/reward step shape.
async function rollout({ variant, model, max_iter, group, idx, temp = 0.7 }) {
  const scope = VARIANT_SCOPES[variant];
  const state = { objective: scope.objective, allowed: scope.allowed, prohibited: scope.prohibited, synthetic_lab: true, queue_history: [], iter: 0, max_iter };
  const traj = { engagement_id: `GRPO-${variant}-g${group}-${idx}`, variant, group, trajectory: [], flag_captured: false, flag_value: null };
  let consecFail = 0;

  for (let i = 1; i <= max_iter; i++) {
    state.iter = i;
    const prompt = buildUserContent(state);     // EXACT SFT-format user message
    let raw = null, action = null;
    for (const tmp of [temp, Math.min(temp + 0.3, 1.2)]) {   // sample; retry hotter if unparsable
      try { raw = await askModel(model, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], tmp); action = parseAction(raw); break; }
      catch (_) { action = null; }
    }
    if (!action || !action.command || !action.command.trim()) {
      if (++consecFail >= 4) { traj.end_reason = `parse_fail_x4_iter_${i}`; break; }
      continue;
    }
    consecFail = 0;
    const cmd = action.command;
    const exec = await runOnDev01(cmd);
    const flagMatch = (exec.output || "").match(FLAG_RE);
    const intent = action.intent_class || "exploit_probe";
    const excerpt = (exec.output || "").slice(0, EXCERPT);

    traj.trajectory.push({
      iter: i,
      prompt,                                   // user content (system is constant SYSTEM_PROMPT)
      completion: raw,                          // the model's OWN output — what GRPO reinforces
      command: cmd,
      intent,
      reasoning: action.reasoning || "",
      expected_artifact: action.expected_artifact || "",
      engagement_phase: PHASE[intent] || "recon",
      outcome: { exit_code: exec.exit_code, output: excerpt },   // reward.py reads outcome.output
    });
    state.queue_history.push({ id: i, status: exec.exit_code === 0 ? "done" : "failed", intent, command: cmd, output_excerpt: excerpt });

    if (flagMatch) { traj.flag_captured = true; traj.flag_value = flagMatch[0]; traj.end_reason = "flag_captured"; break; }
  }
  if (!traj.end_reason) traj.end_reason = "max_iter_reached";
  return traj;
}

async function main() {
  const model = arg("model", "qwen3-coder-30b-pilot");
  const variants = (arg("variants", "v1,v2")).split(",");
  const K = parseInt(arg("k", "8"), 10);
  const max_iter = parseInt(arg("max-iter", "15"), 10);
  const outFile = arg("out", "/home/gcp/ozzu/private/grpo-trajectories/rollouts.jsonl");
  const cfg = arg("variants-config", null);
  if (cfg) Object.assign(VARIANT_SCOPES, JSON.parse(fs.readFileSync(cfg, "utf8")));

  fs.mkdirSync(require("path").dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, "");
  console.error(`[grpo-rollout] model=${model} variants=${variants} K=${K} max_iter=${max_iter}`);

  const CONC = parseInt(arg("conc", "6"), 10);   // safe for read-heavy v1 (LFI/DB reads, no state writes)
  const TEMP = parseFloat(arg("temp", "0.7"));
  let group = 0;
  for (const variant of variants) {
    let wins = 0, done = 0;
    const queue = Array.from({ length: K }, (_, idx) => idx);
    const worker = async () => {
      while (queue.length) {
        const idx = queue.shift();
        const t = await rollout({ variant, model, max_iter, group, idx, temp: TEMP });
        fs.appendFileSync(outFile, JSON.stringify(t) + "\n");   // sync write = atomic per line
        if (t.flag_captured) wins++;
        console.error(`[grpo-rollout] ${variant} #${++done}/${K} flag=${t.flag_captured} steps=${t.trajectory.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, K) }, worker));
    console.error(`[grpo-rollout] === ${variant}: ${wins}/${K} captured (need a MIX per group of 8) ===`);
    group++;
  }
  console.error(`[grpo-rollout] DONE -> ${outFile}`);
}

main().catch(e => { console.error("[grpo-rollout] fatal:", e); process.exit(2); });
