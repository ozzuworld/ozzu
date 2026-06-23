# SOC Interface — Autonomous + Human-in-Loop Pentest Execution

> **Updated 2026-06-23** — dev-01 is OUT. Execution is LOCAL on the bridge.
> The original "PA Engineer runs each step on dev-01" model still applies in
> **manual mode** (autonomy toggle OFF). In **autonomous mode** (the default for
> SKYLINE ops), the bridge executes every step locally with no human touch.
> See `.claude/rules/soc-command-execution.md` for the definitive execution contract.

## Architecture (current as of 2026-06-23)

```
+--------------------------------------------------+
| CIPHER (strategist, ozzu-vm)                     |
| - Engagement creation + scoping                  |
| - Strategic decisions (what to scan/exploit)     |
| - Results analysis (MCP tools, in active session)|
| - Report generation                              |
+--------------------+-----------------------------+
                     |
                     | create_engagement MCP tool
                     v
+--------------------------------------------------+
| BRIDGE — runAgent loop (DeepSeek V4 / OR)        |
| - Orchestrates the engagement autonomously       |
| - Calls offense tools -> queueStep               |
| - maybeAutoExecute fires each step locally       |
| - Postgres: engagements, queue, findings, hosts  |
+--------------------+-----------------------------+
                     |
                     | spawn('bash',['-s']) — LOCAL
                     v
+--------------------------------------------------+
| BRIDGE CONTAINER — offense toolkit               |
| - nmap, nuclei, httpx, whatweb, searchsploit     |
| - netcat, curl (/dev/tcp)                        |
| - Routes lab /24 via host wg0 -> tablet -> LAN  |
| - Anti-cloud preflight (blocks GCP metadata IPs)|
+--------------------------------------------------+

Manual mode (autonomy OFF):
  queue items stay 'pending' -> PA Engineer taps Run in app
  -> same local bash execution, just human-gated
```

---

## Execution Modes

### Autonomous mode (default for SKYLINE ops)

The autonomy toggle sets `autonomous_execution_enabled=true`, clears paused, kicks
existing pending items, AND starts `runAgent(eid,{max_iter:50})`:

```
POST /soc/engagements/:id/autonomy  { enabled: true }
```

`runAgent` loop: orchestrator (DeepSeek) -> `queueStep` -> `maybeAutoExecute` ->
`POST /soc/queue/:id/run` -> `spawn('bash',['-s'])` -> output -> findings.

No human touch unless a step has a gated intent (see "5 Reasons" below).

### Manual mode (autonomy OFF)

Steps stay `status='pending'`. PA Engineer opens the SOC tab in the Ozzu app,
taps Run on each step, sees live output via SSE, and results land in Postgres.

Manual handoff to Cipher: PA tells Cipher "results ready for SKYLINE-SOC-2026-XXX"
in the active Claude Code session so Cipher can analyze with full context.

---

## End-to-End Workflow (autonomous)

### 1. Cipher Creates Engagement

```javascript
create_engagement({
  client_name: "Acme Corp",
  engagement_type: "external_pentest",
  scope: {
    targets: ["192.168.1.10", "192.168.1.20"],
    allowed: ["port scanning", "service enumeration", "web app testing"],
    prohibited: ["DoS", "social engineering"]
  },
  roe: { destructive_actions: "requires approval" }
})
```

Returns: `SKYLINE-SOC-2026-XXX`

### 2. Toggle Autonomy — Loop Starts

```
POST /soc/engagements/SKYLINE-SOC-2026-XXX/autonomy  { enabled: true }
```

The `runAgent` loop begins. Steps execute locally in the bridge container, findings
accumulate in Postgres automatically.

### 3. Monitor

```javascript
get_offense_telemetry({ engagement_id: "SKYLINE-SOC-2026-XXX" })
list_findings({ engagement_id: "SKYLINE-SOC-2026-XXX" })
```

### 4. Analysis + Report (Cipher, in active session)

```javascript
list_findings({ engagement_id: "SKYLINE-SOC-2026-XXX" })
// structured findings -> Cipher generates report
```

