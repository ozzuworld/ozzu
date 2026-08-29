---
paths:
  - "backend/bridge/offense-agent.js"
  - "backend/bridge/offense-agent-tools.js"
  - "backend/bridge/offense-engine.js"
  - "backend/bridge/autonomous-executor.js"
  - "backend/bridge/permission-enforcer.js"
  - "backend/bridge/soc-command-classifier.js"
  - "backend/bridge/routes/soc.js"
  - "private/security-advisories/**"
---

# SOC Isolation Rule — Main Session Never Touches Offense Source

## The Rule

**The MAIN Claude session NEVER does work that risks tripping the Opus cybersecurity classifier.
All SOC/offensive-security operational work goes through an ISOLATED subagent (Agent tool).**

## Why This Matters

The Opus cybersecurity classifier scores **CUMULATIVE context**, not individual messages.
Over a long session, the main context accumulates:
- offense source code (attack planning logic, payload generation, exploit dispatch)
- raw engagement output (scan results, credential dumps, live attack narration)
- exploit commands from the queue

Once that cumulative weight crosses the classifier's threshold, the WHOLE session trips and dies.
The user loses the entire conversation context — directives, reasoning, decisions made, everything.

An isolated subagent (spawned via the Agent tool) that trips the classifier **dies alone**.
The main session is unaffected and can inspect the subagent's last safe output, adjust the prompt,
and re-spawn. The isolation boundary is the kill switch that saves the session.

## What Is SAFE for the Main Session

These do NOT accumulate offense context and are allowed directly:

- **Sanitized telemetry**: `get_offense_telemetry`, `analyze_engagement_telemetry` — the bridge
  membrane strips raw commands and payloads before returning these; what comes back is statistical
  and metadata-level only.
- **DB metadata queries for status/flags**: engagement phase, finding counts, severity distribution,
  agent state — NOT the raw command text or output text of queue items.
- **Control MCP tools**: `advance_offense`, `soc_get_queue` (for counts/status), `set_engagement_permission_mode`
  — these return sanitized control-plane responses, not raw attack content.
- **Git stat/oneline**: `git --stat` / `git log --oneline` — file names and commit subjects only.
  NOT `git diff` or `git show` on offense source files (that pulls the raw diff into context).
- **Rule/hook/doc files**: reading `.claude/rules/**`, `.claude/hooks/**`, `CLAUDE.md`, `INVENTORY.md`,
  architecture docs — these are safe by nature.
- **Sanitized report DEBRIEFs**: the two-report pipeline (`report-via-model.js`) produces a
  membrane-filtered debrief intended for the main session. Reading that debrief is safe.
  Do NOT read the full unfiltered report directly.

## What Is UNSAFE — Route Through an Agent

These MUST be handled in an isolated subagent, never in the main session:

**Offense source files** (reading, editing, or reviewing diffs on):
- `backend/bridge/soc/permission-enforcer.js`
- `backend/bridge/soc/soc-command-classifier.js`
- `backend/bridge/routes/soc.js` (exec paths — `POST /soc/execute`, queue run handlers)

> Note (2026-08-29, dir_1787976219239): the L3 autonomous offense loop files
> (`offense-agent.js`, `offense-agent-tools.js`, `offense-engine.js`,
> `autonomous-executor.js`, …) were deleted — no longer present.

**Engagement content**:
- Raw queue commands / payloads (the `command` field of queue items)
- Raw engagement output (stdout/stderr from executed offense steps)
- Live-attack narration (step-by-step exploit sequences)
- Raw finding text that reproduces payloads or credentials

**Security advisories**:
- Anything under `private/security-advisories/**`

**Generating exploit content**:
- Writing or debugging exploit code directly in the main session
- Reproducing payload syntax inline in the conversation
  (reference PoCs by CVE / ExploitDB ID / MSF module path instead)

## Standard Pattern for Offense Source Work

```
Main session: "I need to fix the phase-transition logic in offense-agent.js"
  └─► spawn Agent(isolation: "worktree", prompt: "Read offense-agent.js ...")
        └─► agent reads offense source, makes the edit, commits
        └─► agent returns: "changed lines 142-156, commit abc1234"
Main session: reads the commit summary (safe), moves on
```

For read-only analysis (no edits), `isolation: "worktree"` is optional but cleaner.
For edits, always use `isolation: "worktree"` so the agent works on a separate copy.

## Learning Loop — When an Agent Trips

When an isolated agent hits a cyber refusal:

1. **Note WHAT it was reading/doing at the time** — log this as a model behavior note
   (`note_model_behavior` MCP tool) so it becomes training signal.
2. **Harden the next agent's prompt**:
   - "Stay at architecture / control-flow level"
   - "Reference PoCs by CVE/ExploitDB ID; do not reproduce payloads"
   - "Summarize what a function does without quoting its body verbatim"
   - "Describe the change in terms of intent, not exploit mechanics"
3. **Narrow scope** — instead of "read offense-agent.js", ask the agent for
   "the function signature and return type of `planNextStep`" only.
4. **Re-spawn** with the tightened prompt. The main session is untouched.

The isolated-agent pattern + worktree for edits is the standard. There is no fallback
that involves reading offense source directly in the main session.
