# Cipher Codebase Analysis

A three-layer system Cipher uses to understand the Ozzu codebase WITHOUT bullshitting
its way through partial reads.

## TL;DR — Cipher: read this first

Before answering any "read the codebase / where is X / what's duplicated / what's dead"
question, **read `.cipher/layer1/SUMMARY.md`** (and Layer 2's index when implemented).
Don't open 5 files and pretend you read everything.

## The three layers

### Layer 1 — Repo map (off-the-shelf, fast)

Runs four indexers on demand:

| Tool | Purpose | Output |
|---|---|---|
| `repomix` | Single-file dump of the whole repo for LLM context | `layer1/repomap.txt` |
| `knip` | Dead exports + orphan files (frontend + backend separately) | `layer1/knip-*.json` |
| `dependency-cruiser` | Module dependency graph + violations | `layer1/depcruise-*.json` |
| `jscpd` | Copy-paste / duplicate-block detection | `layer1/jscpd/jscpd-report.json` |

A digest of all four collapses into `layer1/SUMMARY.md` — Cipher's mandatory pre-read.

Run: `scripts/cipher-analyze.sh layer1`

### Layer 2 — Intent index (LLM, queryable) — TODO

For every source file, an LLM extracts a 2-line "what this is, why it exists, what
calls it" purpose. Stored in postgres (`code_intent` table) with embeddings in qdrant
collection `code-intent`. Cipher queries semantically: "show me every screen and its
purpose" → answers from index, not from reading 13 files.

Run: `scripts/cipher-analyze.sh layer2` (not yet implemented)

### Layer 3 — Drift / consistency checks — TODO

Semgrep + custom AST rules that catch the patterns Cipher keeps missing:

- Every screen rolls its own top bar instead of using a shared component
- Hardcoded color hex outside `design-tokens.ts`
- `pipeline.md` says X but `agent-spawner.js` does Y
- Route references that don't exist as files
- `relativeTime` / `formatDate` defined multiple times instead of imported
- Hooks imported but not exported / dead routes

Run: `scripts/cipher-analyze.sh layer3` (not yet implemented)

CI fails if drift detected. Post-commit hook keeps the indexes fresh.

## Why three layers

| Layer | Question it answers | Cost |
|---|---|---|
| 1 | "What's the SHAPE of the codebase?" (files, exports, imports, duplicates) | seconds, free |
| 2 | "What does each file MEAN? What's its purpose?" | minutes, ~$1 in LLM calls per full rebuild |
| 3 | "Where does the code DRIFT from intent / docs / design system?" | seconds, free |

Each layer builds on the last. Layer 3's rules can reference Layer 2's intent
extracts ("if this file claims to be a 'shared time-format utility' but a
duplicate of it exists elsewhere — flag").

## Why this exists

King Kazuma got tired (2026-05-17) of Cipher saying "let me read the codebase"
and then opening 5 files and bullshitting. The repo is too big to fit in any
single LLM context window — Cipher needs a real index. Real engineers use
ctags, LSP, sourcegraph, dependency graphs. So now Cipher does too.

## Running

```
# All three layers
scripts/cipher-analyze.sh all

# Just one
scripts/cipher-analyze.sh layer1
scripts/cipher-analyze.sh layer2
scripts/cipher-analyze.sh layer3
```

First run does `npm install` in `.cipher/tools/`. Subsequent runs are fast.

## Where outputs live

```
.cipher/
  README.md           ← you are here
  layer1/
    SUMMARY.md        ← Cipher's pre-read digest
    repomap.txt       ← whole-repo dump
    knip-*.json       ← dead exports
    depcruise-*.json  ← import graph
    jscpd/            ← duplicate blocks
  layer2/             ← intent index (TODO)
  layer3/             ← drift findings (TODO)
  tools/              ← package.json + configs + node_modules (gitignored)
  bin/                ← helpers (summarizers, query CLIs)
```
