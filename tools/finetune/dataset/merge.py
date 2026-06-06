#!/usr/bin/env python3
"""
merge.py — Step 9.1 of OFFENSE-FINETUNE-DESIGN.md (dir_1780594820417)

Combine N input corpus JSONLs (output of build-wrn.py, scrape-writeups.py,
export-our-transcripts.py) into a single shuffled training file plus an
optional eval split.

Validates each row matches the {"messages": [...]} chat schema. Drops the
provenance `_meta` header lines (those are per-corpus metadata, not training
examples). Deterministic shuffle when --seed is provided.

Usage:
  python3 merge.py \
    --inputs /tmp/finetune/wrn.jsonl /tmp/finetune/writeups.jsonl /tmp/finetune/agent.jsonl \
    --out    /tmp/finetune/train.jsonl \
    --eval-out /tmp/finetune/eval.jsonl \
    --eval-frac 0.05 \
    --seed 42
"""
import argparse
import json
import random
import sys
from pathlib import Path


def is_valid_chat(row):
    """Return True if row is a valid {messages: [...]} chat example."""
    if not isinstance(row, dict):
        return False
    msgs = row.get("messages")
    if not isinstance(msgs, list) or len(msgs) < 2:
        return False
    if not any(isinstance(m, dict) and m.get("role") == "user" and m.get("content") for m in msgs):
        return False
    if not any(isinstance(m, dict) and m.get("role") == "assistant" and m.get("content") for m in msgs):
        return False
    return True


def is_metadata(row):
    """The header line from each corpus builder — drop these."""
    return isinstance(row, dict) and "_meta" in row


def load_corpus(path):
    """Read a JSONL file. Skip blank lines + metadata headers. Drop malformed."""
    p = Path(path)
    if not p.exists():
        print(f"[merge] WARN: input not found: {path}", file=sys.stderr)
        return []
    kept = []
    seen = 0
    dropped_metadata = 0
    dropped_invalid = 0
    for line in p.open("r", encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        seen += 1
        try:
            row = json.loads(line)
        except Exception:
            dropped_invalid += 1
            continue
        if is_metadata(row):
            dropped_metadata += 1
            continue
        if not is_valid_chat(row):
            dropped_invalid += 1
            continue
        kept.append(row)
    print(
        f"[merge] {path}: seen={seen} kept={len(kept)} "
        f"meta_dropped={dropped_metadata} invalid_dropped={dropped_invalid}",
        file=sys.stderr,
    )
    return kept


def main():
    ap = argparse.ArgumentParser(description="Merge fine-tune corpora into train+eval JSONLs.")
    ap.add_argument("--inputs", nargs="+", required=True, help="Input JSONL paths.")
    ap.add_argument("--out", required=True, help="Output training JSONL path.")
    ap.add_argument("--eval-out", default=None, help="Output eval JSONL path (optional).")
    ap.add_argument("--eval-frac", type=float, default=0.05,
                    help="Fraction held out for eval (default 0.05). Only used if --eval-out set.")
    ap.add_argument("--seed", type=int, default=42, help="Shuffle seed for reproducibility.")
    ap.add_argument("--drop-negative", action="store_true",
                    help="Drop rows whose quality.polarity == 'negative' (set by export-our-transcripts.py "
                         "from model_behavior_notes). Default off, back-compat.")
    args = ap.parse_args()

    all_rows = []
    for path in args.inputs:
        all_rows.extend(load_corpus(path))

    if not all_rows:
        print("[merge] FATAL: no valid rows across all inputs", file=sys.stderr)
        sys.exit(1)

    # dir_1780764144630 — filter by quality.polarity before split so train and
    # eval stay reproducible (deterministic given --seed) regardless of mode.
    dropped_quality = 0
    if args.drop_negative:
        filtered = []
        for r in all_rows:
            q = r.get("quality") if isinstance(r, dict) else None
            if isinstance(q, dict) and q.get("polarity") == "negative":
                dropped_quality += 1
                continue
            filtered.append(r)
        all_rows = filtered

    rng = random.Random(args.seed)
    rng.shuffle(all_rows)

    n_total = len(all_rows)
    if args.eval_out and args.eval_frac > 0:
        n_eval = max(1, int(n_total * args.eval_frac))
        eval_rows = all_rows[:n_eval]
        train_rows = all_rows[n_eval:]
    else:
        eval_rows = []
        train_rows = all_rows

    train_path = Path(args.out)
    train_path.parent.mkdir(parents=True, exist_ok=True)
    with train_path.open("w", encoding="utf-8") as f:
        for r in train_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    drop_summary = f" dropped_negative={dropped_quality}" if args.drop_negative else ""
    if args.eval_out and eval_rows:
        eval_path = Path(args.eval_out)
        eval_path.parent.mkdir(parents=True, exist_ok=True)
        with eval_path.open("w", encoding="utf-8") as f:
            for r in eval_rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(
            f"[merge] DONE — train={len(train_rows)} eval={len(eval_rows)}{drop_summary} "
            f"-> {train_path} + {eval_path}",
            file=sys.stderr,
        )
    else:
        print(f"[merge] DONE — train={len(train_rows)}{drop_summary} -> {train_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
