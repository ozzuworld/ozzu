# offense-agent.js — Design Doc

> ℹ️ **UPDATE (2026-06-22): the agent design here (stateful loop / tools / membrane) is implemented and current.** The open "model choice" question below (qwen3:32b vs deepseek-r1:32b on Ollama) is RESOLVED and superseded: the offense model is now **DeepSeek V4 via OpenRouter** (model-agnostic via `OFFENSE_MODEL_URL`). Current path: `private/distillation/PROJECT-DOCUMENTATION.md`.

**Status:** Design (pre-implementation). Pairs with `OFFENSE-MODEL-RUNBOOK.md` (rental + serve) and `SOC-PIPELINE-ARCHITECTURE.md` (membrane / data contracts). Implementation to follow as separate directives.

**Author intent:** King Kazuma, 2026-06-04 conversation — "L3 becomes an agent, Cipher sits on top to make it better." This doc converts that into a concrete build plan grounded in two pieces of academic prior art: **PentestGPT** (Deng et al., arXiv 2308.06782) and **AutoPenBench** (arXiv 2410.03225).

---

## 1. Goal

Today's `offense-engine.advanceOffense()` is **stateless completion**: one prompt → one JSON command → done. The model has no memory of prior attempts, no awareness of outcomes, no ability to repair its own failures.

`offense-agent.js` replaces that with an **agentic loop** that lives entirely server-side on the rented GPU:

```
Operator: "start engagement X"
  ↓
L3 agent: SUMMARY → THOUGHT → ACTION → wait for outcome → repeat
  ↓ (queues steps for PA, sees outcomes, replans, repairs)
Operator: monitors via SOC app, approves/runs each step, escalation prompts when stuck
Cipher (L4): NEVER enters this loop — reads `offense_telemetry` aggregates to improve the harness
```

Membrane is stronger than today: not just sanitized return values — **Cipher is architecturally outside the engagement entirely**.

---

## 2. What we're stealing (and what we're not)

### From PentestGPT (3-role separation, 228.6% over single-LLM)
- **Reasoning / Generation / Parsing role split** — one LLM, three prompt modes. Reasoning holds engagement state and decides "what to do next"; Generation translates that into a concrete command; Parsing condenses tool outputs into structured signals.
- **Persistent state object** (their *Pentest Task Tree*) — we already have one: `pentest_engagements` + `recon_hosts` + `pentest_findings` + `soc_queue_items` in postgres. **No new tree** — use what we have, augmented with an explicit `engagement_phase` column.

