# Heartbeat reporter (D5b) — deploy to a new device

Each device pushes its own IP/SSID/WG state to the bridge every 60s, so infra state
self-updates instead of going stale. `POST /heartbeat` (per-device token auth) →
`device_state` → visible via `GET /infra/heartbeats` and the `get_device_states` MCP tool.

## Already deployed
- **gcp-bridge-host** — the bridge VM itself. Timer `ozzu-heartbeat-reporter.timer` (active).

## Add a new device (host with bash+curl+jq: dev-01, rock-pi, etc.)
1. **Issue a token on the bridge** (one-time), substituting the device id:
   ```bash
   cd /home/gcp/ozzu/backend/bridge && node -e '
     const db=require("./db.js");(async()=>{await db.init();
     const r=await db.issueDeviceToken("dev-01",{label:"dev-01 reporter"});
     console.log(r.token);process.exit(0)})()' 2>/dev/null | tail -1
   ```
2. **On the device**: store the token at `/root/.ozzu-hb/token` (mode 0600), copy
   `scripts/heartbeat-reporter.sh` + the two systemd units (rename per device), set
   `HB_DEVICE_ID` + `HB_BRIDGE_URL` (use the bridge's WG IP `10.9.0.1:3333` from remote
   devices), then `systemctl enable --now <unit>.timer`.
3. Verify: `curl -s $BRIDGE/infra/heartbeats | jq '.devices[].device_id'`.

## Android (tablet / phone) — no systemd
Run the equivalent via Termux + a cron/`while` loop, or a small foreground service.
SSID on Android: `dumpsys wifi | grep "SSID:"` (root) — set `wifi_ssid` in the POST body.
Key fields the bridge accepts: `wifi_ssid, lan_ip, public_ip, wg_ip, wg_handshake_age_s, battery_pct, meta`.

## Rotate / revoke a device token
`db.issueDeviceToken(id)` re-issues (old hash overwritten); `db.revokeDeviceToken(id)` kills it.
