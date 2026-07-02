# scripts/telemetry — Ozzu fleet telemetry module

The uniform telemetry agents + onboarding for the device fleet. **Full reference
(architecture, contract, troubleshooting, per-device gotchas): [`/FLEET.md`](../../FLEET.md).**

## Contents

| File | What |
|---|---|
| `onboard-device.sh` | **Start here.** One-command onboarding: mint token → deploy agent → supervise → verify. |
| `ozzu-telemetry-android.sh` | Android agent — toybox-safe, tiered vitals, POSTs via static curl. |
| `03-ozzu-telemetry.sh` | Android supervisor (Magisk `service.d`): boot-persist + wakelock + watchdog. Sources `telemetry.env`. |
| `bin/ozzu-curl-aarch64` | Vendored static-pie curl 8.21.0 (aarch64). A real HTTP client — toybox `nc` is unusable for HTTP on old Android. |
| `ozzu-telemetry.service` | Linux systemd unit template (`Restart=always`). |
| `../ozzu-telemetry-linux.sh` | Linux agent (rich). Installed as `/usr/local/bin/ozzu-telemetry.sh`. |
| `../../backend/bridge/scripts/issue-device-token.js` | Mint/rotate a per-device token (run via `docker exec bridge node …`). |

## Onboard a device

```bash
scripts/telemetry/onboard-device.sh <device_id> <android|linux> <target> [role]
# android target = adb serial over WG (e.g. 10.9.0.22:5555)
# linux   target = ssh host, or "local" for the bridge host
```

## Design in one line

Identity comes from the **token** (never the body); the agent is **generic**, per-device
config lives in `telemetry.env` (Android) / systemd `Environment=` (Linux); **liveness is
two-signal** (WG handshake = up/down, telemetry = vitals). See `/FLEET.md`.
