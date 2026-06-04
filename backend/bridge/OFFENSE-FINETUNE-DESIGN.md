# OFFENSE-FINETUNE-DESIGN.md — Qwen3-32B LoRA on DO MI300X

**Status:** Design (dir_1780594657452). Pairs with `OFFENSE-AGENT-DESIGN.md` (the harness) and `OFFENSE-MODEL-RUNBOOK.md` (per-engagement rental). Implementation lands in a future directive AFTER Step 8 (multi-agent) is validated in live runs.

**Compute lock-in (King Kazuma, 2026-06-04):** **training runs ONLY on DigitalOcean MI300X (AMD).** NOT vast.ai. The $100 DO credit at `/root/.config/digitalocean/access_token` is the sole training-spend source. Vast.ai is for *inference* per-engagement rental only (and may be retired entirely later in favor of DO inference too). Future Ciphers: do not propose vast.ai as the training infrastructure.

**Goal:** climb from base Qwen3-32B's ~52% AutoPenBench baseline to xOffense's reported 72-79% by reproducing their fine-tune recipe with our own data, using King Kazuma's $100 DigitalOcean AMD GPU credit.

**Authorship:** King Kazuma 2026-06-04 — "best shot is xOffense, do it ourself."

---

## 1. What we're reproducing

xOffense (arXiv 2509.13021) trained Qwen3-32B with **LoRA + DeepSpeed ZeRO-3 + FlashAttention v2** on:

| Source | Format | Public? |
|---|---|---|
| **WhiteRabbitNeo HF dataset** | JSONL chat (instruction/response with CoT) | ✅ on HuggingFace |
| **HackTheBox / TryHackMe / VulnHub writeups** | scraped, CoT-enriched | ✅ sources public, scraping required |

Their weights are NOT public (ngrok-tunneled private API). Recipe is reproducible from the paper.

**Our addition:** include OUR OWN agent transcripts (from `offense_telemetry` + `engagement_tasks.outcome_summary` + queue history) as a third corpus. Critical for preserving tool-use behavior — we saw earlier today that fine-tunes can break the base model's function-calling. Including real successful tool-call traces in training data inoculates against this.

---

## 2. Infrastructure plan — DigitalOcean MI300X

| Resource | Spec | Cost |
|---|---|---|
| Droplet size | `gpu-mi300x1-192gb` (AMD MI300X 1×, 192 GB VRAM, 20 vCPU, 240 GB RAM, 720 GB disk) | $1.99/hr |
| Image | Ubuntu 22.04 with ROCm pre-installed (DO offers this) | included |
| Storage | 720 GB ephemeral (datasets + checkpoints + adapter output) | included |
| Network egress | model download + push of LoRA back | included |

**Why MI300X over H100 ($3.39/hr):** 192 GB VRAM means we can run **full bf16 LoRA without quantization gymnastics**. Skip bitsandbytes (rough on ROCm), skip QLoRA. Just `bf16 + LoRA rank 32 + DeepSpeed ZeRO-3` and we're done. Costs half as much, faster training because no de-quantization overhead.

**Budget envelope:**
- Data prep (download/format): on the bridge VM, no DO spend
- Training: estimate **10-20 hours @ $1.99/hr = $20-40**
- Buffer for re-runs / hyperparameter search: another $30
- **Total expected: $50-70 of the $100 credit.**

---

## 3. Dataset composition

