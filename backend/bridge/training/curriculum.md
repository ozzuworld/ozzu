# Cipher Overnight Training Curriculum
# Date: 2026-02-14
# Trainer: Claude Code (acting as King Kazuma)
# Trainee: Cipher (directive agents spawned via bridge)

## Goal
Make Cipher a fully autonomous architect who can handle all tech issues,
troubleshoot independently, and only escalate when truly necessary.

## Lessons Learned from iOS Sideloading Session
1. Agent got stuck at "needs King Kazuma" instead of trying alternatives
2. Missing podspec wasn't caught — agent didn't verify build output
3. SSH config issues blocked work for hours
4. Agent couldn't do interactive troubleshooting (crash → analyze → fix → rebuild)
5. The `in_progress` directive status has no recovery path
6. smartDeploy doesn't handle iOS builds

---

## Phase 1: Pipeline Hardening (direct code changes, no directive)
Time budget: ~60 min

### 1a. Fix `in_progress` recovery gap
- Directives stuck in `in_progress` aren't caught by startup recovery
- Add to initStorage(): `in_progress` directives with no running agent → reset to `stale`
- Check runningAgents map during startup recovery

### 1b. Add iOS to smartDeploy
- smartDeploy currently only handles Android APK and OTA
- Need to detect iOS-relevant changes and trigger build-ios.yml
- Add `gh workflow run build-ios.yml` when iOS native changes detected

### 1c. Improve agent exit handling
- When agent exits code 0 but directive is still `in_progress` → mark as `stale`
- The agent should have set it to `completed` but didn't
- Add post-exit check: if status is still in_progress after agent exits, reset it

### 1d. Add directive progress tracking
- Agents should POST /status updates during work
- Add a `lastActivity` timestamp to directives
- Watchdog can use this to detect stalled agents (alive but stuck)

---

## Phase 2: Agent Prompt Engineering (submit directives, observe behavior)
Time budget: ~90 min

### 2a. Test directive: "Add build verification to smartDeploy"
- Submit as 'quick' type
- Observe: Does Cipher find the right file? Does it understand the codebase?
- After: Analyze log, note what went well/poorly

### 2b. Test directive: "Add /health endpoint to bridge server"
- Submit as 'quick' type
- Observe: Can Cipher add an HTTP endpoint correctly?
- Checks: Does it restart the bridge? Does it test the endpoint?

### 2c. Test directive: "Improve directive agent prompts for better autonomy"
- Submit as 'feature' type (needs planning)
- Observe: Does the planning phase produce a good plan?
- Does it identify the right files? Does it understand the architecture?

### 2d. Based on observations, iterate on buildPlanningPrompt and buildImplementationPrompt
- Add lessons learned from phases 2a-2c
- Add specific instructions for common failure modes
- Add examples of good vs bad agent behavior

---

## Phase 3: Infrastructure Improvements (submit directives)
Time budget: ~90 min

### 3a. Directive: "Add structured logging to bridge server"
- Currently using console.log everywhere
- Should have log levels, timestamps, maybe JSON format
- Good test of Cipher's ability to refactor existing code

### 3b. Directive: "Create bridge health monitoring dashboard endpoint"
- Add /dashboard/health that shows: active agents, directive queue, system status
- Tests Cipher's ability to add new functionality

### 3c. Directive: "Add automatic crash report analysis for iOS"
- When an iOS crash report is available, parse it and identify the root cause
- This is the kind of analysis Cipher needs to learn

---

## Phase 4: Analysis & Iteration
Time budget: ~60 min

### 4a. Review all agent logs from phases 2-3
- What patterns emerge? Where does Cipher get stuck?
- What information is missing from prompts?
- What tools does Cipher wish it had?

### 4b. Final prompt engineering pass
- Update buildPlanningPrompt and buildImplementationPrompt
- Add CLAUDE.md context that agents should always read
- Add common troubleshooting patterns

### 4c. Write training report
- Save to /home/gcp/ozzu/backend/bridge/training/report-YYYY-MM-DD.md
- Include: what was tested, what worked, what failed, recommendations
- King Kazuma reviews this in the morning

---

## State File
Progress is tracked in /home/gcp/ozzu/backend/bridge/training/state.json
Each phase updates this file so sessions can resume if interrupted.
