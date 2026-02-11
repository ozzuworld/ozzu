# Ozzu — Project Notes

## Network Architecture

```
GCP VM (server)          VPN Tunnel (OpenVPN)         Home LAN
10.128.0.8 (ens4)  <-->  10.8.0.1 (tun0)  <-->  ER605 router (10.8.0.2)
                                                      |
                                                 172.168.0.0/24
                                                      |
                                            TV: 172.168.0.56
```

- **GCP VM**: 10.128.0.8 (public cloud), 10.8.0.1 (VPN endpoint)
- **Home router**: TP-Link ER605, VPN client name `r605`, bridges home LAN to GCP via OpenVPN
- **Home LAN subnet**: 172.168.0.0/24
- **TV IP**: 172.168.0.56 (ADB port changes frequently — currently 36331)
- **Tablet IP**: 172.168.0.53 (Samsung tablet, runs the ozzu app — ADB port changes, currently 44847)
- **VPN**: OpenVPN UDP/1194, AES-256-CBC, `client-to-client` enabled, `iroute` for 172.168.0.0/24 via r605

## Services (all on GCP VM, network_mode: host)

| Service         | Port  | Notes                              |
|-----------------|-------|------------------------------------|
| Home Assistant  | 8123  | Proxied via nginx at home.ozzu.world |
| Bridge server   | 3333  | Command bridge (Claude Code <-> June) |
| Nginx           | 80/443| SSL via Let's Encrypt + Cloudflare DNS |
| OpenVPN         | 1194  | UDP, connects home ER605 router    |

## Frontend (Expo React Native)

- Debug APK (DEBUGGABLE flag) — connects to Metro bundler for JS
- `.env` uses `10.8.0.1` (VPN IP) for HA and Bridge URLs so devices reach GCP services through VPN
- App package: `com.anonymous.ozzu`, activity: `.MainActivity`

## Devices

- **Tablet**: Samsung SM_P610 at 172.168.0.53 (ADB port changes — currently 44847)
- **TV**: 4K Smart TV at 172.168.0.56 (ADB port changes — currently 36331)
- Connect: `adb connect 172.168.0.53:<PORT>` / `adb connect 172.168.0.56:<PORT>`

## Key Personas

- **King Kazuma**: The user/architect
- **June**: Gemini Live AI companion (runs on tablet/TV app)
- **Cipher**: Claude Code agent (runs on GCP VM)

## Dev Workflow — IMPORTANT

- **Bridge server**: runs in Docker (`docker compose restart bridge` to reload code changes)
- **Frontend deploy** (preferred — builds on GitHub Actions, zero local CPU):
  1. Push to `main` → GitHub Actions builds APK automatically (~10 min)
  2. Deploy: `./scripts/deploy.sh` (downloads artifact + installs both devices)
  3. Or manual: `./scripts/deploy.sh --local` to install a locally-built APK
- **Local build** (only if needed — uses server CPU):
  1. `cd frontend/android && ./gradlew assembleDebug -x lint -x test -PreactNativeArchitectures=arm64-v8a`
  2. `./scripts/deploy.sh --local`
- **Key details**:
  - `debuggableVariants = []` via `plugins/force-bundle-js.js` — JS always embedded, no Metro
  - ABI split: arm64-v8a only — APK is ~56MB (down from 165MB)
  - `adb reverse` does NOT work over wireless ADB/VPN — don't waste time on it
- June talks to Bridge at `http://10.8.0.1:3333` from the devices
