---
paths:
  - "INVENTORY.md"
  - ".claude/rules/**"
  - ".cipher/**"
  - "scripts/cipher*"
---

# Cipher Self-Improvement Pipeline

For Cipher's own operational documentation + tooling changes — INVENTORY.md, `.claude/rules/*`, `.cipher/*`, `cipher.sh` and friends, memory pointers — use the **light pipeline**. These changes don't ship to the app and don't trigger OTA / CI / bridge restarts.

## The light pipeline

1. **Create a directive** (the commit-msg hook still requires one on `cipher/*` branches):
   ```bash
   curl -sX POST http://localhost:3333/directives \
     -H 'Content-Type: application/json' \
     -d '{"title":"<short>","description":"<why>","type":"quick","category":"dev"}'
   ```
   Returns `dir_<id>`. Type must be one of: `quick`, `feature`, `explore`, `epic`.

2. **Branch:** `git checkout -b cipher/dir_<id>`

3. **Edit + stage + commit** with `dir_<id>` in the commit message:
   ```bash
   git commit -m "$(cat <<EOF
   <subject> — dir_<id>

   <body>
   EOF
   )"
   ```

4. **Push to main** — manually merge + push, NO `merge-and-deploy`:
   ```bash
   git checkout main
   git merge cipher/dir_<id> --no-ff -m "Merge cipher/dir_<id> — <subject>"
   git push origin main
   ```

5. **Mark the directive completed** (optional but tidy):
   ```bash
   curl -sX PATCH http://localhost:3333/directives/dir_<id> \
     -H 'Content-Type: application/json' \
     -d '{"status":"completed"}'
   ```

## Why this exists

The full directive → branch → commit → merge-and-deploy → smartDeploy → OTA → CI build path is ~5 min of overhead for a 2-min doc edit that has zero runtime impact. King Kazuma confirmed this policy 2026-04-24 (called it "path (b)").

The strictness on the commit-msg hook (still requires a directive ID on `cipher/*` branches even for doc-only changes) is intentional — the hook is a load-bearing pipeline-bypass guardrail. Don't add an exception.

## What does NOT take the light pipeline

App code lives in `frontend/`, `backend/bridge/` (runtime files), `tv/`, `hardware/` (firmware). Changes there always go through the full directive → branch → `merge-and-deploy` → smartDeploy pipeline. The auto-detected tier (HOT/WARM/STAGING) handles the right deploy.

## Anti-patterns

- ❌ `git commit --no-verify` to skip the hook. **Investigate why it blocked, don't silence it.** The hooks are guardrails, not annoyances. Per CLAUDE.md project rules.
- ❌ Putting operational doc changes through the full pipeline. Wastes pipeline cycles and CI time.
- ❌ Changing the `commit-msg` hook to add a doc exception on `cipher/*` without explicit ask — the strictness is the point.
- ❌ Committing to main directly (the hook blocks it anyway). Even for "tiny" `.md` edits, branch first.
- ❌ Skipping the directive because "it's just docs." The directive ID is the audit trail.

## What counts as "self-improvement"

Files that the rule's `paths:` frontmatter scopes to:
- `INVENTORY.md` — single source of truth for scripts/services/optimizations
- `.claude/rules/**` — scoped agent rules (this file is one of them)
- `.cipher/**` — codebase analysis tooling (Layer 1+2+3+4 outputs)
- `scripts/cipher*` — `cipher.sh`, `cipher-analyze.sh`, etc.

NOT in scope (use the full pipeline):
- `frontend/**`
- `backend/bridge/**` (runtime files — when these change, smartDeploy restarts the bridge)
- `tv/**`
- `hardware/**`
- App-facing routes, schemas, MCP tools

## Related

- PRINCIPLES § II.7 (the light pipeline rule)
- `.claude/rules/pipeline.md` — full pipeline tiers (HOT/WARM/STAGING)
- Memory: `feedback_self_improvement_pipeline.md` (originating context, now superseded by this rule file)
