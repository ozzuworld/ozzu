#!/usr/bin/env bash
# post-train-validate.sh
#
# Runs the 3-step post-training validation sequence on a freshly-pulled
# fine-tune. Exit 0 means safe to swap OFFENSE_MODEL_NAME in backend/.env.
# Exit 1 means a test failed — do NOT swap.
#
# Sequence:
#   1. Step 8 multi-agent smoke against the new model → tool-use preserved?
#   2. AutoPenBench against base + fine-tune → completion-rate delta
#   3. compare.py verdict → +10pp gain triggers swap recommendation
#
# Usage:
#   bash /home/gcp/ozzu/tools/finetune/post-train-validate.sh                       # uses defaults
#   bash post-train-validate.sh --model ozzu-soc-v1 --baseline qwen3:32b
#   bash post-train-validate.sh --skip-eval                                         # only Step 8 smoke (fast)

set -uo pipefail

GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

MODEL="ozzu-soc-v1"
BASELINE="qwen3:32b"
SKIP_EVAL=0
OUTPUT_DIR="/home/gcp/ozzu/private/finetune/eval"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)       MODEL="$2"; shift 2 ;;
    --baseline)    BASELINE="$2"; shift 2 ;;
    --skip-eval)   SKIP_EVAL=1; shift ;;
    --output-dir)  OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage: post-train-validate.sh [opts]

After pull-adapter.sh has registered the new adapter in Ollama, run this
to confirm it's safe to swap the bridge default.

Options:
  --model TAG       The fine-tune to validate (default: ozzu-soc-v1)
  --baseline TAG    The baseline to compare against (default: qwen3:32b)
  --skip-eval       Skip AutoPenBench (slow); only run Step 8 smoke
  --output-dir PATH Where eval results land (default: /home/gcp/ozzu/private/finetune/eval)
EOF
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

section() { echo; echo "${BOLD}═══ $1 ═══${RESET}"; }
pass()  { echo "${GREEN}✓ PASS${RESET}  $*"; }
fail()  { echo "${RED}✗ FAIL${RESET}  $*"; FAILED=$((FAILED + 1)); }
warn()  { echo "${YELLOW}~ WARN${RESET}  $*"; }

echo "${BOLD}Post-train validation — ${MODEL} vs ${BASELINE}${RESET}"
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# ─────────────────────────── 1. Ollama reachable + has the model? ───────────────────────────
section "0. Prereqs"
if ! curl -sf --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
  fail "Ollama not reachable at http://localhost:11434 — is the inference tunnel open?"
  echo "  (run 'wait_offense_model' MCP tool to open the tunnel)"
  exit 1
