# tools/finetune — Qwen3-32B LoRA fine-tune pipeline

Reproduces the xOffense fine-tune recipe on King Kazuma's $100 DigitalOcean MI300X credit. Output: a LoRA adapter we register in Ollama as `ozzu-soc-v1` alongside the base Qwen3-32B.

**Read first:**
- `backend/bridge/OFFENSE-AGENT-DESIGN.md` — the multi-agent harness this fine-tune feeds.
- `backend/bridge/OFFENSE-FINETUNE-DESIGN.md` — the design / recipe / budget for this pipeline. **Includes the AMD/DO compute lock-in note** — training never runs on vast.ai.

## Tree

```
tools/finetune/
├── README.md                          — this file
├── dataset/
│   ├── build-wrn.py                   ✅ WhiteRabbitNeo HF → chat JSONL
│   ├── scrape-writeups.py             ✅ 0xdf HTB writeups (markdown) → chat JSONL
│   ├── export-our-transcripts.py      ✅ our telemetry → chat JSONL (anonymized)
│   └── merge.py                       ✅ combine/shuffle/split corpora → train + eval
├── do-droplet/
│   ├── do-gpu.js                      ✅ DO MI300X lifecycle (create/destroy/status)
│   ├── bootstrap.sh                   ✅ ROCm + PyTorch + HF stack installer
│   └── train.py                       ✅ HF Trainer + PEFT LoRA bf16
├── deploy/
│   ├── Modelfile.template             ✅ Ollama Modelfile (base + adapter)
│   └── load.sh                        ✅ materializes + `ollama create`
└── eval/
    └── run-autopenbench.sh            🚧 stub — implement after first trained adapter
```

## TL;DR — the two-command training flow

After one-time prerequisites (below), the entire training cycle is:

```bash
# 1. Kick off everything — dataset prep + provision + bootstrap + start training
bash /home/gcp/ozzu/tools/finetune/run-finetune.sh --ssh-key-id <YOUR_DO_KEY_ID>

# 2. (Watch progress in another shell)
ssh root@<droplet-ip-from-step-1> 'tail -f /root/train.log'

# 3. When training log shows "DONE — adapter at...", close the loop
bash /home/gcp/ozzu/tools/finetune/pull-adapter.sh
# scp's adapter back, registers in Ollama, prompts before destroy
```

That's it. Two commands + a wait. Cost: ~$30-40 of the DO MI300X credit per full training run.

Optional flags to `run-finetune.sh`:
- `--writeups-repo /path/to/0xdf` — include 0xdf HTB writeups in the dataset (otherwise skipped)
- `--skip-transcripts` — skip our agent transcripts (use on first run before any engagement data exists)
- `--max-hours N` — budget annotation (default 20 → ~$40)

Run `bash run-finetune.sh --help` for the full arg list.

### Resuming a crashed training run

train.py checkpoints to `/root/output/ozzu-soc-v1/checkpoint-N/` every `--save-steps` (default 500). If a training run crashes at hour 8 of 12 (network blip, OOM, droplet glitch), don't lose the progress — resume:

```bash
# Find the droplet id (still alive — DO NOT destroy if you want to resume)
sudo node tools/finetune/do-droplet/do-gpu.js status

# Kick off resume — auto-discovers the latest checkpoint-N dir on the droplet
bash /home/gcp/ozzu/tools/finetune/run-finetune.sh --resume <droplet-id> --ssh-key-id <id>

# Watch
ssh root@<droplet-ip> 'tail -f /root/train.log'
```

If you destroyed the droplet, checkpoints are gone — start fresh.

---

## Manual flow (advanced / debugging)

This is the concrete flow if you want to run each script yourself (useful for debugging or partial reruns). Each command is copy-pasteable.

### 0. Prerequisites (one-time setup)

