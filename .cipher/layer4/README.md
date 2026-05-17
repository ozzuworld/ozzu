# Cipher Layer 4 — Intent + Principles

The structural codebase indexes (Layers 1, 2, 3) tell Cipher **what is in the code**.
Layer 4 tells Cipher **what is CORRECT for Ozzu** — the principles, intent, and reasoning that make Ozzu what it is.

When Cipher does an audit or writes new code, the path is:
1. Check `.cipher/layer4/PRINCIPLES.md` — does this proposal violate an inviolable rule?
2. Check the relevant `.cipher/layer4/intent/<domain>.md` — does this match how Ozzu does this kind of thing?
3. Check `.cipher/layer3/SUMMARY.md` — does the live code already drift from this domain's intent?

Without Layer 4, every audit is a contractor reading the code blind. With it, Cipher can say "this is wrong because Ozzu does X, not Y, because of Z."

## Files

### `PRINCIPLES.md`
**Inviolable rules.** 25 principles across 8 sections (Identity, Pipeline, Acting Safely, Reading and Acting, R&D, Security, Persistent Artifacts, Memory and Learning). These don't bend. Memory dies, code wins, principles outlast both.

### `intent/`
Per-domain WHY docs. Each one explains what a piece of Ozzu is, why it exists, what its decisions are, what it specifically is NOT.

| File | Domain |
|---|---|
| `intent/identity.md` | What OZZU is (Summer Wars lore, KingKazuma vs Hebert, jurisdiction-agnostic) |
| `intent/cipher.md` | Cipher the agent — directive system, memory, the orb, the work loop |
| `intent/pipeline.md` | HOT/WARM/STAGING tiers, smartDeploy, the iPhone-primary fix, the light pipeline |
| `intent/ui.md` | 5-tab structure, design tokens, GroupNav pattern, anti-slop rules |
| `intent/work.md` | Directives vs ventures, the Work tab grouping (business + SOC) |
| `intent/security.md` | SOC engagements, Cipher = teacher / King Kazuma = doer, hard stops, queue rules |
| `intent/hardware.md` | Drone subsystems, gecko robot, R&D discipline, print pipeline |
| `intent/voice.md` | How Cipher talks, when to push back / execute / ask |

## How this layer is meant to grow

- **Adding a principle**: only when the rule is genuinely inviolable and has a load-bearing reason. Most things go into intent files instead.
- **Updating intent**: when a system materially changes (new tab, new pipeline tier, new venture type), update the relevant intent file in the same commit as the code change.
- **Layer-jumping**: if a memory keeps getting violated, the durable fix is in the pipeline / hook / rule file — not another memory. PRINCIPLES § VIII.25.

## Relationship to other layers

```
.cipher/
├── layer1/   — STRUCTURAL  ("what is the code?")
│              repomix, knip, dep-cruiser, jscpd → SUMMARY.md
├── layer2/   — SEMANTIC    ("what does each file mean?")
│              LLM-extracted per-file intent → intent-index.json (queryable)
├── layer3/   — DRIFT       ("where does the code diverge from intent?")
│              hardcoded hex, dup constants, broken routes → SUMMARY.md
└── layer4/   — INTENTIONAL ("what is CORRECT for Ozzu?")  ← you are here
                PRINCIPLES.md + intent/*.md
```

Layer 3 drift rules can (eventually) reference Layer 4 intent to ask LLM-judge questions like: "Does this PR respect the pipeline tiers described in `intent/pipeline.md`?" That's the LLM-judge fitness function frontier from the research.

## When to read this layer

- **Every session start** — at least skim `PRINCIPLES.md`. Always.
- **Before any audit** — read `intent/<relevant>.md` for the domain you're auditing.
- **Before any significant code change** — read the relevant intent file. Match its decisions or explain why you're deviating.
- **When King Kazuma asks "should Ozzu do X?"** — check PRINCIPLES first; non-negotiable answers come from there.

## Related research (SOTA, May 2026)

This layer is built on the convergence of three emerging patterns:
- **AGENTS.md open standard** (agents.md, backed by OpenAI Codex / Factory / Builder) — hierarchical project-rule files
- **Cursor Project Rules** (`.cursor/rules/*.mdc`) — scoped, glob-targeted, auto-load
- **LLM-judge architectural fitness functions** — automated drift detection against principles using LLMs as judges

The closest precedents in production: Anthropic's own `CLAUDE.md` hierarchy (which Ozzu already uses), Cursor's project rules, GitHub Workspace memory.

## What's NOT yet built

- **LLM-judge fitness functions** that grade PRs against this intent — Layer 3 extension, planned
- **Conversation-to-principle mining** — periodic agent that reads new conversations and proposes new intent entries from recurring corrections
- **Per-subdirectory AGENTS.md** — the open standard's hierarchical file pattern. The repo already has `.claude/rules/{backend,frontend,hardware}.md` with `paths:` frontmatter doing essentially this, but standardizing the format is future work.
