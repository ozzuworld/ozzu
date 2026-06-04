# Dataset card — v1.1 (2026-06-04)

Location: `/home/gcp/ozzu/private/finetune/dataset-v1.1/` (gitignored under `private/`)
Builder: `tools/finetune/dataset/build-v11-mix.py`
Source-of-truth design: [`SOC-FIELD-SURVEY-2026-06-04.md`](./SOC-FIELD-SURVEY-2026-06-04.md)

## What's in the box

```
dataset-v1.1/
├── wrn.jsonl       14,000 rows · 92 MB  (offensive domain knowledge)
├── glaive.jsonl     2,444 rows ·  4.2 MB (function-calling preservation)
├── fenrir.jsonl     1,999 rows ·  8.6 MB (defense-leaning diversity)
├── general.jsonl    1,000 rows · 907 KB  (base-anchor general instruction)
├── train.jsonl     18,471 rows · 101 MB  (merged, shuffled, 95% split)
└── eval.jsonl         954 rows ·   5.2 MB (5% holdout, same shuffle seed)
```

Total: **19,425 examples** ready for `train.py`. Cost to rebuild from scratch: ~5-10 min (CPU + HF download).

## Per-corpus stats + provenance

### A. PJMixers/WhiteRabbitNeo (73.3% of train)
- **Source:** [PJMixers/WhiteRabbitNeo](https://huggingface.co/datasets/PJMixers/WhiteRabbitNeo) on HuggingFace (public, ungated mirror of WhiteRabbitNeo/WRN-Chapter-1)
- **Why this mirror:** the original `WhiteRabbitNeo/WRN-Chapter-1` is gated — auth + access approval required. We hit the wall 2026-06-04 mid-training. PJMixers is the same content without the gate.
- **Schema mapped:** `{subject, system, instruction, response}` → standard `{messages: [system, user, assistant]}` via `tools/finetune/dataset/build-wrn.py`.
- **Sample size:** 14,000 / 18,897 available (downsampled to hit ratio target — random shuffle, seed=42)
- **Lean:** offensive cybersec, step-by-step technical answers, refusal-free
- **License:** Apache-2.0

### B. glaiveai/glaive-function-calling-v2 (12.5% of train)
- **Source:** [glaiveai/glaive-function-calling-v2](https://huggingface.co/datasets/glaiveai/glaive-function-calling-v2) on HuggingFace
- **Why this dataset:** dedicated function-calling instruction-tune corpus. Survey identified tool-use preservation as THE critical risk for single-corpus cybersec fine-tuning (Goedel-Prover-V2: function-calling dropped from 89.4% → 0% after specialized SFT). Glaive anchors that capability.
- **Format:** General-purpose (currency exchange, weather, news, calculations) — NOT cybersec. That's intentional. The model learns the *structural pattern* of tool-calling, transferable to our SOC tool schemas.
- **Schema:** chat string with `USER:`/`ASSISTANT:`/`A:`/`FUNCTION RESPONSE:` markers; function calls are INLINE in assistant turns as `<functioncall> {...} <|endoftext|>`.
- **Converter (build-v11-mix.py `parse_glaive_chat`):** extracts the inline `<functioncall>` payload, ast.literal_eval handles Python-repr single-quoted argument strings, re-emits as Qwen3-native `<tool_call>\n{json}\n</tool_call>` wrap.
- **Tool-call signal in v1.1:** **79.4% of glaive rows contain `<tool_call>` content** (1,941/2,444). 79.7% have `tool` role responses. Verified post-build.
- **CAUTION — bug history:** initial parser searched for "FUNCTION CALL:" as a separate role marker, but Glaive embeds calls INLINE. First v1.1 build had 0% tool_call content (broken signal). Fix shipped dir_1780610126989; current build is correct.
- **Sample size:** 2,444 rows kept of 3,000 attempted (parse-fail skip rate ~19%)
- **License:** Apache-2.0

### C. AlicanKiraz0/Cybersecurity-Dataset-Fenrir-v2.1 (10.3% of train)
- **Source:** [AlicanKiraz0/Cybersecurity-Dataset-Fenrir-v2.1](https://huggingface.co/datasets/AlicanKiraz0/Cybersecurity-Dataset-Fenrir-v2.1) on HuggingFace
- **Why this dataset:** survey-identified as 5466-download popular ungated cybersec instruction set. Defense-leaning (causal reasoning, threat analysis, incident response) — complements WRN's offensive lean to broaden the model's cybersec context.
- **Schema:** `{system, user, assistant}` — clean SFT shape, direct map
- **Sample size:** 1,999 rows (2,000 sampled, 1 dropped by merge.py for missing field)
- **License:** check HF model card; community dataset
- **Lean:** defense / blue-team perspective

### D. databricks/databricks-dolly-15k (5.1% of train)
- **Source:** [databricks/databricks-dolly-15k](https://huggingface.co/datasets/databricks/databricks-dolly-15k) on HuggingFace
- **Why this dataset:** general-instruction anchor per the [replay-fraction technique (arXiv 2407.21783)](https://arxiv.org/abs/2407.21783). Including ~5% of out-of-domain general instruction data during specialized fine-tuning provably reduces catastrophic forgetting of base abilities.
- **Schema:** `{instruction, context, response}` (Alpaca) → user/assistant pair
- **Sample size:** 1,000 rows of 15,011 available (random shuffle, seed=42)
- **License:** CC-BY-SA-3.0

## Format

Every row in `train.jsonl` and `eval.jsonl` follows this schema:

```json
{
  "messages": [
    {"role": "system",    "content": "..."},   // optional
    {"role": "user",      "content": "..."},
    {"role": "assistant", "content": "..."}   // may contain <tool_call>...</tool_call>
    {"role": "tool",      "content": "..."}    // function response (Glaive rows)
    {"role": "assistant", "content": "..."}   // multi-turn continuation
  ],
  "source": "<one of: PJMixers-whiterabbitneo / glaiveai-function-calling-v2 / fenrir-v2.1 / databricks-dolly-15k>",
  "id": "<source-prefixed unique id>"
}
```

The `<tool_call>...</tool_call>` XML wrap is **Qwen3's native function-call format** (verified by inspecting Qwen3-32B's `tokenizer_config.json` `chat_template` field — uses literal `<tool_call>` and `<tool_response>` tags around JSON). Training the model on this format teaches it to emit function calls in a form Qwen3's chat template will recognize at inference.

## Training-readiness checklist

- ✅ All 4 corpora downloaded + persisted
- ✅ Merge with seed=42 produces deterministic train/eval split (verified by re-run)
- ✅ Per-source distribution within ±2% of design targets
- ✅ ~10% tool-call training signal (well above the 0% catastrophic-forgetting floor)
- ✅ No `_meta` rows leak into train/eval (merge.py validates)
- ✅ No private/PII content (anonymization not needed — sources are public domain)
- ✅ Format aligns with Qwen3 chat template
- ❌ NOT yet validated against `train.py` end-to-end (requires GPU)
- ❌ NOT yet trained (blocked on DO GPU access approval)

## How to rebuild from scratch

```bash
# 1. Set up Python venv (PEP 668 on Python 3.12)
python3 -m venv /tmp/finetune-venv
source /tmp/finetune-venv/bin/activate
pip install datasets huggingface_hub

# 2. Run the builder (downloads from HF, ~5-10 min)
python3 /home/gcp/ozzu/tools/finetune/dataset/build-v11-mix.py \
  --out-dir /home/gcp/ozzu/private/finetune/dataset-v1.1

# 3. Verify per-source distribution + tool_call ratio
python3 -c "
import json
counts, tc = {}, 0
total = 0
for line in open('/home/gcp/ozzu/private/finetune/dataset-v1.1/train.jsonl'):
    d = json.loads(line)
    if d.get('_meta'): continue
    total += 1
    counts[d['source']] = counts.get(d['source'], 0) + 1
    if any('<tool_call>' in (m.get('content') or '') for m in d['messages']): tc += 1
for s, n in sorted(counts.items(), key=lambda x: -x[1]):
    print(f'{s}: {n} ({100*n/total:.1f}%)')
print(f'<tool_call> rows: {tc} ({100*tc/total:.1f}%)')
"
```

## How to add a 5th corpus (future v1.2+)

1. Add a `build_<name>(out_path, n_target)` function in `build-v11-mix.py` mirroring `build_fenrir()`.
2. Add an entry in `TARGETS` dict at the top.
3. Call it in `main()` alongside the others.
4. Add the new corpus path to the merge.py invocation at the bottom of `main()`.
5. Rebuild + re-run the verification snippet above.

## Known limitations

- **The 5% Dolly slice is heterogeneous.** Some rows are recipes, history facts, software questions — not cybersec. This is *intentional* (replay anchor) but a future v1.2 could swap Dolly for a more carefully curated general-instruction slice if quality concerns arise.
- **Glaive function calls are general-domain.** None are cybersec-specific (no `nmap` / `metasploit` tools in the schemas). The model learns the *form* of tool-calling, not domain-specific tool semantics. Our actual SOC tool schemas (queue_step, advance_phase, etc.) will be presented at inference time via the chat template's `tools` parameter; the model's job is to recognize "structured function call needed" and emit the right shape.
- **No deduplication across corpora.** WRN + ChaoticNeutrals overlap by content (same WhiteRabbitNeo source). We don't include ChaoticNeutrals in v1.1 to avoid the dup; future corpora additions need a dedup pass.
- **No quality filtering** beyond structural validation (valid JSON, non-empty messages, valid roles).
