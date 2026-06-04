#!/usr/bin/env node
// do-gpu.js — Step 9.2 of OFFENSE-FINETUNE-DESIGN.md (dir_1780595077329)
//
// DigitalOcean GPU droplet lifecycle for the Qwen3-32B LoRA fine-tune. Self-
// contained Node CLI; reads the API token from /root/.config/digitalocean/
// access_token (chmod 600 root-only). Only Node built-ins — no npm deps.
//
// Subcommands:
//   status                    — list our running droplets + cost-per-hour
//   images                    — show GPU-ready images we can use
//   sizes                     — show GPU droplet sizes available + price
//   create [opts]             — rent a gpu-mi300x1-192gb droplet for training
//   destroy <droplet_id>      — kill a droplet (stop billing)
//
// Defaults match OFFENSE-FINETUNE-DESIGN.md §2:
//   size = gpu-mi300x1-192gb ($1.99/hr — 192 GB VRAM eliminates QLoRA pain)
//   region = nyc2 (DO's primary AI region; falls back automatically if full)
//   image = gpu-h100x1-base-2/ubuntu-22-04-x64 (DO's GPU base image; ROCm
//           installs on first boot via bootstrap.sh, not from a baked image)

"use strict";

const fs    = require("fs");
const https = require("https");
const path  = require("path");

const TOKEN_PATH = "/root/.config/digitalocean/access_token";
const DEFAULT_SIZE   = "gpu-mi300x1-192gb";
const DEFAULT_REGION = "nyc2";
const DEFAULT_IMAGE  = "gpu-h100x1-base"; // DO uses one base image for all GPU types
const NAME_PREFIX    = "ozzu-finetune";

// ─────────────────────────────── api client ───────────────────────────────

function readToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch (e) {
    console.error(`[do-gpu] FATAL: could not read ${TOKEN_PATH}: ${e.message}`);
    console.error(`[do-gpu] Place a DO API token there with chmod 600 (root). See OFFENSE-FINETUNE-DESIGN.md §2.`);
    process.exit(2);
  }
}

function doReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const token = readToken();
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: `Bearer ${token}` };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(
      `https://api.digitalocean.com/v2${urlPath}`,
      { method, headers, timeout: 30000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 204) return resolve({});  // no content (destroy)
          try {
            const j = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) return resolve(j);
            reject(new Error(`DO API ${method} ${urlPath} → HTTP ${res.statusCode}: ${data.slice(0, 240)}`));
          } catch (e) {
            reject(new Error(`DO API parse error: ${e.message} (body: ${data.slice(0, 240)})`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("DO API timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

const doGet    = (p)    => doReq("GET",    p);
const doPost   = (p, b) => doReq("POST",   p, b);
const doDelete = (p)    => doReq("DELETE", p);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────── subcommands ───────────────────────────────

async function cmdStatus() {
  const data = await doGet("/droplets?per_page=200");
  const all = data.droplets || [];
  // Filter to our prefix to avoid mixing in other workloads
  const ours = all.filter((d) => (d.name || "").startsWith(NAME_PREFIX));
  if (ours.length === 0) {
    console.log("(no ozzu-finetune droplets running)");
    console.log(`(${all.length} other droplets total)`);
    return;
  }
  console.log(`# Ozzu fine-tune droplets (${ours.length})`);
  for (const d of ours) {
    const ip = (d.networks && d.networks.v4 || []).find((n) => n.type === "public");
    const price = d.size && d.size.price_hourly ? `$${d.size.price_hourly}/hr` : "?";
    console.log(`  id=${d.id} name=${d.name} status=${d.status} size=${d.size_slug} ip=${ip ? ip.ip_address : "—"} price=${price} created=${d.created_at}`);
  }
}

async function cmdImages() {
  // GPU images live under the "applications" type; we list everything and filter.
  const data = await doGet("/images?type=distribution&per_page=200");
  const all = data.images || [];
  const gpu = all.filter((i) => /gpu|ai-ml|cuda|rocm/i.test((i.name || "") + " " + (i.description || "")));
  console.log(`# Available GPU/AI images (${gpu.length} of ${all.length} total distros)`);
  for (const i of gpu) {
    console.log(`  slug=${i.slug} id=${i.id} name=${i.name} distro=${i.distribution} min_size=${i.min_disk_size}GB`);
  }
  if (gpu.length === 0) {
    console.log("(no GPU-tagged images — DO ships GPU droplets with a base image; ROCm installs at boot via bootstrap.sh)");
    console.log(`(default DEFAULT_IMAGE='${DEFAULT_IMAGE}' will be used unless overridden)`);
  }
}

async function cmdSizes() {
  const data = await doGet("/sizes?per_page=200");
  const all = data.sizes || [];
  const gpu = all.filter((s) => /gpu/i.test(s.slug || "") || /gpu/i.test(s.description || ""));
  console.log(`# Available GPU droplet sizes (${gpu.length})`);
  for (const s of gpu) {
    const avail = (s.regions || []).join(",") || "—";
    console.log(`  slug=${s.slug} vcpus=${s.vcpus} ram=${s.memory}MB disk=${s.disk}GB price=$${s.price_hourly}/hr regions=${avail}`);
    if (s.description) console.log(`    └─ ${s.description}`);
  }
}

async function cmdCreate(opts) {
  const size       = opts.size   || DEFAULT_SIZE;
  const region     = opts.region || DEFAULT_REGION;
  const image      = opts.image  || DEFAULT_IMAGE;
  const sshKeyId   = opts.sshKeyId;
  const maxHours   = Number(opts.maxHours) > 0 ? Number(opts.maxHours) : 20;
  const name       = `${NAME_PREFIX}-${Date.now().toString(36)}`;

  if (!sshKeyId) {
    console.error("[do-gpu] FATAL: --ssh-key-id is required (DO needs a registered SSH key to authorize the droplet).");
    console.error("[do-gpu] List your keys: curl -H \"Authorization: Bearer <token>\" https://api.digitalocean.com/v2/account/keys");
    process.exit(2);
  }

  const body = {
    name,
    region,
    size,
    image,
    ssh_keys: [sshKeyId],
    backups: false,
    ipv6: false,
    monitoring: true,
    tags: ["ozzu", "finetune", `max-hours-${maxHours}`],
  };
  if (opts.dryRun) {
    console.log("=== DRY RUN — request that WOULD be sent (no DO call, no spend) ===");
    console.log(`POST https://api.digitalocean.com/v2/droplets`);
    console.log(`Authorization: Bearer dop_v1_***redacted***`);
    console.log(`Content-Type: application/json`);
    console.log(`Body:`);
    console.log(JSON.stringify(body, null, 2));
    console.log(`(SSH key id ${sshKeyId} would be referenced — verify it exists with: curl -H "Authorization: Bearer $TOK" https://api.digitalocean.com/v2/account/keys | jq '.ssh_keys[] | {id, name}')`);
    return { dryRun: true, body };
  }
  console.log(`[do-gpu] creating droplet: size=${size} region=${region} image=${image} max_hours=${maxHours}`);
  const created = await doPost("/droplets", body);
  const dropletId = created.droplet && created.droplet.id;
  if (!dropletId) throw new Error(`create returned no droplet.id: ${JSON.stringify(created).slice(0, 240)}`);
  console.log(`[do-gpu] droplet created: id=${dropletId} name=${name}`);

  // Poll until status=active (DO usually takes ~60-180s for GPU droplets)
  console.log(`[do-gpu] waiting for status=active …`);
  const deadline = Date.now() + 5 * 60 * 1000;
  let ip = null;
  while (Date.now() < deadline) {
    await sleep(5000);
    const info = await doGet(`/droplets/${dropletId}`);
    const d = info.droplet || {};
    if (d.status === "active") {
      const pub = (d.networks && d.networks.v4 || []).find((n) => n.type === "public");
      ip = pub ? pub.ip_address : null;
      console.log(`[do-gpu] active. id=${dropletId} ip=${ip || "(no public ip yet)"}`);
      console.log("");
      console.log("=== next steps ===");
      console.log(`  1. SSH:   ssh root@${ip || "<ip>"}`);
      console.log(`  2. Bootstrap (installs ROCm + PyTorch + HF stack):`);
      console.log(`             ssh root@${ip} 'bash -s' < tools/finetune/do-droplet/bootstrap.sh`);
      console.log(`  3. Push dataset:`);
      console.log(`             scp /tmp/finetune/train.jsonl root@${ip}:/root/`);
      console.log(`  4. Train:  ssh root@${ip} 'cd /root && python3 train.py --dataset train.jsonl ...'`);
      console.log(`  5. Pull adapter back when done:`);
      console.log(`             scp -r root@${ip}:/root/output ./private/finetune/`);
      console.log(`  6. DESTROY when done (stop billing):`);
      console.log(`             node tools/finetune/do-droplet/do-gpu.js destroy ${dropletId}`);
      console.log("");
      console.log(`*** Budget watch: ${maxHours} hrs × \$1.99/hr ≈ \$${(maxHours * 1.99).toFixed(2)} max. Destroy when done. ***`);
      return { id: dropletId, ip, name };
    }
    process.stdout.write(".");
  }
  throw new Error(`droplet ${dropletId} did not reach active in 5 min — check DO console`);
}

async function cmdDestroy(dropletId, opts) {
  if (!dropletId) {
    console.error("[do-gpu] FATAL: destroy requires <droplet_id> arg");
    process.exit(2);
  }
  if (opts && opts.dryRun) {
    console.log("=== DRY RUN — request that WOULD be sent (no DO call) ===");
    console.log(`DELETE https://api.digitalocean.com/v2/droplets/${dropletId}`);
    console.log(`Authorization: Bearer dop_v1_***redacted***`);
    console.log(`(No request body)`);
    return { dryRun: true, droplet_id: dropletId };
  }
  console.log(`[do-gpu] destroying droplet ${dropletId} …`);
  await doDelete(`/droplets/${dropletId}`);
  console.log(`[do-gpu] destroyed. billing stopped.`);
}

// ─────────────────────────────── arg parsing ───────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) { args[key] = true; }
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  try {
    switch (cmd) {
      case "status":  await cmdStatus(); break;
      case "images":  await cmdImages(); break;
      case "sizes":   await cmdSizes();  break;
      case "create":  await cmdCreate({
        size: args.size, region: args.region, image: args.image,
        sshKeyId: args["ssh-key-id"], maxHours: args["max-hours"],
        dryRun: !!args["dry-run"],
      }); break;
      case "destroy": await cmdDestroy(args._[0], { dryRun: !!args["dry-run"] }); break;
      default:
        console.log("Usage:");
        console.log("  do-gpu.js status                        — list our droplets");
        console.log("  do-gpu.js images                        — list GPU-tagged images");
        console.log("  do-gpu.js sizes                         — list GPU droplet sizes");
        console.log("  do-gpu.js create --ssh-key-id <id> [--size SLUG] [--region SLUG] [--max-hours N] [--dry-run]");
        console.log("  do-gpu.js destroy <droplet_id> [--dry-run]   — kill a droplet");
        console.log("");
        console.log("  --dry-run on create/destroy prints the exact API request without sending it (no spend).");
        process.exit(1);
    }
  } catch (e) {
    console.error(`[do-gpu] FAILED: ${e.message}`);
    process.exit(1);
  }
}

main();