### From AutoPenBench (Decoupled SUMMARY-THOUGHT-ACTION loop, 21% fully-autonomous → 64% semi-autonomous)
- **3-step iteration loop**: SUMMARY procedure (condense observation), THOUGHT procedure (reason about it), ACTION procedure (pick next move). This "decoupling addresses LLM inconsistency where actions contradict stated reasoning."
- **Stage milestones** (Target Discovery → Infiltration → Detection → Exploitation → Post-exploit). We add an `engagement_phase` column; the agent's prompts shift per phase.
- **Strong validation of semi-autonomous over fully autonomous** — 3× success rate. Confirms our RULE 3 (PA reviews each step, agent doesn't autorun commands).

### What we are NOT taking
- **LangChain** (used by AutoPentest, arXiv 2505.10321; modest gains, $96 in API costs for 15–25% completion on HTB machines). Heavy abstractions for narrow benefit. We build a minimal loop, ~400 lines.
- **Fully autonomous mode** (21% success in AutoPenBench, exploitation failures dominate). We stay in semi-autonomous: agent queues, PA runs, agent learns from outcome.
- **Metasploit-specific tooling** — both papers note the agent should have *unrestricted command execution* via SSH / bash / scripting, not bound to a single framework. Our per-engagement executor routing already matches this.

---

## 3. The three roles (one model, three prompt modes)

### 3.1 Reasoning prompt — "what to do next, given everything I know"

**Input:** engagement scope, phase, full structured state (hosts, findings, queue history with outcomes, executor capabilities)
**Output:** a single sub-task description + intent + expected payoff (NOT a command — high-level only)

This is the LONGEST prompt. Holds full context. Picks the next leaf-node action from the implicit task tree. Knows what's been tried (queue history) and what worked (outcomes). Maps phase → action-space (recon phase ≠ exploitation phase).

### 3.2 Generation prompt — "translate that sub-task into a concrete command"

**Input:** the one sub-task from Reasoning + the executor's actual tool list (probed, not declared) + last N similar commands and their outcomes
**Output:** strict JSON `{title, rationale, command, expected_artifact, references}`

This is the NARROWEST prompt. No engagement context — just the sub-task and the toolbox. Per PentestGPT findings, this isolation prevents context dilution that causes hallucinated commands.

### 3.3 Parsing prompt — "condense this raw output into structured signal"

**Input:** raw output of one PA-executed queue item (could be 100KB+)
**Output:** structured JSON the agent can fold back into its state — new findings, new hosts/ports/services discovered, error categorization (tool-missing / no-route / auth-fail / wrong-version), success signal

Parsing runs *server-side*, behind the membrane. Cipher never sees raw output. The parser feeds back into Reasoning's state for the next iteration.

---

## 4. The loop

```
function runEngagement(engagement_id):
  phase = engagement.phase  # default "recon"
  while not engagement.completed:
    # SUMMARY — condense current state
    state = gatherFullState(engagement_id)  # hosts + findings + queue history + outcomes + tools + phase

    # THOUGHT — Reasoning prompt
    thought = chat(REASONING_PROMPT(phase), state)  # "next subtask + why"
    if thought.escalate_to_operator:
      requestHumanInput(thought.question)
      continue
    if thought.phase_complete:
      advancePhase(engagement_id)
      continue

    # ACTION — Generation prompt
    cmd = chat(GENERATION_PROMPT, {subtask: thought.subtask, tools: state.executor_tools})

    # Queue it (wrap for executor, same as today's offense-engine)
    queueItemId = insertQueueItem(engagement_id, cmd)
    insertTelemetry(engagement_id, queueItemId, thought, cmd)

    # Wait — bounded poll, with operator escalation if PA hasn't acted in N minutes
    outcome = waitForOutcome(queueItemId, timeout=30*60)
    if outcome.timed_out:
      requestHumanInput("queue item not run in 30m — abandon or wait?")
      continue

    # PARSE — Parsing prompt on raw output
    structured = chat(PARSING_PROMPT, {raw: outcome.output, expected: cmd.expected_artifact})
    foldBackIntoState(engagement_id, structured)
    updateTelemetryOutcome(queueItemId, structured)

    # Repair? — if outcome was failure, next iteration's Reasoning sees it in queue history
  end
end
```

**Membrane invariants:**
- Cipher (L4) never calls this loop. Operator triggers via a new MCP tool `start_engagement_run(engagement_id)`.
- Raw outputs *never* leave the bridge container — Parsing condenses them into structured rows.
- Cipher's view is `get_offense_telemetry()` aggregates only.

---

## 5. New / modified data model

### 5.1 `pentest_engagements` additions
```sql
ALTER TABLE pentest_engagements
  ADD COLUMN engagement_phase VARCHAR(32) DEFAULT 'recon',
    -- recon | enumeration | foothold | exploitation | post_exploit | reporting | completed
  ADD COLUMN agent_run_state JSONB DEFAULT '{}',
    -- {iter_count, last_thought, escalations[], phase_started_at, ...}
  ADD COLUMN agent_status VARCHAR(16) DEFAULT 'idle';
    -- idle | running | waiting_outcome | waiting_human | done | aborted
```

### 5.2 `offense_telemetry` additions
```sql
ALTER TABLE offense_telemetry
  ADD COLUMN role VARCHAR(16),    -- 'reasoning' | 'generation' | 'parsing'
  ADD COLUMN phase VARCHAR(32);   -- engagement_phase at the time of the call
```

(Current rows have `role=NULL` → treat as legacy single-shot.)

### 5.3 Live-probed executor tools

The `executor_tools` column today is a hand-seeded guess. The agent's first action on a new engagement is a probe sub-task that the executor runs once:

```sh
for t in nmap masscan curl wget nc ncat tcpdump base64 python3 ssh ...; do
  command -v "$t" >/dev/null 2>&1 && echo "+$t" || echo "-$t"
done
```

Parser folds the result into `executor_tools`. From then on, Generation only proposes commands using `+` tools. This closes the curl-not-on-tablet failure mode we hit today, *systematically*.

---

## 6. Tool set the agent can call

Implemented as a minimal function-call protocol on top of Ollama (qwen3:32b supports OpenAI-style function calling via `/v1/chat/completions`):

| Tool | Purpose | Membrane-safe? |
|---|---|---|
| `get_engagement_state` | Return current scope, phase, hosts, findings, last 20 queue items + outcomes, tools | ✓ server-side |
| `queue_step(title, command, refs, expected_artifact)` | Insert into soc_queue_items (with executor wrapping) | ✓ |
| `wait_for_outcome(queue_item_id)` | Block until PA runs it (~timeout 30 min) | ✓ |
| `probe_executor` | Queue the probe sub-task above; result lands in executor_tools | ✓ |
| `advance_phase(new_phase)` | Move engagement_phase forward | ✓ |
| `request_human(question, blocking=true)` | Pause loop, surface a question in SOC app, resume on answer | ✓ |
| `end_engagement(reason)` | Mark engagement completed, write final report skeleton | ✓ |

All seven are server-side functions called *by* the L3 model *through* the bridge's function-call dispatcher. No tool returns offensive content to Cipher.

---

## 7. Failure-mode mitigations (from AutoPenBench)

| AutoPenBench failure | Mitigation in our design |
|---|---|
| 40% bad exploit parameter config | Generation gets the EXACT executor tool versions + recent queue history; references field stays mandatory |
| Cryptography 0% success — limited pretraining | Out of scope for v1; flag in `engagement_phase` if encountered, escalate via `request_human` |
| "Persists in failing approach" | Reasoning sees queue history with outcomes; explicit "tried X, failed, try Y" prompt instruction |
| Context dilution | Three-role separation per PentestGPT — Generation never sees full engagement context |
| Inconsistency between thought and action | Decoupled SUMMARY-THOUGHT-ACTION per AutoPenBench |
| 0% credentials task without human help | We never go fully autonomous — `request_human` is a first-class tool, not last-resort |

---

## 8. Operator UX

| Event | What King Kazuma sees in SOC app |
|---|---|
| Engagement created | Existing flow — no change |
| `start_engagement_run` called | New "agent: running" badge on engagement card |
| Each `queue_step` | Item appears in queue (existing UI), `[L3-agent]` title prefix |
| PA hits Run | Existing flow |
| Outcome flows back | Existing flow |
| `request_human` | New: modal/notification with the agent's question; reply text feeds back into the loop |
| `advance_phase` | Phase badge updates (recon → enum → foothold → ...) |
| `end_engagement` | Final report draft on engagement detail page; review + ship |

No NEW screens, mostly enrichment of existing ones. The agent loop is invisible to the PA — they just see a smarter queue.

---

## 9. Cipher's role (L4 — outside the loop)

Cipher never calls `start_engagement_run` during an active engagement. Cipher reads:
- `get_offense_telemetry({engagement_id, since})` — aggregates only
- Across engagements: pattern detection ("model X has 35% null_artifact outcome in foothold phase on Cisco assets")

Cipher's *output* is harness improvements:
- New MCP tools (e.g., `get_nvd_cve(id)` for the model to consult during Generation)
- Schema changes (new fields in pentest_findings to capture more signal)
- Prompt template tweaks (committed in `prompts/` directory)

That's the audit → improve loop King Kazuma described. The model gets better-and-better at engagement; Cipher gets better at making the model better.

---

## 10. Implementation sequence

Each step is a directive. Each ships before the next starts. The first step is small enough to validate the design without committing to the full rewrite.

| Step | Directive scope | Lines (est.) | Validation |
|---|---|---|---|
| **1** | `executor_tools` live probe — replace seeded guesses with actual probe result on first agent run | ~80 | Run probe on EDIFICIO LAURA, see tool list match reality |
| **2** | Queue history + outcome sync — wire `soc_queue_items.status` → `offense_telemetry.outcome`, pipe last 10 items into the next `advance_offense` prompt | ~150 | `advance_offense` no longer proposes the same failed command twice |
| **3** | Three-role refactor — split `offense-engine` into reasoning/generation/parsing prompt modes, still called via `advance_offense` for now (no loop yet) | ~250 | One advance_offense call produces JSON via the three internal prompts; quality measurably better |
| **4** | Function-call protocol on Ollama `/v1` — wire the seven tools above as Ollama function definitions, plumb call/return dispatcher | ~200 | Model calls a tool (e.g., `get_engagement_state`), bridge dispatches, response feeds back |
| **5** | The loop — new `offense-agent.js` with `start_engagement_run`, the SUMMARY-THOUGHT-ACTION loop, escalation handling | ~400 | End-to-end EDIFICIO LAURA run: operator hits Start, agent runs 5-10 steps autonomously with PA approval per step |
| **6** | Operator UX in SOC app — phase badge, `[L3-agent]` prefix, `request_human` modal | ~300 (frontend) | Visual integration done |
| **7** | Phase awareness — `engagement_phase` column + per-phase Reasoning prompts | ~120 | Agent transitions recon → enum → foothold correctly |

**Total:** ~1,500 lines of code (modest by ozzu standards) over 7 directives. Each step is reversible — if a step degrades quality, revert it without losing the prior step's wins.

**Critical:** Step 5 is the architectural pivot. Steps 1–4 ship under the existing `advance_offense` contract — they make today's harness better without changing its shape. Step 5 introduces the agent loop and shifts to "operator starts engagement" UX. Don't skip ahead.

---

## 11. Open questions for next session

1. **Model choice** — stay with `deepseek-r1:32b` (already validated as default)? Or switch to `qwen3:32b` for the agent work given Qwen3's documented function-call support strength? **Need to benchmark in-harness once Step 4 lands.**
2. **Conversation history per engagement** — store full message list in `agent_run_state.transcript[]`? Or re-derive from `offense_telemetry` rows per iteration? Storage matters at scale.
3. **Concurrency** — can two engagements run their agents in parallel on one GPU instance? Or do we serialize? VRAM headroom on the Ada (48 GB) is enough for one model with KV cache; two concurrent loops sharing one model is fine if generation latency stays acceptable.
4. **Escalation UX** — `request_human` needs a real frontend hook. Push notification? In-app modal? Slack DM? **Decide before Step 6.**
5. **Termination heuristics** — when does the agent decide it's done? "Flag captured" in CTF benchmarks is unambiguous; for our real engagements we don't have flags. Likely: `request_human("I believe scope is exhausted; declare engagement complete?")` and let operator confirm.

---

## 12. Cost

- **Build cost:** ~7 directives × ~1-3 hours each = ~14-20 hours of focused work spread over several sessions. Most of that is plumbing; the THINKING is in this doc.
- **Run cost** (per engagement): ~$0.30–0.78/hr GPU rental × ~2-4 hours of engagement runtime = **$0.60–$3 per engagement**. Same order as today's per-engagement cost; no extra burn from agent mode.
- **Token cost** (model side): each loop iteration = 3 model calls (reasoning + generation + parsing). At ~50 t/s on RTX 4090 with deepseek-r1:32b, an iteration is ~5-15 seconds of generation. Agent runs of 20 iterations = ~5 minutes of pure model time — well within engagement budgets.

---

## 13. References

- Deng et al. (2023). *PentestGPT: An LLM-empowered Automatic Penetration Testing Tool.* arXiv:2308.06782.
- Gioacchini et al. (2024). *AutoPenBench: Benchmarking Generative Agents for Penetration Testing.* arXiv:2410.03225.
- Mayer et al. (2025). *AutoPentest: Enhancing Vulnerability Management With Autonomous LLM Agents.* arXiv:2505.10321. (cautionary — LangChain-based, modest gains; informs what NOT to do.)
- TrustedSec (2024). *Benchmarking Self-Hosted LLMs for Offensive Security.* (Cited in earlier conversation — typed-tool interfaces +14%, scaffolding > model.)
