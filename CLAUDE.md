# Ozzu — Project Notes

## MANDATORY RULES — READ FIRST

**ALL code changes MUST go through the directive pipeline. Cipher does all work directly.**

- **NEVER commit directly to main.** Cipher works on `cipher/dir_xxx` branches, then merges after verification.
- **NEVER manually trigger builds.** smartDeploy handles CI builds (Android + iOS) and deployment automatically after merge to main.
- **Every change needs a directive** for tracking, audit trail, and dashboard visibility — even quick fixes.
- **The pipeline handles EVERYTHING**: code changes, builds, deploys to all devices (tablets, TV, iPhone).
- **iPhone NEVER receives OTA updates.** ALL iPhone changes (JS or native) require a full iOS CI build (`gh workflow run build-ios.yml`) + sideload via `deploy-ios.sh`. NEVER say OTA will update the iPhone. NEVER run `ota-deploy.sh` expecting it to reach the iPhone. This is a hard platform limitation.
- **Cipher MUST monitor the pipeline proactively.** Check for `deploy_failed`, `blocked`, and stuck directives. Fix merge failures, retry failed deploys, resolve blockers. Do NOT wait for King Kazuma to notice — that is Cipher's job.
- **Every commit MUST reference a directive ID** in the commit message (e.g., `Directive: dir_1234567890`).
- **iPhone is the ONLY device that handles PIN approvals.** Tablets and TV NEVER show keypads or biometric prompts. PIN requests are sent ONLY to devices with deviceType "phone" via broadcastToDeviceType("phone"). This is enforced server-side.
- **Ozzu is a React Native app — there is NO website.** ALL user-facing UI lives in `frontend/`. The bridge server's `/dashboard` endpoint is an internal dev tool only — NEVER build features, redesigns, or user-facing UI there. When King Kazuma says "dashboard", "UI", "screen", or "layout", he means the **React Native app in `frontend/`**, NEVER the bridge web page. Do NOT propose or implement web-based solutions.
- **Cipher MUST use the memory system.** Launch Cipher via `./scripts/cipher.sh` to load context from past sessions. Session transcripts are auto-saved via the SessionEnd hook. If context seems missing, check `/cipher/context` and the session-save hook logs at `/tmp/ozzu-bridge/cipher-session-save.log`.

### Cipher Workflow (CRITICAL - READ BEFORE EVERY CODE CHANGE)

Cipher does all work directly — no worker agents, no orchestrator. Directives are for tracking and audit.

**Step 1: Does this require code/config changes?**
- NO → Handle directly (status queries, research, reading files, answering questions)
- YES → Continue to Step 2

**Step 2: Create or find an existing directive**
```bash
curl -s -X POST http://localhost:3333/directives -H 'Content-Type: application/json' \
  -d '{"title":"...", "description":"...", "type":"quick|feature", "createdBy":"cipher"}'
```

**Step 3: Is this a new feature (type=feature)?**
- YES → Set status to `planned` with a plan. Wait for King Kazuma's PIN approval before implementing.
- NO (fix/debug/config/refactor) → Set status to `in_progress` and proceed immediately.

**Step 4: Do the work**
1. Create branch: `git checkout -b cipher/dir_xxx`
2. Make changes, commit with `Directive: dir_xxx` in message
3. Run verification (see Verification Commands below)
4. Call `POST /directives/{id}/merge-and-deploy` to merge + deploy
5. Directive is auto-completed on successful merge

**If something goes wrong:**
- Verification fails → Fix it on the branch and retry
- Merge conflict → Resolve it, don't force-push
- Deploy fails → Check logs, fix, re-deploy
- Stuck/blocked → Set directive to `blocked` with `failureReason` and tell King Kazuma

**Key principles:**
- Cipher has full project context (memories, briefing, CLAUDE.md) — use it
- Work on branches, never directly on main
- Verify before merging — broken code should never reach main
- Log activity to the directive for dashboard visibility

## Pipeline Enforcement

The pipeline is protected by automated bypass detection. A pre-commit hook ensures audit trail integrity:

- **All commits must reference a directive ID** in the commit message (e.g., `dir_1234567890`) or be on a `cipher/*` or `agent/*` branch
- **Direct commits to `main`** are blocked by the pre-commit hook unless they match an exception
- **Commit messages should include** `Directive: <directive_id>` for audit trail linkage

**Exception tags** (add to commit message to bypass on main):
| Tag | Use Case |
|-----|----------|
| `[pipeline-fix]` | Infrastructure fixes when the pipeline itself is broken |
| `[config]` | `.env` or config-only changes |
| `[docs]` | Documentation-only changes (`*.md` files) |
| `[security]` | Emergency security patches |

**Auto-detected exceptions** (no tag needed):
- Only `.md` files are staged
- Only `.env*` files are staged

**Hook installation:** `git config core.hooksPath .githooks` (hooks live in `.githooks/` tracked in git)

**Violations API:**
- `GET /api/pipeline-violations` — list all violations
- `POST /api/pipeline-violations` — record a violation (called by git hooks)
- `POST /api/pipeline-violations/:id/resolve` — dismiss a violation (requires auth)

## Build Verification Requirements

Cipher MUST verify before merging to main. The `POST /directives/:id/merge-and-deploy` endpoint runs verification automatically, but Cipher can also verify manually:

```bash
curl -s -X POST http://localhost:3333/directives/{directive_id}/verify -H 'Content-Type: application/json' -d '{}'
```

Verification must return `"success": true`. The merge-and-deploy endpoint will reject the merge if verification fails.

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
- **Smart deploy** (triggered automatically after merge to main):
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

**Verification is BLOCKING — Cipher MUST run these checks before merging to main.**
Skipping verification has broken CI builds. The merge-and-deploy endpoint also runs automated checks and will reject the merge if they fail.

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
- If verification fails, fix the issue on the branch and retry
- If stuck, set directive to `blocked` with `failureReason` and tell King Kazuma
- Verification results are logged to `activity_log` for debugging
