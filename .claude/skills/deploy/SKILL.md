---
name: deploy
description: Run merge-and-deploy for a directive branch
allowed-tools: Bash, Read
argument-hint: "[directive_id]"
---

Deploy directive $ARGUMENTS to production:

1. Find the directive: `curl -s http://localhost:3333/directives` and locate the one matching the ID or description
2. Verify the directive is `in_progress` with committed code on its branch
3. Run verification: `curl -s -X POST http://localhost:3333/directives/{id}/verify -H 'Content-Type: application/json' -d '{}'`
4. If verification passes, merge and deploy: `curl -s -X POST http://localhost:3333/directives/{id}/merge-and-deploy -H 'Content-Type: application/json' -d '{"branch":"cipher/{id}"}'`
5. Monitor deploy output and report result (smartDeploy handles bridge restart automatically)

If merge-and-deploy fails, diagnose the issue (git state, branch existence, conflicts) and report.
