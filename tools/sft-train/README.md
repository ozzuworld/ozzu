# sft-train — Sprint 3 SFT pipeline for Qwen3-Coder-30B

> ⚠️ **SUPERSEDED (2026-06-22) — SFT is ABANDONED.** Offense model is now **DeepSeek V4 via OpenRouter + the harness** (no training). Research artifact only. Current path: `private/distillation/PROJECT-DOCUMENTATION.md`.

## 1. What it is + use case

Fine-tunes Qwen3-Coder-30B-A3B-Instruct-FP8 (base) on the curated Opus trajectories
produced by `tools/oracle/generate-trajectories-v2.js` + `tools/oracle/format-sft.js`.
Output: a LoRA adapter (~200MB) that can be merged back into the base model + redeployed
on vLLM, OR served live by vLLM with `--enable-lora` for instant swap.

Uses **LLaMA-Factory** (proven ROCm support for MI300X, simpler config than axolotl).

## 2. Architecture

```
sft-train.jsonl (ChatML pairs)        ─── input
  │
  ▼
LLaMA-Factory train_qlora             ─── runs ON the MI300X droplet
  - 4-bit base via bitsandbytes-rocm    after we re-provision it
  - LoRA rank 32, alpha 64
  - chat template: qwen3
  - 3 epochs, lr 2e-5, bs 4
  │
  ▼
sft-out/adapter_*.safetensors          ─── ~200MB LoRA
  │
  ▼
merge + requantize to FP8 (optional)   ─── or keep as LoRA
  │
  ▼
deploy:
  Option A: merge → push to vLLM as base model swap
  Option B: vLLM --enable-lora + serve adapter with named ID
```

## 3. Build

Re-provision MI300X droplet first (see `tools/llama-cpp-rocm-droplet/setup.sh`).
Then inside the droplet:

```bash
# In rocm/vllm container (already has bitsandbytes + transformers)
docker run -it --rm --device /dev/kfd --device /dev/dri --group-add video \
  --ipc=host --shm-size 16G -v /root/qwen3-coder-30b:/model \
  -v /root/sft-out:/sft-out -v /root/sft-data:/data \
  rocm/vllm:latest bash

# Inside container
pip install -U llamafactory[torch,bitsandbytes] datasets
```

## 4. Configuration

`sft-config.yaml` (in this dir) is the LLaMA-Factory training config.
Key knobs:

| Knob | Default | What it does |
|---|---|---|
| `model_name_or_path` | /model (mount Qwen3-Coder-30B-FP8) | Base model |
| `dataset` | sft-train.jsonl | Curated Opus trajectories |
| `template` | qwen | Chat template matching Qwen3 |
| `lora_rank` | 32 | LoRA capacity (32 = ~200MB adapter) |
| `lora_alpha` | 64 | LoRA scale factor |
| `learning_rate` | 2e-5 | Conservative for instruction-tuned base |
| `num_train_epochs` | 3 | Standard for small dataset (~500-1000) |
| `per_device_train_batch_size` | 4 | Fits comfortably in 192GB VRAM |
| `gradient_accumulation_steps` | 4 | Effective batch 16 |
| `quantization_bit` | 4 | QLoRA — base in 4-bit, LoRA in fp16 |

## 5. Deployment

Run the training inside the droplet container:

```bash
llamafactory-cli train /sft-out/sft-config.yaml
```

Wait ~1-2 hrs for 3 epochs on ~500 samples.
Output goes to `/sft-out/adapter_*.safetensors`.

To deploy on vLLM:

```bash
# Option A: merge LoRA into base (clean swap)
llamafactory-cli merge /sft-out/merge-config.yaml
docker stop vllm
docker run -d --name vllm ... -v /root/sft-out/merged:/model rocm/vllm:latest \
  vllm serve /model --served-model-name qwen3-coder-30b-sft ...

# Option B: serve LoRA adapter live (faster, no merge)
docker run -d --name vllm ... rocm/vllm:latest \
  vllm serve /model --enable-lora --lora-modules \
    sprint3=/sft-out/adapter --max-loras 4 ...
```

## 6. Budget

Compute: $0 (MI300X droplet on free credits).
Training time: ~1-2 hrs.
Total Sprint 3 wall clock from "have curated dataset" to "Run #14 ready": ~2-3 hrs.

## 7. Operation

```bash
# Format curated trajectories → SFT-ready
node tools/oracle/format-sft.js \
  private/oracle-trajectories/curated-all.jsonl \
  --out-train sft-train.jsonl \
  --out-eval sft-eval.jsonl \
  --eval-frac 0.1

# Push to droplet (after re-provisioning)
rsync -avh sft-train.jsonl sft-eval.jsonl sft-config.yaml \
  root@DROPLET_IP:/root/sft-data/

# Kick training
ssh root@DROPLET_IP "docker run -d --name sft-train ... llamafactory-cli train /sft-config.yaml"

# Watch
ssh root@DROPLET_IP "docker logs -f sft-train"

# Eval after training (loss + held-out eval set)
ssh root@DROPLET_IP "docker exec sft-train llamafactory-cli eval /sft-config.yaml"
```

## 8. Troubleshooting

- **OOM on MI300X** — drop `per_device_train_batch_size` to 2 or 1, bump `gradient_accumulation_steps` to keep effective batch 16.
- **Loss plateaus immediately** — base might already know this. Try lower LR (1e-5) or look at eval qualitatively.
- **Loss explodes** — LR too high. Drop to 1e-5 or 5e-6.
- **NaN gradients** — known issue with bitsandbytes-rocm on certain shapes. Switch to gptq quantization or full-precision LoRA (skip 4-bit base).
- **bitsandbytes-rocm import error** — `pip install bitsandbytes-rocm` (not regular bitsandbytes).

## 9. Limits

- **No multi-GPU** — single MI300X. Larger datasets would benefit from tensor parallel, not built into LLaMA-Factory yet for ROCm.
- **No flash-attention-3** — Triton FA on ROCm is slower than CUDA's FA-3. Training is ~2× slower than equivalent H200.
- **Eval set is held-out from same lab variants** — doesn't measure generalization to NEW vuln classes. Only measures "does the model match Opus on the kind of scenarios it was trained on." Real generalization requires testing on Run #14 against the lab.
- **LoRA only** — full fine-tune would require ~600GB VRAM peak. LoRA fits because frozen base.
- **No DPO/RL in this sprint** — pure SFT. Sprint 4 adds RL.
