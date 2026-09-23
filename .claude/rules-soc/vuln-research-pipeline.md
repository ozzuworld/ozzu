# Vulnerability Research Pipeline (S0–S8) — loads with /soc
Distilled SOP. Full rationale + sources: `private/soc-research/AI-VULN-RESEARCH-ROUTE-MAP-2026-09-23.md`. Evidence base for these rules: `private/cucm/expressway-evidence/AUDIT-RESEARCH-PIPELINE-2026-09-23.md` (waste catalog W1–W9).

## Session contract (EVERY SOC research session, no exceptions)
1. **READ-FIRST**: engagement `STATE.md` → `REGISTRY.md` → DB findings (`list_findings` + `get_finding_graph`) → campaign ledger. Never re-derive a fact that has a registry row.
2. **SALVAGE-ON-ERROR**: after any API error / compaction / crash recovery, the FIRST write is open threads + in-flight state to STATE.md (mine the jsonl tail per `reference_blocked_session_recovery`), then resume via contract 1. Sessions must be resumable by a stranger with amnesia.
3. **SEARCH-BEFORE-CLAIM**: every attribution / novelty / severity claim cites a REGISTRY row or DB finding — or greps ALL evidence eras first. (W1: the ":8443=ATS" truth sat in 5 files while a wrong claim was made.)
4. **FACTS STATED ONCE**: canonical row in REGISTRY (dated + sourced). Corrections in place with `⚠️ CORRECTED` + DB errata finding (insert-only ledger; #923 pattern). Snapshots are history, never resume sources.

## Stages + hard gates
- **S0 Charter** — engagement in DB; ROE rows current in STATE/REGISTRY (KK-order-only, dated); permission mode set; scope validated (`validate_engagement_scope`).
- **S1 Surface map** — every listener → REGISTRY row (port→pid→binary→version→CVE status) via socket-inode→pid, before ANY finding may reference it.
- **S2 Lane selection** — query `get_finding_graph` (frontiers, enables-hypotheses, closed lanes). Gate: lane not in closed-lanes; log `kind=hypothesis` node with `informed_by` facts BEFORE probing (grounding rule).
- **S3 Harness build** — RE boundary → ABI → private patched binary copy (NEVER the shared $APP) → lld+RPATH+patchelf recipe. Gates: valid input exits 0; adversarial battery triaged; env-artifacts (asserts/logging init) eliminated before launch; exec-rate sanity (fork-server ground truth, not bash loops).
- **S4 Campaign run** — ledger row per campaign; monitor armed (verify baseline parses!); plateau policy: pending=0 across N cycles → LLM seed enrichment (ChatAFL-adapted) or core rotation, decision recorded in ledger.
- **S5 Triage** — reproduce NATIVELY (qemu can fake hangs) → minimize → gdb root-cause (debugger-in-the-loop, Big Sleep pattern) → classify DoS/corruption/logic. Gate: wire-plausible-size crash → LIVE-WIRE validation on the authorized clone, bracketed (pid + dmesg before/after), BEFORE severity discussion.
- **S6 Log** — `add_finding` with `informed_by` (evidence edges), `enables` (future paths), refs, evidence_files, honest scope (proven vs NOT-proven), severity by precedent (#901 known-CVE-live = MED 5.3; primitive-only = AC:H). SAME TURN: update REGISTRY rows + campaign ledger + STATE threads. Corrections only via errata findings.
- **S7 Chain** — re-query graph; promote/retire enables-hypotheses; test every new finding against STANDING chain hypotheses (e.g., fragile-equilibrium: local-root × any untrusted-code-exec). Gate: no chain claimed without both legs evidenced or explicitly deployment-conditional.
- **S8 Era closure** — FINAL-REPORT pattern: bottom line, findings ledger, closed-lanes UPDATE, evidence index, budget/discipline record (incl. self-inflicted incidents). Demote snapshots to history/; reset STATE for next era.

## Chaining rules
Chains live in the GRAPH (enables/informed_by edges), not prose. Missing leg stated explicitly. Deployment-conditional ≠ dismissed. Refuted legs KEPT with ruled-out lists (negative knowledge prevents re-litigation — #910 lesson).

## Live-fire pre-flight (before every batch)
Re-read ROE (STATE.md). Check traps table: rate-limit jails + budgets, framer caps, clock skews, listener-restart watchers. Bracket all firings (pid + dmesg). One target class per batch; results to evidence files same turn — never /tmp for persistent artifacts.

## Tool filter (adopted 2026-09-23, re-review per era)
- **ADOPT** (methodology, zero new deps): stage gates (Aardvark), fact/intent externalized state (Intentest → bridge primitives), evidence bundles per finding (Buttercup), debugger-in-the-loop triage (Big Sleep), stability-first operations (AIxCC SoK: "stability and accuracy were deciding factors").
- **ADAPT** (small scripts when the need is live): ChatAFL-style LLM seed/grammar enrichment for plateaued protocol corpora; OSS-Fuzz-Gen false-positive-mitigation patterns for harness builds; fix-diff variant-hunting lanes (Big Sleep/58154 pattern).
- **IGNORE** (duplicate our bridge or out-of-niche): web-pentest agent mass (commodity scanning, "near-ceiling"), CAI (archived), MCP security hubs (HexStrike/CyberStrikeAI — bridge is one, deeper and engagement-specific), guardrail-free model lines (ROE + membrane cover safety).
- **WATCH**: Buttercup OSS (harness-factory ideas for OSS targets), ExploitGym (exploit-chaining evals), ARTEMIS (R4 live-network multi-agent), AFL++ feature currency (persistent qemu mode / cmplog / custom mutators / -M-S sync — VERIFY VERSION at adoption time, not from memory).
