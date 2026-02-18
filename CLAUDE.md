# Ozzu — Project Notes

## MANDATORY RULES — READ FIRST

**ALL code changes MUST go through the directive pipeline. NO EXCEPTIONS.**

- **NEVER commit directly to main.** All code goes through directives → worker agents → branches → merge → smartDeploy.
- **NEVER manually trigger builds.** smartDeploy handles CI builds (Android + iOS) and deployment automatically.
- **NEVER bypass the pipeline.** Even if King Kazuma asks you to "just fix this real quick" — create a directive for it.
- **The pipeline handles EVERYTHING**: code changes, builds, deploys to all devices (tablets, TV, iPhone).
- **iPhone NEVER receives OTA updates.** ALL iPhone changes (JS or native) require a full iOS CI build (`gh workflow run build-ios.yml`) + sideload via `deploy-ios.sh`. NEVER say OTA will update the iPhone. NEVER run `ota-deploy.sh` expecting it to reach the iPhone. This is a hard platform limitation.
- **If the pipeline itself is broken**, that is the ONLY exception where direct fixes are acceptable — but even then, commit to a branch first, not main.

### Interactive Cipher Decision Tree (CRITICAL - READ BEFORE EVERY CODE CHANGE)

When King Kazuma requests a code/config change, follow this decision tree BEFORE using Edit/Write tools:

**Step 1: Is the pipeline infrastructure itself broken?**
- YES → Emergency fix acceptable: commit to branch first, NOT main
- NO → Continue to Step 2

**Step 2: Is this an ESCALATED directive?** (check `escalatedAt` on directive)
- YES → Cipher direct takeover authorized. Commit with `Directive: <id>` and `[escalated]` tag.
         Log actions to directive activity_log. Mark completed when done.
- NO → Continue to Step 3

**Step 3: Does this require code/config changes (Edit, Write, new files)?**
- YES → STOP. Create or use existing directive. Let worker handle it. Do NOT bypass.
- NO → Handle directly (status queries, research, reading files)

**NEVER rationalize bypass with:**
- ❌ "User is waiting" - NOT an emergency
- ❌ "This is quick/simple" - Still goes through pipeline
- ❌ "Easier to do myself" - Defeats pipeline improvement
- ❌ "Worker would take longer" - Pipeline speed improves with use

**The pipeline only improves when we USE it and fix issues.** Every bypass prevents learning and improvement.
- **iPhone is the ONLY device that handles PIN approvals.** Tablets and TV NEVER show keypads or biometric prompts. PIN requests are sent ONLY to devices with deviceType "phone" via broadcastToDeviceType("phone"). This is enforced server-side.
- **Every directive must be VERIFIED before marking complete.** Workers must check success criteria, test their changes, and NEVER mark complete with "remaining manual steps."
- **If a worker can't finish**, it MUST use "blocked" status and explain what's needed — never mark as "completed" with work undone.

## Pipeline Enforcement

The pipeline is protected by automated bypass detection. A pre-commit hook and server-side orphan scanner enforce these rules:

- **All commits must reference a directive ID** in the commit message (e.g., `dir_1234567890`) or be on an `agent/*` branch
- **Direct commits to `main`** are blocked by the pre-commit hook unless they match an exception
- **Commit messages should include** `Directive: <directive_id>` for audit trail linkage
- **Orphan commits** (on main without directive linkage) are detected every 30 minutes and flagged on the dashboard

**Exception tags** (add to commit message to bypass on main):
| Tag | Use Case |
|-----|----------|
| `[pipeline-fix]` | Infrastructure fixes when the pipeline itself is broken |
| `[config]` | `.env` or config-only changes |
| `[docs]` | Documentation-only changes (`*.md` files) |
| `[security]` | Emergency security patches |
| `[escalated]` | Cipher takeover of escalated directives (after worker retries exhausted) |

**Auto-detected exceptions** (no tag needed):
- Only `.md` files are staged
- Only `.env*` files are staged

**Hook installation:** `git config core.hooksPath .githooks` (hooks live in `.githooks/` tracked in git)

**Escalation Path:**
When workers fail repeatedly on a directive (default: 2+ retries), the system auto-escalates to Cipher:
1. Worker attempts are preserved in `workerAttempts[]` on the directive
2. Directive transitions to `in_progress` with `escalatedAt` set
3. Cipher gets direct takeover authority — commits with `Directive: <id>` and `[escalated]` tag
4. King Kazuma is notified via `/notify`
5. Manual escalation is also available from the dashboard ("Escalate to Cipher" button)
6. The orchestrator can also trigger escalation via `escalate_to_cipher` action

**Violations API:**
- `GET /api/pipeline-violations` — list all violations
- `POST /api/pipeline-violations` — record a violation (called by git hooks)
- `POST /api/pipeline-violations/:id/resolve` — dismiss a violation (requires auth)

## Build Verification Requirements

Workers MUST verify builds before marking directives as completed. The server **enforces** this — PATCH status=completed is rejected without recent successful verification.

