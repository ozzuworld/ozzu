#!/usr/bin/env python3
"""
build-v11-mix.py — build the v1.1 multi-corpus training mix.

Per SOC-FIELD-SURVEY-2026-06-04.md, single-corpus WhiteRabbitNeo training
risks catastrophic forgetting of tool-calling ability (HackSynth + Goedel-
Prover-V2 evidence). v1.1 mixes WRN with Glaive (tool-use anchor) +
Fenrir (defense diversity) + Dolly (general anchor) per documented
"replay fraction" technique (arXiv 2407.21783).

Target ratios:
  70% PJMixers/WhiteRabbitNeo  — offensive domain knowledge
  15% Glaive Function Calling v2 — tool-calling preservation
  10% Fenrir-v2.1               — defense lean
   5% databricks-dolly-15k      — general anchoring

Usage:
  python3 build-v11-mix.py --out-dir /home/gcp/ozzu/private/finetune/dataset-v1.1/

Requires: pip install datasets huggingface_hub  (in a venv per PEP 668)
"""
import argparse
import json
import pathlib
import random
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent

TARGETS = {
    "wrn":     14000,  # 70%
    "glaive":   3000,  # 15%
    "fenrir":   2000,  # 10%
    "general":  1000,  #  5%
}

# ─────────────────────────── Glaive parser ───────────────────────────

def parse_glaive_chat(chat: str):
    """Convert Glaive's chat string into messages. Each ROLE: line is a
    separate turn. FUNCTION CALL → assistant <tool_call> wrap.
    FUNCTION RESPONSE → tool role."""
    if not chat:
        return []
    msgs = []
    turns = [t.strip() for t in chat.split("\n\n\n") if t.strip()]
    for t in turns:
        m = re.match(r"^(USER|ASSISTANT|FUNCTION CALL|FUNCTION RESPONSE|A)\s*:\s*(.*)", t, re.DOTALL)
        if not m:
            continue
        role_raw, content = m.group(1), m.group(2).strip()
        if role_raw == "USER":
            msgs.append({"role": "user", "content": content})
        elif role_raw in ("ASSISTANT", "A"):
            msgs.append({"role": "assistant", "content": content})
        elif role_raw == "FUNCTION CALL":
            msgs.append({"role": "assistant", "content": f"<tool_call>{content}</tool_call>"})
        elif role_raw == "FUNCTION RESPONSE":
            msgs.append({"role": "tool", "content": content})
    return msgs


def build_glaive(out_path, n_target):
    from datasets import load_dataset
    print("=== Glaive Function Calling v2 ===")
    ds = load_dataset("glaiveai/glaive-function-calling-v2", split="train")
    print(f"  loaded {len(ds)} rows")
    indices = list(range(len(ds)))
    random.shuffle(indices)
    indices = indices[:n_target + 500]   # over-sample because some parse-fail

    kept, skipped = 0, 0
    with out_path.open("w") as f:
        f.write(json.dumps({"_meta": True, "source": "glaiveai/glaive-function-calling-v2"}) + "\n")
        for idx in indices:
            if kept >= n_target: break
            row = ds[idx]
            msgs = []
            sys_text = (row.get("system") or "").lstrip()
            if sys_text.upper().startswith("SYSTEM:"):
                sys_text = sys_text[7:].lstrip()
            if sys_text:
                msgs.append({"role": "system", "content": sys_text})
            chat_msgs = parse_glaive_chat(row.get("chat") or "")
            if len(chat_msgs) < 2:
                skipped += 1
                continue
            msgs.extend(chat_msgs)
            f.write(json.dumps({"messages": msgs, "source": "glaiveai-function-calling-v2", "id": f"glaive-{idx}"}) + "\n")
            kept += 1
    print(f"  kept={kept} skipped={skipped} → {out_path}")
    return kept


def build_fenrir(out_path, n_target):
    from datasets import load_dataset
    print("=== Fenrir v2.1 ===")
    ds = load_dataset("AlicanKiraz0/Cybersecurity-Dataset-Fenrir-v2.1", split="train")
    print(f"  loaded {len(ds)} rows")
    indices = list(range(len(ds)))
    random.shuffle(indices)
    indices = indices[:n_target]
    kept = 0
    with out_path.open("w") as f:
        f.write(json.dumps({"_meta": True, "source": "AlicanKiraz0/Fenrir-v2.1"}) + "\n")
        for idx in indices:
            row = ds[idx]
            sys_text = (row.get("system") or "").strip()
            user_text = (row.get("user") or "").strip()
            asst_text = (row.get("assistant") or "").strip()
            if not user_text or not asst_text:
                continue
            msgs = []
            if sys_text: msgs.append({"role": "system", "content": sys_text})
            msgs.append({"role": "user",      "content": user_text})
            msgs.append({"role": "assistant", "content": asst_text})
            f.write(json.dumps({"messages": msgs, "source": "fenrir-v2.1", "id": f"fenrir-{idx}"}) + "\n")
            kept += 1
    print(f"  kept={kept} → {out_path}")
    return kept


