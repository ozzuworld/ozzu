#!/usr/bin/env python3
"""
compare.py — Step 9.13 (dir_1780598637924)

Compare two AutoPenBench result JSONs (output of run-autopenbench.sh) and emit
a markdown delta report. Use this to score the fine-tune's gain over base.

Usage:
  python3 compare.py --base qwen3_32b_xxxx_results.json \\
                     --ft   ozzu_soc_v1_xxxx_results.json \\
                     --out  /home/gcp/ozzu/private/finetune/eval/compare.md
"""
import argparse
import json
from pathlib import Path
from collections import defaultdict


def load(path):
    return json.load(open(path))


def by_task(results):
    return {r["task"]: r for r in results}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="Baseline results JSON (base model)")
    ap.add_argument("--ft", required=True, help="Fine-tune results JSON")
    ap.add_argument("--base-label", default="base", help="Display label for the base model")
    ap.add_argument("--ft-label", default="fine-tune", help="Display label for the fine-tune")
    ap.add_argument("--out", default=None, help="Markdown output path (stdout if omitted)")
    args = ap.parse_args()

    base = by_task(load(args.base))
    ft   = by_task(load(args.ft))

    all_tasks = sorted(set(base) | set(ft))
    n_total   = len(all_tasks)
    base_succ = sum(1 for t in all_tasks if base.get(t, {}).get("success"))
    ft_succ   = sum(1 for t in all_tasks if ft.get(t, {}).get("success"))

    cats_base, cats_ft = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    for t in all_tasks:
        c = (base.get(t) or ft.get(t) or {}).get("category", "?")
        if base.get(t):
            cats_base[c][0] += 1
            if base[t]["success"]: cats_base[c][1] += 1
        if ft.get(t):
            cats_ft[c][0] += 1
            if ft[t]["success"]: cats_ft[c][1] += 1

    out = []
    out.append(f"# AutoPenBench comparison — {args.base_label} vs {args.ft_label}")
    out.append("")
    out.append(f"**Total tasks:** {n_total}")
    base_rate = 100 * base_succ / max(n_total, 1)
    ft_rate   = 100 * ft_succ   / max(n_total, 1)
    delta     = ft_rate - base_rate
    out.append(f"**{args.base_label}:** {base_succ}/{n_total} = **{base_rate:.1f}%**")
    out.append(f"**{args.ft_label}:** {ft_succ}/{n_total} = **{ft_rate:.1f}%**")
    sign = "+" if delta >= 0 else ""
    out.append(f"**Δ:** {sign}{delta:.1f} percentage points")
    out.append("")

    out.append("## Per-category")
    out.append(f"| category | {args.base_label} | {args.ft_label} | Δ |")
    out.append("|---|---|---|---|")
    for c in sorted(set(cats_base) | set(cats_ft)):
        b_n, b_s = cats_base.get(c, [0, 0])
        f_n, f_s = cats_ft.get(c, [0, 0])
        b_rate = 100 * b_s / max(b_n, 1)
        f_rate = 100 * f_s / max(f_n, 1)
        d = f_rate - b_rate
        out.append(f"| {c} | {b_s}/{b_n} ({b_rate:.0f}%) | {f_s}/{f_n} ({f_rate:.0f}%) | {'+' if d>=0 else ''}{d:.1f} |")
    out.append("")

    out.append("## Per-task (only tasks where outcome changed)")
    out.append(f"| task | {args.base_label} | {args.ft_label} |")
    out.append("|---|---|---|")
    for t in all_tasks:
        b_ok = base.get(t, {}).get("success", False)
        f_ok = ft.get(t,   {}).get("success", False)
        if b_ok != f_ok:
            sym_b = "✓" if b_ok else "✗"
            sym_f = "✓" if f_ok else "✗"
            out.append(f"| {t} | {sym_b} | {sym_f} |")
    out.append("")

    out.append("## Headline")
    if delta >= 10:
        out.append(f"✓ **Fine-tune wins by {delta:.1f}pp** — exceeds the +10pp success bar in OFFENSE-FINETUNE-DESIGN.md §6.")
        out.append("Action: swap OFFENSE_MODEL_NAME=ozzu-soc-v1 in backend/.env, recreate bridge.")
    elif delta >= 0:
        out.append(f"~ Fine-tune marginally ahead ({delta:.1f}pp) — under the 10pp bar.")
        out.append("Action: investigate which tasks regressed; consider another training run with adjusted hyperparameters.")
    else:
        out.append(f"✗ **Fine-tune REGRESSED by {-delta:.1f}pp** — do NOT swap the default model.")
        out.append("Action: check training loss curves, eval-loss divergence, or dataset quality. Likely cause: tool-use degradation (need more transcripts in corpus C).")

    text = "\n".join(out)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text)
        print(f"wrote {args.out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
