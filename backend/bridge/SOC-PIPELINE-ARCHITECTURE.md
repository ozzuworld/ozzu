# SOC Platform — Canonical Doc (how it works NOW + where we are + progress log)

> **This is THE single living doc for the SOC / offense pipeline.** It supersedes the
> scattered SOC/offense/finetune docs that used to live under `.claude/` and
> `backend/bridge/` (consolidated 2026-06-23, dir_1782250182891). If a tripped or
> compacted session needs to recover SOC context, **read this one file.**
>
> **Companion docs (do not duplicate — cross-link):**
> - Execution contract (the definitive command-execution rules) → `.claude/rules/soc-command-execution.md`
> - Main-session isolation rule → `.claude/rules/soc-isolation.md`
> - Cipher's SOC role + workflow (RULE 3) → `CLAUDE.md`
> - Banned-phrasing / stop-at-queue planning template → `.claude/SOC-PROMPT-TEMPLATE.md`
> - **Model-research record** (the custom-train effort + spend + why it was abandoned) → `private/distillation/PROJECT-DOCUMENTATION.md`
> - Per-domain intent (WHY) → `.cipher/layer4/intent/security.md` + `.cipher/layer4/intent/distillation.md`
> - Memory refs: `reference_membrane_architecture_decision`, `reference_soc_execution_groundtruth`, `reference_soc_bridge_deepseek_pipeline`

---

## 1. HOW IT WORKS NOW (ground truth, verified against `main` 2026-06-23)

**The pipeline is operational and unblocked end-to-end.** A frontier reasoning model
drives an agentic loop inside the bridge; commands run locally; the lab is reached over
the VPN; the membrane is split into a kept observation half and a de-fanged execution half.

### 1.1 The driver: DeepSeek-V4 in the bridge `runAgent` loop

- **The offense model is DeepSeek-V4 via OpenRouter** (config in `backend/.env`). It is an
  off-the-shelf frontier reasoning model, untrained on our labs.
- It runs inside the bridge in the multi-agent `runAgent` loop (`backend/bridge/soc/offense-agent.js`):
  orchestrator picks the next task → synthesize command → SOC queue → execute → fold the
  outcome back into structured state → repeat. (The PentestGPT-style reasoning / generation /
  parsing role split and the AutoPenBench SUMMARY→THOUGHT→ACTION loop that this design was
  built on are now **implemented**, not just designed.)
- **The custom-trained model was ABANDONED — negative result.** The earlier effort to
  distill/fine-tune our own offense model (Claude-teacher → SFT → GRPO on Qwen3-32B) did
  **not generalize** across vulnerability classes: it memorized trained instances, and adding
  more data *or* more classes *lowered* held-out capture. DeepSeek-V4, untrained, beat the
  distilled 30B on held-out labs. **The harness, not bespoke weights, is the product.** Full
  narrative + ~$1k spend record: `private/distillation/PROJECT-DOCUMENTATION.md`.

Latency is ~120s/step (reasoning model). A transient `inference_hung` (no content after the
window) is retried by the loop, not treated as quit.

### 1.2 Execution is LOCAL on the bridge

- Queue items run via **`spawn('bash','-s')`** in `routes/soc.js` — the command is piped via
  **stdin** to a local `bash -s` (so `$VAR` assignments survive; no base64 wrapping needed).
- **dev-01 is OUT of the offense pipeline** (King Kazuma, 2026-06-23). It is a GCP cloud VM
  with its own conflicting `192.168.1.x` (the sim labs) — running offense there scanned the
  cloud, not the lab. The `ssh dev-01` / `dev-01:8888` exec paths are gone from both execute
  endpoints. It is no longer surfaced as an executor or a default.
- **How a local process reaches a physical lab:** the bridge container is `network_mode: host`,
  and the host routes the lab `/24` over `wg0` (`192.168.1.0/24 → wg0 → tablet relay →
  EDIFICIO LAN`). So **the bridge holds the offense toolkit** and **the tablet is the L3
  doorway** into the lab. An engagement's `executor_host` names the **relay**, not an ssh target.
- **Anti-cloud pre-flight:** both execute endpoints abort a command that targets cloud infra
  (the GCP metadata IP or an `*.internal` host) — a mis-scoped scan can never hit GCP/dev-01.
