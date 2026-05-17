# Intent: Pipeline — how code becomes deployed Ozzu

## The shape

```
King Kazuma decides to build something
        ↓
  create_directive  →  dir_<id>, status=pending
        ↓
   approve (auto or manual)
        ↓
   cipher/dir_<id> branch
        ↓
   Cipher commits (with directive ID in message — hook enforces)
        ↓
   merge-and-deploy  →  smartDeploy detects tier
        ↓
   ┌───── tier dispatch ─────┐
   ↓             ↓            ↓
  HOT          WARM        STAGING
 ~25s          ~10m         on-demand
 OTA          CI build       iOS rebuild
 (+ iOS CI    (Android       (only if HOT
  parallel)    + iOS in       CI failed)
                parallel)
```

## Why the tiers exist

iPhone is King Kazuma's primary device (PRINCIPLES § I.3). Android tablets are secondary surfaces. The tier system optimizes for: how fast can a JS-only fix reach the iPhone he actually carries?

| Tier | When | Android | iOS | Optimization target |
|---|---|---|---|---|
| **HOT** | JS-only changes (95% of commits) | OTA (~25s) | CI build (~10m) — **PARALLEL, automatic** | Tablets get updates in seconds; iPhone within minutes; no manual user step |
| **WARM** | Native changes (app.json, plugins/, modules/, native deps) | CI build via GitHub Actions | CI build in parallel | New compiled binaries for both platforms |
| **STAGING** | Recovery only — when HOT iOS CI failed/cancelled | — | iOS rebuild on demand | Restore the iPhone IPA without disturbing tablets |

The historical bug (fixed 2026-05-17, `dir_1779023696807`): HOT used to skip iOS entirely. Pipeline.md said "iOS = on demand." iPhone is primary, so HOT-only deploys never reached the device King Kazuma actually used. The fix is in `backend/bridge/agent-spawner.js` line ~1610: HOT branch now calls `spawnDetachedDeploy("ios", buildIosDeployCommand(directive))` in parallel with the OTA.

## What Cipher does and doesn't do

### Cipher DOES
- Create directives for code work
- Branch + commit with directive ID
- Call `merge-and-deploy` (the only legitimate deploy path)
- Report tier + ETA + cached IPA path

### Cipher does NOT
- Commit directly to main (hook blocks it)
- Commit without a directive ID (hook blocks it)
- Run `./scripts/ota-deploy.sh` manually after merge (smartDeploy does it)
- Run `./scripts/deploy.sh` manually after merge (same)
- Run `gh workflow run build-ios.yml` manually after merge (HOT auto-does it — manual creates a duplicate)
- Skip hooks with `--no-verify` (principle violation)
- Force-push to main (destructive — explicit auth required)
- Touch the immutable `cipher.sh` / `routes/cipher.js` files (chattr +i for a reason)

## How smartDeploy decides the tier

`backend/bridge/agent-spawner.js` → `smartDeploy(directive)` scans the diff:

1. If any change touches native paths (`frontend/app.json`, `frontend/plugins/**`, `frontend/modules/**/android/**`, `frontend/modules/**/ios/**`, native deps in `package.json`) → **WARM**
2. Else if any change touches `frontend/**/*.tsx` → **HOT**
3. Else if TV changes → TV-specific HOT or WARM
4. Else if hardware firmware changes → firmware tier
5. Else if bridge code changes → bridge restart (with 60s/10s delay based on tier)
6. Else → no deploy needed

The dispatch is single-pass — a directive that touches both native and JS goes WARM (the larger change dominates).

## Bridge restart specifics

If a commit touches `backend/bridge/**` core files, `smartDeploy` waits before restarting the bridge:
- 60s delay for HOT-tier deploys (let OTA finish first)
- 10s delay for WARM-tier deploys (let CI builds queue first)

Cipher does NOT restart the bridge manually. `docker restart bridge` is only legitimate if the user explicitly asks for it OR if smartDeploy's wait period was missed for some reason (rare).

## The light pipeline (self-improvement)

PRINCIPLES § II.7. For Cipher meta-work — INVENTORY.md, `.claude/rules/`, `.cipher/` tooling, `MEMORY.md` — the path is:

1. Create a directive (still required by the hook)
2. Branch `cipher/dir_xxx`
3. Commit
4. Push to main (manual `git push` or `git merge --no-ff` + push)
5. NO `merge-and-deploy` — the change isn't app code, doesn't OTA, doesn't build iOS

This was decided 2026-04-24 (`feedback_self_improvement_pipeline.md`) and applies whenever Cipher is editing its own scaffolding rather than the running app.

## Decision matrix (canonical in `.claude/rules/pipeline.md`)

| Changed files | Android | iOS | Tier |
|---|---|---|---|
| `frontend/**/*.tsx` (no native) | OTA (~25s) | CI build (~10m, parallel) | HOT |
| `frontend/app.json` | CI build | CI build | WARM |
| `frontend/plugins/**` | CI build | CI build | WARM |
| `frontend/modules/**/android/**` | CI build | CI build | WARM |
| `tv/**/*.tsx` (no native) | TV OTA | — | HOT |
| `tv/app.json` or `tv/plugins/**` | TV CI build | — | WARM |
| `hardware/**` | — | — | Firmware |
| `backend/bridge/**` (core) | — | — | Bridge restart |
| `.cipher/**`, `.claude/rules/**`, `INVENTORY.md` | — | — | Light pipeline (no deploy) |

## Why memory dies and code wins (PRINCIPLES § VIII.25)

The HOT-tier iOS skip regressed 4 times because each session Cipher would:
1. Read `pipeline.md`, find "iOS = on demand"
2. Tell King Kazuma to run `/stage-ios`
3. King Kazuma rage
4. Cipher writes a feedback memory: "iPhone is primary, don't punt iOS to user"
5. Memory dies between sessions
6. Repeat from step 1

The fix that worked (May 2026): edit `agent-spawner.js` HOT branch to actually spawn iOS in parallel. Update `pipeline.md` to match. Add `feedback_ios_pipeline.md` as a *reminder*, but the load-bearing fix is in code, not memory.

Pattern: whenever a behavioral regression keeps recurring, the durable fix is in the pipeline / hook / tool — not another memory file.

## Related principles & memories

- PRINCIPLES § II (the whole pipeline section), § I.3 (iPhone primary), § VIII.25 (code wins)
- Rules: `.claude/rules/pipeline.md`, `.claude/rules/print-pipeline.md`, `.claude/rules/soc-command-execution.md`
- Memory: `feedback_ios_pipeline.md`, `feedback_self_improvement_pipeline.md`, `feedback_do_the_work.md`
- Code: `backend/bridge/agent-spawner.js` (smartDeploy + tier dispatch)
