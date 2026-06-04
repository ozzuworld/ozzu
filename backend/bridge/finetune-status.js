"use strict";
// finetune-status.js — Step 9.9 of OFFENSE-FINETUNE-DESIGN.md (dir_1780596279268)
//
// Reports the current state of the Qwen3-32B LoRA fine-tune pipeline.
// One-call view so the operator (or future Cipher session) can pick up
// the workflow without re-deriving where things stand.
//
// Probes (all read-only):
//   - Local dataset corpora under /tmp/finetune/  (existence + size + line count)
//   - Active DO droplets via the DO API           (ozzu-finetune-prefixed only)
//   - Trained adapter at /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/
//   - Whether ozzu-soc-v1 is registered in Ollama (via the inference tunnel)

const fs    = require("fs");
const https = require("https");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

const DO_TOKEN_PATH       = "/root/.config/digitalocean/access_token";
const DATASET_DIR         = "/tmp/finetune";
const ADAPTER_HOME        = "/home/gcp/ozzu/private/finetune";
const OLLAMA_TUNNEL_BASE  = "http://127.0.0.1:11434";
const EXPECTED_CORPORA    = ["wrn.jsonl", "writeups.jsonl", "agent.jsonl", "train.jsonl", "eval.jsonl"];

function readDOTokenSafe() {
  try { return fs.readFileSync(DO_TOKEN_PATH, "utf8").trim(); }
  catch { return null; }
}

function fileInfo(path) {
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile()) return null;
    // Approx line count via byte sniff isn't reliable; do a quick line read for jsonl files
    let lines = null;
    try {
      // Cheap: count newlines via streaming would be cleaner; quick-and-dirty is fine for status
      const data = fs.readFileSync(path, "utf8");
      lines = data ? data.split("\n").filter(Boolean).length : 0;
    } catch { /* leave null */ }
    return {
      path, size_bytes: stat.size,
      size_mb: +(stat.size / (1024 * 1024)).toFixed(2),
      lines, mtime: stat.mtime.toISOString(),
    };
  } catch { return null; }
}

async function probeDODroplets() {
  const token = readDOTokenSafe();
  if (!token) return { available: false, reason: "DO token not present at " + DO_TOKEN_PATH };
  return new Promise((resolve) => {
    https.get("https://api.digitalocean.com/v2/droplets?per_page=200",
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 },
      (res) => {
        let body = ""; res.on("data", (c) => body += c);
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            const all = j.droplets || [];
            const ours = all.filter((d) => (d.name || "").startsWith("ozzu-finetune"));
            resolve({
              available: true,
              total: all.length,
              ozzu_finetune_droplets: ours.map((d) => ({
                id: d.id, name: d.name, status: d.status,
                size: d.size_slug, region: d.region && d.region.slug,
                price_hourly: d.size && d.size.price_hourly,
                ip: (d.networks && d.networks.v4 || []).find((n) => n.type === "public")?.ip_address || null,
                created_at: d.created_at,
              })),
            });
          } catch (e) { resolve({ available: false, reason: `DO API parse error: ${e.message}` }); }
        });
      }).on("error", (e) => resolve({ available: false, reason: `DO API error: ${e.message}` }))
        .on("timeout", function () { this.destroy(); resolve({ available: false, reason: "DO API timeout" }); });
  });
}

function listAdapters() {
  try {
    if (!fs.existsSync(ADAPTER_HOME)) return [];
    const entries = fs.readdirSync(ADAPTER_HOME, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => {
      const dir = `${ADAPTER_HOME}/${e.name}`;
      const manifestPath = `${dir}/manifest.json`;
      let manifest = null;
      if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
        catch { manifest = { _parse_error: true }; }
      }
      const finalDir = `${dir}/final-adapter`;
      let adapter_present = false;
      if (fs.existsSync(`${finalDir}/adapter_config.json`) &&
          fs.existsSync(`${finalDir}/adapter_model.safetensors`)) {
        adapter_present = true;
      }
      return { name: e.name, dir, adapter_present, manifest };
    });
  } catch (e) { return []; }
}

async function probeOllamaRegistered() {
  try {
    const r = await execAsync(`curl -s --max-time 3 ${OLLAMA_TUNNEL_BASE}/api/tags`);
    const j = JSON.parse(r.stdout);
    const models = (j.models || []).map((m) => m.name);
    return { reachable: true, models, ozzu_soc_v1_registered: models.some((n) => n.startsWith("ozzu-soc-v1")) };
  } catch (e) { return { reachable: false, reason: e.message.slice(0, 160) }; }
}

async function status() {
  const datasets = {};
  for (const f of EXPECTED_CORPORA) datasets[f] = fileInfo(`${DATASET_DIR}/${f}`);

  const droplets = await probeDODroplets();
  const adapters = listAdapters();
  const ollama   = await probeOllamaRegistered();

  return {
    dataset_dir: DATASET_DIR,
    corpora: datasets,
    do_droplets: droplets,
    local_adapters: adapters,
    ollama: ollama,
    summary: summarize(datasets, droplets, adapters, ollama),
  };
}

function summarize(corpora, droplets, adapters, ollama) {
  const lines = [];
  // Corpora readiness
  const have_train = !!(corpora["train.jsonl"]);
  const have_wrn   = !!(corpora["wrn.jsonl"]);
  const have_wu    = !!(corpora["writeups.jsonl"]);
  const have_agt   = !!(corpora["agent.jsonl"]);
  if (have_train) lines.push(`✓ train.jsonl ready (${corpora["train.jsonl"].lines} examples, ${corpora["train.jsonl"].size_mb} MB)`);
  else            lines.push(`✗ train.jsonl missing — run merge.py over corpora`);
  if (have_wrn)   lines.push(`✓ wrn.jsonl present`); else lines.push(`✗ wrn.jsonl missing — run build-wrn.py`);
  if (have_wu)    lines.push(`✓ writeups.jsonl present`); else lines.push(`✗ writeups.jsonl missing — run scrape-writeups.py`);
  if (have_agt)   lines.push(`✓ agent.jsonl present (tool-use preservation)`);
  else            lines.push(`~ agent.jsonl absent (OK on first training run; required from run #2)`);
  // DO droplets
  if (droplets.available) {
    if ((droplets.ozzu_finetune_droplets || []).length) {
      const d = droplets.ozzu_finetune_droplets[0];
      lines.push(`! DO droplet ACTIVE: id=${d.id} ${d.size} @ \$${d.price_hourly}/hr — destroy when done!`);
    } else lines.push(`✓ no DO droplets running ($0 burn)`);
  } else lines.push(`? DO unreachable: ${droplets.reason || "?"}`);
  // Adapters
  const ready = adapters.find((a) => a.adapter_present);
  if (ready) lines.push(`✓ trained adapter ready: ${ready.dir}`);
  else if (adapters.length) lines.push(`~ adapter dirs exist but no final-adapter saved yet`);
  else lines.push(`✗ no trained adapter yet`);
  // Ollama
  if (ollama.reachable) {
    if (ollama.ozzu_soc_v1_registered) lines.push(`✓ ozzu-soc-v1 registered in Ollama`);
    else lines.push(`~ ozzu-soc-v1 NOT registered in Ollama (run deploy/load.sh after training)`);
  } else lines.push(`? Ollama unreachable: ${ollama.reason} (tunnel not open?)`);
  return lines;
}

module.exports = { status };
