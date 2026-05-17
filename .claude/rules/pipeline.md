---
paths:
  - "**"
---

# Deploy Pipeline — Three Tiers

Cipher MUST understand and correctly use these tiers. Using the wrong tier wastes time or misses devices.

## Tier 1: HOT (~25s Android OTA + ~10 min iOS CI in parallel) — JS-only changes

**Trigger:** `merge-and-deploy` when only JS/TSX files changed (no native code)
**What happens:** Android OTA (~25s) AND iOS CI build (~10 min) — **both run in parallel automatically**.
**Devices updated:** Android tablets + redroid mirror (via ADB double-restart). iOS IPA cached to `artifacts/ozzu-latest.ipa` when CI finishes.
**iOS:** **Built automatically every time.** iPhone is King Kazuma's PRIMARY device. Do NOT make him run `/stage-ios` manually for HOT deploys.

This is the fast path. 95% of changes are JS-only. OTA gets to tablets in 25s; iPhone IPA is ready ~10 min later. Cipher does not need to call `/stage-ios` — smartDeploy spawns the iOS build itself.

## Tier 2: WARM (~10 min) — Native changes

**Trigger:** `merge-and-deploy` when native files changed (app.json, plugins/, modules/, native deps in package.json)
**What happens:** Android CI build + iOS CI build in parallel via GitHub Actions
**Devices updated:** Android tablets get new APK via `deploy.sh`. iOS IPA cached to `artifacts/ozzu-latest.ipa`.

Native = anything that changes the compiled binary: `app.json`, `plugins/**`, `modules/**/android/**`, `modules/**/ios/**`, new native npm deps.

## Tier 3: STAGING (explicit, rarely needed) — iOS rebuild on demand

**Trigger:** `stage_ios` MCP tool (only when iOS CI failed or skipped, and King Kazuma needs a rebuild)
**What happens:** iOS CI build only. IPA cached to `artifacts/ozzu-latest.ipa`.
**When to use:** Iff the HOT-tier iOS build failed/cancelled and you need to rebuild. Normal HOT deploys already build iOS — this is the recovery path.

## Decision Matrix

| Changed files | Android | iOS | Tier |
|---------------|---------|-----|------|
| `frontend/**/*.tsx` (no native) | OTA (~25s) | CI build (~10 min, parallel) | HOT |
| `frontend/app.json` | CI build | CI build | WARM |
| `frontend/plugins/**` | CI build | CI build | WARM |
| `frontend/modules/**/android/**` | CI build | CI build | WARM |
| `tv/**/*.tsx` (no native) | TV OTA | — | HOT |
| `tv/app.json` or `tv/plugins/**` | TV CI build | — | WARM |
| `hardware/positioning/**` | — | — | Firmware |
| `backend/bridge/**` (core files) | — | — | Bridge restart |
| King Kazuma says "build iPhone" | — | CI build | STAGING |

## Scripts

| Script | Purpose | Tier |
|--------|---------|------|
| `./scripts/ota-deploy.sh --restart` | Android-only OTA + double-restart | HOT |
| `./scripts/ota-deploy-tv.sh` | TV Android OTA | HOT |
| `./scripts/deploy.sh` | Install APK from CI to Android devices | WARM |
| `stage_ios` MCP tool | Trigger iOS CI build | STAGING |
| `merge-and-deploy` MCP tool | Auto-detects tier and runs correct pipeline | ALL |

## Rules for Cipher

1. **iPhone is King Kazuma's PRIMARY device** — every frontend HOT deploy auto-builds iOS in parallel. Do NOT make him run `/stage-ios`.
2. **ALWAYS use `merge-and-deploy`** — it auto-detects the correct tier. Don't manually run scripts after merge.
3. **After HOT deploy**, tell King Kazuma: "Tablets updated (~25s). iPhone IPA still building (~10 min), will land at artifacts/ozzu-latest.ipa."
4. **OTA needs double-restart** — 1st launch downloads, 2nd launch applies. `ota-deploy.sh --restart` handles this automatically.
5. **Bridge restart delay** — if bridge code changed, smartDeploy waits 60s (HOT) or 10s (WARM) before restarting. Don't restart manually.
