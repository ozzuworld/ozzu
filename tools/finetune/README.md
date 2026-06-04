# tools/finetune — Qwen3-32B LoRA fine-tune pipeline

This directory is the build for Step 9 of `backend/bridge/OFFENSE-AGENT-DESIGN.md` and follows the full plan in `backend/bridge/OFFENSE-FINETUNE-DESIGN.md`. **Read both docs before running anything here.**

## Purpose

Reproduce xOffense's reported fine-tune of Qwen3-32B on offensive-security data, using King Kazuma's DigitalOcean MI300X credit. Output: a LoRA adapter we register in Ollama alongside the base model.

## Tree

```
tools/finetune/
├── README.md                     — this file
├── dataset/
│   ├── build-wrn.py              — download + format WhiteRabbitNeo from HF
│   ├── scrape-writeups.py        — HTB/THM/VulnHub scraper          (stub)
│   ├── export-our-transcripts.py — pull our telemetry → chat JSONL   (stub)
│   └── merge.py                  — combine + shuffle + train/eval split
├── do-droplet/                   — DigitalOcean MI300X provisioning   (TBD)
├── deploy/                       — Ollama Modelfile + adapter load    (TBD)
└── eval/                         — AutoPenBench eval comparison       (TBD)
```

## Per-piece status

| Piece | State | Directive |
|---|---|---|
| Directory tree | ✅ this directive | dir_1780594820417 |
| `dataset/build-wrn.py` | ✅ this directive | dir_1780594820417 |
| `dataset/merge.py` | ✅ this directive (shell — train/eval split, dedup) | dir_1780594820417 |
| `dataset/scrape-writeups.py` | 🚧 stub — implement in future directive | — |
| `dataset/export-our-transcripts.py` | 🚧 stub — implement when we have engagement data | — |
| `do-droplet/provision.js` | 🚧 to write | — |
| `do-droplet/bootstrap.sh` | 🚧 to write | — |
| `do-droplet/train.py` | 🚧 to write | — |
| `deploy/Modelfile` | 🚧 to write | — |
| `eval/run-autopenbench.sh` | 🚧 to write | — |

## Quick start (when ready to train)

```bash
# 1. Build dataset corpora (runs on bridge — no GPU needed)
python3 tools/finetune/dataset/build-wrn.py --out /tmp/finetune/wrn.jsonl
python3 tools/finetune/dataset/scrape-writeups.py --out /tmp/finetune/writeups.jsonl   # TBD
python3 tools/finetune/dataset/export-our-transcripts.py --out /tmp/finetune/agent.jsonl # TBD
python3 tools/finetune/dataset/merge.py \
  --inputs /tmp/finetune/wrn.jsonl /tmp/finetune/writeups.jsonl /tmp/finetune/agent.jsonl \
  --out    /tmp/finetune/train.jsonl --eval-out /tmp/finetune/eval.jsonl --eval-frac 0.05

# 2. Provision DO MI300X + push dataset + run training (TBD)
node tools/finetune/do-droplet/provision.js --max-hours 20 --dataset /tmp/finetune/train.jsonl

# 3. After training: pull adapter back + register with Ollama (TBD)
./tools/finetune/deploy/load.sh
```

## Constraints

- **No tool-use loss.** Including our own agent transcripts (`dataset/export-our-transcripts.py`) is non-negotiable — it's how we keep the fine-tune from breaking function-calling.
- **Apache-2.0/MIT data only.** WhiteRabbitNeo is Apache 2.0; 0xdf writeups are unlicensed (case-by-case OK for personal training); IppSec is GitHub public domain. Document each corpus's source + license in the JSONL header line.
- **Budget cap.** `do-droplet/provision.js` will require `--max-hours` arg; auto-destroys droplet when hit.

## Why no GPU is needed for this directive

This phase is data engineering only — downloading from HF, shaping JSONL. Runs in seconds-to-minutes on the bridge VM. The actual training (GPU-heavy) is `do-droplet/train.py` which is a future directive.
