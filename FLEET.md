# FLEET.md — Ozzu Fleet Telemetry

> **Canonical reference for the device fleet + telemetry system.** Read this before
> touching anything under `scripts/telemetry/`, `routes/infra.js`, the Ops→Fleet tab,
> or when onboarding/debugging a device. It is the "fleet tab doc." Kept current by
> Cipher; if a device changes, update the inventory table + `infra_registry.md`.

## TL;DR

- Every device runs a small **telemetry agent** that POSTs vitals to the bridge every
  60s. The bridge stores them in `device_state`; the **Ops → Fleet** tab renders them.
- **Liveness is two-signal.** A device is "up" if EITHER its telemetry is fresh OR its
  WireGuard handshake is fresh. WG is the authority (server-observed, can't be faked by
  a dead agent); telemetry is enrichment (the vitals). A flaky agent never makes a
  reachable device read as dead.
- **Onboard a new device with one command:** `scripts/telemetry/onboard-device.sh`.
- The **hard-won lesson** (the CAT saga): on toybox/old-Android, `nc` is not a usable
  HTTP client and a bare `nohup agent &` is not supervision. The Android agent uses a
  **static `curl`** + a **Magisk `service.d` supervisor** (boot-persist + wakelock +
  watchdog). Linux uses **systemd** (`Restart=always`).

## The fleet

| device_id | Hardware | OS | Role | Transport | Supervision | Notes |
|---|---|---|---|---|---|---|
| `gcp-bridge-host` | GCP VM | Linux | bridge | curl → localhost | systemd `ozzu-telemetry.service` | the bridge itself |
| `ozzu-sbc` | Rock Pi 4B | Linux | sbc/gateway | curl → 10.9.0.1 (WG) | systemd | the real SBC/VoIP gateway |
| `dev-01` | GCP VM | Linux | dev | curl → 10.9.0.1 (WG) | systemd | **flaky** — drops off WG; OUT of offense/print pipelines |
| `cat-s41` | CAT S41 | Android 8 (toybox, kernel 4.4) | phone | **static curl** → 10.9.0.1 (WG) | **Magisk service.d supervisor** | no RTC; WG via app VpnService; see gotchas |
| `tablet-p610` | Samsung Tab S6 Lite | Android (LineageOS) | pentest-bridge | static curl → 10.9.0.1 (WG) | Magisk service.d supervisor | L3 pentest bridge; root `wireguard-go` daemon |

Live view: `docker exec ozzu-postgres psql -U ozzu -d ozzu -c "SELECT device_id, source, status, EXTRACT(EPOCH FROM (NOW()-last_seen))::int AS age_s FROM device_state ORDER BY last_seen DESC;"`

## Architecture (data flow)

```
 device agent (per-OS)                         bridge (network_mode: host)
 ───────────────────                           ───────────────────────────
 collect vitals every 60s                      POST /api/device-telemetry  (routes/device-telemetry.js)
 POST JSON  ──────────────► over WG (10.9.0.1) ─►  verify per-device token → device_id
 Authorization: Bearer <tok>                       upsert device_state (+ device_telemetry_snapshots, device_inventory)
                                                            │
 host wg-poller (systemd timer, ~60s)                       ▼
 `wg show` → data/infra/wg-state.json  ────────►  GET /infra/heartbeats  → effective_status (2-signal)
                                                            │
                                                            ▼
                                               Ops → Fleet tab  (FleetDeviceCard, fleet-hooks.ts, polls 15s)
```

## Two-signal liveness (why the CAT was "down for days")

The Fleet tab used to trust ONLY device-pushed telemetry. When the CAT's agent stopped
pushing (fragile transport), it read "down" for 45h even though its WG handshake was
~1 minute old — i.e. plainly reachable. Fixed in `routes/infra.js` (`/infra/heartbeats`):

```
telemetryFresh = (now - last_seen) <= 150s          // 2.5× the 60s tick
wgFresh        = wg_handshake_age_s <= 200s          // from data/infra/wg-state.json, joined by wg_ip
effective_status = telemetryFresh ? stored_status : (wgFresh ? "online" : "offline")
```

**Rule:** device push tells you the *vitals*; the server-observed WG handshake tells you
*up/down*. Offline only when BOTH are stale. `wg_ip` in `device_state` MUST match a
wg-state.json peer's `allowed_ips` for the join to work.

## The telemetry contract

- **Endpoint:** `POST http://10.9.0.1:3333/api/device-telemetry` (host uses `localhost`).
- **Auth:** `Authorization: Bearer <per-device-token>`. **Identity is the token's
  `device_id`, never the body.** Tokens are per-device, scope `heartbeat:write`, stored
  only as sha256 in `device_credentials`. Devices posting over WG/LAN/loopback bypass the
  global `BRIDGE_API_KEY` (TRUSTED_NETS) and are gated solely by this token.
