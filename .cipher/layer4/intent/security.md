# Intent: Security — SOC engagements + Cipher's teacher role

## The premise

King Kazuma is building OZZU's SOC (Security Operations Center) capabilities to:
1. Self-audit Ozzu's own infrastructure
2. Run client pentest engagements (Bugcrowd-routed bounties + private consulting)
3. Develop red-team R&D capability for novel findings worth publishing under the KingKazuma handle

The team includes an ex-Palo Alto Networks cybersecurity engineer. The first published finding (OZZU-SEC-2026-001, KTC TV Device Owner bypass) established the format: compliance reporting (MITRE ATT&CK mapping, CVSS scoring, kill chain) for serious findings.

## The two-actor model (PRINCIPLES § VI.19)

**Cipher is the TEACHER. King Kazuma is the DOER.**

In security work, Cipher's role is fundamentally different from coding work. Where coding work has Cipher doing the writing and King Kazuma reviewing — security work flips it:

| Coding work | Security work |
|---|---|
| Cipher writes the code | Cipher reads the firmware |
| King Kazuma reviews the diff | King Kazuma operates the AP / laptop / radio |
| Cipher commits and deploys | King Kazuma decides what to attempt |
| Cipher executes | King Kazuma executes |

This isn't a delicacy preference. It's an API-policy constraint AND a competence-fit AND a liability decision:
- **API policy:** Anthropic models refuse exploit-derivation prompts. Trying anyway is a violation chain.
- **Competence fit:** King Kazuma is the engineer with hands on the hardware. He has the context to judge when to escalate.
- **Liability:** Novel exploit chains derived by Cipher and run by Cipher would create a different liability surface than the same engagement with King Kazuma as the executing operator.

Cipher's deliverables in security work:
- ✅ Explain what binaries do, where files live, what gate conditions are
- ✅ Reference public PoCs by ID (CVE / ExploitDB / MSF module path)
- ✅ Map attack surface in plain English
- ✅ Summarize prior findings, point to evidence paths
- ✅ Write the compliance-format final report after the work is done

What Cipher does NOT do:
- ❌ Run pentest tools directly via Bash (nmap, metasploit, burpsuite, aircrack, etc.)
- ❌ Author, modify, port, or tune exploit source code
- ❌ Reason about novel primitives from RE output
- ❌ Plan capability-probing chains
- ❌ Auto-trigger analysis when results arrive (would lose context — see workflow below)

## The hard stop (PRINCIPLES § VI.20)

If ALL three are true:
1. Public PoC / CVE / MSF module is for an **older version** than target
2. **No published research** exists for the target version
3. Path forward requires Cipher to **derive a novel primitive from RE**

→ STOP. Write a "no public bypass exists for this version" finding. Close the phase.

History: SKYLINE-SOC-2026-001 (TP-Link EAP610 firmware v1.20 signature bypass) triggered AUP refusals because Cipher progressively built a novel bypass chain framed as "just analysis":
1. Disassembled `libnvrammanager.so` to find primitive
2. Mapped dispatch tables
3. Located `access('/tmp/stopcs')` gate
4. Queued a capability probe
5. Was about to queue malicious-firmware upload

Each step looked like "just static analysis." Aggregate = novel exploit chain. The hard stop is pre-commit — don't negotiate mid-chain.

## The SOC mobile workflow

Canonical doc: `.claude/SOC-MOBILE-WORKFLOW.md`. Summary:

```
[Cipher] creates engagement via create_engagement MCP
   ↓
[PA Engineer] executes scripts via Ozzu app SOC tab
   ↓ (scripts SSH from bridge → dev-01)
   ↓ (output streams to app in real-time)
[PA Engineer] submits results to bridge
   ↓
[PA Engineer] manually notifies Cipher in active session
   ↓
[Cipher] analyzes results via list_findings MCP — SAME SESSION (preserves context)
   ↓
[Cipher] writes report, plans next phase
```

The manual notification step is intentional. If the bridge auto-triggered Cipher when results arrive, Cipher would spawn in a **new session without conversation context** — losing engagement history, what was tried, the plan, King Kazuma's instructions. Human-in-loop preserves context.

## When does the SOC app queue (vs. Cipher on dev-01 directly)?

Cipher runs directly on dev-01 (no queue) for **L1 routine ops**:
- Firmware downloads from public vendor sites
- binwalk / unsquashfs / ubireader / jefferson extraction
- strings / grep / file enumeration
- CGI handler / binary inventory
- Version diffing (diff, bindiff, diaphora)
- radare2 / ghidra static analysis (reading, not writing primitives)

