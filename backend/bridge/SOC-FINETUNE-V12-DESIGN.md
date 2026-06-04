# Fine-tune v1.2+ design — what comes after v1.1

**Status:** speculative, written 2026-06-04 before v1.1 has trained. Will become more concrete once v1.1 runs and we see actual eval numbers.

This memo exists so future Cipher sessions can iterate the fine-tune without re-deriving from `SOC-FIELD-SURVEY-2026-06-04.md` + scratch.

## Where v1.1 leaves us

After the first DO MI300X training run (~$30, 10-20 hours) we expect:
- An adapter at `/home/gcp/ozzu/private/finetune/qwen3-32b-ozzu-soc-v1/final-adapter/`
- Registered in Ollama as `ozzu-soc-v1`
- A baseline AutoPenBench number (target: beat base Qwen3-32B's 30.30%)
- A baseline Step 8 multi-agent smoke result (PASS = tool-use preserved)
- A compare.py report showing per-category delta
- ~ 1000-2000 telemetry rows accumulated from real engagements (if King Kazuma runs any post-training)

Two outcome trees:

### If v1.1 passes (AutoPenBench Δ ≥ +10pp, Step 8 smoke green)
- Swap `OFFENSE_MODEL_NAME=ozzu-soc-v1` in bridge `.env`
- Run engagements with the fine-tune
- **v1.2 work is about widening the lead** — add corpora, do more epochs, swap base model

### If v1.1 marginally passes (0 ≤ Δ < +10pp)
- Don't swap (the base is fine)
- Diagnose: low Δ suggests data quality OR LR/epoch tuning
- **v1.2 work is about closing the gap** — better data first, hyperparams second

### If v1.1 fails (Δ < 0, OR Step 8 smoke red)
- Catastrophic forgetting won — Glaive's 12% wasn't enough
- **v1.2 work is about more tool-use preservation** — bump to 20-25%, add structured-agent transcripts

## v1.2 candidate improvements (ranked by expected ROI)

### 1. ⭐ Add agent.jsonl (real engagement transcripts) — 20% of mix

**Why:** The most-cited bottleneck in the field survey. WhiteRabbitNeo + Glaive + Fenrir + Dolly all lack our specific tool schemas (queue_step, advance_offense, etc.). The model learns the GENERAL shape of tool-calling but not OUR shapes.

**Source:** `offense_telemetry` + `engagement_tasks.outcome_summary` + `soc_queue_items` from real engagements run between v1.1 and v1.2 training.

**Mechanism:** `tools/finetune/dataset/export-our-transcripts.py` already exists (shipped Step 9.6). Anonymizer is built. Just needs DATA — i.e. real engagements running with v1.1 + base for 1-2 weeks.

**Target:** 1000+ rows of structured tool_calls following our exact schemas (`queue_step({command:..., expected_artifact:...})`, etc.)

**Cost:** zero — derived from existing engagement history. Just operator time running engagements.

### 2. ⭐ Add HTB writeups corpus — 10% of mix

**Why:** Step-by-step technical walkthroughs train the model on the EXACT format SOC tasks need (recon → foothold → privesc → cleanup). Currently zero in v1.1 because 0xdf's GitLab repo required auth.

**Source candidates (in priority order):**

| Source | Format | Ungated? | Status |
|---|---|---|---|
| [IppSec/parrot](https://github.com/IppSec/parrot) | Video transcripts + commands | ✓ public GitHub | **Best lead** — needs a converter |
| 0xdf via different hosting | Markdown | ⚠️ GitLab requires auth | already tried, failed |
| HackTheBox official writeups | Mixed | ⚠️ HTB account required | semi-public |
| TryHackMe community writeups (Medium) | Mixed | ✓ scrapable | needs polite rate-limit scraper |
| VulnHub archive | Mixed | ✓ public | dated content |

**Converter needed:** ~150 lines Python. Walks the parrot repo, parses per-machine transcripts into multi-turn chat: user = "Walk me through HTB <machine>"; assistant = walkthrough with code blocks for each command.

### 3. RL on top of SFT (Pentest-R1 approach)

**Why:** [Pentest-R1 paper (arXiv 2508.07382)](https://arxiv.org/abs/2508.07382) hit 24.2% AutoPenBench via two-stage RL, second only to Gemini 2.5 Flash among 2025-2026 models. Their approach: SFT first (what we're doing), then RL on engagement outcomes.

**Mechanism:** DPO (Direct Preference Optimization) or GRPO. Requires (prompt, good_response, bad_response) tuples. Source these from:
- Engagement reruns where v1.1 succeeds vs base fails on same task
- Operator-curated "this was a better step" annotations during real engagements
- Synthetic comparisons (LLM-as-judge between two model outputs)

**Cost:** another $30-40 training run. **Only valuable if v1.1 SFT clears the +10pp bar** — RL on a bad SFT base just amplifies errors.

### 4. LR / rank / epoch sweep

**Why:** train.py uses defaults (lr=2e-4, rank=32, epochs=3). These are educated guesses, not measured optima.

**Mechanism:** 3-4 micro-runs at different settings. Each ~$5-10 of compute (1 epoch on 5% subset, just enough to see loss-curve shape).

- lr ∈ {1e-4, 2e-4, 5e-4} — see which produces fastest, smoothest descent
- rank ∈ {16, 32, 64} — 32 is xOffense's likely value, but 64 might give more headroom for our larger corpus mix
- epochs ∈ {2, 3, 4} — diminishing returns past 3, but worth measuring eval-loss-gap to confirm

**Cost:** $20-30 total. **Only valuable if v1.1 didn't pass cleanly** — if it cleared +10pp, further tuning is overfitting to AutoPenBench.

### 5. Try a different base model

**Why:** Qwen3-32B is our anchor (xOffense validated). But the field has moved:
- **Qwen3-72B / Qwen3-Coder-32B** — bigger or coder-specialized variants
- **DeepSeek-V3** — competitive on cybersec benchmarks
- **Llama-3.3-70B** — different lineage; might preserve tool-use differently

**Risk:** loses our xOffense alignment. We can't directly compare to their 72.72% if base model differs.

**Cost:** another full $30-40 training run per base model swap.

### 6. Mixed-precision exploration

**Why:** train.py uses bf16. Could try int8 or 4-bit quantization during training (QLoRA) to free VRAM for larger batch / longer context.

**Risk:** ROCm/AMD has rougher quantization library support than CUDA. Could waste cycles fighting libraries.

**Cost:** infrastructure debugging + $5-10 micro-run.

## Decision tree for v1.2 prioritization

```
After v1.1 results land:

  IF Δ < 0 (regression)
    THEN bump Glaive ratio + add HTB writeups via IppSec parrot
       → v1.2 = (corpus C: agent transcripts, IF any) + Glaive 20% + parrot 10% + WRN 60% + Dolly 10%

  ELIF Δ < +10pp (marginal)
    THEN run a 3-3-3 sweep (lr × rank × epochs micro-runs) → take best
       → v1.2 = same data, tuned hyperparams

  ELIF +10pp ≤ Δ < +30pp (good)
    THEN add agent transcripts + HTB writeups, hold hyperparams
       → v1.2 = v1.1 data + corpus C (20%) + parrot (10%), proportionally rebalance

  ELIF Δ ≥ +30pp (great)
    THEN consider RL second-stage (Pentest-R1 approach)
       → v1.3 = DPO on top of v1.2 SFT
```

## Things NOT to do in v1.2

- ❌ **Don't restart from scratch.** v1.1 has 19k examples + a working LoRA. Build on it.
- ❌ **Don't switch base models without a control.** If we move to Qwen3-72B, do BOTH on the same dataset so we can attribute improvement.
- ❌ **Don't add corpora indiscriminately.** Every new dataset needs the same care as Glaive (parser, validation, tool-call ratio check).
- ❌ **Don't drop Glaive.** The tool-use anchor is non-negotiable.
- ❌ **Don't blindly trust AutoPenBench.** Per the [Kernel Divergence paper (arXiv 2502.00678)](https://arxiv.org/abs/2502.00678), Qwen-family LLMs have known leakage on common benchmarks. Diversify eval — PentestEval + CyberMetric + real engagement smoke.

## Eval roadmap

Each v1.x training should report on:
1. **AutoPenBench task completion** (our existing harness)
2. **Step 8 multi-agent smoke** (tool-use preserved?)
3. **Berkeley Function Calling Leaderboard** (independent tool-use eval)
4. **CyberMetric** (general cybersec knowledge) — once we wire up a runner
5. **Real engagement signal** — `analyze_engagement_telemetry` patterns

The compare.py script generalizes — same logic works across any two model JSONLs as long as the schema matches.

## When this memo is stale

After v1.2 trains successfully, write `SOC-FINETUNE-V13-DESIGN.md` and update this file to point at it. The decision tree above is the durable artifact; the specific recommendations decay over weeks.
