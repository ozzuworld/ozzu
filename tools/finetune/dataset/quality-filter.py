#!/usr/bin/env python3
"""
quality-filter.py — filter low-quality rows from per-corpus JSONL.

Catches:
  - INLINE REFUSALS — assistant turn contains "I will not provide" /
    "that would be unethical" / etc anywhere in content. These teach
    the model to refuse mid-response which is bad for autonomous SOC.
  - FULL-CONVERSATION DUPLICATES — identical system+user+assistant
    triples (computed as md5 of concatenated content). Different from
    user-prompt-only dups (those are usually legit different
    conversations with different tool sets).

Does NOT filter:
  - Safety disclaimers / hedging — too prevalent to drop without losing
    most of the corpus; the content itself is still substantive
  - Markup artifacts — too few to matter (~1.7%)
  - Polite "I can't help with that, but I can do X" responses in Glaive
    — those are GOOD training (teaches the model to redirect within
    available tools)

Usage:
  python3 quality-filter.py --in /home/gcp/ozzu/private/finetune/dataset-v1.1/wrn.jsonl \\
                            --out /home/gcp/ozzu/private/finetune/dataset-v1.2/wrn.jsonl
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

# HARMFUL refusal patterns — explicit refusals to provide content where the
# model SHOULD have provided it. These teach the model to refuse mid-response.
#
# NOT INCLUDED:
#   - "I'm sorry but I don't have the capability to..." — polite redirect to
#     available tools. GOOD training (teaches scope awareness). Common in
#     Glaive when user asks for something outside the function set.
#   - "Please note that..." / disclaimers / safety preambles — too prevalent
#     in WRN; dropping them would lose 1/3 of the training set
HARMFUL_REFUSAL_PATTERNS = [
    r"\bi (?:cannot|can'?t|won't|will not) (?:provide|create|write|help|assist|condone|engage|develop|generate)",
    r"\b(?:i must|let me) (?:decline|refuse|refrain) (?:from |to )",
    r"\bthat would be (?:unethical|illegal|harmful)",
    r"\binstead,? i'?ll (?:not |refrain from )",
    r"\bi will not provide (?:any |the )?(?:actual |working |real |malicious )",
]
REFUSAL_RE = re.compile("|".join(HARMFUL_REFUSAL_PATTERNS), re.IGNORECASE)


def detect_refusal(messages):
    """Check if any assistant turn contains a refusal pattern."""
    for m in messages:
        if m.get("role") == "assistant":
            c = m.get("content") or ""
            if REFUSAL_RE.search(c):
                return True
    return False


def full_convo_hash(messages):
    """Hash the entire concatenated message list for dedup."""
    text = "|".join(
        f"{m.get('role','?')}:{(m.get('content') or '')[:500]}"
        for m in messages
    )
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    in_path = Path(args.in_path)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    seen_hashes = set()
    n_total = 0
    n_refusal = 0
    n_dup = 0
    n_kept = 0

    with in_path.open() as fin, out_path.open("w") as fout:
        for line in fin:
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Pass _meta headers through unchanged
            if d.get("_meta"):
                fout.write(line)
                continue
            n_total += 1
            msgs = d.get("messages") or []
            if detect_refusal(msgs):
                n_refusal += 1
                continue
            h = full_convo_hash(msgs)
            if h in seen_hashes:
                n_dup += 1
                continue
            seen_hashes.add(h)
            fout.write(line)
            n_kept += 1

    pct_drop = 100 * (n_refusal + n_dup) / max(n_total, 1)
    print(f"  {in_path.name}: in={n_total} kept={n_kept} dropped={n_refusal + n_dup} ({pct_drop:.2f}%)", file=sys.stderr)
    print(f"    refusals dropped: {n_refusal}", file=sys.stderr)
    print(f"    full-conv dups dropped: {n_dup}", file=sys.stderr)


if __name__ == "__main__":
    main()
