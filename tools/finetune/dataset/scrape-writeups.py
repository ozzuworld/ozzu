#!/usr/bin/env python3
"""
scrape-writeups.py — Step 9.7 of OFFENSE-FINETUNE-DESIGN.md (dir_1780595993200)

Replace the Step 9.1 stub. Convert 0xdf's HackTheBox writeups (markdown
files from his blog repo) into chat-format JSONL examples for the
xOffense-style Qwen3-32B LoRA fine-tune.

Approach: NO live scraping. Operator clones the public repo locally:
  git clone https://gitlab.com/0xdf/ctfwriteups.git /tmp/0xdf-writeups
then this script walks the .md files and parses them. Reproducible,
respects 0xdf's hosting, no rate-limit concerns.

Output one JSONL row per writeup:
  {
    "messages": [
      {"role": "user",      "content": "Walk me through HackTheBox machine <name>."},
      {"role": "assistant", "content": "<rendered writeup with code blocks preserved>"}
    ],
    "source": "0xdf-htb-writeups",
    "machine": "<name>",
    "license": "CC-BY-SA-4.0 0xdf"
  }

v1 keeps each writeup as a SINGLE assistant turn — the markdown is
already structured, and code blocks are preserved verbatim (which is
exactly the tool-use signal we want). A future v2 could split each
section into a separate iter (planning → tool → output → planning).

Usage:
  git clone https://gitlab.com/0xdf/ctfwriteups.git /tmp/0xdf-writeups
  python3 scrape-writeups.py --repo /tmp/0xdf-writeups --out /tmp/finetune/writeups.jsonl
  python3 scrape-writeups.py --repo /tmp/0xdf-writeups --out /tmp/finetune/writeups.jsonl --max 10  # quick test
"""
import argparse
import json
import re
import sys
from pathlib import Path

# Heuristics for what looks like an HTB writeup file in 0xdf's repo.
WRITEUP_GLOB = "**/*.md"
HTB_PATH_HINTS = (
    "htb",         # 0xdf organizes by platform; HTB writeups live under ./htb/
    "hackthebox",
)

# Files that are clearly NOT writeups
EXCLUDE_NAMES = {
    "README.md",
    "readme.md",
    "CONTRIBUTING.md",
    "LICENSE.md",
    "_config.md",
}

# Jekyll front-matter delimiter
FRONT_MATTER_RE = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)

# Extract a machine name from a path like ./htb/Boxes/MachineName/index.md
MACHINE_RE = re.compile(r"(?:htb|hackthebox)/(?:boxes/)?([A-Za-z0-9_-]+)", re.IGNORECASE)


def looks_like_writeup(path: Path) -> bool:
    """Quick predicate — does this .md file look like a writeup vs README?"""
    if path.name in EXCLUDE_NAMES:
        return False
    s = str(path).lower()
    if not any(hint in s for hint in HTB_PATH_HINTS):
        return False
    # Must have some real content
    try:
        size = path.stat().st_size
    except OSError:
        return False
    return size > 2000  # skip near-empty stubs


def extract_machine_name(path: Path, text: str) -> str:
    """Best-effort name extraction. Path > front-matter title > h1."""
    m = MACHINE_RE.search(str(path))
    if m:
        return m.group(1)
    # Try a Jekyll front-matter title
    fm = FRONT_MATTER_RE.match(text)
    if fm:
        fm_text = fm.group(0)
        t = re.search(r"^title:\s*['\"]?([^'\"\n]+)['\"]?", fm_text, re.MULTILINE)
        if t:
            return t.group(1).strip()
    # Fallback: first h1
    h1 = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    if h1:
        return h1.group(1).strip()
    return path.stem


def strip_front_matter(text: str) -> str:
    return FRONT_MATTER_RE.sub("", text, count=1).lstrip()


def is_valid_writeup_body(body: str) -> bool:
    """A writeup needs SOME code blocks (commands) to be useful training data."""
    code_blocks = re.findall(r"```[\s\S]*?```", body)
    # Real writeups have multiple code blocks — recon scans, exploit commands, etc.
    return len(code_blocks) >= 3 and len(body) >= 1500


def build_example(path: Path, repo_root: Path):
    """Read a markdown file → chat example. Returns None if not a valid writeup."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        print(f"[scrape] WARN: can't read {path}: {e}", file=sys.stderr)
        return None
    body = strip_front_matter(text)
    if not is_valid_writeup_body(body):
        return None
    machine = extract_machine_name(path, text)
    rel = path.relative_to(repo_root)
    return {
        "messages": [
            {"role": "user",      "content": f"Walk me through HackTheBox machine {machine}. Cover recon, foothold, and privilege escalation step-by-step. Preserve exact tool commands."},
            {"role": "assistant", "content": body.strip()},
        ],
        "source": "0xdf-htb-writeups",
        "machine": machine,
        "path": str(rel),
        "license": "CC-BY-SA-4.0 0xdf",
    }


def main():
    ap = argparse.ArgumentParser(description="Convert 0xdf's HTB writeups to chat JSONL for LoRA training.")
    ap.add_argument("--repo", required=True, help="Path to a local clone of 0xdf's writeups repo.")
    ap.add_argument("--out", required=True, help="Output JSONL path.")
    ap.add_argument("--max", type=int, default=None, help="Stop after this many examples (quick test).")
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    if not repo.is_dir():
        print(f"[scrape] FATAL: --repo not a directory: {repo}", file=sys.stderr)
        print(f"[scrape] Clone first: git clone https://gitlab.com/0xdf/ctfwriteups.git {repo}", file=sys.stderr)
        sys.exit(2)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Walk all candidate .md files
    candidates = list(repo.glob(WRITEUP_GLOB))
    print(f"[scrape] scanning {len(candidates)} .md files under {repo}", file=sys.stderr)

    kept = 0
    seen = 0
    skipped_not_writeup = 0
    skipped_invalid = 0

    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        # Header line
        f.write(json.dumps({
            "_meta": True,
            "source": "0xdf-htb-writeups",
            "repo": str(repo),
            "tool_version": "scrape-writeups.py v1",
        }) + "\n")

        for path in candidates:
            if args.max and kept >= args.max:
                break
            seen += 1
            if not looks_like_writeup(path):
                skipped_not_writeup += 1
                continue
            ex = build_example(path, repo)
            if ex is None:
                skipped_invalid += 1
                continue
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")
            kept += 1

    if kept == 0:
        print(f"[scrape] FATAL: 0 valid writeups extracted from {repo} (scanned {seen})", file=sys.stderr)
        print("[scrape] Is the repo path correct? Are writeups under ./htb/ or ./hackthebox/?", file=sys.stderr)
        try: tmp_path.unlink()
        except OSError: pass
        sys.exit(1)

    tmp_path.rename(out_path)
    print(
        f"[scrape] DONE — kept {kept} writeups (of {seen} scanned). "
        f"Skipped: {skipped_not_writeup} non-writeup, {skipped_invalid} invalid. -> {out_path}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