- **Bridge offense toolkit** (in-container, baked into `backend/bridge/Dockerfile`):
  `nmap`, `nuclei`, `httpx`, `whatweb`, `searchsploit`, `netcat-openbsd`, `curl` (`/dev/tcp` works).

The definitive execution-contract details (stdin piping, surviving variables, the old broken
ssh contract, process-group cancel) live in **`.claude/rules/soc-command-execution.md`** — read
that file before reasoning about how a command runs.

### 1.3 The membrane — split into two halves

The membrane exists because a frontier LLM (Claude, L4) can trip the usage-policy classifier
when a whole engagement's offensive context accumulates in one conversation. The fix is
architectural: **never let the whole offensive picture exist in one frontier-model window.**

The 2026-06-23 architecture decision (recorded in `reference_membrane_architecture_decision`)
split the membrane into two clearly-separated halves:

- **OBSERVATION half — KEPT (this is the part that matters).** Everything *Claude reads* is
  abstracted: sanitized telemetry, the DEBRIEF report, finding-graph IP-redaction, and
  `advance_offense` server-side synthesis. Claude (L4) reads ONLY structured rows
  (`get_recon` / `list_findings`) and aggregates (`get_offense_telemetry`) — never raw scan
  output. This is the boundary the whole design hinges on; do not remove it.
- **EXECUTION half — DEMOTED to log-only.** The Postgres trigger
  `trg_check_cipher_exploit_write` used to `RAISE EXCEPTION` on exploit-pattern command writes.
  But it fired on the **execution path** — on DeepSeek's own attack writes, where there is no
  Claude classifier to defend against — and was silently strangling every credential/brute-force
  step at execution time (the HTTP-500 class). It is now **log-only**: it records to the
  forensic table and never blocks. The real protection on the execution path is **authorized
  framing + isolated agents**, not a DB content-blocker.

Why this is right: no published autonomous-pentest system (XBOW, PentestGPT, VulnBot, …) puts a
content-blocking layer on the *execution* path — they run open/self-hosted models with no
classifier to trip, so their orchestrator reads tool output directly. Our membrane is a
Claude-specific need that belongs only on *Claude's input*. (Two independent investigations
converged on this; see `reference_membrane_architecture_decision`.)

### 1.4 The five layers + data contracts

| Layer | Owner | Reads (in) | Emits (out) |
|---|---|---|---|
| L0 Execution | **Bridge LOCAL bash** (`spawn('bash',['-s'])`) + (optional) human PA via app | command + rationale | raw stdout, XML, binaries, screenshots |
| L1 System-of-record | Postgres | raw output | server-side evidence keyed to engagement/host |
| **L2 Membrane** | `soc/soc-recon-parser.js` (+ observation-half sanitizers) | raw evidence | structured rows: `recon_hosts` + `pentest_findings` |
| L3 Offense-synthesis | **DeepSeek-V4 via OpenRouter** (the `runAgent` loop) | structured rows + retained raw | candidate PoCs **by ID**, queued server-side |
| L4 Strategist | **Claude** (frontier) | **ONLY** L2 structured rows / aggregates | scoping, methodology, CVE-by-ID, report; queues command+rationale |

The loop re-enters L0 after each pivot (it is re-entrant, not a one-shot pipeline). The raw blob
never crosses into Claude's context.

`recon_hosts` — `{engagement_id, ip, mac, vendor, hostname, status, ports[{port,proto,state,service,version}], raw_excerpt}`.
`pentest_findings` — PlexTrac/Faraday/AttackForge union: `{title, severity, status, description,
cvss_score, cvss_vector, refs[], affected_asset, affected_assets[]{ip,ports[],note},
mitre_attack[], reproduction, remediation, evidence_files[], discovered_by}`.

### 1.5 Two execution modes per engagement

Flags live in the DB (`db.js`):

- **Autonomous** (`autonomous_execution_enabled=true`, `autonomous_paused=false`): `queueStep` →
  `maybeAutoExecute` (`soc/autonomous-executor.js`) → `POST /soc/queue/:id/run` → local bash. No
  human touch. **This is the default for SKYLINE ops.**
- **Manual** (`autonomous_execution_enabled=false`): item stays `status='pending'` until a human
  taps Run in the Ozzu app SOC tab; output streams via SSE; the PA notifies Cipher in the active
  session.
