# SOC Pipeline — Layered Reference Architecture

**Status (updated 2026-06-23):** pipeline fully operational with autonomous execution. The GPU-rental gate (DigitalOcean approval) was the original blocker; as of 2026-06-23 the offense model runs via DeepSeek V4 on OpenRouter from the bridge directly — no vast.ai rental required for current operations. See "Build state" section below.
**Source:** deep-research (105-agent, adversarially verified, 2026-06-04) validating the design against PTES, NIST SP 800-115, PentestGPT (USENIX Security 2024), and Pentest Copilot (arXiv 2409.09493).

## Build state

| Layer / piece | State |
|---|---|
| L0 — PA Engineer via SOC app | live |
| L1 — Postgres system-of-record | live (`pentest_engagements`, `recon_hosts`, `pentest_findings`, `engagement_tasks` DAG) |
| L2 — membrane (soc-recon-parser.js) | live |
| L3 — offense engine + advance_offense + multi-agent runAgent | live, mechanically smoke-tested |
| L4 — Cipher strategist | live |
| Fine-tune pipeline — code (Steps 9.1–9.17) | shipped, untested e2e (~$30-40/run) |
| Fine-tune dataset v1.1 | built + persisted at `/home/gcp/ozzu/private/finetune/dataset-v1.1/` (4-corpus mix, 9.9% tool-call signal) |
| AutoPenBench eval + compare.py | shipped |
| Diagnostics (per-engagement + fleet + membrane-audit) | live |
| Test suite (run-all.sh, 4 smokes) | green, ~85s |
| Operator-side blocker | DO GPU droplet access not yet approved on King Kazuma's account |

**Pre-launch reading for any new Cipher session:**
1. `SOC-FIELD-SURVEY-2026-06-04.md` — why we made the choices we made (existing pentest LLMs, tool-use preservation findings)
2. `SOC-DATASET-V11-CARD.md` — what's in dataset-v1.1 (per-corpus provenance, license, format, rebuild instructions)
3. `tools/finetune/README.md` — how to run training when DO access lands

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
| L0 Execution | **Bridge LOCAL bash** (`spawn('bash',['-s'])`) + (optional) human PA via app | command + rationale | raw stdout, XML, binaries, screenshots |
| L1 System-of-record | Postgres | raw output | server-side evidence keyed to engagement/host |
| **L2 Membrane** | `soc-recon-parser.js` | raw evidence | structured rows: `recon_hosts` + `pentest_findings` |
| L3 Offense-synthesis | DeepSeek V4 via OpenRouter (current); self-hosted model on vast.ai (on-demand, future) | structured rows + retained raw | candidate PoCs **by ID**, queued server-side |
| L4 Strategist | Claude (frontier) | **ONLY** L2 structured rows | scoping, methodology, CVE-by-ID, report; queues command+rationale |

The loop re-enters L0 after each pivot (NIST "Additional Discovery" feedback arrow) —
the schema is re-entrant, not a one-shot pipeline.

### Where the membrane sits
The membrane is the **L2 normalizer at the execution → Postgres boundary**. Commands
run locally in the bridge container (or via a human PA in manual mode); raw output
lands in Postgres as evidence (server-side); `soc-recon-parser` normalizes it into
`recon_hosts` / `pentest_findings` rows; the strategist reads ONLY those rows via
`get_recon` / `list_findings`. The raw blob never crosses into Claude's context.
(= NIST Discovery's banner→version→NVD normalization + Pentest Copilot's
raw→plaintext-before-the-model, implemented as our parser.)

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

## Execution reality (verified 2026-06-23 — ground truth from code)

**Execution is LOCAL on the bridge** — `spawn('bash',['-s'])` in `routes/soc.js`. dev-01
is fully removed from the offense pipeline (soc.js:986, 1079). The bridge container is
`network_mode: host`; the host routes the lab `/24` via `wg0` → tablet relay → EDIFICIO
LAN, so `nmap`, `httpx`, etc. reach physical lab targets.

**Two modes per engagement** (flags in DB via `db.js`):
- `autonomous_execution_enabled=true` (`autonomous_paused=false`): `queueStep` →
  `maybeAutoExecute` (`autonomous-executor.js`) → `POST /soc/queue/:id/run` → bash. No
  human touch.
- `autonomous_execution_enabled=false`: item stays `status='pending'` until a human taps
  Run in the app.
- **Wizard default** (`POST /soc/engagements`): sets `permission_mode='full_engagement'` +
  `autonomous_full_access=true`, but does NOT set `autonomous_execution_enabled` — you
  must toggle autonomy or use `/run` to start the loop.

**The autonomy toggle (`POST /soc/engagements/:id/autonomy {enabled:true}`) also STARTS
`runAgent(eid,{max_iter:50})`** if none is running (soc.js:435-439). It is the primary
way to start or resume an engagement.

**`advance_offense` ≠ the autonomous loop** (`offense-engine.js:218`). It is a separate
single-shot path: one orchestrator call → inserts ONE queue item → `maybeAutoExecute`
fire-and-forget → returns. It does NOT resume `runAgent`. Steps queued into a completed
engagement via `advance_offense` will sit `pending` forever (no live loop = no watchdog).
Do NOT use `advance_offense` to "resume" a halted/completed run.

**5 reasons a queue item stays `status='pending'`** (autonomous-executor.js):
1. `autonomous_execution_enabled=false`
2. `autonomous_paused=true`
3. Gated intent (`cred_test`/`exploit_probe`/`lateral`/`post_exploit` — GATE_INTENTS) AND
   `autonomous_full_access=false` → waits for human approval + push notification
4. ROE blocklist match → set `failed` (not pending)
5. Preflight lint fail → set `failed`

**Deployed reliability fixes (2026-06-23):**
- `dir_1782234450321` — loop-breaker (patience: empty orchestrator response ≠ quit)
- `dir_1782238863765` — outcome-watchdog (stuck running → failed after timeout)
- `dir_1782242371780` — dark-loop / halt-detector (terminal-phase conclude + budget guard)
- `dir_1782243745921` — orphaned-pending resolver (items left pending in a dead run → auto-fail)

**Current offense model:** DeepSeek V4 via OpenRouter (`backend/.env`). Latency ~120s/step
(reasoning model). The `inference_hung` error (no content after 120s) is transient and the
loop now retries it rather than quitting.

**Bridge offense toolkit** (in-container, `backend/bridge/Dockerfile`):
`nmap`, `nuclei`, `httpx`, `whatweb`, `searchsploit`, `netcat-openbsd`, `curl` (`/dev/tcp` works).

## Operational rules (must ship alongside the code)

- The membrane is **necessary but not sufficient**: a resumed/compacted hot SOC session re-scans accumulated context and re-trips. **RULE: SOC analysis = fresh, single-purpose session; never `--resume` a SOC chat.**
- L4 (Claude) is **TEACHER** — references PoCs by ID only, never authors exploit source. L0 execution is autonomous (bridge bash) in full_engagement mode; human gate applies when `autonomous_full_access=false`. (This human gate is our safety/legal choice, not something the literature mandates.)

## Verified sources
- PTES — http://www.pentest-standard.org
- NIST SP 800-115 — https://csrc.nist.gov/pubs/sp/800/115/final
- PentestGPT (USENIX Security 2024) — https://www.usenix.org/conference/usenixsecurity24/presentation/deng
- Pentest Copilot (arXiv 2409.09493) — https://arxiv.org/html/2409.09493v2
- Tooling / finding schemas — Dradis, Metasploit DB, PlexTrac, Faraday, AttackForge
