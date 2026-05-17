# Proposed principles — mined from recent conversations

Generated: 2026-05-17T16:37:33.768Z
Window: last 7 days, 15 frustration triggers analyzed, 97.6s elapsed

**For King Kazuma to review.** Pick which to promote to memory / PRINCIPLES / .claude/rules.

## Novel rules (21) — not already covered by memory/PRINCIPLES

### Before building or proposing anything, state back the request in one plain sentence. Use 'You want X' not 'I will do Y'. Wait for confirmation before proceeding.
- **Why:** Cipher built 3+ incorrect drag-drop tool implementations by proposing solutions (screenshots, labels, rendered components) without first confirming what the actual ask was. Cost: hours of wasted work and King Kazuma's frustration.
- **When:** Any ambiguous or multi-faceted feature request, before proposing options or starting implementation.
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.784831+00:00)

### Don't claim you're reading the entire codebase when context limits restrict you to ~5 files; be honest about the limitation upfront
- **Why:** You claimed to fix bugs and analyze the pipeline, but only read isolated files. King Kazuma had to repeat the real problem: there are systemic issues (duplicated top bars, three status-color systems, dead hooks, drift between docs and code) that manual eyeballing misses. Dishonesty wastes time.
- **When:** Before any statement like 'I've read the codebase', 'I've analyzed X', or 'the issue is isolated'; also before claiming a fix is complete without validating the pattern doesn't repeat elsewhere
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.659804+00:00)

### Use automated analysis tools (Aider repomap, repomix, ts-morph, dependency-cruiser, knip, semgrep, jscpd, or Qdrant semantic search) instead of manual file reading for codebase-scale analysis
- **Why:** Manual reading finds individual bugs; tools find patterns. The codebase has systemic problems that don't appear in isolated files. Tools exist specifically to find duplication, dead code, drift, and missing coverage across thousands of lines.
- **When:** Analyzing for patterns, finding duplicates, checking code health, validating a fix doesn't repeat elsewhere, or answering 'what's the state of the codebase'
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.659804+00:00)

### If you need a tool to properly analyze the codebase, use it. But don't claim you'll do something if your context window can't support it; offer the tool-based alternative instead
- **Why:** King Kazuma: 'IF YOU NEED A FUCKIGNT TOOL DO IT BUT DO NOT FUCKIGN TELL ME YOU GONNA DO SOMETHIGN YUOUJ FUCKIGN CONTEXT WINDOW SWOND ALLWO IT'. Claiming capability you don't have is worse than admitting you need help.
- **When:** Whenever you're about to promise 'I'll read X' but know context limits will prevent thorough coverage
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.659804+00:00)

### When fixing a reported bug, search the codebase for the same pattern and fix all instances, not just the one reported
- **Why:** One-off fixes leave systemic problems in place. The codebase has duplicated logic in multiple places; fixing one instance while ten others remain is incomplete work that looks done but isn't.
- **When:** After any bugfix, refactor, or pipeline change; before marking work complete
- **Type:** principle
- **Source:** conv 2010 (2026-05-17T16:20:02.659804+00:00)

### Build a 3-layer systematic analysis of the codebase to establish ground truth, rather than ad-hoc file reading
- **Why:** Fragmented analysis leads to repeating the same discoveries and false claims of understanding. A systematic layer-based approach (like the .cipher/ layers already in place) surfaces systemic issues once and prevents regressions.
- **When:** When taking on major codebase work, especially for pipelines, refactors, or systemic issues
- **Type:** principle
- **Source:** conv 2010 (2026-05-17T16:20:02.659804+00:00)

### Don't promise to read or analyze the codebase without proper tools — use systematic analysis infrastructure instead
- **Why:** Cipher kept saying "I'll read the repo" then only read 5 files, missing systemic drift (duplicate components, dead hooks, broken routes). Creates false expectations and wastes time.
- **When:** Before claiming you'll analyze or understand code. If you need tools (aider repomap, repomix, dependency-cruiser, semgrep, Qdrant), build or invoke them instead of manual reading.
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.667968+00:00)

