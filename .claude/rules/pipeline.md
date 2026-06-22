---
paths:
  - "**"
---

# Deploy Pipeline

**The Ozzu app is iOS-ONLY (dir_1782138428827).** There is NO Android build, OTA, APK, or Redroid mirror for the app — decommissioned. The only other deployable frontend is the **TV app** (`tv/`), which IS Android (Android TV) with its own OTA. Don't conflate them.

## The Ozzu app — iOS only

**Trigger:** `merge-and-deploy` on a `cipher/dir_*` branch.
**What happens:** the iOS IPA builds in GitHub Actions CI (~10 min) and caches to `artifacts/ozzu-latest.ipa`. **iOS CI runs its OWN Node/Xcode in the cloud — fully independent of this box's host toolchain.**
**Install:** King Kazuma refreshes via SideStore/AltStore on his iPhone (his only app device). The iPhone NEVER receives OTA — every app change is a native CI build + sideload.
**No Android, no fast lane.** No `ota-deploy.sh`, no APK, no mirror. There is no JS-only "HOT ~25s" path anymore (that was Android OTA, now gone) — every app change goes through the ~10-min iOS CI build.

### Native vs JS — same path now
Both go through the same iOS CI build. `app.json` / `plugins/**` / `modules/**/ios/**` / new native deps = a native rebuild (same ~10 min). There is no separate JS fast lane.

### STAGING (recovery)
`stage_ios` MCP tool — rebuild the iOS IPA on demand if a `merge-and-deploy` iOS build failed/cancelled.

## The TV app (`tv/`) — Android TV, SEPARATE from the app

| Change | Command | Notes |
|---|---|---|
| `tv/**/*.tsx` (JS only) | `./scripts/ota-deploy-tv.sh` | TV Android OTA (~25s). **Bundles LOCALLY on the host → needs host Node ≥ current LTS** (Metro needs Node 20+). |
| `tv/app.json` / `tv/plugins/**` | CI APK on `tv/` push to main | self-installs via Device Owner |

## Other targets
| Changed files | Action |
|---|---|
| `backend/bridge/**` (core) | bridge restart (`docker compose restart bridge`); on merge, smartDeploy waits 60s before restarting |
| `hardware/positioning/**` | firmware (manual) |

## Scripts
| Script / tool | Purpose |
|---|---|
| `merge-and-deploy` MCP tool | THE app deploy — merges the cipher branch + triggers the iOS CI build. Always use it; never run build scripts manually after a merge. |
| `stage_ios` MCP tool | Rebuild the iOS IPA on demand (recovery). |
| `./scripts/ota-deploy-tv.sh` | TV Android OTA — **TV app only**. |
| `./scripts/ota-deploy.sh`, `./scripts/deploy.sh` | **DEPRECATED for the app** (were the app's Android OTA/APK). Dead path; do not use for the app. |

## Rules for Cipher
1. **The app is iOS-only.** Never reach for Android OTA / `ota-deploy.sh` / `deploy.sh` / a mirror for the app — decommissioned 2026-06-22.
2. **ALWAYS use `merge-and-deploy`** for the app — it merges + triggers the iOS build. Don't manually run build scripts after merge.
3. **After deploy**, tell King Kazuma: "iPhone IPA building (~10 min), will land at `artifacts/ozzu-latest.ipa` — refresh via SideStore."
4. **UI cannot be previewed locally** (iOS needs macOS; no mirror). Get the design right in code; King Kazuma verifies on his iPhone.
5. **Bridge restart delay** — if bridge code changed, smartDeploy waits 60s before restarting. Don't restart manually.
6. **Host Node must be ≥ current LTS (20+).** The TV OTA + any local Metro bundling needs it. (iOS CI is unaffected — separate cloud Node.)