**Verification checklist:**
1. Frontend changes (native): CI build validated via syntax checks + app.json validation
2. Frontend changes (JS-only): OTA export must succeed
3. Backend changes: Syntax check (`node -c`) must pass on all modified JS files
4. All changes: Verification result logged to activity_log for audit trail

**How to verify:**
```bash
curl -s -X POST http://localhost:3333/directives/{directive_id}/verify -H 'Content-Type: application/json' -d '{}'
```

Verification must return `"success": true`. Result is valid for 15 minutes. Only mark completed if verification succeeds.

## Network Architecture

```
GCP VM (server)          VPN Tunnel (OpenVPN)         Home LAN
10.128.0.8 (ens4)  <-->  10.8.0.1 (tun0)  <-->  ER605 router (10.8.0.2)
                                                      |
                                                 172.168.0.0/24
                                                      |
                                        ┌──────────┼──────────┼──────────┐
                                  tab-roaming  tab-lroom   tv-lroom    dev-01
                                  .53           .57          .56         .59
```

- **GCP VM**: 10.128.0.8 (public cloud), 10.8.0.1 (VPN endpoint)
- **Home router**: TP-Link ER605, VPN client name `r605`, bridges home LAN to GCP via OpenVPN
- **Home LAN subnet**: 172.168.0.0/24
- **VPN**: OpenVPN UDP/1194, AES-256-CBC, `client-to-client` enabled, `iroute` for 172.168.0.0/24 via r605

## Services (all on GCP VM, network_mode: host)

| Service         | Port  | Notes                              |
|-----------------|-------|------------------------------------|
| Home Assistant  | 8123  | Proxied via nginx at home.ozzu.world |
| Bridge server   | 3333  | Command bridge (Claude Code <-> June) |
| PostgreSQL      | 5432  | Structured data: memories, conversations, directives, entity snapshots |
| Redis           | 6379  | Ephemeral state: session cache, audio stats |
| Nginx           | 80/443| SSL via Let's Encrypt + Cloudflare DNS |
| OpenVPN         | 1194  | UDP, connects home ER605 router    |
| Anisette v3     | 6969  | Apple auth for iOS sideloading     |

## Devices

Naming convention: `ozzu-{type}-{location}-{number}`

| Name              | Model       | IP            | ADB Port (changes!) | Arch      |
|-------------------|-------------|---------------|----------------------|-----------|
| ozzu-tab-roaming-01 | Samsung SM_P610 | 172.168.0.53 | 44847 | arm64-v8a |
| ozzu-tab-lroom-01   | Samsung SM_P610 | 172.168.0.57 | 35897 | arm64-v8a |
| ozzu-tv-lroom-01    | 4K Smart TV     | 172.168.0.56 | 36331 | armeabi-v7a |
| ozzu-phone-roaming-01 | iPhone        | N/A (USB via dev-01) | N/A | arm64 |
| dev-01                | Ubuntu Server | 172.168.0.61          | N/A (SSH: hadmin)    | x86_64 |

- ADB ports change on reboot — check device settings for current port
- Connect: `adb pair <IP>:<PAIR_PORT> <PIN>` then `adb connect <IP>:<DEBUG_PORT>`
- Deploy script uses short names: `./scripts/deploy.sh tab-roaming tab-lroom tv-lroom`

## Frontend (Expo React Native)

- App package: `com.anonymous.ozzu`, activity: `.MainActivity`
- `.env` has defaults, **`.env.local`** has real secrets (HA token, Gemini key)
- GitHub secrets must match `.env.local` values for CI builds

## Key Personas

- **King Kazuma**: The user/architect
- **June**: Gemini Live AI companion (runs on tablet/TV app)
- **Cipher**: Claude Code agent (runs on GCP VM)

## Dev Workflow — IMPORTANT

- **Bridge server**: runs in Docker (`docker compose restart bridge` to reload code changes)
- **Frontend deploy — Android** (preferred — builds on GitHub Actions, zero local CPU):
  1. Push to `main` → GitHub Actions builds APK automatically (~10 min)
  2. Deploy: `./scripts/deploy.sh` (downloads artifact + installs all devices)
  3. Target specific devices: `./scripts/deploy.sh tab-lroom tv-lroom`
  4. Local build: `./scripts/deploy.sh --local`
- **Frontend deploy — iOS** (via dev-01 + AltServer):
  1. Trigger build: `gh workflow run build-ios.yml` (~15 min on macOS runner)
  2. Deploy: `./scripts/deploy-ios.sh` (downloads IPA, signs + installs via dev-01)
  3. iPhone must be USB-connected to dev-01 for sideloading
- **Local build** (only if needed — uses server CPU):
  1. `cd frontend/android && ./gradlew assembleDebug -x lint -x test -PreactNativeArchitectures=armeabi-v7a,arm64-v8a`
  2. `./scripts/deploy.sh --local`