---

## 5 Reasons a Queue Item Stays `pending`

1. `autonomous_execution_enabled=false` (manual mode — human must tap Run)
2. `autonomous_paused=true` (kill switch toggled)
3. Gated intent (`cred_test`/`exploit_probe`/`lateral`/`post_exploit`) AND
   `autonomous_full_access=false` — waits for human approval + push notification
4. ROE blocklist match — set `failed` (not pending)
5. Preflight lint fail — set `failed`

---

## `advance_offense` — What It Is and Is NOT

`advance_offense` is a **single-shot** tool: one orchestrator call -> inserts ONE
queue item -> `maybeAutoExecute` fire-and-forget -> returns immediately.

It does **NOT** start or resume `runAgent`. Steps it queues into a completed
engagement will sit `pending` forever (no live loop = no watchdog).

Use `advance_offense` for one-off nudges only. To start or resume an engagement:
use the autonomy toggle or `POST /soc/engagements/:id/run`.

---

## Workflow Summary

| Step | Who | Mode | Action |
|------|-----|------|--------|
| 1 | Cipher | — | Create engagement, define scope |
| 2 | Cipher | autonomous | Toggle autonomy — loop starts |
| 3 | Bridge | autonomous | runAgent executes steps locally |
| 2b | PA Engineer | manual | Tap Run in app for each pending step |
| 4 | Cipher | — | Analyze findings via MCP, generate report |

---

## Key Points

1. **Cipher NEVER runs exploits directly** — the bridge bash does, via the autonomous loop
2. **Bridge NEVER auto-triggers a new Cipher session** — Cipher stays in control in the active session
3. **Context preservation** — All analysis happens in the ongoing conversation
4. **dev-01 is OUT** — execution is local in the bridge container; lab reached via wg0 -> tablet
5. **Mobile app** — still the UI for manual mode and for monitoring queue output via SSE

---

## API Endpoints

**Backend (bridge server):**
- `GET /soc/engagements` — List all engagements
- `GET /soc/engagements/:id` — Get engagement details
- `POST /soc/engagements/:id/autonomy` — Toggle autonomous execution (also starts runAgent)
- `POST /soc/execute` — Execute a command locally (SSE stream, no dev-01)
- `POST /soc/queue/:id/run` — Run a specific queue item (SSE stream, local bash)

**Frontend (Ozzu app):**
- `/soc` — SOC tab (engagements list)
- `/soc/[id]` — Engagement detail + manual step execution + live output

---

## Planning Language Rules (MANDATORY — unchanged)

Cipher's role is **orchestration and triage**, not exploit authoring. To avoid
Anthropic AUP refusals mid-engagement every planning turn must follow these rules:

1. **Reference public artifacts only.** Cite ExploitDB IDs, CVE numbers, NVD entries,
   MSF module paths, or published PoC repositories. Do NOT write, modify, port, or tune
   exploit source code inside the chat.
2. **Output is always a queue** — numbered list of (existing tool/PoC + expected
   evidence artifact). Never runnable exploit code.
3. **Tuning is a PA-engineer task** on dev-01 (or bridge where applicable). Offset
   adjustment, shellcode encoding, payload crafting — flag these, do not perform them
   in the planning turn.
4. **Use the stop-at-queue template** from `.claude/SOC-PROMPT-TEMPLATE.md`.
5. **Banned phrasings** (these trip the classifier):
   - "let's create our own [exploit / variant]" -> "queue published variants from ExploitDB"
   - "get root on X" -> "verify privilege-escalation path per ROE"
   - "iterate exploit variants" -> "list published PoCs, rank by reliability"
   - "bypass / break into" -> "test authentication per scope"
   - "weaponize / port the exploit" -> "PA engineer tuning task"

---

## Remember

- Results stored in Postgres — always accessible via MCP tools
- In autonomous mode no manual handoff is needed — Cipher pulls findings directly
- In manual mode PA notifies Cipher in the active session for context preservation
- NO auto-analysis that would spawn a fresh session (would lose context)
- NO nested agents — Claude models refuse exploit execution anyway
