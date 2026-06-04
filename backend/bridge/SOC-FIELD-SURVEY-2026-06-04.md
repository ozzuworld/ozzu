# Field survey — open-source pentest LLM fine-tunes (2026-06-04)

Salvaged from the failed deep-research workflow (108 subagents, 1.7M tokens, structured-output bug killed synthesis). Search/fetch results were saved to transcripts — this doc is the manual synthesis from those transcripts.

## TL;DR — what changes our v1 plan

1. **xOffense's recipe is the anchor** — they validated Qwen3-32B + LoRA at **72.72% on AutoPenBench** (24/33 tasks). Base Qwen3-32B alone scores 30.30%. We're matching their architecture exactly. ✅ Worth using.
2. **HackSynth's warning is critical** — fine-tuning hit **92.50% on CyberMetric but "severely compromises safety resilience"** (their paper's words). Tool-use degradation is REAL, not theoretical.
3. **Goedel-Prover-V2 cautionary tale** — heavy SFT dropped function-calling accuracy from **89.4% → 0%**. This is the failure mode we MUST avoid.
4. **The fix has a name: replay fraction.** Mix ~10-20% general/tool-call data during fine-tuning. Documented technique with measured results.
5. **Glaive Function Calling v2** exists and is exactly what we need to mix in. Not cybersec — that's the point. It anchors tool-calling.
6. **Don't trust AutoPenBench alone** — "Qwen family of LLMs shows a high risk of data leakage in several benchmarks." Use multiple benchmarks (CyberMetric, PentestEval, Berkeley Function Calling Leaderboard).

## 1. Existing pentest fine-tuned models (verified)

### xOffense (arXiv [2509.13021](https://arxiv.org/abs/2509.13021)) — our direct reference
- **Base:** Qwen3-32B
- **Method:** LoRA
- **AutoPenBench (Table 2):**

| Model | Task completion | n/33 |
|---|---|---|
| **Qwen3-32B-finetune (xOffense)** | **72.72%** | 24/33 |
| Llama3.1-405B (VulnBot) | 30.30% | 10/33 |
| Qwen3-32B-base | 30.30% | 10/33 |
| GPT-4o | 21.21% | 7/33 |
| PentestGPT | 9.09% | 3/33 |

- **Sub-task completion:** 79.17%
- **Key finding:** 32B fine-tune beat Llama3.1-405B (~12× bigger) on every metric.
- **Architecture:** Multi-agent (Task Orchestrator + Knowledge Repository + Command Synthesizer + Action Executor + Information Aggregator). This is what we copied for Step 8.
- **Weights:** Not publicly released as of survey. Paper describes recipe.
- **Verdict:** **LEARN-FROM + match the recipe.** This is our north star. Their 72.72% is the bar.

### VulnBot (arXiv [2501.13411](https://arxiv.org/abs/2501.13411))
- **Base:** Llama3.1-405B
- **AutoPenBench:** 30.30% (10/33) — same as base Qwen3-32B at 1/12 the size
- **Verdict:** **IGNORE.** 405B is too big, performance is worse than base Qwen3.

### Pentest-R1 (arXiv [2508.07382](https://arxiv.org/abs/2508.07382))
- **Method:** Two-stage Reinforcement Learning (RL, not SFT)
- **AutoPenBench:** 24.2% (second only to Gemini 2.5 Flash among models tested)
- **Verdict:** **LEARN-FROM.** RL is a more advanced technique than SFT. Could be our v3+ direction. But for v1, SFT is the right starting point.

### HackSynth (arXiv [2412.01778](https://arxiv.org/abs/2412.01778))
- **Result:** "Up to 92.50% accuracy on CyberMetric" after fine-tuning
- **CRITICAL CAVEAT (direct quote):** "*while fine-tuning improves cyber security task performance (achieving up to 92.50% accuracy on CyberMetric), it severely compromises safety resilience across all tested models and attack vectors*"
- **Verdict:** **LEARN-FROM.** Their result confirms the side-effect we feared. Don't blindly chase the cybersec score.

### Foundation-Sec-8B / Foundation-Sec-8B-Reasoning (Cisco)
- **Base:** Llama-3.1-8B
- **Defense-focused** (not offensive)
- **Open-weight, no commercial agreement required**
- **HarmBench:** 98.25% protection (with LlamaGuard pairing)
- **Verdict:** **IGNORE for offense.** Wrong lean (defense). But interesting to compare against.