```bash
# DO token already lives at /root/.config/digitalocean/access_token (chmod 600 root-only).
# Confirm it works:
sudo node /home/gcp/ozzu/tools/finetune/do-droplet/do-gpu.js status      # should say "no droplets running"
sudo node /home/gcp/ozzu/tools/finetune/do-droplet/do-gpu.js sizes       # confirms gpu-mi300x1-192gb available

# Find your DO SSH key id (you'll pass it to create later):
TOK=$(sudo cat /root/.config/digitalocean/access_token)
curl -s -H "Authorization: Bearer $TOK" "https://api.digitalocean.com/v2/account/keys" | python3 -c "
import json, sys
for k in json.load(sys.stdin).get('ssh_keys', []):
    print('id=' + str(k['id']), 'name=' + k['name'], 'fp=' + k['fingerprint'])
"
# Note one of the ids — you'll pass it as --ssh-key-id to do-gpu.js create.
```

### 1. Build dataset (on the bridge — no GPU needed, free)

```bash
mkdir -p /tmp/finetune

# Corpus A: WhiteRabbitNeo HF instruction set
pip install --user datasets  # one-time
python3 /home/gcp/ozzu/tools/finetune/dataset/build-wrn.py \
  --out /tmp/finetune/wrn.jsonl

# Corpus B: 0xdf HTB writeups (clone first, then convert)
git clone https://gitlab.com/0xdf/ctfwriteups.git /tmp/0xdf-writeups
python3 /home/gcp/ozzu/tools/finetune/dataset/scrape-writeups.py \
  --repo /tmp/0xdf-writeups \
  --out /tmp/finetune/writeups.jsonl

# Corpus C: our own agent transcripts (preserves tool-use)
# Requires real engagement runs to exist; safe to skip on first training run.
PGHOST=postgres PGUSER=ozzu PGPASSWORD="$(grep ^POSTGRES_PASSWORD /home/gcp/ozzu/backend/.env | cut -d= -f2-)" \
  python3 /home/gcp/ozzu/tools/finetune/dataset/export-our-transcripts.py \
    --out /tmp/finetune/agent.jsonl \
    --statuses completed,idle --min-iter 3

# Merge all corpora into one shuffled training set + eval split
python3 /home/gcp/ozzu/tools/finetune/dataset/merge.py \
  --inputs /tmp/finetune/wrn.jsonl /tmp/finetune/writeups.jsonl /tmp/finetune/agent.jsonl \
  --out /tmp/finetune/train.jsonl \
  --eval-out /tmp/finetune/eval.jsonl \
  --eval-frac 0.05 --seed 42

# Sanity check
wc -l /tmp/finetune/*.jsonl
head -1 /tmp/finetune/train.jsonl | python3 -c "import json, sys; print(json.dumps(json.loads(sys.stdin.read()), indent=2)[:600])"
```

### 2. Provision MI300X (real spend starts here)

```bash
# This rents a droplet. After this point, $1.99/hr is burning until destroy.
sudo node /home/gcp/ozzu/tools/finetune/do-droplet/do-gpu.js create \
  --ssh-key-id <YOUR_KEY_ID> \
  --max-hours 20

# Note the droplet id + ip printed at the end. Export them:
DROPLET_ID=<id-from-output>
DROPLET_IP=<ip-from-output>
```

### 3. Bootstrap + push data + train

```bash
# Install ROCm/PyTorch/HF stack on the droplet (~10-15 min on first run)
ssh root@$DROPLET_IP 'bash -s' < /home/gcp/ozzu/tools/finetune/do-droplet/bootstrap.sh

# Push dataset + training script to the droplet
scp /tmp/finetune/train.jsonl /tmp/finetune/eval.jsonl \
    root@$DROPLET_IP:/root/dataset/
scp /home/gcp/ozzu/tools/finetune/do-droplet/train.py root@$DROPLET_IP:/root/

# Kick off training (runs ~10-20 hours; use tmux on the droplet so the
# SSH disconnect doesn't kill it)
ssh root@$DROPLET_IP 'tmux new-session -d -s train "source /opt/ozzu-train/venv/bin/activate && \
  python3 /root/train.py \
    --base-model Qwen/Qwen3-32B \
    --dataset /root/dataset/train.jsonl \
    --eval-dataset /root/dataset/eval.jsonl \
    --output-dir /root/output/ozzu-soc-v1 \
    --epochs 3 \
    2>&1 | tee /root/train.log"'

# Tail the log to watch progress
ssh root@$DROPLET_IP 'tail -f /root/train.log'
# Ctrl-C exits the tail; training continues on the droplet under tmux.
```

