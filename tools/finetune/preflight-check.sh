#!/usr/bin/env bash
# preflight-check.sh
#
# Pre-training sanity sweep. Run this before launching run-finetune.sh
# to catch every cheap pre-launch failure mode. Exit 0 = safe to spend
# $30-40 on the actual training; Exit 1 = fix something first.
#
# Usage:
#   bash /home/gcp/ozzu/tools/finetune/preflight-check.sh
#   bash /home/gcp/ozzu/tools/finetune/preflight-check.sh --dataset-dir /custom/path

set -uo pipefail

GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

DATASET_DIR="/home/gcp/ozzu/private/finetune/dataset-v1.3"
MIN_TOOL_CALL_PCT=10
TARGET_SLUG="gpu-mi300x1-192gb"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dataset-dir) DATASET_DIR="$2"; shift 2 ;;
    --min-tool-call) MIN_TOOL_CALL_PCT="$2"; shift 2 ;;
    -h|--help) echo "Usage: $0 [--dataset-dir PATH] [--min-tool-call N]"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

section() { echo; echo "${BOLD}═══ $1 ═══${RESET}"; }
pass() { echo "${GREEN}✓ PASS${RESET}  $*"; }
warn() { echo "${YELLOW}~ WARN${RESET}  $*"; }
fail() { echo "${RED}✗ FAIL${RESET}  $*"; FAILED=$((FAILED + 1)); }

echo "${BOLD}Pre-training preflight check${RESET}"
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Dataset: $DATASET_DIR"

# ─────────────────────────── 1. dataset files ───────────────────────────
section "1. Dataset files"
if [[ ! -d "$DATASET_DIR" ]]; then
  fail "dataset dir not found: $DATASET_DIR"
  exit 1
fi
for f in train.jsonl eval.jsonl wrn.jsonl glaive.jsonl fenrir.jsonl general.jsonl soc-synthetic.jsonl; do
  if [[ -s "$DATASET_DIR/$f" ]]; then
    SIZE=$(du -h "$DATASET_DIR/$f" | cut -f1)
    LINES=$(wc -l < "$DATASET_DIR/$f")
    pass "$f ($LINES lines, $SIZE)"
  else
    fail "$f missing or empty"
  fi
done

# ─────────────────────────── 2. corpus distribution ───────────────────────────
section "2. Corpus distribution + tool_call ratio"
python3 << PY
import json
counts = {}; total = 0; tc = 0
for line in open("$DATASET_DIR/train.jsonl"):
    try: d = json.loads(line)
    except: continue
    if d.get("_meta"): continue
    total += 1
    counts[d.get("source", "?")] = counts.get(d.get("source", "?"), 0) + 1
    if any("<tool_call>" in (m.get("content") or "") for m in d["messages"]):
        tc += 1
print(f"  total train rows: {total}")
for s, n in sorted(counts.items(), key=lambda x: -x[1]):
    print(f"    {s:<32} {n:>5} ({100*n/total:.1f}%)")
print(f"  tool_call rows: {tc} ({100*tc/total:.1f}%)")
exit(0 if 100*tc/total >= $MIN_TOOL_CALL_PCT else 1)
PY
if [[ $? -eq 0 ]]; then
  pass "tool_call ratio above ${MIN_TOOL_CALL_PCT}% floor"
else
  fail "tool_call ratio below ${MIN_TOOL_CALL_PCT}% — model risks losing function-calling ability"
fi

# ─────────────────────────── 3. tokenization sanity ───────────────────────────
section "3. Tokenization (Qwen3-32B, max_seq=4096)"
if [[ -d /tmp/finetune-venv ]]; then
  source /tmp/finetune-venv/bin/activate
  # unquoted heredoc so $DATASET_DIR expands
  python3 << PY
import json, sys
from transformers import AutoTokenizer
try:
    tok = AutoTokenizer.from_pretrained("Qwen/Qwen3-32B")
except Exception as e:
    print(f"  WARN: could not load tokenizer ({e}); skipping")
    sys.exit(0)
