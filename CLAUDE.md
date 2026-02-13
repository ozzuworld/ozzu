# Ozzu — Project Notes

## Network Architecture

```
GCP VM (server)          VPN Tunnel (OpenVPN)         Home LAN
10.128.0.8 (ens4)  <-->  10.8.0.1 (tun0)  <-->  ER605 router (10.8.0.2)
                                                      |
                                                 172.168.0.0/24
                                                      |
                                        ┌─────────────┼─────────────┐
                                  tab-roaming     tab-lroom      tv-lroom
                                  .53              .57             .56
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

## Devices

Naming convention: `ozzu-{type}-{location}-{number}`

| Name              | Model       | IP            | ADB Port (changes!) | Arch      |
|-------------------|-------------|---------------|----------------------|-----------|
| ozzu-tab-roaming-01 | Samsung SM_P610 | 172.168.0.53 | 44847 | arm64-v8a |
| ozzu-tab-lroom-01   | Samsung SM_P610 | 172.168.0.57 | 35897 | arm64-v8a |
| ozzu-tv-lroom-01    | 4K Smart TV     | 172.168.0.56 | 36331 | armeabi-v7a |

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
- **Frontend deploy** (preferred — builds on GitHub Actions, zero local CPU):
  1. Push to `main` → GitHub Actions builds APK automatically (~10 min)
  2. Deploy: `./scripts/deploy.sh` (downloads artifact + installs all devices)
  3. Target specific devices: `./scripts/deploy.sh tab-lroom tv-lroom`
  4. Local build: `./scripts/deploy.sh --local`
- **Local build** (only if needed — uses server CPU):
  1. `cd frontend/android && ./gradlew assembleDebug -x lint -x test -PreactNativeArchitectures=armeabi-v7a,arm64-v8a`
  2. `./scripts/deploy.sh --local`
- **Key details**:
  - `debuggableVariants = []` via `plugins/force-bundle-js.js` — JS always embedded, no Metro
  - ABI split: armeabi-v7a + arm64-v8a — APK is ~84MB (down from 165MB)
  - `adb reverse` does NOT work over wireless ADB/VPN — don't waste time on it
- June talks to Bridge at `http://10.8.0.1:3333` from the devices