Three corpora merged into one JSONL training set. Target ~50-80k examples (matches xOffense's reported scale).

### 3a. WhiteRabbitNeo HF instruction dataset

**Source:** [WhiteRabbitNeo/WRN-Chapter-1](https://huggingface.co/datasets/WhiteRabbitNeo/WRN-Chapter-1) (and successive chapters). Publicly downloadable via `datasets` library.

**Format:** instruction-tuned chat — `{"messages": [{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}`.

**Volume:** ~30-40k examples across the WRN chapters.

**Use:** primary cybersec instruction signal.

### 3b. HackTheBox / TryHackMe / VulnHub writeups (scraped + CoT-enriched)

**Sources:**
- 0xdf's HTB writeups: https://0xdf.gitlab.io/ (already in the public domain, ~500 boxes)
- IppSec video transcripts: https://github.com/IppSec/parrot (open-source companion)
- TryHackMe community writeups (Medium articles, GitHub)
- VulnHub writeup archives

**Format conversion:** each writeup → multi-turn chat where the assistant solves the box step-by-step. Inject `<think>...</think>` blocks before each tool invocation (mirrors xOffense's CoT trace format).

**Volume target:** ~10-15k examples.

**Implementation:** a `tools/finetune/scrape-writeups.py` script that pulls + cleans + formats. Polite rate-limit, respect robots.txt, archive-only sources to avoid re-scraping later.

### 3c. Our own agent transcripts (tool-use preservation)

**Source:** `offense_telemetry` rows + `engagement_tasks.outcome_summary` + `soc_queue_items` outputs from real engagements we've run. Anonymize IPs/hostnames to fictitious values while preserving the SHAPE of tool calls and reasoning.

**Format:** chat history with real tool_calls + tool_results — the same format Ollama function-calling produces during a real run.

**Volume target:** ~2-5k examples to start (grows naturally over time as more engagements run).

**Critical:** this is the dataset that preserves tool-use ability after fine-tuning. Without it, the fine-tune optimizes for cybersec text generation and likely degrades the model's ability to emit structured tool_calls — exactly the failure mode that disqualifies most existing public fine-tunes.

---

## 4. Training recipe

Match xOffense's disclosed setup, adapt to our infra:

```yaml
base_model: Qwen/Qwen3-32B
precision: bf16

lora:
  r: 32              # higher than xOffense's likely rank — we have VRAM
  alpha: 64
  dropout: 0.05
  target_modules:
    - q_proj
    - k_proj
    - v_proj
    - o_proj
    - gate_proj
    - up_proj
    - down_proj

training:
  framework: huggingface transformers + PEFT + accelerate
  optimizer: AdamW (8bit NOT needed — MI300X has VRAM)
  lr: 2e-4
  lr_scheduler: cosine
  warmup_ratio: 0.03
  num_epochs: 3
  per_device_batch_size: 1
  gradient_accumulation_steps: 16
  max_seq_length: 4096       # matches xOffense's 16K-ctx ÷ 4 for memory

infra:
  deepspeed: zero-3 (offload params to CPU if needed; 240GB system RAM helps)
  flash_attention: v2 with CK backend (AMD ROCm port)

output:
  adapter_only: true           # ~600MB LoRA adapter — not full 65GB model
  push_to_hub: false           # private; lives on bridge filesystem
  artifact_location: /home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/
```

**Why bf16 LoRA on MI300X is genuinely simpler than the usual A100/H100 path:**
- 192 GB VRAM > model (65 GB bf16) + activations + optimizer state + gradient accumulation room
- No bitsandbytes / 4-bit / nf4 / qlora needed — those are AMD's roughest libraries
- Standard HF Trainer with `bf16=True, peft_config=LoRA(...)` just works on ROCm

---

## 5. Pipeline shape (code lands in a future directive)

```
/home/gcp/ozzu/tools/finetune/
├── README.md                      — operator instructions
├── dataset/
│   ├── build-wrn.py               — download + format WhiteRabbitNeo from HF
│   ├── scrape-writeups.py         — HTB/THM/VulnHub scraper
│   ├── export-our-transcripts.py  — pull telemetry + queue_items → chat JSONL
│   └── merge.py                   — combine + shuffle + train/eval split
├── do-droplet/
│   ├── provision.js               — DO API: create MI300X droplet, return SSH info
│   ├── bootstrap.sh               — ROCm/PyTorch/HF/PEFT/DeepSpeed install
│   ├── train.py                   — the HF Trainer loop
│   ├── pull-adapter.sh            — scp LoRA back to bridge after training
│   └── destroy.js                 — kill droplet (stop billing)
├── deploy/
│   ├── Modelfile                  — Ollama Modelfile wrapping base + LoRA
│   └── load.sh                    — `ollama create ozzu-soc-v1 -f Modelfile`
└── eval/
    ├── run-autopenbench.sh        — run AutoPenBench against our model in our harness
    └── compare.py                 — score vs base Qwen3-32B baseline
```

**Operator UX:** a single MCP tool `start_finetune({source_data_paths, dataset_version})` that orchestrates the whole pipeline: builds the dataset, provisions the droplet, kicks off training (background), polls for completion, pulls the adapter back, registers in Ollama, runs the eval. Returns when done with a benchmark comparison.

---

## 6. Eval — how we measure success

After training, the deliverable is a numeric comparison:

| Configuration | Expected | Source |
|---|---|---|
| base Qwen3-32B in our single-loop (Step 5) | ~50% | tested empirically tonight |
| base Qwen3-32B in our multi-agent (Step 8) | ~55-65% | new ceiling once Step 8 validated |
| **ozzu-soc-v1 (this fine-tune) in our multi-agent** | **target 65-78%** | per xOffense's gain |
| xOffense (reference) | 72.72% | their paper |

**Eval procedure:**
1. AutoPenBench's task set (33 tasks, public)
2. Run each task in our SOC harness using the multi-agent pipeline
3. Score sub-task completion + full-task completion
4. Compare ozzu-soc-v1 vs base Qwen3-32B side-by-side

If ozzu-soc-v1 doesn't beat base Qwen3-32B by ≥10 points on full tasks, the fine-tune is wasted spend and we revert to base + harness improvements.

---

## 7. Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Fine-tune breaks tool-use** (the same failure mode that disqualified Trendyol/BaronLLM) | Include our agent transcripts (corpus 3c) with real tool_calls in training data |
| **Dataset quality drift** — scraped writeups may have inconsistent format | Strict format validator in `merge.py`; reject malformed examples; manual review of 100-example sample |
| **ROCm-specific bugs** — FlashAttention CK backend has had compat issues with newer transformers | Pin versions in `bootstrap.sh`; have a CUDA-fallback `provision.js` flag that switches to H100 droplet if MI300X path fails |
| **Training divergence** — LoRA on a thinking model can destabilize CoT | Save checkpoints every 500 steps; eval at each; revert if eval regresses 2 consecutive checkpoints |
| **Spend overrun** — $100 isn't infinite | `provision.js` includes a max-hours budget arg; auto-destroy when hit |

---

## 8. Sequencing (when this lands)

1. **PREREQUISITE:** Step 8 validated in a live engagement (see OFFENSE-AGENT-DESIGN.md). We need a working multi-agent harness to measure the fine-tune's gain against.
2. **THEN** write the code in `/home/gcp/ozzu/tools/finetune/` per the file tree above. ~1500 lines across data prep + droplet ops + training + eval.
3. **THEN** the actual training run — burns ~$30-40 of King Kazuma's DO credit.
4. **THEN** eval + comparison report.
5. **IF** the fine-tune wins: register `ozzu-soc-v1` in Ollama, swap `OFFENSE_MODEL_NAME` to it, retire base Qwen3-32B as default.

**Not a rush.** Step 8 needs at least one real engagement to mature before we invest in fine-tuning. The harness gain from Step 8 alone may be enough for many engagements; fine-tune is the marginal improvement on top.

---

## 9. References

- xOffense paper: arXiv:2509.13021 (Qwen3-32B fine-tune recipe)
- WhiteRabbitNeo HF dataset: huggingface.co/datasets/WhiteRabbitNeo
- 0xdf HTB writeups: 0xdf.gitlab.io
- IppSec parrot corpus: github.com/IppSec/parrot
- HF PEFT LoRA docs: huggingface.co/docs/peft
- DeepSpeed ZeRO-3: github.com/deepspeedai/DeepSpeed
- DO MI300X GPU droplets: docs.digitalocean.com/products/droplets/gpu
- ROCm PyTorch: pytorch.org (rocm channel)
