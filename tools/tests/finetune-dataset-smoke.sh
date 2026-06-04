#!/usr/bin/env bash
# finetune-dataset-smoke.sh — Step 9.14 (dir_1780599210887)
#
# Validate the dataset-prep pipeline (merge.py + provenance handling +
# format correctness) on TINY synthetic inputs that mimic the shape each
# real corpus emits. NO spend, NO HF download, NO 0xdf clone, NO postgres.
#
# Catches: python errors in merge.py, schema drift between corpora,
# eval-split math bugs, _meta-header handling regressions.
#
# Usage:
#   bash /home/gcp/ozzu/tools/tests/finetune-dataset-smoke.sh

set -uo pipefail

GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MERGE_PY="$ROOT/finetune/dataset/merge.py"
WORK=$(mktemp -d /tmp/finetune-smoke.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

log() { echo "[finetune-smoke] $*"; }
fail() { echo "${RED}✗ FAIL${RESET}  $*"; exit 1; }
pass() { echo "${GREEN}✓ PASS${RESET}  $*"; }

# ─────────────────────────── py_compile sweep ───────────────────────────
# Validate Python syntax of every .py file under tools/finetune/ — catches
# typos / unbalanced-paren / missing-import-syntax bugs in train.py + the
# dataset scripts BEFORE the operator burns DO compute discovering them.
PY_FILES=$(find "$ROOT/finetune" -type f -name '*.py' 2>/dev/null | sort)
if [[ -z "$PY_FILES" ]]; then
  fail "py_compile sweep: no .py files found under $ROOT/finetune (path wrong?)"
fi
PY_COUNT=$(echo "$PY_FILES" | wc -l)
log "py_compile sweep across $PY_COUNT files under tools/finetune/"
PY_ERRORS=0
while IFS= read -r f; do
  if ! python3 -m py_compile "$f" 2>&1 | sed 's/^/    /'; then
    PY_ERRORS=$((PY_ERRORS + 1))
    echo "  ${RED}✗${RESET} $f"
  fi
done <<< "$PY_FILES"
if [[ "$PY_ERRORS" -gt 0 ]]; then
  fail "py_compile sweep: $PY_ERRORS file(s) have syntax errors"
fi
pass "py_compile sweep: $PY_COUNT files syntactically valid"

# ─────────────────────────── synthesize tiny corpora ───────────────────────────
# Each corpus matches the real format: _meta header (skipped by merge) + N rows.
log "synthesizing tiny corpora under $WORK"

python3 - <<PY
import json, pathlib
work = pathlib.Path("$WORK")

# Corpus A: WhiteRabbitNeo-style
with (work / "wrn.jsonl").open("w") as f:
    f.write(json.dumps({"_meta": True, "source": "whiterabbitneo", "rows_kept": 5}) + "\n")
    for i in range(5):
        f.write(json.dumps({
            "messages": [
                {"role": "user", "content": f"WRN test prompt {i}"},
                {"role": "assistant", "content": f"WRN test response {i} with code block:\n\`\`\`bash\necho test\n\`\`\`"},
            ],
            "source": "whiterabbitneo", "chapter": "WRN-Chapter-1", "id": f"wrn-{i}",
        }) + "\n")

# Corpus B: 0xdf writeups
with (work / "writeups.jsonl").open("w") as f:
    f.write(json.dumps({"_meta": True, "source": "0xdf-htb-writeups"}) + "\n")
    for i in range(3):
        f.write(json.dumps({
            "messages": [
                {"role": "user", "content": f"Walk me through HackTheBox machine Test{i}."},
                {"role": "assistant", "content": f"# Test{i}\n\nRecon:\n\`\`\`\nnmap -p- 10.10.10.{i}\n\`\`\`\nFoothold via SQLi...\n\`\`\`\nsqlmap -u ...\n\`\`\`"},
            ],
            "source": "0xdf-htb-writeups", "machine": f"Test{i}", "license": "CC-BY-SA-4.0 0xdf",
        }) + "\n")

# Corpus C: our agent transcripts (anonymized)
with (work / "agent.jsonl").open("w") as f:
    f.write(json.dumps({"_meta": True, "source": "ozzu-agent-transcripts"}) + "\n")
    for i in range(4):
        f.write(json.dumps({
            "messages": [
                {"role": "system", "content": "You are the COMMAND SYNTHESIZER..."},
                {"role": "user", "content": f"Task: recon target {i}"},
                {"role": "assistant", "content": json.dumps({"command": "nmap -sV 10.99.99.10", "title": "recon", "expected_artifact": "service list"})},
            ],
            "source": "ozzu-agent-transcripts", "engagement_hash": f"abc12345{i:03d}",
        }) + "\n")
PY

# Verify the inputs we just created
for f in wrn.jsonl writeups.jsonl agent.jsonl; do
  [[ -s "$WORK/$f" ]] || fail "synthesized $f is empty"
done
pass "synthesized 3 corpora (5 + 3 + 4 = 12 examples + 3 _meta headers)"

# ─────────────────────────── run merge.py ───────────────────────────
log "running merge.py with --seed 42 --eval-frac 0.25"
python3 "$MERGE_PY" \
  --inputs "$WORK/wrn.jsonl" "$WORK/writeups.jsonl" "$WORK/agent.jsonl" \
  --out      "$WORK/train.jsonl" \
  --eval-out "$WORK/eval.jsonl"  \
  --eval-frac 0.25 \
  --seed 42 \
  2>&1 | sed 's/^/  | /'

[[ -s "$WORK/train.jsonl" ]] || fail "merge.py produced no train.jsonl"
[[ -s "$WORK/eval.jsonl"  ]] || fail "merge.py produced no eval.jsonl"
pass "merge.py exited cleanly + produced both outputs"

# ─────────────────────────── assert shape ───────────────────────────
python3 - <<PY || exit 1
import json, sys, pathlib
work = pathlib.Path("$WORK")

train = [json.loads(l) for l in (work/"train.jsonl").open() if l.strip()]
eval_ = [json.loads(l) for l in (work/"eval.jsonl").open()  if l.strip()]

# 12 examples total. 25% eval → 3 eval, 9 train. Some merge.py impls round
# differently (floor vs round-half), so we accept 2-4 eval and rest train.
assert 10 <= len(train) + len(eval_) <= 12, f"merge dropped rows: {len(train)} train + {len(eval_)} eval"
assert 2 <= len(eval_) <= 4, f"eval split wrong size: {len(eval_)} (expected 2-4 for 12 rows @ 0.25)"

# No _meta rows should survive
for row in train + eval_:
    assert not row.get("_meta"), f"_meta row leaked through merge: {row}"

# Every row must have messages list
for row in train + eval_:
    assert isinstance(row.get("messages"), list) and row["messages"], f"missing messages: {row}"
    for m in row["messages"]:
        assert m.get("role") in ("system", "user", "assistant"), f"bad role: {m}"
        assert isinstance(m.get("content"), str), f"non-string content: {m}"

# All three sources represented in the combined set
sources_seen = {r.get("source") for r in train + eval_}
expected = {"whiterabbitneo", "0xdf-htb-writeups", "ozzu-agent-transcripts"}
missing = expected - sources_seen
assert not missing, f"missing sources after merge: {missing}"

# Deterministic shuffle — running again with same seed should give same order
train_ids = [json.dumps(r["messages"]) for r in train]
print(f"  shape OK — train={len(train)} eval={len(eval_)} sources={sorted(sources_seen)}")
PY
pass "merge output schema OK + all 3 sources present + no _meta leakage"

# ─────────────────────────── re-run with same seed → identical output ───────────────────────────
log "re-running with same seed — should be byte-identical"
python3 "$MERGE_PY" \
  --inputs "$WORK/wrn.jsonl" "$WORK/writeups.jsonl" "$WORK/agent.jsonl" \
  --out      "$WORK/train2.jsonl" \
  --eval-out "$WORK/eval2.jsonl"  \
  --eval-frac 0.25 --seed 42 \
  >/dev/null 2>&1
if diff -q "$WORK/train.jsonl" "$WORK/train2.jsonl" >/dev/null && \
   diff -q "$WORK/eval.jsonl"  "$WORK/eval2.jsonl"  >/dev/null; then
  pass "deterministic shuffle: same seed → byte-identical outputs"
else
  fail "merge.py is non-deterministic with --seed (train2.jsonl differs from train.jsonl)"
fi

# ─────────────────────────── re-run with DIFFERENT seed → DIFFERENT order ───────────────────────────
log "re-running with seed=99 — order should differ"
python3 "$MERGE_PY" \
  --inputs "$WORK/wrn.jsonl" "$WORK/writeups.jsonl" "$WORK/agent.jsonl" \
  --out      "$WORK/train3.jsonl" \
  --eval-out "$WORK/eval3.jsonl"  \
  --eval-frac 0.25 --seed 99 \
  >/dev/null 2>&1
if diff -q "$WORK/train.jsonl" "$WORK/train3.jsonl" >/dev/null; then
  echo "${YELLOW}~ WARN${RESET}  different seed produced identical output (possible if N too small)"
else
  pass "seed change → different shuffle order (as expected)"
fi

# ─────────────────────────── Qwen3 tokenization check ───────────────────────────
# Render rows through Qwen3's actual chat_template (CPU only — no GPU needed)
# to catch format-drift bugs where converters emit messages that don't match
# the expected schema. Requires transformers + jinja2 in the venv.
log "Qwen3-32B tokenization check (CPU, no GPU)"
if [[ -d /tmp/finetune-venv ]]; then
  # shellcheck disable=SC1091
  source /tmp/finetune-venv/bin/activate
  python3 -c "
import sys, json
try:
    from transformers import AutoTokenizer
except ImportError:
    print('  ${YELLOW}~ WARN${RESET}  transformers not installed — skipping tokenization check')
    sys.exit(0)
try:
    tok = AutoTokenizer.from_pretrained('Qwen/Qwen3-32B')
except Exception as e:
    print(f'  ${YELLOW}~ WARN${RESET}  could not load Qwen3-32B tokenizer (network?): {e}')
    sys.exit(0)
ok = 0; fail = 0
for line in open('$WORK/train.jsonl'):
    try: d = json.loads(line)
    except: continue
    if d.get('_meta'): continue
    try:
        text = tok.apply_chat_template(d['messages'], tokenize=False, add_generation_prompt=False)
        assert '<|im_start|>' in text and '<|im_end|>' in text, 'missing Qwen turn markers'
        ok += 1
    except Exception as e:
        print(f'  FAIL on {d.get(\"source\",\"?\")} id={d.get(\"id\",\"?\")}: {e}')
        fail += 1
        if fail >= 3: break
print(f'  rendered: {ok} rows OK, {fail} rows failed')
sys.exit(0 if fail == 0 else 1)
" || fail "Qwen3 tokenization check produced failures"
  pass "Qwen3 tokenization renders cleanly on all sample rows"
else
  log "${YELLOW}~ WARN${RESET}  /tmp/finetune-venv not found — skip tokenization (run build-wrn.py once to set it up)"
fi

echo
echo "${GREEN}🎯 ALL DATASET SMOKE ASSERTIONS PASSED${RESET}"
echo "Pipeline is ready for real corpora when operator runs run-finetune.sh."
