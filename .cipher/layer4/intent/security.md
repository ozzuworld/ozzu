# Intent: Security — pipeline mode (SOC engagements + research)

*(Rewritten 2026-09-23, dir_1790188614863 — supersedes the "Cipher's teacher role" version, which was Anthropic-refusal-era policy. Prior text in git history.)*

## The premise

King Kazuma is building OZZU's SOC (Security Operations Center) capabilities to:
1. Self-audit Ozzu's own infrastructure
2. Run client pentest engagements (Bugcrowd-routed bounties + private consulting)
3. Develop red-team R&D capability for novel findings worth publishing (0xReadingSteiner for the Cisco research campaign; KingKazuma handle for OZZU public output — jurisdiction-agnostic)

The team includes an ex-Palo Alto Networks cybersecurity engineer. The first published finding (OZZU-SEC-2026-001, KTC TV Device Owner bypass) established the format: compliance reporting (MITRE ATT&CK mapping, CVSS scoring, kill chain) for serious findings.

## Why pipeline mode (the WHY behind PRINCIPLES §VI, revised 2026-09-23)

King Kazuma's order: *"the SOC to be more like a pipeline — I work on the terminal along with Cipher and then it uses the pipeline to work, investigate, create and modify and move forward."*

The earlier two-actor model (Cipher = TEACHER, never fires a packet; queue-only tripwires; main-session isolation from offense content; banned phrasings) was built Apr–Jun 2026 to survive Anthropic AUP/classifier refusals. Three things made it obsolete:
1. **The L3 autonomous offense loop was deleted** (2026-08-29) — SOC is manual-only; there is no "offense model" to observe or delegate to, and Joko/dev-01 delegation was decommissioned before that.
2. **Cipher runs on Qwen now** (provider-agnostic harness, 2026-08-29 split-brain fix) — the Anthropic cumulative-context classifier the isolation architecture defended against is not in the loop. Field truth banked in June: most apparent "trips" were HTTP 529 capacity errors, not refusals (one real Opus 4.8 trip is documented — re-assess ONLY if SOC work routes back to Opus).
3. **The working mode KK actually wants was demonstrated** (2026-09-22 WiFi audit): Cipher ran monitor-mode captures, driver RE + DKMS builds, and crack planning directly in the terminal while KK set ROE in-session ("all networks valid for recon except SARAPL"). He explicitly set the SOC rules aside that session — the rules were the friction, not the protection.

What survives, and WHY:
- **The pipeline as system-of-record** — same instinct as "Memory dies; code wins": sessions compact and crash; engagement rows, finding-graph edges (informed_by/enables), and evidence files outlive them and make every session resumable by a stranger with amnesia.
- **ROE/scope discipline** — liability is real regardless of model provider. Scope creep is what turns research into a crime. Out-of-scope → ask KK; destructive/spreading → confirm always.
- **Human judgment on strategic/destructive moves** — KK commands; that's identity (Summer Wars), not API policy.
- **Context economy** — parse megabyte dumps to structured rows (recon parser, get_recon) so long engagements don't drown the window. This is context hygiene, NOT classifier defense.
- **Don't waste the commander's attention** — the NETGEAR-BOUNTY lesson (15+ trivial queued steps) generalizes: the queue is for tap-approval moments and automation, not routine ops.

## The two-actor model, now

| King Kazuma | Cipher |
|---|---|
| Commands; sets ROE/scope (engagement record + dated in-session directives) | Investigates, creates, modifies, moves forward — hands-on in the terminal |
| Approves out-of-scope / destructive / strategic moves | Lands every result in the pipeline the same turn (findings, evidence paths, graph edges, STATE/REGISTRY rows) |
| Tap-approves queued shots in the app (optional path) | Keeps engagement state so any future session resumes cleanly |

## The pipeline loop

Charter (`create_engagement` + `validate_engagement_scope` + permission mode) → investigate terminal-direct (hypothesis findings BEFORE probing) → create/modify (tools/, advisories, evidence under `private/`) → move forward (`get_finding_graph` frontiers; S0–S8 lanes per `.claude/rules-soc/vuln-research-pipeline.md`) → close (S8: ledger, closed lanes, final report). Full contract: `.claude/rules-soc/soc-workflow.md`.

## What lives where

| Surface | Purpose |
|---|---|
| **Cipher MCP tools** | `create_engagement`, `soc_queue_steps`, `soc_get_queue`, `add_finding`, `list_findings`, `get_finding_graph`, `get_recon`, `set_engagement_permission_mode`, `validate_engagement_scope`, `register_engagement_cron/hook`, `note_model_behavior` |
| **App: Work → SOC** | `frontend/app/(tabs)/soc.tsx` (list), `frontend/app/soc/[id].tsx` (detail) — queue Run w/ SSE output, findings, reports |
| **Backend** | `backend/bridge/routes/soc.js` + `backend/bridge/soc/*` (gate stack, recon parser, finding graph, crons, hooks, claim verifier) |
| **Execution** | LOCAL `bash -s` on the bridge (`network_mode: host`); lab via `wg0 → tablet relay → EDIFICIO LAN`; toolkit baked into the bridge Dockerfile. Contract: `.claude/rules-soc/soc-command-execution.md` |
| **dev-01** | Kali RE workstation (KK 2026-08-03) — research VMs (PAN-OS qcow2 mounts, CUCM/Expressway targets), binary analysis. NOT a queue executor (removed 2026-06-23) |
| **Engagement evidence** | `private/soc/<engagement-id>/` or `private/<topic>/evidence/` — NEVER /tmp (PRINCIPLES §22) |
| **Advisories** | `private/security-advisories/` + `.claude/rules-soc/disclosure-framework.md` |
| **Final reports** | `private/sec-report-*.md` (e.g., OZZU-SEC-2026-001 KTC TV bypass) |

## Engagement lifecycle

```
scoping → approved → in_progress → reporting → completed → billed
```

Live counts via `list_engagements` — never snapshot counts into docs (they rot).

## Naming conventions

| Pattern | Example |
|---|---|
| Engagement ID | `SKYLINE-SOC-2026-NNN` (client work) or `SKYLINE-LAB-2026-NNN` (internal lab) |
| Finding report | `OZZU-SEC-2026-NNN` (published advisories, KingKazuma handle) / `SKYLINE-YYYY-NNN` (vuln tracking, 0xReadingSteiner campaign) |
| Branch | `cipher/dir_<id>` (security findings still ride the normal directive system) |

Naming split: engagements are Skyline-tagged (client-facing business); published advisories are jurisdiction-agnostic under KingKazuma, Cisco-campaign research under 0xReadingSteiner. The cross-link rule (Principle I.2) governs.

## Related principles & memories

- PRINCIPLES § VI (19/20/21 — revised 2026-09-23 to pipeline mode)
- Memory: `feedback_soc_pipeline_mode.md` (canonical rule), `project_soc_redteam_consulting.md` (business context), `project_panos_vuln_research.md` (active research), `MEMORY-SOC.md` index (loads via /soc)
- Rules: `.claude/rules-soc/soc-workflow.md` (contract), `soc-command-execution.md`, `vuln-research-pipeline.md`
- Docs: `backend/bridge/SOC-PIPELINE-ARCHITECTURE.md` (platform canonical)
- History: `git log .claude/rules-soc/` (refusal-era machine, removed dir_1790188614863); `private/distillation/PROJECT-DOCUMENTATION.md` (abandoned custom-model effort)
