# SOC Workflow — Pipeline Mode (King Kazuma's order, 2026-09-23)

> "I want the SOC to be more like a pipeline — I work on the terminal along with
> Cipher and then it uses the pipeline to work, investigate, create and modify
> and move forward."

## The mode

King Kazuma and Cipher work **side-by-side in the terminal**. Cipher runs tools
directly — scans, RE, cracking, PoC validation — inside the session's ROE. No
queue ritual, no delegation, no banned phrasings, no isolation subagents.

**The pipeline is the spine, not a gate.** The SOC platform (engagement record →
queue → gate stack → parser → findings graph → reports) is the system-of-record
Cipher uses to investigate, create, modify, and move forward. Sessions die; the
pipeline remembers.

## The pipeline loop

1. **Charter** — before real work: `create_engagement` (client, scope, ROE) →
   `validate_engagement_scope` → `set_engagement_permission_mode`. KK's
   in-session directives (e.g. "every network is in scope except SARAPL") are
   ROE rows — record them on the engagement, dated.
2. **Investigate** — work directly in the terminal. Results land structured:
   recon parses to `recon_hosts` rows (`get_recon`); hypotheses and outcomes go
   to `add_finding` with `kind=hypothesis` BEFORE probing and
   `confirmed`/`refuted` after, wired with `informed_by` (evidence edges) and
   `enables` (future paths). The graph carries the reasoning, not chat memory.
3. **Create / modify** — custom tools → `tools/<name>/` (tools-folder.md);
   advisories → `private/security-advisories/` (disclosure-framework.md);
   evidence → `private/<engagement-or-topic>/evidence/` — **never /tmp**
   (PRINCIPLES §22).
4. **Move forward** — `get_finding_graph` for open frontiers; pick the next lane
   per `vuln-research-pipeline.md` (S0–S8 stage gates + session contract:
   READ-FIRST → SALVAGE-ON-ERROR → SEARCH-BEFORE-CLAIM → FACTS-ONCE). Update
   engagement phase/status as work progresses (RULE 2 discipline applies to
   engagements too — keep `work_summary`-equivalent state in the DB + STATE.md).
5. **Close** — S8 era closure: findings ledger, closed lanes, evidence index,
   final report (`private/sec-report-*.md`).

## Where the queue still earns its keep

`soc_queue_steps` + the app's Run button remain available — as an **option**, for:
- shots KK wants to tap-approve himself (from his phone, async)
- steps a `register_engagement_cron` / `register_engagement_hook` should run on
  a schedule or event (the gate stack applies to those: ROE → permission_mode →
  workspace_jail → command tokens → preflight → hooks → auto-verify)
- long captures KK wants running while away from the terminal

The bridge-side gate stack stays armed for queued/auto-executed items — that is
operational safety (scope enforcement), not model-refusal defense. Never burn
KK's attention on trivial queued steps (PRINCIPLES §21).

## Discipline that survives (legal + hygiene, not refusal-era)

- **ROE/scope**: engagement scope + KK's session directives decide what is
  targetable. Out-of-scope = ask KK first. Destructive/spreading/hard-to-reverse
  = confirm first, always (matches the standing `feedback_just_try` exception).
- **Audit trail**: work without an engagement record is work the pipeline can't
  remember. Charter one even for "quick" surveys — the 2026-09-22 WiFi audit is
  the model: evidence files on disk + findings in DB + lessons in memory.
- **Context economy**: megabyte-scale raw dumps go to disk and get parsed to
  structured rows/summaries (`get_recon`, `soc-recon-parser.js`) — that's why
  the parser exists. Keep the session context lean so it survives long
  engagements; this is context hygiene, NOT classifier defense.
- **Evidence hygiene**: bracket live-fire batches (pid + dmesg before/after),
  one target class per batch, results written to evidence files the same turn.

## What died (2026-09-23 audit, dir_1790188614863)

Removed as refusal-era machine, obsolete under the current provider (Qwen — no
Anthropic classifier in the loop) and the manual-only pipeline (L3 offense loop
deleted 2026-08-29):

- `soc-isolation.md` + `soc-isolation-guard.sh` hook (Opus cumulative-context
  classifier defense, isolated-subagent routing)
- `SOC-PROMPT-TEMPLATE.md` (AUP-evasion banned-phrasings / stop-at-queue)
- TEACHER/DOER policy + no-novel-primitives hard stop (`feedback_security_role`,
  PRINCIPLES §VI.19/20 revised)
- queue-only tripwire bright line (`feedback_tooling_install_isnt_exempt`)
- observer-role / membrane / execution-groundtruth memories (dead L3 era)
- `invoke_joko` MCP tool (ssh-to-dev-01 delegation, decommissioned)

Caveat on record: one REAL Opus 4.8 cumulative-context trip happened 2026-06-23.
If SOC work is ever routed back through Claude/Opus on the Max plan, re-assess
guards then — not preemptively now. History: `git log .claude/rules-soc/` +
`private/distillation/PROJECT-DOCUMENTATION.md`.