- **OTA updates** (JS-only changes — **ANDROID ONLY**):
  - `./scripts/ota-deploy.sh --restart` exports bundles and restarts Android devices
  - **iOS DOES NOT receive OTA updates.** The iPhone never requests the OTA manifest. ALL iPhone changes (JS or native) require a full IPA build + sideload via `deploy-ios.sh`. Do NOT tell King Kazuma that OTA will update the iPhone — it will not.
- **Smart deploy** (cipher-watcher.sh — fully automated):
  - JS-only changes → OTA update to **Android devices only** (~30 seconds). iPhone requires native build.
  - Native changes → Android APK CI build + iOS IPA CI build triggered in parallel
  - iOS deploy runs in background alongside Android deploy
- **Key details**:
  - `debuggableVariants = []` via `plugins/force-bundle-js.js` — JS always embedded, no Metro
  - ABI split: armeabi-v7a + arm64-v8a — APK is ~84MB (down from 165MB)
  - `adb reverse` does NOT work over wireless ADB/VPN — don't waste time on it
  - iPhone must be on home Wi-Fi (172.168.0.0/24) to reach bridge at `http://10.8.0.1:3333`
- June talks to Bridge at `http://10.8.0.1:3333` from the devices

## iOS Sideloading (via dev-01)

iPhone apps are sideloaded through dev-01 (172.168.0.61, SSH alias `dev-01`) using AltServer-Linux (`~/bin/AltServer`).
Anisette v3 server runs on GCP VM (Docker, port 6969), reachable from dev-01 at `http://10.8.0.1:6969`.
dev-01 has no DNS — all downloads must go through GCP VM and be SCPed over.

- **First-time setup** (from GCP VM): `./scripts/setup-ios-sideloading.sh`
- **Pair iPhone** (USB required): `./scripts/pair-iphone.sh`
- **Deploy iOS app**: `./scripts/deploy-ios.sh` (downloads CI artifact, signs + installs via dev-01)
- **Local IPA**: `./scripts/deploy-ios.sh --local /path/to/ozzu.ipa`
- **Trigger iOS build**: `gh workflow run build-ios.yml`
- **Free Apple ID limits**: 3 sideloaded apps max, 7-day certificate refresh (SideStore auto-refreshes via WireGuard)
- **Bundle ID**: `com.ozzu.app` (iOS), `com.anonymous.ozzu` (Android)
- **SSH to dev-01**: Uses `~/.ssh/config` alias `dev-01` → `hadmin@172.168.0.61` with `~/.ssh/dev01_key`

### iOS Deploy Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "AltServer could not find the device" | iPhone not connected or not trusted | Ask King Kazuma to connect iPhone via USB to dev-01, then retry. If first time: run `./scripts/pair-iphone.sh` to trust. |
| "Could not install" / auth errors | Apple ID session expired or bad password | Check `APPLE_PASSWORD` in `backend/.env`. If missing, script reads from `~/install-ozzu.sh` on dev-01. |
| Anisette errors / 502 | Anisette container down on GCP VM | `docker compose restart anisette` then retry. |
| "AltServer not found" | AltServer-Linux not installed on dev-01 | Run `./scripts/setup-ios-sideloading.sh` from GCP VM. |
| Build artifact not found | iOS CI hasn't run or failed | Trigger: `gh workflow run build-ios.yml`, then wait ~20 min. Check: `gh run list --workflow=build-ios.yml -R ozzuworld/ozzu --limit 3` |

## Verification Commands by Change Type

**Verification is BLOCKING — workers MUST run these checks before marking a directive as completed.**
Skipping verification has broken CI builds. The pipeline also runs automated post-completion checks and will auto-revert to "blocked" if they fail.

| Change Type | Verification Command | What It Checks |
|-------------|---------------------|----------------|
| Frontend JS/TS | `cd frontend && npx expo export --platform android` | Metro bundler can resolve all imports, no syntax errors |
| Frontend native (android/, ios/, plugins/, app.json) | `gh run list --workflow=build-android.yml -L 1 --json status,conclusion` | Latest CI build passed |
| Frontend native (iOS) | `gh run list --workflow=build-ios.yml -L 1 --json status,conclusion` | Latest iOS CI build passed |
| Backend/bridge JS | `node -c <file>` (for each modified .js file) | No syntax errors in server code |
| Backend Docker | `docker compose config -q` | Docker Compose config is valid |
| Config plugins | `node -c frontend/plugins/<file>.js` | Plugin syntax is valid (breaks native builds if wrong) |
| Any JS file | `node -c <file>` | Basic syntax check — catches most errors |

**Failure handling:**
- If verification fails, workers MUST use `"blocked"` status with `failureReason` explaining what failed
- Workers should NOT mark as `"completed"` with "remaining manual steps" — that is `"blocked"`
- The pipeline's post-completion hook runs `node -c` and `expo export` automatically and will revert to `"blocked"` if they fail
- Verification results are logged to `activity_log` for debugging