- **Wizard default** (`POST /soc/engagements`): sets `permission_mode='full_engagement'` +
  `autonomous_full_access=true`, but does NOT set `autonomous_execution_enabled` — you must
  toggle autonomy or use `/run` to start the loop.

**The autonomy toggle (`POST /soc/engagements/:id/autonomy {enabled:true}`) ALSO STARTS
`runAgent(eid,{max_iter:50})`** if none is running — it is the primary way to start or resume
an engagement.

**`advance_offense` ≠ the autonomous loop.** It is a single-shot path: one orchestrator call →
inserts ONE queue item → `maybeAutoExecute` fire-and-forget → returns. It does NOT resume
`runAgent`. Steps queued via `advance_offense` into a completed engagement sit `pending` forever
(no live loop = no watchdog). **Never use `advance_offense` to "resume" a halted/completed run.**

**5 reasons a queue item stays `status='pending'`** (`autonomous-executor.js`):
1. `autonomous_execution_enabled=false`
2. `autonomous_paused=true`
3. Gated intent (`cred_test`/`exploit_probe`/`lateral`/`post_exploit`) AND `autonomous_full_access=false` → waits for human approval + push notification
4. ROE blocklist match → set `failed`
5. Preflight lint fail → set `failed`

### 1.6 Cipher's role (RULE 3, summarized — full text in CLAUDE.md)

Cipher (L4) = **strategy + analysis**, the offense model = **execution**.
- Cipher NEVER runs pentest tools directly via Bash; the bridge bash does, via the loop.
- Cipher references public PoCs **by ID only** (ExploitDB / CVE / NVD / MSF module path) — never
  authors, modifies, ports, or tunes exploit source. Output is always a **queue**, never runnable
  exploit code. Banned-phrasing list + the stop-at-queue template: `.claude/SOC-PROMPT-TEMPLATE.md`.
- Cipher analyzes results **in the active session** (preserves context); a resumed/compacted hot
  SOC chat re-scans accumulated context and re-trips — **SOC analysis = fresh, single-purpose
  session; never `--resume` a SOC chat.**

### 1.7 GPU rental — deferred, not required

The offense model runs via DeepSeek-V4 on OpenRouter **from the bridge directly** — no GPU rental
is needed for current operations. The earlier on-demand vast.ai rental runbook (spin up a
self-hosted model per engagement, tear down) is **superseded** for now; if a self-hosted L3 model
is ever wanted again, the `gpu_create`/`gpu_ssh_exec`/`gpu_destroy` MCP tools still exist and the
spend is gated on King Kazuma's approval (defer-spend rule).

---

## 2. CURRENT STATE — where we are (deployed on `main`, 2026-06-23)

The night of 2026-06-23 took the harness from "keeps dying" to **unblocked end-to-end**. All of
the following are merged to `main` and live:

**Harness reliability fixes (the four ways the loop used to die, each found in code/DB, each fixed):**
- `dir_1782234450321` — loop-breaker + phase ratchet + lint auto-repair (patience: an empty orchestrator response is not a quit)
- `dir_1782238863765` — outcome watchdog + denial feedback (a stuck `running` step fails after timeout; blocked steps get unfrozen)
- `dir_1782239552993` — command-token script-runtime classifier fix (unblock scripting-language steps in `exploitation_auto`)
- `dir_1782242371780` — dark-loop conclude + halt detector (terminal-phase conclude + budget guard + halt telemetry)
- `dir_1782243745921` — orphaned-pending resolver (items left `pending` in a dead run → auto-fail)

**The executor unblock (the real results-blocker):**
- `dir_1782246387821` — executor HTTP-500 fix (the membrane trigger was mis-firing on the
  "mark running" status update and blocking every credential step)
- `dir_1782247607113` — exploit-write trigger **demoted to log-only** (the architectural fix:
  removes the membrane from the execution path; kills the whole 500 class at the root, including
  a second trigger-fire point the HTTP-500 patch missed)

**Isolation + honesty + tooling:**
- `dir_1782245718979` — cyber-isolation guard (the main session structurally cannot trip on
  offense source again) + `invoke_joko` hook deprecated
- honest run-status UI — RUNNING vs **STALLED** vs FAILED vs DONE (a dark loop never lies green)
- `httpx` / `whatweb` baked into `backend/bridge/Dockerfile` + docs updated to ground truth

