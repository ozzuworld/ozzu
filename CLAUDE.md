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
- **TV IP**: 172.168.0.56 (ADB port changes frequently — currently 34387)
- **Tablet IP**: 172.168.0.53 (Samsung tablet, runs the ozzu app — ADB port changes, currently 41107)
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

- **Tablet**: Samsung SM_P610 at 172.168.0.53 (ADB port changes — currently 41107)
- **TV**: 4K Smart TV at 172.168.0.56 (ADB port changes — currently 34387)
- Connect: `adb connect 172.168.0.53:<PORT>` / `adb connect 172.168.0.56:<PORT>`

## Key Personas

- **King Kazuma**: The user/architect
- **June**: Gemini Live AI companion (runs on tablet/TV app)
- **Cipher**: Claude Code agent (runs on GCP VM)

## Dev Workflow — IMPORTANT

- **Bridge server**: runs in Docker (`docker compose restart bridge` to reload code changes)
- **Frontend rebuild + deploy** (JS bundle is embedded in APK — no Metro needed):
  1. `cd frontend/android && ./gradlew assembleDebug -x lint -x test` (builds APK with JS bundled in)
  2. Install: `adb -s 172.168.0.53:<PORT> install -r android/app/build/outputs/apk/debug/app-debug.apk`
  3. Launch: `adb -s <device> shell am start -n com.anonymous.ozzu/.MainActivity`
  4. `debuggableVariants = []` in build.gradle forces JS embedding — Metro is NOT needed
  5. `adb reverse` does NOT work over wireless ADB/VPN — don't waste time on it
  6. APK is ~165MB, install over VPN takes 2-3 minutes per device
- June talks to Bridge at `http://10.8.0.1:3333` from the devices