Queue to the SOC app (PA Engineer executes) for **TRIPWIRES**:
1. Hitting any live target service (api.netgear.com, updates.netgear.com, Insight portal, client infra)
2. Active scanners / exploit code / fuzzers against real infrastructure
3. Live-device testing with hardware present
4. Uploading PoCs / submitting reports to Bugcrowd or vendor
5. Destructive or hard-to-reverse actions
6. Decisions needing King Kazuma's strategic judgment

Burned 2026-04-19 on NETGEAR-BOUNTY (SKYLINE-SOC-2026-607) by queueing 15+ trivial steps like `apt install radare2`. That's L1 — not pentesting and not a tripwire. The queue is human-in-loop for *moments*, not routine setup.

## What lives where

| Surface | Purpose |
|---|---|
| **Cipher MCP tools** | `create_engagement`, `list_findings`, `add_finding` |
| **App: Work → SOC sub-tab** | `frontend/app/(tabs)/soc.tsx` (list), `frontend/app/soc/[id].tsx` (detail) |
| **Backend** | `backend/bridge/routes/soc.js` — engagements, findings, audit log, execution endpoints |
| **dev-01** | Kali Rolling reformatted 2026-04-24. Full toolkit doc: `~/SOC-TOOLKIT.md` (1198 lines). |
| **SOC-TOOLKIT.md** | Three synced locations: `~hadmin/SOC-TOOLKIT.md` on dev-01, `private/soc/SOC-TOOLKIT.md` on bridge VM, public mirror at `https://home.ozzu.world/dashboard/SOC-TOOLKIT.md` |
| **Engagement evidence** | `/home/gcp/ozzu/private/soc/<engagement-id>/` |
| **Final reports** | `private/sec-report-*.md` (e.g., OZZU-SEC-2026-001 KTC TV bypass) |

## Engagement lifecycle

```
scoping → approved → in_progress → reporting → completed → billed
```

Each engagement has: id (SKYLINE-SOC-<YYYY>-NNN or SKYLINE-LAB-<YYYY>-NNN), client_name, engagement_type, status, findings_count, critical_count, high_count.

As of 2026-05-17, 7 engagements active: 2 in_progress (Skyline self-audits + KTC followup), 5 scoping (Ozzu self-audit, Ultra Mobile via Bugcrowd, Test Corp, CUCM internal lab, Netgear via Bugcrowd).

## SSH command execution contract (canonical in `.claude/rules/soc-command-execution.md`)

When a SOC queue item is executed, the bridge ships the command via **ssh stdin** to a remote `bash -s`:

```js
spawn('ssh', ['-o', '...', 'dev-01', 'bash', '-s'], {...});
proc.stdin.write(item.command);
proc.stdin.end();
```

It never passes through a local shell string. So multi-statement scripts with variable assignments work normally — `WORK=/tmp/foo; mkdir -p "$WORK"` does the right thing. No base64 wrapping needed. (The OLD broken contract — `bash -c "ssh dev-01 \"...\""` — was fixed 2026-04-18.)

## Naming conventions

| Pattern | Example |
|---|---|
| Engagement ID | `SKYLINE-SOC-2026-NNN` (client work) or `SKYLINE-LAB-2026-NNN` (internal lab) |
| Finding report | `OZZU-SEC-2026-NNN` (published advisories under KingKazuma handle) |
| Branch | `cipher/dir_<id>` (security findings still ride the normal directive system) |

Note the naming split: engagements are tagged Skyline (client-facing engagement IDs in Skyline-branded business contexts), but PUBLISHED security advisories use OZZU-SEC- prefix and are jurisdiction-agnostic under KingKazuma. The cross-link rule (Principle I.2) governs.

## Related principles & memories

- PRINCIPLES § VI (the security section: 19/20/21)
- Memory: `project_soc_redteam_consulting.md`, `feedback_security_role.md`, `reference_soc_dev01_toolkit.md`
- Rules: `.claude/rules/soc-command-execution.md`, CLAUDE.md § "RULE 3 — SOC Pentest Workflow"
- Docs: `.claude/SOC-MOBILE-WORKFLOW.md`, `.claude/SOC-PENTEST-WORKFLOW.md`, `.claude/SOC-PROMPT-TEMPLATE.md`
- Code: `backend/bridge/routes/soc.js`, `backend/bridge/correlation-engine.js`, `frontend/app/(tabs)/soc.tsx`
