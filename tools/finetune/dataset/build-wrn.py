#!/usr/bin/env python3
"""
build-wrn.py — Step 9.1 of OFFENSE-FINETUNE-DESIGN.md (dir_1780594820417)

Download the WhiteRabbitNeo HuggingFace dataset(s), validate the
instruction/response format, and emit cleaned JSONL ready for the
xOffense-style Qwen3-32B LoRA fine-tune.

Output JSONL schema (one example per line):
  { "messages": [
      {"role":"system", "content":"..."},  # optional
      {"role":"user",   "content":"..."},
      {"role":"assistant","content":"..."}
    ],
    "source": "whiterabbitneo",
    "chapter": "WRN-Chapter-1",
    "id": "<hf row idx>"
  }

Usage:
  pip install --user datasets
  python3 build-wrn.py --out /tmp/finetune/wrn.jsonl                 # default chapters
  python3 build-wrn.py --out /tmp/finetune/wrn.jsonl --chapters WRN-Chapter-2
  python3 build-wrn.py --out /tmp/finetune/wrn.jsonl --max-rows 1000 # quick test

The script tries each chapter listed; missing/private ones are skipped with a
warning. No fatal errors when one chapter is unavailable — partial output is
better than no output.
"""
import argparse
import json
import os
import sys
from pathlib import Path

# Default WhiteRabbitNeo HF dataset list. PJMixers/WhiteRabbitNeo is the
# UNGATED public mirror — original WhiteRabbitNeo/WRN-Chapter-* require auth
# + access approval and silently break the pipeline (discovered 2026-06-04).
# Schema is essentially identical: {subject, system, instruction, response}
# which the normalize_example function already handles via the
# instruction/response generic mapper.
DEFAULT_CHAPTERS = [
    "PJMixers/WhiteRabbitNeo",                 # ungated mirror, 18,897 rows — try first
    # Gated originals kept as a fallback for users with HF_TOKEN + access:
    "WhiteRabbitNeo/WRN-Chapter-1",
    "WhiteRabbitNeo/WRN-Chapter-2",
]


def normalize_example(row, source, chapter, idx):
    """
    Map a single HF row into our unified chat JSONL schema.

    WhiteRabbitNeo's row shape has varied across chapters. The columns we've
    seen in the wild include `instruction`, `output`, `input`, `text`, plus
    sometimes a `system` prompt or `messages`-style list already. We probe
    several shapes and emit the unified format.
    """
    # Already in our schema — pass through (validate later).
    if isinstance(row.get("messages"), list) and len(row["messages"]) >= 2:
        return {
            "messages": row["messages"],
            "source": source,
            "chapter": chapter,
            "id": str(idx),
        }

    # Common Alpaca-style: instruction + (optional) input + output
    instr = row.get("instruction") or row.get("prompt") or row.get("question") or row.get("query")
    out   = row.get("output") or row.get("response") or row.get("answer") or row.get("completion")
    extra_input = row.get("input")
    sys_prompt  = row.get("system")

    if instr and out:
        messages = []
        if sys_prompt:
            messages.append({"role": "system", "content": str(sys_prompt)})
        user_content = str(instr)
        if extra_input:
            user_content += "\n\n" + str(extra_input)
        messages.append({"role": "user",      "content": user_content})
        messages.append({"role": "assistant", "content": str(out)})
        return {
            "messages": messages,
            "source": source,
            "chapter": chapter,
            "id": str(idx),
        }

    # Plain `text` field — split heuristically. Skip if we can't structure it.
    return None


def is_valid_example(ex):
    if not isinstance(ex, dict):
        return False
    msgs = ex.get("messages", [])
    if not isinstance(msgs, list) or len(msgs) < 2:
        return False
    has_user = any(isinstance(m, dict) and m.get("role") == "user" and (m.get("content") or "").strip() for m in msgs)
    has_asst = any(isinstance(m, dict) and m.get("role") == "assistant" and (m.get("content") or "").strip() for m in msgs)
    return has_user and has_asst


def write_metadata_header(f, source, chapters_used, counts):
    f.write(json.dumps({
        "_meta": True,
        "source": source,
        "chapters_used": chapters_used,
        "counts": counts,
        "tool_version": "build-wrn.py v1",
    }) + "\n")


def main():
    ap = argparse.ArgumentParser(description="Download + format WhiteRabbitNeo HF dataset(s) to chat JSONL.")
    ap.add_argument("--out", required=True, help="Output JSONL path.")
    ap.add_argument("--chapters", nargs="+", default=DEFAULT_CHAPTERS,
                    help="HF dataset names. Defaults to the WhiteRabbitNeo chapters list.")
    ap.add_argument("--max-rows", type=int, default=None,
                    help="Stop after this many TOTAL examples (useful for quick tests).")
    ap.add_argument("--hf-token", default=os.environ.get("HF_TOKEN"),
                    help="HuggingFace token (env HF_TOKEN if not passed). Public chapters don't need one.")
    args = ap.parse_args()

    try:
        from datasets import load_dataset  # noqa: E402  (deferred — datasets is a heavy import)
    except ImportError:
        print("[build-wrn] FATAL: `datasets` package not installed. Run: pip install --user datasets",
              file=sys.stderr)
        sys.exit(2)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    total_kept = 0
    total_seen = 0
    chapters_used = []
    counts = {}

    # Write to a temp file first; only rename to final on success so a partial
    # run never overwrites a good previous file.
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        # Header metadata gets filled at the end; placeholder for now.
        header_pos = f.tell()
        f.write("\n")  # 1 byte reserved (we'll rewrite this after)

        for chapter in args.chapters:
            if args.max_rows and total_kept >= args.max_rows:
                break
            try:
                print(f"[build-wrn] loading {chapter} from HF ...", file=sys.stderr)
                ds = load_dataset(chapter, split="train", token=args.hf_token)
            except Exception as e:
                print(f"[build-wrn] WARN: failed to load {chapter}: {e}", file=sys.stderr)
                continue

            chapters_used.append(chapter)
            kept_here = 0
            seen_here = 0
            for idx, row in enumerate(ds):
                if args.max_rows and total_kept >= args.max_rows:
                    break
                seen_here += 1
                total_seen += 1
                ex = normalize_example(row, source="whiterabbitneo", chapter=chapter, idx=idx)
                if ex is None or not is_valid_example(ex):
                    continue
                f.write(json.dumps(ex, ensure_ascii=False) + "\n")
                kept_here += 1
                total_kept += 1
            counts[chapter] = {"seen": seen_here, "kept": kept_here}
            print(f"[build-wrn] {chapter}: seen={seen_here} kept={kept_here}", file=sys.stderr)

    if total_kept == 0:
        print("[build-wrn] FATAL: no examples extracted from any chapter", file=sys.stderr)
        try:
            tmp_path.unlink()
        except Exception:
            pass
        sys.exit(1)

    # Rewrite header line with real counts (re-open + prepend pattern via in-place rewrite).
    # Simpler approach: rewrite the file with header at top.
    with tmp_path.open("r", encoding="utf-8") as src:
        body_lines = src.readlines()[1:]  # drop the placeholder first line
    with tmp_path.open("w", encoding="utf-8") as dst:
        write_metadata_header(dst, "whiterabbitneo", chapters_used, counts)
        dst.writelines(body_lines)

    tmp_path.rename(out_path)
    print(
        f"[build-wrn] DONE — kept {total_kept}/{total_seen} examples across "
        f"{len(chapters_used)} chapter(s) -> {out_path}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
