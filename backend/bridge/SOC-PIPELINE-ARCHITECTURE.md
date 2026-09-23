# SOC Platform — Canonical Doc (current truth: pipeline mode)

> **2026-09-23 audit (dir_1790188614863):** refusal-era machine stripped. SOC is
> **pipeline mode**: King Kazuma + Cipher work side-by-side in the terminal; the
> platform (engagements → queue → gates → parser → findings graph → reports) is the
> system-of-record Cipher uses to investigate, create, modify, and move forward.
> Work contract: `.claude/rules-soc/soc-workflow.md`.
>
> **2026-08-29 (dir_1787976219239):** the L3 autonomous offense loop was REMOVED
> (offense-agent/engine/executor, report-via-model, autonomy + run/stop endpoints,
> the autonomous MCP tools). Manual/pipeline only since.

**Companion docs (do not duplicate — cross-link):**
- Pipeline-mode work contract → `.claude/rules-soc/soc-workflow.md`
- Research SOP (S0–S8 stage gates, session contract) → `.claude/rules-soc/vuln-research-pipeline.md`
- Command-execution contract (how queued commands run) → `.claude/rules-soc/soc-command-execution.md`
- Disclosure identity/format → `.claude/rules-soc/disclosure-framework.md`
- Tooling conventions → `.claude/rules-soc/tools-folder.md`
- Cipher's SOC role (RULE 3) → `CLAUDE.md` + PRINCIPLES §VI (revised 2026-09-23)
- Custom-model research record (abandoned — negative result) → `private/distillation/PROJECT-DOCUMENTATION.md`
- Per-domain intent (WHY) → `.cipher/layer4/intent/security.md`

---

## 1. Current architecture

### Platform components (bridge)

| Module | Role |
|---|---|
| `routes/soc.js` | engagements, queue, execute endpoints (`POST /soc/execute`, `POST /soc/queue/:id/run` — local `spawn('bash','-s')`, stdin-piped), reports |
| `soc/permission-enforcer.js` + `soc/soc-command-classifier.js` | gate stack on auto-executed/cron items: ROE blocklist → permission_mode (`recon_only`…`full_engagement`) → workspace_jail → command tokens → preflight lint |
| `soc/scope-validator.js` | `validate_engagement_scope` — typed targets (IPv4/CIDR/hostname); free-text-only scopes starve the workspace jail |
| `soc/soc-recon-parser.js` | raw nmap/nc output → `recon_hosts` rows (context economy: structured rows via `get_recon`, not megabyte dumps). Contract: nmap-NORMAL format |
| `soc/finding-graph.js` | attack graph: confirmed/hypothesis/refuted nodes + `informed_by`/`enables` edges + open frontiers (`get_finding_graph`) |
| `soc/claim-verifier.js` (+ `soc/verify-gate-constants.js`) | async re-check of high-stakes cred_test claims (auto-verify; catches false-positive "default creds accepted" findings) |
| `soc/engagement-cron.js` + `soc/hooks.js` | scheduled/operator-configured automation (`register_engagement_cron` / `register_engagement_hook`) — runs through the full gate stack |

**Network path to the physical lab:** bridge container is `network_mode: host`;
host routes `192.168.1.0/24 → wg0 → tablet relay → EDIFICIO LAN`. Offense toolkit
baked into `backend/bridge/Dockerfile` (nmap, nuclei, httpx, whatweb,
searchsploit, netcat-openbsd). Anti-cloud pre-flight in the execute endpoints
aborts commands targeting the GCP metadata IP or `*.internal` hosts.

**App surface (iOS-only):** Work tab → SOC — `frontend/app/(tabs)/soc.tsx` (list),
`frontend/app/soc/[id].tsx` (detail): engagements, queue with Run button
(SSE-streamed output), findings, reports. Manual Run is the human-approval path;
terminal-direct work is the default mode.

**MCP tools (live):** `create_engagement`, `get_engagement`, `list_engagements`,
`soc_queue_steps`, `soc_get_queue`, `add_finding`, `list_findings`,
`get_finding_graph`, `get_recon`, `set_engagement_permission_mode`,
`validate_engagement_scope`, `register_engagement_cron`,
`list_engagement_crons`, `delete_engagement_cron`, `register_engagement_hook`,
`list_engagement_hooks`, `note_model_behavior`, `list_model_behavior_notes`.

### Data model (postgres)

- `pentest_engagements` — scope, ROE, permission_mode, phase, status lifecycle
  `scoping → approved → in_progress → reporting → completed → billed`
- `soc_queue_items` — command, intent_class, lifecycle `pending → running → done/failed`
- `recon_hosts` — `{ip, mac, vendor, hostname, status, ports[{port,proto,state,service,version}], raw_excerpt}`
- `pentest_findings` — `{title, severity, status, description, cvss_score, cvss_vector,
  refs[], affected_asset(s), mitre_attack[], reproduction, remediation, evidence_files[],
  kind: confirmed|hypothesis|refuted, informed_by[], enables[]}`
- `agent_audit_log` — spawned-agent + task audit trail
- `cipher_exploit_write_attempts` — forensic table, **log-only** since 2026-06-23
  (the old blocking trigger strangled legitimate execution; it records, never blocks)
- engagement cron/hook tables — automation config

## 2. History (condensed — details in git + the distillation record)

- **Apr–Jun 2026:** built for the Anthropic-refusal era — 5-layer "membrane"
  (raw offensive output never entered Claude's context), TEACHER/DOER policy,
  banned-phrasing templates, Joko delegation, then a DeepSeek/Qwen L3 autonomous
  offense loop. Custom-model distillation (~$1k, Qwen3-32B LoRA on DO MI300X)
  → **abandoned, negative result** (memorized trained instances; untrained
  DeepSeek-V4 beat it; "the harness, not bespoke weights, is the product").
  Record: `private/distillation/PROJECT-DOCUMENTATION.md`.
- **2026-06-23:** execution moved dev-01 → bridge-local (`bash -s` stdin);
  exploit-write DB trigger demoted to log-only; ~11 sprawled docs consolidated here.
  Field truth banked: most "Claude tripped" events were HTTP 529 capacity errors,
  not content refusals (one real Opus 4.8 cumulative-context trip is documented).
- **2026-08-29:** L3 loop + autonomous endpoints removed — manual-only.
- **2026-09-23:** KK ordered pipeline mode; the audit (dir_1790188614863) removed
  the isolation rule + guard hook, SOC-PROMPT-TEMPLATE, dead L3/membrane memories,
  and `invoke_joko`; PRINCIPLES §VI revised. Re-assess classifier guards only if
  SOC work ever routes back through Claude/Opus.

## Progress log

<!-- Newest first. The merge_and_deploy PostToolUse hook (soc-progress-log.sh) appends a
     timestamped line here on each SOC-related merge. Manual entries welcome too. -->

- 2026-09-23 — Pipeline-mode audit: stripped refusal-era rules/hooks/memories, removed invoke_joko, rewrote canonical doc slim (dir_1790188614863).
- 2026-06-23 — Consolidated ~11 sprawled SOC/offense/finetune docs into this single canonical doc; deleted the stale duplicates; wired the auto-update hook (dir_1782250182891).
