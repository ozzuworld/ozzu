---
paths:
  - "**"
---

# Deploy Pipeline

**The Ozzu app is iOS-ONLY (dir_1782138428827)** — the iPhone is the only app device; there is no Android build/APK/mirror for the app. But iOS-only does **NOT** mean "always rebuild": the app ships JS changes **over-the-air (OTA)** and only does a full native CI build when native code changes. The **TV app** (`tv/`) is a separate Android-TV target with its own OTA — don't conflate them.

## The Ozzu app — two tiers (OTA architecture, 2026-06-22)

| Change | Path | Time | How it lands on the iPhone |
|---|---|---|---|
| **JS / TSX only** (components, screens, logic) | **OTA** — `ota-deploy.sh` exports the iOS+Android JS bundle; bridge serves it at `GET /api/manifest` | ~25–30s | App pulls the new JS on next launch (expo-updates `checkAutomatically: ON_LOAD`). **No reinstall.** |
| **Native** (`app.json`, `plugins/**`, `modules/**/ios/**`, new native deps) | **iOS CI build** (`build-ios.yml`) → IPA → `ios-latest` Release → `artifacts/ozzu-latest.ipa` | ~10 min | Sideload via SideStore/AltStore. Bump `runtimeVersion`. |

**Trigger:** `merge-and-deploy` on a `cipher/dir_*` branch. smartDeploy auto-detects JS-only vs native (`detectNativeChanges` / `detectFrontendChanges`) and picks the tier.

**Why OTA works on a sideloaded app:** expo-updates delivers JS via the manifest, independent of how the app was installed. The 7-day sideload signing expiry doesn't touch OTA (it updates JS, not the signature).

**runtimeVersion gate (important):** the OTA bundle's `runtimeVersion` (currently `1.0.0`, in `app.json`) must match the installed build's. A native change that breaks JS↔native compatibility MUST bump `runtimeVersion` — that bump is exactly what stops a stale JS bundle from being served to a new native build, and what forces the native-build tier.

**Gotchas that cost whole sessions (2026-06-22) — all now handled inside `ota-deploy.sh`, but know them:**
- **Stale Metro cache → stale OTA.** `expo export` can ship OLD screen code even when the working tree is current (Metro's transformer cache doesn't reliably invalidate after a git checkout/merge). `ota-deploy.sh` now exports with `--clear`. Symptom: app runs new code on one screen but old on another, or even runs JS older than the embedded build. If you ever hand-export, use `--clear` and confirm the bundle md5 / manifest `id` actually changed.
- **Empty `expoClient` → app silently rejects the update.** The manifest needs the resolved app config; `expo export` does NOT emit it. `ota-deploy.sh` generates `expoConfig.json` via `expo config --json`. Without it the app fetches the manifest then downloads 0 assets.
- **Two-step apply.** expo-updates DOWNLOADS on launch N and APPLIES on launch N+1. A single reopen looks like "nothing changed." Always tell King Kazuma: **force-quit + reopen, then force-quit + reopen again.**
- A *correct* IPA can still show *old* UI if the OTA bundle is stale (or, historically, if iOS OTA was hard-blocked in `pipeline.js`). When "new build looks identical," check the OTA bundle the manifest serves BEFORE blaming the IPA or the install. The manifest at `GET /api/manifest` is `multipart/mixed` (boundary `ota-boundary`), NOT plain JSON — grep the body for `launchAsset`, don't `json.load` it.
- **Element in the bundle but invisible on-device = layout, not delivery.** If `strings <bundle>.hbc` finds your text but King Kazuma can't see it, it's a render/overflow bug — and you can read ground-truth (installed build, expo-updates log) off the iPhone via dev-01 + `pymobiledevice3`. See memory `reference_iphone_invisible_ui_debugging`.

### STAGING (recovery)
`stage_ios` MCP tool — rebuild the iOS IPA on demand if a native `merge-and-deploy` build failed/cancelled.

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
| `merge-and-deploy` MCP tool | THE app deploy — merges the cipher branch + smartDeploy picks OTA (JS) or CI build (native). Always use it. |
| `./scripts/ota-deploy.sh` | App JS OTA — exports the **iOS + Android** bundle and publishes to the bridge manifest. Run by smartDeploy on JS-only changes; safe to run manually to re-publish. `--restart` double-restarts Android tablets (iPhone applies on its own next launch). |
| `stage_ios` MCP tool | Rebuild the iOS IPA on demand (recovery, native tier). |
| `./scripts/ota-deploy-tv.sh` | TV Android OTA — **TV app only**. |
| `./scripts/deploy.sh` | DEPRECATED (was the app's Android APK path). Dead. |

## Rules for Cipher
1. **JS change → OTA, native change → build.** Don't force a 10-min native build for a JS-only change — that's what OTA is for. Don't try to OTA a native change — bump `runtimeVersion` and build.
2. **ALWAYS use `merge-and-deploy`** for the app — smartDeploy auto-picks the tier. Don't run build/OTA scripts manually after a merge.
3. **After a JS deploy**, tell King Kazuma: "Published over-the-air — force-quit and reopen Ozzu, then do it once more (expo-updates downloads on the first launch, applies on the second)." After a native deploy: "iPhone IPA building (~10 min) → `artifacts/ozzu-latest.ipa`, refresh via SideStore."
4. **UI cannot be previewed locally** (iOS needs macOS; no mirror). Get the design right in code; King Kazuma verifies on his iPhone.
5. **Bridge restart delay** — if bridge code changed, smartDeploy waits 60s before restarting. Don't restart manually.
6. **Host Node must be ≥ current LTS (20+).** OTA bundling + any local Metro needs it. (iOS CI is unaffected — separate cloud Node.)
