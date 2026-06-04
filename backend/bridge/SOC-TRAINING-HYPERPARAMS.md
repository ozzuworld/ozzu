# Training hyperparameters + first-30-min watch checklist (2026-06-04)

For the upcoming first real training run on `dataset-v1.1` against Qwen3-32B on DigitalOcean MI300X.

## Hyperparameters (train.py defaults)

| Param | Default | Why this value |
|---|---|---|
| `--base-model` | `Qwen/Qwen3-32B` | Validated by xOffense (72.72% AutoPenBench). Open-weight, ~65 GB bf16, fits MI300X's 192 GB VRAM with headroom for activations + LoRA + grad-accum. |
| `--epochs` | 3 | Standard LoRA SFT range. Below this, model doesn't converge on domain. Above this, overfitting on 19k examples becomes likely. xOffense paper likely used similar. |
| `--lr` | 2e-4 | Standard LoRA learning rate. Higher than full-FT LRs (typically 1e-5) because only adapters update — they need bigger steps. Below this, training barely moves; above, instability. |
| `--rank` | 32 | LoRA rank (matrix decomposition dimension). xOffense likely used ~16. We have 192 GB VRAM, can afford 32 — gives more capacity for the cybersec + tool-use task mix. ~262k trainable params per attention layer. |
| `--alpha` | 64 | LoRA alpha = 2× rank. Standard scaling. Effective LR multiplier inside LoRA is alpha/rank = 2. |
| `--lora-dropout` | 0.05 | Tiny dropout on adapter weights. Prevents adapter from memorizing rare patterns. Standard SFT value. |
| `--max-seq-length` | 4096 | Trade-off between throughput and example coverage. Long Glaive function-call examples + multi-turn writeups need ~4k context. Beyond 4k → ~quadratic memory/time cost. |
| `--per-device-batch-size` | 1 | Each forward pass processes 1 example at a time. Required for 32B model on a single 192 GB GPU at 4096 ctx (~80 GB activations per example). |
| `--gradient-accumulation-steps` | 16 | Accumulate grads over 16 micro-batches before update. **Effective batch = 1 × 16 = 16.** Standard for big-model LoRA. Smaller eff batch → noisy gradients, slower convergence. |
| `--warmup-ratio` | 0.03 | LR warms up over first 3% of training (~520 steps for 19k×3epochs). Stabilizes early training. |
| `--logging-steps` | 10 | Log loss every 10 update-steps (i.e. every 160 examples). ~1100 log entries over the run. Tail-able. |
| `--save-steps` | 500 | Checkpoint every 500 update-steps (~every 12 min of training). Resume-friendly. |
| `--eval-steps` | 500 | Run eval on holdout every 500 steps. Detects overfit. |
| `--seed` | 42 | Deterministic shuffle. Same seed → same training order → identical artifacts. |

## Measured token-length distribution (dataset-v1.3, Qwen3-32B tokenizer)

Measured 2026-06-04 by tokenizing every row in `train.jsonl` (18,424 rows) through Qwen3's actual chat template.

| Corpus | Count | Median | p90 | Max |
|---|---|---|---|---|
| PJMixers/WhiteRabbitNeo | 13,295 | 1,292 | 1,703 | 3,169 |
| Glaive function-calling | 2,209 | 351 | 526 | 1,516 |
| Fenrir-v2.1 | 1,879 | 690 | 1,244 | 2,471 |
| Dolly-15k | 948 | 120 | 378 | 3,994 |
| ozzu-soc-synthetic | 93 | 243 | 264 | 268 |

**Zero rows exceed `max_seq_length=4096`.** All examples fit fully — no mid-sequence truncation, no lost tool_call tokens.

Implication: could lower `--max-seq-length` to 2048 for ~50% activation-memory savings + faster steps (cuts ~10-15% of WRN p90 rows at 2048, but those tail rows could be filtered). For v1.3 we keep 4096 because:
- MI300X 192 GB has ample memory headroom
- Safety margin against edge-case multi-turn rows
- Dolly's max=3994 is uncomfortably close to a hypothetical 2048; some examples would lose their last assistant turn



- **Total examples per epoch:** 18,471 (dataset-v1.1 train)
- **Total update-steps per epoch:** 18,471 / 16 = 1,154 update-steps
- **Total update-steps for 3 epochs:** 3,462
- **Checkpoints saved:** 3,462 / 500 = ~7 checkpoints
- **Estimated wall-clock:** ~10-20 hours on MI300X (192 GB, ~6 TB/s memory bandwidth)
- **Cost at $1.99/hr:** $20-40 for the full run

## First 30 minutes — watch checklist