fi
MODELS=$(curl -s http://localhost:11434/api/tags | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(m['name'] for m in d.get('models',[])))")
echo "  Ollama models: $MODELS"
if [[ ! "$MODELS" == *"$MODEL"* ]]; then
  fail "$MODEL not registered in Ollama. Run pull-adapter.sh first."
  exit 1
fi
if [[ ! "$MODELS" == *"$BASELINE"* ]]; then
  warn "$BASELINE not in Ollama. AutoPenBench baseline comparison will fail (skip with --skip-eval if intended)."
fi
pass "Ollama reachable + $MODEL present"

# ─────────────────────────── 2. Step 8 multi-agent smoke ───────────────────────────
section "1. Step 8 multi-agent smoke (tool-use preservation)"
echo "  This proves the agent loop still works with the fine-tune."
echo "  If this fails, the fine-tune degraded tool-calling → DO NOT swap."
echo
SMOKE_LOG=$(mktemp /tmp/post-train.smoke.XXXXXX.log)
if docker cp "$ROOT/tests/agent-smoke.js" bridge:/app/agent-smoke.js >/dev/null 2>&1; then
  if OFFENSE_MODEL_NAME="$MODEL" timeout 90 docker exec -e OFFENSE_MODEL_NAME="$MODEL" bridge \
      node /app/agent-smoke.js 2>&1 | tee "$SMOKE_LOG" | tail -12; then
    if grep -q "SMOKE TEST PASSED" "$SMOKE_LOG"; then
      pass "Step 8 smoke green — multi-agent loop works with $MODEL"
    else
      fail "Step 8 smoke RAN but didn't show PASSED marker — tool-use likely degraded"
    fi
  else
    fail "Step 8 smoke crashed — $MODEL likely can't emit structured JSON tool_calls"
  fi
else
  fail "Could not copy agent-smoke.js into bridge container"
fi

# If Step 8 fails, skip eval entirely — the fine-tune is unusable
if [[ "$FAILED" -gt 0 ]]; then
  echo
  echo "${RED}✗ Step 8 smoke failed — skipping AutoPenBench eval (would be wasted spend).${RESET}"
  echo "${RED}  DO NOT swap OFFENSE_MODEL_NAME. The fine-tune is broken.${RESET}"
  exit 1
fi

# ─────────────────────────── 3. AutoPenBench eval ───────────────────────────
if [[ "$SKIP_EVAL" -eq 1 ]]; then
  section "2. AutoPenBench eval — SKIPPED (--skip-eval)"
else
  section "2. AutoPenBench eval ($BASELINE then $MODEL)"
  echo "  This runs the AutoPenBench harness against both models."
  echo "  Each model is run on the 33 task containers; per-task completion rate computed."
  echo "  Wall clock: ~30-60 min per model."
  echo
  mkdir -p "$OUTPUT_DIR"
  TS=$(date +%Y%m%d_%H%M%S)
  BASE_RESULTS="$OUTPUT_DIR/${BASELINE//[\/:]/_}_${TS}_results.json"
  FT_RESULTS="$OUTPUT_DIR/${MODEL//[\/:]/_}_${TS}_results.json"
  if bash "$ROOT/finetune/eval/run-autopenbench.sh" --model "$BASELINE" --output-dir "$OUTPUT_DIR"; then
    pass "$BASELINE AutoPenBench run complete"
    # Find the just-written results
    BASE_RESULTS=$(ls -t "$OUTPUT_DIR"/${BASELINE//[\/:]/_}_*_results.json 2>/dev/null | head -1)
  else
    fail "$BASELINE AutoPenBench run failed"
  fi
  if bash "$ROOT/finetune/eval/run-autopenbench.sh" --model "$MODEL" --output-dir "$OUTPUT_DIR"; then
    pass "$MODEL AutoPenBench run complete"
    FT_RESULTS=$(ls -t "$OUTPUT_DIR"/${MODEL//[\/:]/_}_*_results.json 2>/dev/null | head -1)
  else
    fail "$MODEL AutoPenBench run failed"
  fi

  # ─────────────────────────── 4. compare.py verdict ───────────────────────────
  section "3. compare.py verdict (+10pp bar)"
  if [[ -f "$BASE_RESULTS" && -f "$FT_RESULTS" ]]; then
    REPORT="$OUTPUT_DIR/comparison_${TS}.md"
    python3 "$ROOT/finetune/eval/compare.py" \
      --base "$BASE_RESULTS" --ft "$FT_RESULTS" \
      --base-label "$BASELINE" --ft-label "$MODEL" \
      --out "$REPORT"
    echo
    cat "$REPORT"
    echo
    # Detect the verdict by grepping the report
    if grep -q "✓ \*\*Fine-tune wins" "$REPORT"; then
      pass "Δ ≥ 10pp — verdict: SAFE TO SWAP"
    elif grep -q "~ Fine-tune marginally" "$REPORT"; then
      warn "Δ < 10pp — verdict: marginal, consider another training run"
    elif grep -q "✗ \*\*Fine-tune REGRESSED" "$REPORT"; then
      fail "Δ < 0 — verdict: REGRESSION, DO NOT SWAP"
    else
      warn "compare.py output ambiguous — review $REPORT manually"
    fi
  else
    fail "Could not locate result JSONs — skipping compare.py"
  fi
fi

# ─────────────────────────── summary ───────────────────────────
echo
echo "═══════════════════════════════════════════════════════════════════"
if [[ "$FAILED" -eq 0 ]]; then
  echo "${GREEN}🎯 ALL VALIDATION CHECKS GREEN${RESET}"
  echo
  echo "Safe to swap the bridge default:"
  echo "  sudo sed -i 's/^OFFENSE_MODEL_NAME=.*/OFFENSE_MODEL_NAME=$MODEL/' /home/gcp/ozzu/backend/.env"
  echo "  cd /home/gcp/ozzu/backend && docker compose up -d bridge"
  echo
  echo "Then run a real engagement and confirm via 'analyze_engagement_telemetry'."
  exit 0
else
  echo "${RED}✗ $FAILED check(s) failed${RESET}"
  echo
  echo "DO NOT swap OFFENSE_MODEL_NAME. The base model ($BASELINE) remains in use."
  echo "Debug guide: SOC-TRAINING-HYPERPARAMS.md → 'If the fine-tune fails' section."
  exit 1
fi
