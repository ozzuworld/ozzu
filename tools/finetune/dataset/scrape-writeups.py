#!/usr/bin/env python3
"""
scrape-writeups.py — Step 9.1 STUB (dir_1780594820417)

This script will scrape HTB / TryHackMe / VulnHub writeups (0xdf, IppSec
transcripts, community Medium articles), inject `<think>...</think>` CoT
traces, and emit our standard chat JSONL.

Implementation deferred to a future directive. The scraping logic is
non-trivial (per-source HTML parsing, rate-limit, CoT injection prompt
templates) and isn't on the critical path — the WhiteRabbitNeo corpus
alone is enough to start training and validate the pipeline. Add writeups
as a quality booster once the end-to-end loop is proven.

When implementing:
  - Polite rate-limit (1 request / 3s per host).
  - Respect robots.txt.
  - Archive sources only — no live scraping of paid content.
  - Cache raw HTML locally so the scrape is reproducible (`/home/gcp/ozzu/private/finetune/writeup-cache/`).
  - One JSONL output, same `{"messages": [...]}` schema as build-wrn.py.
"""
import sys

print("[scrape-writeups] STUB — not yet implemented. See OFFENSE-FINETUNE-DESIGN.md §3b.",
      file=sys.stderr)
print("[scrape-writeups] Tracked in OFFENSE-FINETUNE-DESIGN.md; future directive will land this.",
      file=sys.stderr)
sys.exit(2)