- **Body schema** (all of `identity`/`system` optional; only `tier`+`vitals` required):

```jsonc
{
  "tier": "fast" | "medium" | "full",
  "identity": {                          // sent on the SLOW cycle only (every 30)
    "hardware": { "model", "manufacturer", "serial", "cpu_cores", "cpu_abi" },
    "os":       { "name", "version", "kernel", "api_level"|"arch" },
    "agent":    { "version" }
  },
  "vitals": {                            // EVERY tick
    "cpu":     { "load_1m", "load_5m", "load_15m", "temp_c" },
    "memory":  { "total_mb", "free_mb", "available_mb", "used_pct" },
    "battery": { "pct", "status", "temp_c" },     // Android
    "thermal": [ { "zone", "temp_c" } ],
    "network": { "wifi": {"ssid","signal_dbm","freq_mhz"}, "lan_ip", "wg_ip",
                 "public_ip", "wg_handshake_age_s", "wifi_ssid" },
    "uptime_s": 12345
  },
  "system":   { "disk": [ {"fs","mount","size_kb","used_kb","avail_kb","use_pct"} ] },  // MEDIUM cycle (every 5)
  "meta":     { "source": "ozzu-telemetry", "role", "agent_version", "cycle", "tier" }
}
```

- **`meta.source` must be `"ozzu-telemetry"`** so the bridge stamps `device_state.source =
  "telemetry-v2"`, which is what the Fleet card uses to show the rich (vs. thin) layout.
- **Tiers** keep the payload small: `fast` = vitals only (60s); `medium` adds `system.disk`
  (every 5 cycles); `full` adds `identity` (every 30 cycles).

## The agents

| File (repo, canonical) | Runs on | Transport | Notes |
|---|---|---|---|
| `scripts/telemetry/ozzu-telemetry-android.sh` | Android (any) | static `curl` | toybox-safe (no awk); tiered; reads config from env |
| `scripts/telemetry/03-ozzu-telemetry.sh` | Android (Magisk `service.d`) | — | **supervisor**: boot-persist + wakelock + 30s watchdog; sources `telemetry.env` |
| `scripts/telemetry/bin/ozzu-curl-aarch64` | Android arm64 | — | vendored static-pie curl 8.21.0 (sha256 `1cd1df17…`), source: stunnel/static-curl |
| `scripts/ozzu-telemetry-linux.sh` | Linux | `curl` | rich (adds processes/connections/USB); installed as `/usr/local/bin/ozzu-telemetry.sh` |
| `scripts/telemetry/ozzu-telemetry.service` | Linux (systemd) | — | unit template; `Restart=always` |
| `backend/bridge/scripts/issue-device-token.js` | bridge | — | mint/rotate a per-device token (local only, no HTTP endpoint) |

**On-device layout (Android, standard):** `/data/adb/ozzu/{ozzu-curl, ozzu-telemetry-android.sh,
hb-token, telemetry.env}` + `/data/adb/service.d/03-ozzu-telemetry.sh`. The agent is generic;
per-device config (id, paths, role) lives in `telemetry.env`, sourced by the supervisor — that
is what makes onboarding uniform without editing the agent.

**Why static curl on Android:** toybox `nc` closes on stdin-EOF before reading the reply and
does not reliably deliver the request on MTK/Android-8 (kernel 4.4). A real HTTP client is
mandatory. The binary is fully static (bionic-compatible).

## Onboarding a new device

```bash
scripts/telemetry/onboard-device.sh <device_id> <android|linux> <target> [role]
#   android target = adb serial reached via the bridge over WG, e.g. 10.9.0.22:5555
#   linux   target = ssh host (e.g. dev-01) or "local" for the bridge host itself
```

It: (1) mints a per-device token, (2) deploys the agent (+ static curl on Android),
(3) installs supervision (systemd unit / Magisk supervisor), (4) starts it, (5) polls
`device_state` and confirms telemetry lands within 90s. Idempotent — re-running rotates
the token and re-deploys. Examples:

```bash
scripts/telemetry/onboard-device.sh cat-s41     android 10.9.0.22:5555 phone
scripts/telemetry/onboard-device.sh tablet-p610 android 10.9.0.10:5555 pentest-bridge
scripts/telemetry/onboard-device.sh some-vm      linux   some-ssh-host  server
```

## Token management

```bash
# issue / rotate (idempotent per device_id — prints the plaintext token ONCE):
docker exec bridge node scripts/issue-device-token.js <device_id> "label"
# list credentials:
docker exec ozzu-postgres psql -U ozzu -d ozzu -c "SELECT device_id, scopes, label, last_used_at, revoked_at FROM device_credentials ORDER BY device_id;"
# revoke (db.revokeDeviceToken): sets revoked_at; the device 401s until re-onboarded.
```

