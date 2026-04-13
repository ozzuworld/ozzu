---
paths:
  - "frontend/**"
---

# Frontend Rules

- Ozzu is a React Native + Expo app — NOT a website
- "dashboard" = the RN app in `frontend/`
- iPhone NEVER receives OTA — requires native build + sideload via AltStore on Windows PC
- Android gets OTA via `./scripts/ota-deploy.sh --restart`
- iOS build: `gh workflow run build-ios.yml` → IPA cached at `artifacts/ozzu-latest.ipa`
- User installs IPA manually — NEVER automate iOS install

## Verification
- `cd frontend && npx expo export --platform android`
- Config plugins: `node -c frontend/plugins/<file>.js`