def build_general(out_path, n_target):
    from datasets import load_dataset
    print("=== Dolly (general anchor) ===")
    ds = load_dataset("databricks/databricks-dolly-15k", split="train")
    print(f"  loaded {len(ds)} rows")
    indices = list(range(len(ds)))
    random.shuffle(indices)
    indices = indices[:n_target]
    kept = 0
    with out_path.open("w") as f:
        f.write(json.dumps({"_meta": True, "source": "databricks-dolly-15k"}) + "\n")
        for idx in indices:
            row = ds[idx]
            inst = (row.get("instruction") or "").strip()
            ctx = (row.get("context") or "").strip()
            resp = (row.get("response") or "").strip()
            if not inst or not resp: continue
            user = f"{inst}\n\n{ctx}".strip() if ctx else inst
            f.write(json.dumps({
                "messages": [
                    {"role": "user",      "content": user},
                    {"role": "assistant", "content": resp},
                ],
                "source": "databricks-dolly-15k",
                "id": f"dolly-{idx}",
            }) + "\n")
            kept += 1
    print(f"  kept={kept} → {out_path}")
    return kept


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True, help="Where to write all corpora + the final train/eval split")
    ap.add_argument("--wrn-from", default="/home/gcp/ozzu/private/finetune/dataset-v1/wrn.jsonl",
                    help="Existing WRN JSONL to downsample (skip the HF re-download)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--eval-frac", type=float, default=0.05)
    args = ap.parse_args()

    random.seed(args.seed)
    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ─── A) Glaive — tool-use anchor ───
    build_glaive(out_dir / "glaive.jsonl", TARGETS["glaive"])
    # ─── B) Fenrir — defense lean ───
    build_fenrir(out_dir / "fenrir.jsonl", TARGETS["fenrir"])
    # ─── C) Dolly — general anchor ───
    build_general(out_dir / "general.jsonl", TARGETS["general"])
    # ─── D) WRN — copy + downsample from existing v1 dataset ───
    print("=== WRN (downsampled) ===")
    wrn_src = pathlib.Path(args.wrn_from)
    if not wrn_src.exists():
        print(f"  WARN: {wrn_src} not found — you'll need to run build-wrn.py-equivalent first", file=sys.stderr)
        sys.exit(2)
    wrn_rows = []
    for line in wrn_src.open():
        try:
            d = json.loads(line)
        except: continue
        if d.get("_meta"): continue
        wrn_rows.append(d)
    print(f"  source has {len(wrn_rows)} rows")
    random.shuffle(wrn_rows)
    wrn_rows = wrn_rows[:TARGETS["wrn"]]
    with (out_dir / "wrn.jsonl").open("w") as f:
        f.write(json.dumps({"_meta": True, "source": "PJMixers-whiterabbitneo", "downsampled_to": len(wrn_rows)}) + "\n")
        for r in wrn_rows:
            f.write(json.dumps(r) + "\n")
    print(f"  kept={len(wrn_rows)} → {out_dir/'wrn.jsonl'}")

    # ─── merge ───
    print()
    print("=== merging into train + eval ===")
    import subprocess
    merge = pathlib.Path("/home/gcp/ozzu/tools/finetune/dataset/merge.py")
    subprocess.check_call([
        "python3", str(merge),
        "--inputs",
            str(out_dir / "wrn.jsonl"),
            str(out_dir / "glaive.jsonl"),
            str(out_dir / "fenrir.jsonl"),
            str(out_dir / "general.jsonl"),
        "--out",      str(out_dir / "train.jsonl"),
        "--eval-out", str(out_dir / "eval.jsonl"),
        "--eval-frac", str(args.eval_frac),
        "--seed",      str(args.seed),
    ])

    # ─── summary ───
    print()
    print("=== final corpus distribution ===")
    from collections import Counter
    c = Counter()
    for line in (out_dir / "train.jsonl").open():
        try: d = json.loads(line)
        except: continue
        if d.get("_meta"): continue
        c[d.get("source", "?")] += 1
    total = sum(c.values())
    print(f"  total train rows: {total}")
    for src, n in c.most_common():
        print(f"    {src:<32}: {n:>6} ({100*n/total:.1f}%)")


if __name__ == "__main__":
    main()