After kicking off training (`bash run-finetune.sh ...` or via the resume path), `ssh root@<droplet-ip> 'tail -f /root/train.log'` and watch for these signals:

### ✓ Healthy training (do nothing, let it run)

- **Initial loss:** typically 2.0–4.0 on first log line. Below 1.0 on iter 0 → suspicious (model already knew the data; check for contamination). Above 6.0 → bad data quality, kill.
- **Loss curve:** decreasing roughly linearly for the first ~200 steps, then slowing. **Should drop ~30-50% in first 200 steps.** That's the model adapting to the format.
- **GPU utilization:** `nvidia-smi` (or `rocm-smi` on AMD) should show 90%+ GPU usage with VRAM ~150-180 GB.
- **No NaN/Inf:** loss values are real numbers, not `nan` or `inf`.

### ✗ Kill the droplet immediately (save $30+)

If ANY of these in the first 30 min:

1. **Loss explodes** — single-step jump >10x, or loss > 100. Numerical instability; likely a bad data row or LR too high.
2. **NaN/Inf appearing** — anywhere in train_loss or eval_loss. Training is dead, won't recover. `tmux kill-session -t train && sudo node tools/finetune/do-droplet/do-gpu.js destroy <id>`.
3. **Loss flat at very low value** (e.g., 0.05) from iter 0 — data leakage or the model memorized somehow. Won't generalize.
4. **OOM in log** — `CUDA out of memory` (or ROCm equivalent). Reduce max_seq_length or per_device_batch_size, re-launch.
5. **`<|endoftext|>` token bleeding into normal text** — sign that tokenization is broken. Stop, debug the tokenizer setup.

### ~ Watch but don't kill yet

- **Loss plateau** in first 100 steps (no decrease) — could be warmup. Wait for warmup-ratio × total = 3% × 3462 = 104 steps, THEN should decrease.
- **Eval loss substantially higher than train loss** in first eval (at step 500) — early overfit warning. Watch the next eval; if gap widens at step 1000, kill.
- **Per-step time > 30 seconds** — slower than expected. Check GPU utilization; could be a network bottleneck if dataset is on slow disk.

## When training completes successfully

The log shows `[train] DONE — adapter at /root/output/ozzu-soc-v1/final-adapter` with a manifest.json. Run:

```bash
bash /home/gcp/ozzu/tools/finetune/pull-adapter.sh
```

This:
1. Verifies the adapter files on the droplet
2. SCPs them to `/home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/`
3. Registers in Ollama as `ozzu-soc-v1`
4. Prompts before destroying the droplet (CRITICAL — stops billing)
5. Prints the bridge env-var swap command

## Post-train sanity tests (before swapping bridge default)

In order:

1. **Step 8 multi-agent smoke test** with the new model:
   ```bash
   OFFENSE_MODEL_NAME=ozzu-soc-v1 docker exec bridge node /app/agent-smoke.js
   ```
   PASS = model still emits structured JSON for orchestrator/synthesizer/aggregator roles. FAIL = tool-use degraded — DO NOT swap.

2. **AutoPenBench eval** with both base + fine-tune:
   ```bash
   bash tools/finetune/eval/run-autopenbench.sh --model qwen3:32b  # baseline
   bash tools/finetune/eval/run-autopenbench.sh --model ozzu-soc-v1  # fine-tune
   python3 tools/finetune/eval/compare.py --base <base>.json --ft <ft>.json
   ```
   The compare.py output prints a verdict: if Δ ≥ 10pp → recommends swap, else → suggests another training run.

3. **Real engagement smoke** — `start_engagement_run` on a test engagement, watch `analyze_engagement_telemetry` for healthy patterns (step_queued rate > 50%, no loops, no membrane breaches).

Only after all 3 pass: swap `OFFENSE_MODEL_NAME=ozzu-soc-v1` in `backend/.env` and recreate the bridge.

## If the fine-tune fails (any of the 3 tests fails)

- **Step 8 smoke fails** → tool-use degradation. Cause: not enough Glaive in mix, or Glaive parser still bugged. Re-check dataset-v1.1's tool_call ratio (must be ≥10%), rebuild if needed, re-train.
- **AutoPenBench Δ < 0** → fine-tune made model worse. Causes: bad LR, too many epochs (overfit), data quality. Inspect train/eval loss curves saved at `/home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/`. Consider lower LR (1e-4) or fewer epochs (2).
- **Real engagement smoke surfaces issues** → debug-specific. Use `analyze_engagement_telemetry` to identify which detector fires.

The base Qwen3-32B remains usable in all failure cases — fall back via `OFFENSE_MODEL_NAME=qwen3:32b`.
