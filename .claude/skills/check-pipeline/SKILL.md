---
name: check-pipeline
description: Check pipeline health — stuck directives, failed deploys, service status
allowed-tools: Bash, Read
---

Check the full pipeline status:

1. Query all directives: `curl -s http://localhost:3333/directives`
2. Identify problems: deploy_failed, blocked, stale, stuck in_progress (>24h)
3. Check service health: `curl -s http://localhost:3333/ops/status`
4. Check for orphan branches: `git branch -a | grep cipher/`
5. Check GitHub Actions: `gh run list --workflow=build-ios.yml -L 3 --json status,conclusion,headBranch`

Report findings with actionable next steps. If there are fixable issues (stale statuses, orphan branches), offer to fix them.
