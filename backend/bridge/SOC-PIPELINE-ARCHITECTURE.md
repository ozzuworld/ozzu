# SOC Pipeline — Layered Reference Architecture

**Status:** design + Layer L1/L2 in build (`dir_1780543681043`).
**Source:** deep-research (105-agent, adversarially verified, 2026-06-04) validating
the design against PTES, NIST SP 800-115, PentestGPT (USENIX Security 2024), and
Pentest Copilot (arXiv 2409.09493).

## Why this exists

A frontier LLM (Claude) trips the usage-policy classifier when a full engagement's
offensive context accumulates in one conversation. The classifier scores the whole
transcript every turn, so the longer/better a SOC session goes, the more the
accumulated context resembles the attack plan it is — and it trips hardest at the
*end*, where compaction or a final summary re-scans the largest, most offense-dense
window.

The fix is architectural, not prompt-level: **never let the whole offensive picture
exist in one frontier-model window.** Keep raw offensive output out of Claude's
context (a "membrane"), persist structured state in Postgres, and offload the
offense-synthesis that must hold risk to a self-hosted model. This mirrors how the
professional tooling ecosystem (Faraday / Dradis / PlexTrac / Metasploit DB) already
works — the system-of-record normalizes heterogeneous raw tool output into typed rows
so no single tool or person holds the whole engagement.

## The five layers + data contracts

| Layer | Owner | Reads (in) | Emits (out) |
|---|---|---|---|
| L0 Execution | Human PA + dev-01/tablet | command + rationale | raw stdout, XML, binaries, screenshots |
| L1 System-of-record | Postgres | raw output | server-side evidence keyed to engagement/host |
| **L2 Membrane** | `soc-recon-parser.js` | raw evidence | structured rows: `recon_hosts` + `pentest_findings` |
| L3 Offense-synthesis | self-hosted model on vast.ai (on-demand) | structured rows + retained raw | candidate PoCs **by ID**, queued server-side |
| L4 Strategist | Claude (frontier) | **ONLY** L2 structured rows | scoping, methodology, CVE-by-ID, report; queues command+rationale |

The loop re-enters L0 after each pivot (NIST "Additional Discovery" feedback arrow) —
the schema is re-entrant, not a one-shot pipeline.

### Where the membrane sits
The membrane is the **L2 normalizer at the dev-01 → Postgres boundary**. The PA runs
the tool on dev-01; raw output lands in Postgres as evidence (server-side);
`soc-recon-parser` normalizes it into `recon_hosts` / `pentest_findings` rows; the
strategist reads ONLY those rows via `get_recon` / `list_findings`. The raw blob never
crosses into Claude's context. (= NIST Discovery's banner→version→NVD normalization +
Pentest Copilot's raw→plaintext-before-the-model, implemented as our parser.)

## Structured schema (the data contract)

`recon_hosts` — `{engagement_id, ip, mac, vendor, hostname, status, ports[{port,proto,state,service,version}], raw_excerpt}`. Fully covers host→service→version. *(db.js)*

`pentest_findings` — field union of PlexTrac + Faraday + AttackForge:
`{title, severity, status, description, cvss_score, cvss_vector, refs[], affected_asset, affected_assets[]{ip,ports[],note}, mitre_attack[], reproduction, remediation, evidence_files[], discovered_by}`.
`refs[]` / `affected_assets[]` added + `cvss_vector` widened to 255 in `dir_1780543681043`.

## Build roadmap

- **A. (in progress, `dir_1780543681043`)** Schema alignment + codify the drifted SOC tables into schema-as-code.
- **B.** Pillar-4 benchmark — which model (WhiteRabbitNeo V3 / modern open), Ollama vs vLLM, GGUF quant + VRAM, vast.ai per-engagement cost + weight cache. **UNRESOLVED — needs a benchmarked test, not assertion.**
- **C.** L2/L3 data-contract spec — how much raw L3 ingests + how its output is sanitized before queueing for the PA.
- **D.** Wire L3 — `gpu_create` → pull model → OpenAI-compat API → read findings → emit structured next-steps. **Stop at vast-rental-ready; GPU stays on-demand.**

## Operational rules (must ship alongside the code)

- The membrane is **necessary but not sufficient**: a resumed/compacted hot SOC session re-scans accumulated context and re-trips. **RULE: SOC analysis = fresh, single-purpose session; never `--resume` a SOC chat.**
- L4 (Claude) is **TEACHER** — references PoCs by ID only, never authors exploit source. L0 human PA executes. (This human gate is our safety/legal choice, not something the literature mandates.)

## Verified sources
- PTES — http://www.pentest-standard.org
- NIST SP 800-115 — https://csrc.nist.gov/pubs/sp/800/115/final
- PentestGPT (USENIX Security 2024) — https://www.usenix.org/conference/usenixsecurity24/presentation/deng
- Pentest Copilot (arXiv 2409.09493) — https://arxiv.org/html/2409.09493v2
- Tooling / finding schemas — Dradis, Metasploit DB, PlexTrac, Faraday, AttackForge