## The Fleet tab (UI)

- `frontend/components/ops/FleetDeviceCard.tsx` — `DEVICE_META` maps `device_id` → emoji/label
  (add a row when onboarding a new device). `online = effective_status === "online"`;
  `hasTelemetry = source === "telemetry-v2"` (rich vs thin card).
- `frontend/lib/fleet-hooks.ts` — `useFleetDevices()` polls `GET /infra/heartbeats` +
  `/infra/inventory` every 15s. `frontend/app/(tabs)/ops.tsx` — the Ops tab (fleet|voip|services).

## Troubleshooting

| Symptom | Check |
|---|---|
| Device reads "down" but is reachable | `GET /infra/wg` — is the handshake fresh? Is `device_state.wg_ip` == a wg peer's `allowed_ips`? (the join). |
| Telemetry stale, device up | Agent died and nothing respawned it. Android: is `03-ozzu-telemetry.sh` in `service.d`? `pkill -f ozzu-telemetry-android` and watch the watchdog respawn in ≤30s. Linux: `systemctl status ozzu-telemetry`. |
| Android POST never lands | Confirm it uses the static curl, NOT `nc`. Test: `su -c '/data/adb/ozzu/ozzu-curl -sS -m10 -w "%{http_code}" -X POST $URL -H "Authorization: Bearer $(cat /data/adb/ozzu/hb-token)" -d "{\"tier\":\"fast\",\"vitals\":{}}"'` → want `{"ok":true...}` `200`. |
| 401 from the bridge | Token rotated but the device has the old one → re-onboard. Or the credential was revoked. |
| `source` is `heartbeat` not `telemetry-v2` | Device is on the legacy heartbeat reporter; onboard it to migrate to the v2 agent. |
| Agent hangs a tick | Only bounded calls allowed. The agent makes ZERO unbounded external calls (the old `ifconfig.me` fetch wedged ticks — removed). curl is always `-m 15`. |

## Device-specific gotchas

**CAT S41 (`cat-s41`) — the fragile one:**
- **No RTC** — clock resets to Dec 31 2009 on every reboot. WireGuard's Tai64N replay
  protection rejects handshakes "from the past", so the WG keepalive fixes the clock (NTP)
  BEFORE bringing the tunnel up. **Never reboot the CAT blind.**
- **Kernel 4.4 blackholes root UDP sockets** — a root `wireguard-go` daemon's packets never
  leave the device (sendto() lies). WG MUST use the **Android app VpnService** (broadcast
  intents in `02-ozzuwg-keepalive.sh`), not a root daemon. App-based WG drops when WiFi
  disconnects → the keepalive watchdog toggles the tunnel.
- **toybox `nc` is a dead end** for HTTP → static curl (above).
- **MTK RF coexistence** — running a cellular/GSM app destabilized 5GHz WiFi (radio
  coexistence on MT6757). The GSM gateway app was removed; the Rock Pi is the SBC now.
- Load average ~14 is NORMAL here (MediaTek kernel threads parked in D-state) — a red herring,
  not load.

**tablet-p610 — the pentest bridge:** WG is a root `wireguard-go` daemon (`ozzuwg0`) +
wakelock + watchdog + Magisk boot-persist (doze once froze the WG app → zombie tunnel). Its
telemetry onboards via the same Android path; don't touch the WG daemon when doing so.

**dev-01:** flaky — drops off WG (SSH times out when it does). Deliberately OUT of the offense
and print pipelines (it owns a conflicting `192.168.1.x`). Stale telemetry usually means the
box is simply unreachable, not a telemetry bug.

## Source files (don't re-derive — these are canonical)

- Ingest route: `backend/bridge/routes/device-telemetry.js`
- Liveness + fleet endpoints: `backend/bridge/routes/infra.js` (`/infra/heartbeats`, `/infra/wg`, `/infra/inventory`, `/infra/telemetry/:id`)
- Token + state DB: `backend/bridge/db.js` (`issueDeviceToken`, `verifyDeviceToken`, `upsertDeviceState`, `device_credentials`/`device_state`/`device_telemetry_snapshots` tables)
- WG poller: `scripts/wg-state-poller.sh` + `wg-state-poller.timer` (host systemd)
- Agents + onboarding: `scripts/telemetry/` (this module) + `scripts/ozzu-telemetry-linux.sh`
- Fleet UI: `frontend/components/ops/FleetDeviceCard.tsx`, `frontend/lib/fleet-hooks.ts`, `frontend/app/(tabs)/ops.tsx`
