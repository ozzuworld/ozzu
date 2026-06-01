#!/usr/bin/env bash
# heartbeat-reporter.sh — push this device's own view of the world to the bridge
# (D5b). Runs on a 60s systemd timer. Generic enough to run on any host/device
# with bash + curl; per-device config via env or the defaults below.
#
# Auth: a per-device token (db.issueDeviceToken), NOT the global BRIDGE_API_KEY.
# Token lives in $HB_TOKEN_FILE (default /root/.ozzu-hb/token, mode 0600).
set -euo pipefail

DEVICE_ID="${HB_DEVICE_ID:-gcp-bridge-host}"
BRIDGE="${HB_BRIDGE_URL:-http://localhost:3333}"
TOKEN_FILE="${HB_TOKEN_FILE:-/root/.ozzu-hb/token}"
WG_STATE="${HB_WG_STATE:-/home/gcp/ozzu/data/infra/wg-state.json}"
WG_SELF_IP="${HB_WG_SELF_IP:-10.9.0.1}"   # this host's own wg address (server end)

[ -r "$TOKEN_FILE" ] || { echo "no token at $TOKEN_FILE" >&2; exit 1; }
TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"

# LAN IP (first non-loopback IPv4)
LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -vE '^(127\.|10\.9\.0\.)' | head -1 || true)"

# Public IP — best-effort, short timeout, never fail the heartbeat over it
PUBLIC_IP="$(curl -s -m 4 https://api.ipify.org 2>/dev/null || true)"

# WG handshake age for THIS host: the host is the wg server, so report the
# freshest peer handshake age as a liveness proxy (min age across peers).
WG_AGE="null"
if [ -r "$WG_STATE" ]; then
  WG_AGE="$(jq -r '[.peers[]?.handshake_age_s | numbers] | min // null' "$WG_STATE" 2>/dev/null || echo null)"
fi

BODY="$(jq -n \
  --arg lan "${LAN_IP:-}" \
  --arg pub "${PUBLIC_IP:-}" \
  --arg wg "$WG_SELF_IP" \
  --argjson age "${WG_AGE:-null}" \
  '{
     lan_ip:     (if $lan == "" then null else $lan end),
     public_ip:  (if $pub == "" then null else $pub end),
     wg_ip:      $wg,
     wg_handshake_age_s: $age,
     meta: { source: "heartbeat-reporter.sh", role: "bridge-host" }
   }')"

curl -sS -m 10 -X POST "$BRIDGE/heartbeat" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" >/dev/null
