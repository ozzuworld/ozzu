"use strict";
// offense-startup.js — one-click L3 offense model lifecycle (dir_1780582623131)
//
// Replaces the manual 12-min "rent + attach SSH key + install Ollama + pull
// model + open tunnel" sequence with three idempotent operations:
//
//   startOffenseModel(opts)  -> rents (or reuses) a vast.ai GPU, installs
//                               Ollama, kicks off the model pull in BACKGROUND
//                               on the remote. Returns immediately.
//   waitOffenseModel({timeout_sec}) -> blocks until ollama list shows the
//                               model, then opens the bridge->instance SSH
//                               tunnel and verifies /v1/models is reachable.
//   stopOffenseModel()       -> closes the bridge tunnel and destroys all
//                               running vast.ai instances (billing stops).
//
// Membrane discipline: all three return ONLY sanitized status — no offensive
// content. The membrane is the same one offense-engine.js relies on. See
// SOC-PIPELINE-ARCHITECTURE.md.

const fs = require("fs");
const net = require("net");
const https = require("https");
const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

const VAST_KEY_PATH = "/root/.config/vastai/vast_api_key";
const BRIDGE_PUBKEY_PATH = "/root/.ssh/id_ed25519.pub";
const DEFAULT_MODEL = process.env.OFFENSE_MODEL_NAME || "deepseek-r1:32b";
const DEFAULT_GPU = "RTX_4090";
const DEFAULT_MAX_COST = 0.50;
const DEFAULT_DISK_GB = 60;
const OLLAMA_CTX = 16384;

// ----- vast.ai api -----

function readVastKey() {
  try { return fs.readFileSync(VAST_KEY_PATH, "utf8").trim(); }
  catch (e) { throw new Error(`vast.ai API key not found at ${VAST_KEY_PATH}`); }
}

function readBridgePubkey() {
  return fs.readFileSync(BRIDGE_PUBKEY_PATH, "utf8").trim();
}

function vastReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const vastKey = readVastKey();
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: `Bearer ${vastKey}` };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(`https://console.vast.ai/api/v0${path}`, { method, headers, timeout: 30000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`vast.ai non-JSON: ${d.slice(0, 200)}`)); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("vast.ai timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}
const vastGet = (p) => vastReq("GET", p);
const vastPost = (p, b) => vastReq("POST", p, b);
const vastPut = (p, b) => vastReq("PUT", p, b);
const vastDelete = (p) => vastReq("DELETE", p);

// ----- ssh helpers -----

function sshOpts(port) {
  return [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-p", String(port),
  ];
}

function probeSshPort(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(false));
    s.connect(port, host);
  });
}

