---
paths:
  - "frontend/**"
---

# Frontend Rules

- Ozzu is a React Native + Expo app — NOT a website
- "dashboard" = the RN app in `frontend/`
- **App is iOS-PRIMARY** (dir_1782138428827) with an **interim Android target** (KK order 2026-09-27, dir_1790538151856): KK is running the app on Android for the time being — `build-android.yml` produces a sideloadable APK (`android-latest` GitHub Release → `ozzu.apk`, cached to `artifacts/ozzu-latest.apk`). Still no Redroid mirror/screenshot loop.
- JS/TSX changes deploy via **OTA** (`ota-deploy.sh`, ~30s, no reinstall) — expo-updates downloads on launch N, applies on N+1 (tell King Kazuma to force-quit + reopen twice). The manifest serves **iOS + Android** bundles — an installed APK picks up JS OTA exactly like the iPhone (runtimeVersion 1.0.0 gate applies to both).
- Native changes (`app.json`, `plugins/**`, `modules/**/ios/**`, new native deps) → iOS CI build → `artifacts/ozzu-latest.ipa` → sideload via SideStore/AltStore. Android native → `gh workflow run build-android.yml` (or push-main on native paths) → APK → sideload.
- **NEVER** manually trigger `build-ios.yml` — use `merge-and-deploy` which auto-picks the tier
- See `.claude/rules/pipeline.md` for the canonical deploy docs

## Verification
- `cd frontend && npx expo export --platform ios --clear`
- Config plugins: `node -c frontend/plugins/<file>.js`