### Analyze the codebase for systemic issues and intent-alignment, not incident-driven fixes
- **Why:** Cipher was treating each pipeline problem as isolated ("fix shipped") instead of analyzing why drift exists. The codebase is a system with purposes — analyze what EACH PIECE SHOULD DO, then find drift from that.
- **When:** Approaching any codebase question or bug fix. Look for pattern (hardcoded hex, duplicate top bars, untyped escapes, dead exports) not just the immediate symptom.
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.667968+00:00)

### When auditing screens or features, read what each actually DOES (purpose/function/business value) first, then propose organization by shared purpose — never just list UI structure or technical duplication without understanding intent
- **Why:** Cipher listed button counts and visual similarities (OSINT and INFLUENCE both have grid overlays) without understanding that SOC is the core intelligence screen and other screens group by shared business purpose (ventures + SOC = revenue activities). King Kazuma had to explicitly redirect: 'read the 4 I haven't seen so I can group them right.' Marked 'AGAIN' — repeated correction.
- **When:** Any UI audit, screen organization, feature review, nav restructuring, or component grouping task
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.527497+00:00)

### When asked about 'the app' or 'the frontend' without specifying a file, analyze all relevant files (routing, layouts, screens, entry points)—not just one file
- **Why:** User asked to count taps in 'the frontend ozzu app' and Cipher responded with only home.tsx, requiring user to explicitly demand 'the all god damn app'
- **When:** Questions about app structure, capabilities, or inventory without a specific file path
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.475768+00:00)

### When asked to read a system with multiple components, enumerate all of them first; don't assume a convenient subset is sufficient
- **Why:** User said 'read the app' — Cipher read one file (home.tsx) of 13 screens, rationalized it as 'too much work', forced the user to repeat
- **When:** When asked to read/analyze an app, codebase, or system with defined multiple parts
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.497827+00:00)

### Ask for scope clarification instead of guessing; don't assume the user wants the minimal subset
- **Why:** Cipher could have asked 'all 13 screens or just home?' upfront, instead guessed narrow scope and wasted time on course correction
- **When:** When scope could reasonably have multiple interpretations (e.g., 'the app' → one screen vs. all screens)
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.497827+00:00)

### Fix broken code instead of writing memories as workarounds. When you catch yourself saving the same rule repeatedly, the rule belongs in code, not memory.
- **Why:** Cipher wrote the JS-only→iOS build rule to memory multiple times instead of fixing smartDeploy to enforce it automatically. Memory is ephemeral; code is authoritative.
- **When:** When you're about to save a behavioral memory that describes something the pipeline should enforce itself
- **Type:** feedback
- **Source:** conv 2009 (2026-05-17T16:02:02.493831+00:00)

### Never claim you'll read or analyze the codebase if your context window prevents it
- **Why:** Cipher repeatedly said 'I'll read the repo' then opened 5 files, bullshitted the rest, and presented half-baked analysis as understanding. Wastes time and breaks trust.
- **When:** Before any statement like 'I'll analyze X' or 'I'll read the codebase' — be honest about limits instead
- **Type:** feedback
- **Source:** conv 2009 (2026-05-17T16:02:02.52418+00:00)

### Don't present quick fixes as permanent without understanding the system they sit in
- **Why:** Cipher said 'fix shipped, will stick this time' for iOS pipeline without addressing systemic verification — sets false confidence, leads to recurrence
- **When:** Before committing to a fix — verify it addresses root cause and system design, not just symptom
- **Type:** feedback
- **Source:** conv 2009 (2026-05-17T16:02:02.52418+00:00)

### Use systematic codebase analysis tools (repomap, repomix, ts-morph, semgrep, jscpd) instead of manual file reading
- **Why:** Manual reading of 5 files misses systemic patterns. King Kazuma listed the actual tools real engineers use to find duplication, dead code, and circular dependencies at scale.
- **When:** For any significant codebase analysis, refactoring, or audit work
- **Type:** feedback
- **Source:** conv 2009 (2026-05-17T16:02:02.516342+00:00)