function probeSshAuth(host, port) {
  return new Promise((resolve) => {
    const p = spawn("ssh", [...sshOpts(port), `root@${host}`, "echo", "AUTH_OK"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("exit", (code) => resolve(code === 0 && out.includes("AUTH_OK")));
    p.on("error", () => resolve(false));
  });
}

function runRemoteScript(host, port, script, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = spawn("ssh", [...sshOpts(port), `root@${host}`, "bash", "-s"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("exit", (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.stdin.write(script);
    p.stdin.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- tunnel mgmt (inside the bridge container) -----

async function killBridgeTunnel() {
  try { await execAsync("pkill -f 'ssh -N -L 127.0.0.1:11434:127.0.0.1:11434'"); } catch { /* none was running */ }
}

function openBridgeTunnel(host, port) {
  const args = [
    "-N",
    "-L", "127.0.0.1:11434:127.0.0.1:11434",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ServerAliveInterval=60",
    "-o", "ServerAliveCountMax=5",
    "-o", "ExitOnForwardFailure=yes",
    "-p", String(port),
    `root@${host}`,
  ];
  const p = spawn("ssh", args, { detached: true, stdio: "ignore" });
  p.unref();
  return p.pid;
}

async function isTunnelHealthy() {
  try {
    const r = await execAsync("curl -s --max-time 3 http://127.0.0.1:11434/api/tags");
    return r.stdout.includes("\"models\"");
  } catch { return false; }
}

// ----- discovery -----

// Returns the single L3 instance if one exists (treats this as a singleton
// lifecycle — we don't manage multiple parallel L3 instances).
async function findOurInstance() {
  const info = await vastGet("/instances/?owner=me");
  const list = info.instances || [];
  if (list.length === 0) return null;
  // Prefer running over loading
  return list.find((i) => i.actual_status === "running") || list[0];
}

function instanceToConn(inst) {
  // Prefer direct SSH (public_ipaddr + ports['22/tcp']) over the vast.ai proxy
  // (ssh_host=ssh7.vast.ai etc.) — the proxy doesn't accept our keys reliably.
  // Mirrors the gpu_status handler's picking logic in routes/mcp.js.
  let host = inst.ssh_host;
  let port = Number(inst.ssh_port);
  const sshMapping = inst.ports && inst.ports["22/tcp"];
  if (inst.public_ipaddr && sshMapping && sshMapping[0]) {
    host = inst.public_ipaddr;
    port = Number(sshMapping[0].HostPort);
  }
  return { id: inst.id, host, port, gpu: inst.gpu_name, cost: Number(inst.dph_total), status: inst.actual_status };
}

// ----- start -----

async function rentInstance(gpu, maxCost, diskGb) {
  const q = encodeURIComponent(JSON.stringify({
    gpu_name: { eq: gpu },
    dph_total: { lte: maxCost },
    disk_space: { gte: diskGb },
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
  }));
  const offers = await vastGet(`/bundles?q=${q}&order=[[%22dph_total%22,%22asc%22]]&limit=5`);
  const list = offers.offers || [];
  if (list.length === 0) throw new Error(`no ${gpu} offers <= $${maxCost}/hr with >= ${diskGb}GB disk`);
  const best = list[0];
  const r = await vastPut(`/asks/${best.id}/`, { client_id: "me", image: "vastai/base-image:cuda-13.0.2-auto", disk: diskGb });
  if (!r.new_contract) throw new Error(`vast.ai rent failed: ${JSON.stringify(r).slice(0, 200)}`);
  return r.new_contract;
}

async function pollInstanceRunning(instanceId, maxSec = 240) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSec) {
    const info = await vastGet(`/instances/${instanceId}`);
    const inst = info.instances ? info.instances[0] : info;
    if (inst && inst.actual_status === "running" && inst.ssh_port) return instanceToConn(inst);
    await sleep(8000);
  }
  throw new Error(`instance ${instanceId} did not become running in ${maxSec}s`);
}

async function attachSshKey(instanceId, pubkey) {
  const r = await vastPost(`/instances/${instanceId}/ssh/`, { ssh_key: pubkey });
  // "already associated" is success
  if (r.success === false && !/already/i.test(r.msg || "")) {
    throw new Error(`attach ssh-key failed: ${r.msg || JSON.stringify(r)}`);
  }
}

async function pollSshReady(host, port, maxSec = 180) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSec) {
    if (await probeSshPort(host, port)) {
      if (await probeSshAuth(host, port)) return;
    }
    await sleep(5000);
  }
  throw new Error(`SSH not ready on ${host}:${port} in ${maxSec}s`);
}

function installScript(model) {
  return `set -e
if ! which ollama >/dev/null 2>&1; then
  echo "=== install ollama v0.30.4 ==="
  which zstd >/dev/null 2>&1 || apt-get install -y zstd >/dev/null 2>&1
  curl -fsSL https://github.com/ollama/ollama/releases/download/v0.30.4/ollama-linux-amd64.tar.zst -o /tmp/ollama.tar.zst
  tar --zstd -xf /tmp/ollama.tar.zst -C /usr
  echo "installed: $(which ollama)"
else
  echo "ollama already present: $(which ollama)"
fi
echo "=== (re)start ollama serve, ${OLLAMA_CTX} ctx, loopback only ==="
pkill -f "ollama serve" 2>/dev/null || true
sleep 2
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_CONTEXT_LENGTH=${OLLAMA_CTX} OLLAMA_KEEP_ALIVE=24h nohup ollama serve > /var/log/ollama.log 2>&1 &
sleep 6
ss -tln 2>/dev/null | grep -q '127.0.0.1:11434' || { echo "ollama not listening"; tail -20 /var/log/ollama.log; exit 1; }
echo "=== model already present? ==="
if ollama list 2>/dev/null | grep -q "^${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[[:space:]]"; then
  echo "MODEL_ALREADY_PULLED"
else
  echo "=== kick off background pull of ${model} ==="
  : > /var/log/ollama-pull.log
  nohup ollama pull ${model} > /var/log/ollama-pull.log 2>&1 &
  echo "pull_pid=$!"
fi
echo "OFFENSE_STARTUP_DONE"
`;
}

async function startOffenseModel(opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const gpu = opts.gpu_model || DEFAULT_GPU;
  const maxCost = opts.max_cost || DEFAULT_MAX_COST;
  const diskGb = opts.disk_gb || DEFAULT_DISK_GB;
  const pubkey = readBridgePubkey();

  // 1. Detect existing instance (singleton lifecycle)
  let existing = await findOurInstance();
  let inst, reused = false, alreadyPulled = false;
  if (existing) {
    if (existing.actual_status !== "running") {
      inst = await pollInstanceRunning(existing.id);
    } else {
      inst = await instanceToConn(existing);
    }
    reused = true;
  } else {
    // 2. Rent
    const id = await rentInstance(gpu, maxCost, diskGb);
    inst = await pollInstanceRunning(id);
  }

  // 3. Attach SSH key (idempotent)
  await attachSshKey(inst.id, pubkey);

  // 4. Wait for SSH ready
  await pollSshReady(inst.host, inst.port);

  // 5. Install + serve + kick off pull (background on remote)
  const r = await runRemoteScript(inst.host, inst.port, installScript(model), 180000);
  if (r.code !== 0 || !r.stdout.includes("OFFENSE_STARTUP_DONE")) {
    throw new Error(`remote setup failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-400)}`);
  }
  alreadyPulled = r.stdout.includes("MODEL_ALREADY_PULLED");

  return {
    reused,
    instance_id: inst.id,
    model,
    gpu: inst.gpu,
    cost_hr: `$${inst.cost.toFixed(3)}/hr`,
    status: alreadyPulled ? "ready_pending_tunnel" : "provisioning",
    already_pulled: alreadyPulled,
    note: alreadyPulled
      ? "Instance is up, ollama serving, model already present. Call wait_offense_model to open the bridge tunnel."
      : "Instance is up, ollama serving, model pull kicked off in background on the GPU. Call wait_offense_model to block until the pull finishes and open the bridge tunnel.",
  };
}

// ----- wait -----

async function waitOffenseModel(opts = {}) {
  const timeoutSec = opts.timeout_sec || 900;
  const model = process.env.OFFENSE_MODEL_NAME || DEFAULT_MODEL;
  const existing = await findOurInstance();
  if (!existing) throw new Error("no running vast.ai instance — call start_offense_model first");
  const inst = await instanceToConn(existing);
  if (inst.status !== "running") {
    await pollInstanceRunning(inst.id);
  }

  const re = new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m");
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    const r = await runRemoteScript(inst.host, inst.port, "ollama list 2>/dev/null", 20000);
    if (r.code === 0 && re.test(r.stdout)) {
      // Model present. Open the bridge tunnel.
      await killBridgeTunnel();
      openBridgeTunnel(inst.host, inst.port);
      // Give SSH a moment to establish then verify
      await sleep(4000);
      const healthy = await isTunnelHealthy();
      if (!healthy) throw new Error("tunnel opened but /api/tags via tunnel not reachable");
      return {
        ready: true,
        instance_id: inst.id,
        model,
        elapsed_sec: Math.round((Date.now() - start) / 1000),
        note: "L3 offense model is up and the bridge tunnel is open. advance_offense calls will reach it.",
      };
    }
    await sleep(15000);
  }
  throw new Error(`model ${model} did not become ready in ${timeoutSec}s`);
}

// ----- stop -----

async function stopOffenseModel() {
  await killBridgeTunnel();
  const info = await vastGet("/instances/?owner=me");
  const list = info.instances || [];
  const destroyed = [];
  for (const i of list) {
    await vastDelete(`/instances/${i.id}/`);
    destroyed.push(i.id);
  }
  return {
    tunnel_closed: true,
    destroyed_instances: destroyed,
    note: destroyed.length
      ? `Tunnel closed; destroyed ${destroyed.length} instance(s): ${destroyed.join(", ")}. Billing stopped.`
      : "Tunnel closed; no instances were running.",
  };
}

module.exports = { startOffenseModel, waitOffenseModel, stopOffenseModel };
