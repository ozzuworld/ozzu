#!/usr/bin/env bash
# wg-state-poller.sh — snapshot live WireGuard peer state to a JSON file the
# bridge can read. Runs on the HOST (the bridge container has no `wg` binary),
# on a 60s systemd timer. Output is consumed by GET /infra/wg (routes/infra.js).
# Replaces a stale never-wired 2026-05-12 attempt. dir_1780260211404.
set -euo pipefail

IFACE="${WG_IFACE:-wg0}"
OUT="${WG_STATE_OUT:-/home/gcp/ozzu/data/infra/wg-state.json}"
mkdir -p "$(dirname "$OUT")"

now="$(date +%s)"
dump="$(wg show "$IFACE" dump)"

# First line is the interface (4 fields); peer lines have 8 tab-separated fields:
# pubkey  psk  endpoint  allowed-ips  latest-handshake  rx  tx  keepalive
peers="$(printf '%s\n' "$dump" | tail -n +2 | jq -R -s --argjson now "$now" '
  split("\n") | map(select(length > 0)) | map(split("\t")) | map(
    ((.[4] // "0") | tonumber? // 0) as $h | {
      public_key: .[0],
      endpoint: (if (.[2] // "(none)") == "(none)" then null else .[2] end),
      allowed_ips: .[3],
      latest_handshake: $h,
      handshake_age_s: (if $h == 0 then null else ($now - $h) end),
      rx_bytes: ((.[5] // "0") | tonumber? // 0),
      tx_bytes: ((.[6] // "0") | tonumber? // 0),
      status: (if $h == 0 then "never" elif ($now - $h) <= 180 then "up" else "stale" end)
    })')"

jq -n --argjson now "$now" --arg iface "$IFACE" --argjson peers "$peers" \
  '{generated_at: $now, interface: $iface, peers: $peers}' > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