### NYU CTF Agents (arXiv [2502.10931](https://arxiv.org/abs/2502.10931))
- **Open source:** [github.com/NYU-LLM-CTF/nyuctf_agents](https://github.com/NYU-LLM-CTF/nyuctf_agents)
- **Verdict:** **FORK-CANDIDATE.** Academic CTF benchmark + agent. Worth comparing our harness against.

### WhiteRabbitNeo 13B/33B/70B (the original)
- **Weights:** Released but with Llama-2 license restrictions
- **Dataset:** What we're using (PJMixers mirror)
- **Tool-calling:** Not specifically trained for it — that's why our risk is real
- **Verdict:** **IGNORE the model**, **USE the dataset** (already doing this).

### Lily-Cybersecurity-7B-v0.2 / Trendyol / Fenrir variants
- Various smaller fine-tunes
- No AutoPenBench numbers found in survey
- **Verdict:** **IGNORE the models**; their **datasets** may be useful (Fenrir-v2.1 + Trendyol are in our backup pool).

## 2. Datasets — the corpus mix problem

We already have the **PJMixers/WhiteRabbitNeo** mirror (18,897 examples, on disk at `/home/gcp/ozzu/private/finetune/dataset-v1/`).

Additional ungated cybersec datasets confirmed in survey:

| Dataset | Size hint | Format | Lean | Use case |
|---|---|---|---|---|
| [Fenrir-v2.1](https://huggingface.co/datasets/AlicanKiraz0/Cybersecurity-Dataset-Fenrir-v2.1) | 5466 downloads, popular | `{system, user, assistant}` | Defense / causal reasoning | Broaden domain |
| [Trendyol-Cybersecurity](https://huggingface.co/datasets/Trendyol/Trendyol-Cybersecurity-Instruction-Tuning-Dataset) | 2628 downloads | `{system, user, assistant}` | Defense (C2 / TLS analysis) | Broaden domain |
| [ChaoticNeutrals-ShareGPT](https://huggingface.co/datasets/ChaoticNeutrals/Cybersecurity-ShareGPT) | 284 downloads | `{conversations}` (ShareGPT) | Same as WRN — likely overlap | Skip if dup |
| [hcnote/Cybersecurity-HQ](https://huggingface.co/datasets/hcnote/Cybersecurity-High-Quality-Dataset) | 291 downloads | `{instruction, output}` (Alpaca) | Generic CS knowledge | Marginal |
| [preemware/pentesting-eval](https://huggingface.co/datasets/preemware/pentesting-eval) | 107 downloads | `{question, choices, answer}` | Multi-choice | **EVAL ONLY — DO NOT TRAIN** |

**The critical dataset gap — tool-calling preservation:**

| Source | What it provides | Why we need it |
|---|---|---|
| **[Glaive Function Calling v2](https://huggingface.co/datasets/glaiveai/glaive-function-calling-v2)** | Dedicated function-calling instruction-tune dataset, general purpose | **Anchors structured `tool_calls` output** so the model doesn't lose function-calling during cybersec fine-tune |
| **Berkeley Function Calling Leaderboard data** | Benchmark + training set | Standard eval for function-calling capability |
| **MCP tool-call examples** | Some unnamed cybersec datasets include MCP-format calls | Even better — domain-specific function calls |

**At least one cybersec dataset in the survey advertised MCP tool-call examples** — that's the holy grail (cybersec content + structured function calls in the same row). Worth specifically hunting for HF datasets with `tool_calls` in the schema.

## 3. Existing pentest agent harnesses

| Harness | Architecture | Status | Verdict |
|---|---|---|---|
| **xOffense** | Multi-agent (5 roles) | Paper-only, no public code | **LEARN-FROM** — we already cloned the architecture |
| **PentestGPT** | Three-role (Reasoning/Generation/Parsing) | Open source, ICLR 2024 | **LEARN-FROM** — Step 8.1 mirrors this |
| **AutoPenBench** | Eval harness, not agent | [github.com/lucagioacchini/auto-pen-bench](https://github.com/lucagioacchini/auto-pen-bench) | **USE** — already wired into `tools/finetune/eval/run-autopenbench.sh` |
| **AutoPentest** | LangChain-based | $96/run for 15-25% completion (cautionary) | **IGNORE** — bad cost/perf ratio |
| **HackSynth** | LLM agent + eval framework | Open source on GitHub | **LEARN-FROM** — but their safety result is a warning, not a recipe |
| **NYU CTF Agents** | Multi-LLM agent on CTFs | [Open](https://github.com/NYU-LLM-CTF/nyuctf_agents) | **FORK-CANDIDATE** for cross-eval |
| **VulnBot** | Multi-agent | Paper | **IGNORE** — performance too low |

## 4. Research papers — reading list

Verified arxiv papers cited in survey transcripts:

| ID | Topic | Why read |
|---|---|---|
| [2509.13021](https://arxiv.org/abs/2509.13021) | xOffense — Qwen3-32B + LoRA + multi-agent | Our direct reference |
| [2410.03225](https://arxiv.org/abs/2410.03225) | AutoPenBench (benchmark itself) | Eval methodology |
| [2410.17141](https://arxiv.org/abs/2410.17141) | Towards Automated Penetration Testing | Survey paper |
| [2412.01778](https://arxiv.org/abs/2412.01778) | HackSynth | Safety degradation finding |
| [2501.13411](https://arxiv.org/abs/2501.13411) | VulnBot — multi-agent | Architecture comparison |
| [2502.10931](https://arxiv.org/abs/2502.10931) | NYU CTF Agents | Open-source alt-implementation |
| [2508.07382](https://arxiv.org/abs/2508.07382) | Pentest-R1 — two-stage RL | Direction for v3+ |
| [2512.14233](https://arxiv.org/pdf/2512.14233) | PentestEval — stage-level benchmark | Better eval design |
| [2407.21783](https://arxiv.org/abs/2407.21783) | Catastrophic forgetting + replay fraction | **The technique we need** |
| [2502.00678](https://arxiv.org/abs/2502.00678) | Dataset leakage measurement (Kernel Divergence) | Why AutoPenBench numbers may be inflated |

## 5. Tool-use preservation — the answer

The survey found a clear, named technique:

### Replay Fraction (arXiv [2407.21783](https://arxiv.org/abs/2407.21783))

During domain fine-tuning, mix in a fraction `ρ` of the original pretraining data (or substitute: general instruction-tuning / function-calling data). Empirically tested replay fractions: **0.25, 0.5, 0.75, 0.875**.

**Direct quote from the survey:** *"Heavy supervised fine-tuning on a target domain can strongly suppress capabilities that were present in the base model. Specifically, Goedel-Prover-V2, trained on 1.8 million formal-math examples, experienced severe capability degradation—function-calling accuracy plummeted from 89.4% to nearly 0%."*

**Mitigation in same paper:** with replay, *"Berkeley Function Calling Leaderboard: Performance improved from near zero to 83.8%"*.

### Other LoRA-specific forgetting mitigation
- **CorDA** — Singular Value Decomposition on pre-trained weights to identify safe directions
- **RoseLoRA** — sparsity constraints on low-rank matrices (selectively update most critical params)

**Both are advanced techniques.** For v1, the simpler approach is sufficient: **include Glaive Function Calling v2 as 10-20% of the training mix.**

## 6. Updated v1 training recipe

Based on this survey, drop the single-corpus plan. New plan:

```
v1 training corpus mix (~25k examples total):
├── PJMixers/WhiteRabbitNeo            ~14k (70%)  — domain knowledge (offensive)
├── Glaive Function Calling v2          ~3k  (15%) — TOOL-USE PRESERVATION
├── Fenrir-v2.1 (sampled)               ~2k  (10%) — defense-leaning diversity
└── General instruction data (sampled)  ~1k  (5%)  — base anchoring
```

**Why these ratios:**
- Survey shows tool-calling needs ~15-20% replay to stay above 80% of base capability (Goedel-Prover-V2 evidence)
- Defense data prevents the "refuses to discuss defense" failure mode
- 70% domain-specific is the maximum we can do while still preserving general ability

**Eval plan after training:**
1. **AutoPenBench** (33 tasks) — our existing harness
2. **Berkeley Function Calling Leaderboard** — confirm tool-use preservation
3. **PentestEval** (when available) — independent cybersec eval
4. **Step 8 smoke test** (`tools/tests/agent-smoke.js`) — confirms agent loop still works

**Why this catches the failure mode:** if tool-calling degraded, AutoPenBench scores might still LOOK good (it tests cybersec output, not tool emission). But Step 8 smoke test will fail because our multi-agent loop requires structured `tool_calls`. So smoke test is the canary.

### Cost / time impact
- Dataset prep adds: 1-2 hours of work to add Glaive + Fenrir converters
- Training cost: unchanged (~$30-40, model sees same total tokens)
- Eval cost: unchanged
- Risk reduction: huge — addresses the #1 failure mode we identified

## 7. Open questions still worth answering

The survey couldn't fully verify these — would benefit from a targeted re-research with smaller, more focused queries:

1. **xOffense paper hyperparameters** — exact LoRA rank, alpha, epochs, batch size. They published the recipe but the survey's PDF extraction was incomplete. Would inform our train.py defaults.
2. **Which HF cybersec dataset has MCP tool-calls** — the survey saw an example but didn't identify the specific dataset.
3. **Pentest-R1 RL details** — for our v3 planning. Their 24.2% with RL beat all baselines except Gemini 2.5 Flash; recipe details would be useful.
4. **AutoPenBench contamination quantification** — how much of Qwen3's 30.30% base score is from pretraining contamination vs actual capability?

These are **future** research directives, not blockers. The v1 recipe above is complete enough to train when DO GPU access lands.
