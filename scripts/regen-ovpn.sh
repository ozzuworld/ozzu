#!/usr/bin/env bash
# Regenerate an OpenVPN client config bundle.
# Usage: regen-ovpn.sh <client-name> [output-path]
# Example: regen-ovpn.sh ozzu-android artifacts/ozzu-android.ovpn
#
# Sources cert/key from backend/openvpn/config/<client-name>.{crt,key}.
# Embeds CA + tls-auth from same directory.
# Targets vpn.ozzu.world — never hardcode the GCP IP, that is what bit us last cycle.

set -euo pipefail

CLIENT="${1:-}"
OUT="${2:-artifacts/${CLIENT}.ovpn}"

if [[ -z "$CLIENT" ]]; then
  echo "usage: $0 <client-name> [output-path]" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$REPO_ROOT/backend/openvpn/config"

# tls-auth is disabled in server.conf — do NOT embed ta.key in the client bundle.
# Client tls-auth without server tls-auth = HMAC envelope mismatch, server silently drops.
for f in ca.crt "$CLIENT.crt" "$CLIENT.key"; do
  [[ -f "$CFG/$f" ]] || { echo "missing $CFG/$f" >&2; exit 1; }
done

mkdir -p "$(dirname "$REPO_ROOT/$OUT")"

{
  cat <<'HEADER'
client
dev tun
proto udp
remote vpn.ozzu.world 1194
resolv-retry infinite
nobind
persist-key
persist-tun

cipher AES-256-CBC
data-ciphers AES-256-GCM:AES-128-GCM:AES-256-CBC
data-ciphers-fallback AES-256-CBC
auth SHA256

remote-cert-tls server
verb 3

# Split tunneling — only VPN + GCP internal traffic through tunnel
route-nopull
route 10.8.0.0 255.255.255.0
route 10.128.0.0 255.255.255.0

HEADER

  echo '<ca>'
  cat "$CFG/ca.crt"
  echo '</ca>'
  echo
  echo '<cert>'
  cat "$CFG/$CLIENT.crt"
  echo '</cert>'
  echo
  echo '<key>'
  cat "$CFG/$CLIENT.key"
  echo '</key>'
} > "$REPO_ROOT/$OUT"

chmod 600 "$REPO_ROOT/$OUT"
echo "wrote $OUT ($(wc -l < "$REPO_ROOT/$OUT") lines)"