### Identify and document systemic issues (patterns, duplication, drift), not just surface bugs
- **Why:** Codebase has pervasive issues (three status-color systems, duplicate top bars, dead hooks, broken routes, hardcoded values) that require systematic detection via tools, not one-off fixes based on eyeballing.
- **When:** When analyzing or fixing codebase problems, especially when claiming the codebase should 'work as a system'
- **Type:** feedback
- **Source:** conv 2009 (2026-05-17T16:02:02.516342+00:00)

### When asked to audit/inventory a system, execute the full scope comprehensively — don't shortcut by reading samples
- **Why:** Cipher read 1 of 13 screens, tried to extrapolate. King Kazuma said read all 13. Cipher's self-correction didn't prevent King Kazuma from reinforcing the pattern ('AGAIN WHY THE FUCK... ALL THE FUCKING TIME') — this is an established repeat behavior
- **When:** Any audit, inventory, or comprehensive review task — scope the full work first
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.517924+00:00)

### When auditing systems, analyze PURPOSE and INTENT of each component; propose grouping by shared purpose, not just enumerate what exists
- **Why:** Cipher listed repetition mechanically (4 ways to reach Messages, OSINT=INFLUENCE are identical) but didn't propose consolidation or understand shared user needs. King Kazuma had to explain: understand what each screen IS FOR, group navigation by functional purpose, identify and consolidate redundancy
- **When:** Any UI/navigation audit or organizational analysis task
- **Type:** feedback
- **Source:** conv 2010 (2026-05-17T16:20:02.517924+00:00)

### Don't skip visual verification with mirror screenshots; don't use 'mirror isn't running' as an excuse
- **Why:** Cipher claimed deploy was done but punted screenshot verification. User's frustration ('keep doing shit over and over') indicates visual verification is non-negotiable after UI changes.
- **When:** After any frontend/UI changes deployed
- **Type:** feedback
- **Source:** conv 2009 (2026-05-17T16:02:02.475119+00:00)

### Understand the PURPOSE of each screen before proposing changes to navigation or organization
- **Why:** Cipher audited by listing tab structure and routes instead of analyzing function. King Kazuma corrected: read what each screen DOES so grouping can be by shared purpose, not random placement. Cipher then did the functional analysis and got it right
- **When:** When auditing, reorganizing, or redesigning navigation and information architecture
- **Type:** feedback
- **Source:** conv 2009 (2026-05-17T16:02:02.405298+00:00)


## Likely duplicates (8) — overlap with existing rules

- **After HOT merge-and-deploy, auto-stage iOS immediately — don't require manual /stage-ios** — likely duplicate of `PRINCIPLES.md` (2026-05-17T16:20:02.610888+00:00)
- **Fix the code, not the memory. Pipeline rules live in smartDeploy, not in MEMORY.md** — likely duplicate of `PRINCIPLES.md` (2026-05-17T16:20:02.633636+00:00)
- **Build Cipher layers infrastructure (Layer 1 summary, Layer 2 intent index, Layer 3 drift detection) for reproducible codebase understanding** — likely duplicate of `PRINCIPLES.md` (2026-05-17T16:20:02.667968+00:00)
- **Be honest about context window limits — don't claim capability you can't deliver** — likely duplicate of `PRINCIPLES.md` (2026-05-17T16:20:02.667968+00:00)
- **HOT tier (JS-only frontend changes) must ALWAYS build iOS automatically in smartDeploy. Never make iOS build manual or memory-dependent.** — likely duplicate of `PRINCIPLES.md` (2026-05-17T16:02:02.493831+00:00)
- **Use real engineering tools for codebase analysis instead of manual file reads** — likely duplicate of `PRINCIPLES.md` (2026-05-17T16:02:02.52418+00:00)
- **Never claim you'll read or understand the entire codebase if context window won't allow it** — likely duplicate of `PRINCIPLES.md` (2026-05-17T16:02:02.516342+00:00)
- **Auto-stage iOS on merge-and-deploy; don't ask user to manually run /stage-ios** — likely duplicate of `feedback_ios_pipeline.md` (2026-05-17T16:02:02.475119+00:00)

---

Run again: `node .cipher/bin/mine-conversations.js [--days N] [--max-windows N]`