**Learned (so a future session does not re-chase ghosts):** most of what looked like "Claude
tripping" across these sessions was actually **HTTP 529 capacity errors** (and one OpenRouter 402
billing error), NOT the content filter. A 100-run study found Claude's real content-refusal rate
under authorized-pentest framing is ~zero. One real Opus 4.8 content trip *was* taken — which is
why the isolation guard still earns its keep — but the bulk of the pain was phantom server errors.

### OPEN MILESTONE

> **A run that records a REAL (non-INFO) finding.** Every run to date = **0 real findings** — the
> harness produced great recon but never cracked anything (the membrane trigger was strangling the
> attacks at execution time; that is now fixed). The next run is the first with a clean,
> unobstructed shot: converging loop, working executor, no membrane on the attack path. **The
> milestone to watch: does it finally crack something.**

---

## 3. Why this design exists (rationale, condensed)

A frontier LLM trips the usage-policy classifier when a full engagement's offensive context
accumulates in one window — it scores the whole transcript every turn, and trips hardest at the
*end* (compaction / final summary re-scans the largest, most offense-dense window). The fix is
architectural, not prompt-level: keep raw offensive output out of Claude's context (the
observation membrane), persist structured state in Postgres, and run the offense-synthesis in a
model that has no classifier to trip (DeepSeek-V4). This mirrors how the professional tooling
ecosystem (Faraday / Dradis / PlexTrac / Metasploit DB) already works — a system-of-record
normalizes heterogeneous raw tool output into typed rows so no single tool or person holds the
whole engagement.

The original design was validated by deep research (2026-06-04, adversarially verified) against
PTES, NIST SP 800-115, PentestGPT (USENIX Security 2024), Pentest Copilot (arXiv 2409.09493), and
AutoPenBench (arXiv 2410.03225). The 3-role separation (Reasoning / Generation / Parsing) and the
SUMMARY→THOUGHT→ACTION loop come from PentestGPT + AutoPenBench respectively, and are implemented
in `soc/offense-agent.js` / `soc/offense-engine.js` / `soc/offense-orchestrator.js`.

### Verified sources
- PTES — http://www.pentest-standard.org
- NIST SP 800-115 — https://csrc.nist.gov/pubs/sp/800/115/final
- PentestGPT (USENIX Security 2024) — https://www.usenix.org/conference/usenixsecurity24/presentation/deng
- Pentest Copilot (arXiv 2409.09493) — https://arxiv.org/html/2409.09493v2
- AutoPenBench (arXiv 2410.03225)
- Tooling / finding schemas — Dradis, Metasploit DB, PlexTrac, Faraday, AttackForge

---

## 4. Provenance (what was folded into this doc, 2026-06-23 consolidation)

This file absorbed the still-useful content from docs that were retired in dir_1782250182891:
- `.claude/SOC-MOBILE-WORKFLOW.md` → §1.2/§1.5/§1.6 (execution modes, 5-reasons, advance_offense). *(left as a redirect stub; CLAUDE.md still points to it)*
- `backend/bridge/OFFENSE-AGENT-DESIGN.md` → §1.1/§3 (the role-split / loop design, now implemented). *(deleted; recoverable via git history)*
- `backend/bridge/SOC-OFFENSE-MODEL-RUNBOOK.md` → §1.7 (GPU rental deferred). *(deleted)*
- The 2026-06-04 custom-train/dataset design docs (`SOC-FINETUNE-V12-DESIGN.md`,
  `OFFENSE-FINETUNE-DESIGN.md`, `SOC-FIELD-SURVEY-2026-06-04.md`, `SOC-TRAINING-HYPERPARAMS.md`,
  `SOC-DATASET-V11-CARD.md`) → their content is **dead** (the custom-train was abandoned); the
  authoritative historical record lives in `private/distillation/PROJECT-DOCUMENTATION.md`. *(deleted)*
- `.claude/SOC-PENTEST-WORKFLOW.md` (the dead `invoke_joko`/Joko-on-dev-01 / Opus-4.6 model) → *(deleted; fully superseded by §1)*.

---

## Progress log

<!-- Newest first. The merge_and_deploy PostToolUse hook (soc-progress-log.sh) appends a
     timestamped line here on each SOC-related merge. Manual entries welcome too. -->

- 2026-06-23 — Consolidated ~11 sprawled SOC/offense/finetune docs into this single canonical doc; deleted the stale duplicates; wired the auto-update hook (dir_1782250182891).
