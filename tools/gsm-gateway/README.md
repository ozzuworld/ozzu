# Ozzu GSM Gateway

Turns a spare Android phone (CAT S41) into a GSM-to-SIP gateway for the Ozzu SOC call investigation pipeline.

## Purpose

All incoming calls to King Kazuma's Swift number are forwarded to the CAT phone's Colombian SIM. The gateway app auto-answers, captures caller ID, bridges audio to Asterisk (on the bridge VM) via RTP, and notifies the bridge API for real-time OSINT. Screened calls ring through to the iPhone via the Ozzu app (VoIP/CallKit).

## Architecture

```
Incoming call → Swift 4G → *21* forward → CAT S41 (Colombian SIM)
                                              │
                                         GSM Gateway app
                                         auto-answers
                                         captures caller ID → bridge API
                                         bridges audio → RTP → Asterisk
                                              │
                                         Asterisk (bridge VM)
                                         AI screener (DeepSeek)
                                         SIP header analysis
                                              │
                                    ┌─────────┴─────────┐
                                    │                   │
                               Spam/Robot           Legit call
                               → hang up            → ring Ozzu app
                               → auto-OSINT           on iPhone
                               → log + probe          via VoIP
```

## Components

| Component | Location | Role |
|---|---|---|
| GSM Gateway APK | `tools/gsm-gateway/android/` | Android app on CAT S41 — auto-answers GSM, bridges audio to Asterisk |
| Asterisk PBX | `backend/asterisk/conf/` | Docker container on bridge — receives SIP, runs dialplan + AI screener |
| Bridge call API | `backend/bridge/routes/soc.js` | REST endpoints for call log, OSINT, analysis |
| Ozzu app SIP client | `frontend/modules/sip-toolkit/` | iPhone receives screened calls via VoIP |

## Configuration

### CAT S41 (Gateway phone)
1. Install the APK
2. Open app → set Bridge URL (`http://10.9.0.1:3333`) and token
3. Set Asterisk Host (`10.9.0.1`)
4. Tap "Set as Call Screener" → grant the role
5. Grant all permissions (phone, microphone, call log)
6. Tap "Save & Start Gateway"
7. CAT phone must be on WireGuard VPN

### Call forwarding
On the Swift iPhone: `*21*[CAT-number]#`
To cancel: `##21#`

### Asterisk
Starts automatically via docker-compose. SIP accounts:
- `cat-gateway` / `ozzu-gsm-2026` — CAT phone registers here
- `ozzu-iphone` / `ozzu-sip-2026` — iPhone Ozzu app registers here

## Build

```bash
cd tools/gsm-gateway/android
./gradlew assembleRelease
# APK at app/build/outputs/apk/release/app-release-unsigned.apk
```

## Limits

- Audio capture quality depends on Android device — VOICE_CALL source (both sides) works on some devices without root, falls back to MIC (local side only) on others
- CAT S41 minSdk is Android 8 (API 26) but CallScreeningService needs API 29 — check if CAT is on Android 10+, or use the BroadcastReceiver fallback
- RTP is direct UDP to Asterisk — requires WireGuard tunnel between CAT and bridge