### 4. Pull adapter back + register with Ollama

```bash
# When training finishes (log shows "DONE — adapter at /root/output/.../final-adapter"):
mkdir -p /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1
scp -r root@$DROPLET_IP:/root/output/ozzu-soc-v1/. \
       /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/

# Register with Ollama (assumes Ollama is running on this host or OLLAMA_HOST set)
/home/gcp/ozzu/tools/finetune/deploy/load.sh \
  --manifest /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/manifest.json \
  --tag ozzu-soc-v1

# Verify
ollama list | grep ozzu-soc-v1
ollama run ozzu-soc-v1 "Reply with the single word READY."
```

### 5. DESTROY droplet (CRITICAL — stop billing)

```bash
sudo node /home/gcp/ozzu/tools/finetune/do-droplet/do-gpu.js destroy $DROPLET_ID
sudo node /home/gcp/ozzu/tools/finetune/do-droplet/do-gpu.js status   # confirm 0 droplets
```

### 6. Wire the bridge to the new model

Only do this after confirming the adapter behaves correctly:

```bash
sudo sed -i 's/^OFFENSE_MODEL_NAME=.*/OFFENSE_MODEL_NAME=ozzu-soc-v1/' /home/gcp/ozzu/backend/.env
cd /home/gcp/ozzu/backend && docker compose up -d bridge   # recreate, picks up new env

# Verify
docker exec bridge env | grep OFFENSE_MODEL_NAME
```

## Constraints + safety

- **No tool-use loss.** Always include `agent.jsonl` (our anonymized transcripts) in the dataset — that's how the fine-tune keeps function-calling intact. Skip on FIRST run if no engagement data exists yet, but include from run #2 onward.
- **License hygiene.** WhiteRabbitNeo (Apache-2.0), 0xdf (CC-BY-SA-4.0), our transcripts (private). The merge.py output carries source tags per row so we can drop a corpus later if needed.
- **Budget cap.** `do-gpu.js create --max-hours N` is operator-side annotation (not auto-enforced); always pair `create` with a calendar reminder to `destroy`.
- **Anonymization.** export-our-transcripts.py replaces private IPs → 10.99.x.x deterministic per engagement, public IPs → REDACTED, MACs → AA:BB:..., engagement IDs → SHA256[:12].

## Per-piece status

| Piece | State | Directive |
|---|---|---|
| README.md | ✅ this revision | dir_1780596162609 |
| `dataset/build-wrn.py` | ✅ | dir_1780594820417 |
| `dataset/merge.py` | ✅ smoke-tested | dir_1780594820417 |
| `dataset/scrape-writeups.py` | ✅ smoke-tested (0xdf path) | dir_1780595993200 |
| `dataset/export-our-transcripts.py` | ✅ anonymizer smoke-tested | dir_1780595557351 |
| `do-droplet/do-gpu.js` | ✅ smoke-tested (read-only paths) | dir_1780595077329 |
| `do-droplet/bootstrap.sh` | ✅ | dir_1780595203692 |
| `do-droplet/train.py` | ✅ | dir_1780595306981 |
| `deploy/Modelfile.template` | ✅ | dir_1780595412819 |
| `deploy/load.sh` | ✅ | dir_1780595412819 |
| `eval/run-autopenbench.sh` | 🚧 STUB — needs trained adapter to be useful | — |

## Why no GPU for dataset prep

The dataset scripts run on the bridge VM in seconds-to-minutes. Only `train.py` needs a GPU (real spend at ~$1.99/hr on MI300X). Everything in `dataset/` is free and reproducible.
