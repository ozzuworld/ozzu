---
name: recover
description: Auto-recover failed/stuck directives
allowed-tools: Bash, Read
---

Scan for and recover broken directives:

1. Get all directives: `curl -s http://localhost:3333/directives`
2. For each `deploy_failed` directive:
   - Check if its branch exists and has commits
   - Check if its code is already in main (git log)
   - If already in main: verify + mark completed
   - If not in main: retry merge-and-deploy
3. For each `blocked` or `stale` directive:
   - Check failure reason
   - Attempt to unblock (re-run verification, fix branch, etc.)
4. For each `in_progress` directive older than 24h with no recent activity:
   - Flag as potentially stuck
   - Check if branch has recent commits
5. Clean up orphan branches that don't match any active directive
6. Report all actions taken