MAX_SEQ = 4096
n = 0; truncated = 0
for line in open("$DATASET_DIR/train.jsonl"):
    try: d = json.loads(line)
    except: continue
    if d.get("_meta"): continue
    n += 1
    try:
        out = tok.apply_chat_template(d["messages"], tokenize=True, add_generation_prompt=False)
        tlen = len(out["input_ids"])
        if tlen > MAX_SEQ: truncated += 1
    except Exception:
        continue
pct = 100*truncated/max(n,1)
print(f"  rows tokenized: {n}")
print(f"  rows exceeding {MAX_SEQ} tokens: {truncated} ({pct:.3f}%)")
# Threshold: <0.1% is negligible; >0.1% worth warning about
sys.exit(0 if pct < 0.1 else 1)
PY
  if [[ $? -eq 0 ]]; then
    pass "truncation rate below 0.1% — negligible"
  else
    warn "truncation rate ≥0.1% — consider raising max_seq or filtering long rows"
  fi
else
  warn "/tmp/finetune-venv not found — skipping tokenization check (run build-wrn.py first)"
fi

# ─────────────────────────── 4. training scripts ───────────────────────────
section "4. Training scripts"
for s in run-finetune.sh pull-adapter.sh post-train-validate.sh do-droplet/do-gpu.js do-droplet/bootstrap.sh do-droplet/train.py; do
  if [[ -f "$ROOT/finetune/$s" ]]; then
    if [[ "$s" == *.py ]]; then
      if python3 -m py_compile "$ROOT/finetune/$s" 2>/dev/null; then pass "$s (py syntax OK)"
      else fail "$s — python syntax error"; fi
    elif [[ "$s" == *.sh ]]; then
      if bash -n "$ROOT/finetune/$s"; then pass "$s (bash syntax OK)"
      else fail "$s — bash syntax error"; fi
    elif [[ "$s" == *.js ]]; then
      if node --check "$ROOT/finetune/$s" 2>/dev/null; then pass "$s (js syntax OK)"
      else fail "$s — js syntax error"; fi
    fi
  else
    fail "$s NOT FOUND"
  fi
done

# ─────────────────────────── 5. DO credentials ───────────────────────────
section "5. DO credentials + SSH key"
if [[ -f /root/.config/digitalocean/access_token ]]; then
  TOK=$(sudo cat /root/.config/digitalocean/access_token 2>/dev/null)
  if [[ ${#TOK} -gt 50 ]]; then
    pass "DO token present (length ${#TOK})"
    KEY_COUNT=$(curl -sH "Authorization: Bearer $TOK" "https://api.digitalocean.com/v2/account/keys" \
      | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('ssh_keys', [])))" 2>/dev/null || echo "0")
    if [[ "$KEY_COUNT" -gt 0 ]]; then
      pass "DO account has $KEY_COUNT SSH key(s) registered"
    else
      fail "DO account has 0 SSH keys — need at least one for droplet auth"
    fi
  else
    fail "DO token file exists but content looks truncated"
  fi
else
  fail "DO token missing at /root/.config/digitalocean/access_token"
fi

# ─────────────────────────── 6. GPU access status ───────────────────────────
section "6. GPU droplet access"
if [[ -n "${TOK:-}" ]]; then
  REGIONS=$(curl -sH "Authorization: Bearer $TOK" "https://api.digitalocean.com/v2/sizes?per_page=200" \
    | python3 -c "
import json,sys
d = json.load(sys.stdin)
for s in d.get('sizes', []):
    if s.get('slug') == '$TARGET_SLUG':
        print(','.join(s.get('regions') or [])); break" 2>/dev/null)
  if [[ -n "$REGIONS" ]]; then
    pass "$TARGET_SLUG AVAILABLE in regions: $REGIONS — READY TO LAUNCH"
  else
    warn "$TARGET_SLUG has no regions yet — DO GPU access pending. Poller at /tmp/gpu-poll.log."
  fi
else
  warn "skipped GPU check (no token)"
fi

# ─────────────────────────── summary ───────────────────────────
echo
echo "═══════════════════════════════════════════════════════════════════"
if [[ "$FAILED" -eq 0 ]]; then
  echo "${GREEN}🎯 PREFLIGHT PASSED${RESET} — all systems ready (training launches when DO GPU access lands)"
  exit 0
else
  echo "${RED}✗ $FAILED check(s) failed${RESET} — fix before launching training"
  exit 1
fi
