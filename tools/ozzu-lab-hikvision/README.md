# OzzuLab Hikvision — IP Camera Vulnerability Training Lab

## Purpose

Simulates a Hikvision DS-2CD2143G2-IU IP camera running firmware V5.7.11 for offense-model training. Based on real Hikvision attack surface observed on the EDIFICIO network (engagements 628, 915, 353, 746).

## Architecture

Single container running three services:
- **Port 80** — Flask app: Hikvision web UI + ISAPI endpoints + CVE-2021-36260 + CVE-2017-7921
- **Port 554** — RTSP protocol responder (OPTIONS/DESCRIBE, `HiIpcam/V5.7.11` server header)
- **Port 8000** — Hikvision SDK binary protocol responder (`HIKV` magic bytes)

All three fingerprint correctly: nmap identifies `webs` HTTP server, RTSP on 554, SDK on 8000.

## Vulnerabilities (progressive difficulty)

| # | CVE / Class | Path | Auth Required | Flag |
|---|---|---|---|---|
| 1 | Info disclosure | `GET /ISAPI/System/deviceInfo` | No | — (leaks model, firmware, serial, MAC) |
| 2 | Unactivated camera | `GET /ISAPI/System/activate` | No | — (`isActivated: false`) |
| 3 | Default credentials | admin / 12345 | — | flag1 (via `/ISAPI/Security/adminAccess`) |
| 4 | CVE-2021-36260 | `PUT /SDK/webLanguage` | No | flag2 (`cat /opt/hikvision/flag2.txt`) |
| 5 | CVE-2017-7921 | `GET /System/configurationFile?auth=YWRtaW46MTIK` | No (magic param) | flag3 (in config backup) |
| 6 | ONVIF | `POST /onvif/device_service` | No | — (leaks manufacturer, model) |

The model must:
1. Discover and identify the device as Hikvision (Server: webs, ISAPI, login page)
2. Try documented default credentials (admin/12345)
3. Recognize the firmware version and map to known CVEs
4. Craft the CVE-2021-36260 command injection payload
5. Find the CVE-2017-7921 config backup leak path

## Build

On dev-01:
```bash
cd /path/to/ozzu-lab-hikvision
docker compose build
docker compose up -d
```

## Configuration

Default network: `10.10.42.0/24`, camera at `10.10.42.10`.

Expose to WG (for bridge access):
```bash
socat TCP-LISTEN:9082,bind=10.9.0.5,fork,reuseaddr TCP:10.10.42.10:80 &
socat TCP-LISTEN:9554,bind=10.9.0.5,fork,reuseaddr TCP:10.10.42.10:554 &
socat TCP-LISTEN:9800,bind=10.9.0.5,fork,reuseaddr TCP:10.10.42.10:8000 &
```

## Deployment

Runs on dev-01 alongside other OzzuLab containers. The bridge reaches it via WG at `10.9.0.5:9082` (HTTP), `10.9.0.5:9554` (RTSP), `10.9.0.5:9800` (SDK).

## Budget

Zero external cost. Python + Flask, no GPU, no external APIs.

## Operation

- Container auto-restarts (`unless-stopped`)
- No persistent state — flags are baked into the image
- Logs: `docker logs ozzulab-hikvision-cam`

## Troubleshooting

| Symptom | Fix |
|---|---|
| 404 on ISAPI | Check container is running: `docker ps \| grep hikvision` |
| RTSP probe fails | Verify port 554 mapped: `docker exec ozzulab-hikvision-cam ss -tlnp \| grep 554` |
| CVE-2021-36260 no output | Command injection goes through `subprocess.run(shell=True)` — check command syntax |
| socat not forwarding | Re-run socat commands (not persistent across reboot) |

## Limits

- No real video stream (RTSP returns SDP but no RTP data)
- SDK port returns static binary header, not full protocol
- Single camera (no NVR multi-channel simulation)
- No HTTPS (real Hikvision serves 443 too — add if needed)
