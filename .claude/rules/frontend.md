---
paths:
  - "frontend/**"
---

# Frontend Rules

- Ozzu is a React Native + Expo app — NOT a website
- "dashboard" = the RN app in `frontend/`
- **App is iOS-ONLY** (dir_1782138428827) — no Android build/APK/mirror
- JS/TSX changes deploy via **OTA** (`ota-deploy.sh`, ~30s, no reinstall) — expo-updates downloads on launch N, applies on N+1 (tell King Kazuma to force-quit + reopen twice)
- Native changes (`app.json`, `plugins/**`, `modules/**/ios/**`, new native deps) → iOS CI build → `artifacts/ozzu-latest.ipa` → sideload via SideStore/AltStore
- **NEVER** manually trigger `build-ios.yml` — use `merge-and-deploy` which auto-picks the tier
- See `.claude/rules/pipeline.md` for the canonical deploy docs

## Verification
- `cd frontend && npx expo export --platform ios --clear`
- Config plugins: `node -c frontend/plugins/<file>.js`
