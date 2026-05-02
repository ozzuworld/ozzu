#!/usr/bin/env bash
# infra.sh — source this for canonical Ozzu infra (IPs, SSH paths, ports).
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/infra.sh"   # from scripts/X.sh
#   ssh "$DEV01_HOST" 'echo hi'
#   ssh -J "$ROCKPI_JUMP" "${ROCKPI_USER}@${ROCKPI_LAN}" 'cmd'
#   curl "http://${BRIDGE_FQDN}:${BRIDGE_PORT}/health"
#
# Reads infra/devices.json (override path with $OZZU_INFRA_JSON).
# Sources secrets from $OZZU_SECRETS or $HOME/.ozzu-secrets if present
# (see infra/secrets.example). Failing-soft on missing secrets.
#
# Provides:
#   GCP_PUBLIC_IP, GCP_INTERNAL_IP, GCP_WG_IP, GCP_PROJECT_ID
#   BRIDGE_FQDN, WG_FQDN, BRIDGE_PORT, WG_PORT, QDRANT_PORT, ANISETTE_PORT
#   <NAME>_WG, <NAME>_LAN, <NAME>_WIFI, <NAME>_USER, <NAME>_HOST,
#   <NAME>_KEY, <NAME>_JUMP   (one set per device, name uppercased + dashes→underscores)

# Locate devices.json — prefer $OZZU_INFRA_JSON, else relative to this file.
if [ -z "${OZZU_INFRA_JSON:-}" ]; then
  _infra_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  OZZU_INFRA_JSON="${_infra_dir}/infra/devices.json"
fi

if [ ! -f "$OZZU_INFRA_JSON" ]; then
  echo "infra.sh: cannot find devices.json at $OZZU_INFRA_JSON" >&2
  return 1 2>/dev/null || exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "infra.sh: jq not found in PATH — install with 'apt-get install -y jq'" >&2
  return 1 2>/dev/null || exit 1
fi

# GCP fields
GCP_PUBLIC_IP=$(jq -r '.gcp.public_ip' "$OZZU_INFRA_JSON")
GCP_INTERNAL_IP=$(jq -r '.gcp.internal_ip' "$OZZU_INFRA_JSON")
GCP_WG_IP=$(jq -r '.gcp.wg_ip' "$OZZU_INFRA_JSON")
GCP_PROJECT_ID=$(jq -r '.gcp.project_id' "$OZZU_INFRA_JSON")
BRIDGE_FQDN=$(jq -r '.gcp.fqdn.bridge' "$OZZU_INFRA_JSON")
WG_FQDN=$(jq -r '.gcp.fqdn.wg' "$OZZU_INFRA_JSON")
BRIDGE_PORT=$(jq -r '.gcp.ports.bridge' "$OZZU_INFRA_JSON")
WG_PORT=$(jq -r '.gcp.ports.wg' "$OZZU_INFRA_JSON")
QDRANT_PORT=$(jq -r '.gcp.ports.qdrant' "$OZZU_INFRA_JSON")
ANISETTE_PORT=$(jq -r '.gcp.ports.anisette' "$OZZU_INFRA_JSON")
FACE_API_PORT=$(jq -r '.gcp.ports.face_api' "$OZZU_INFRA_JSON")

# Per-device fields
while IFS=$'\t' read -r name wg lan wifi user alias key jump; do
  prefix=$(echo "$name" | tr 'a-z-' 'A-Z_')
  [ "$wg"    != "null" ] && eval "${prefix}_WG=\"$wg\""
  [ "$lan"   != "null" ] && eval "${prefix}_LAN=\"$lan\""
  [ "$wifi"  != "null" ] && eval "${prefix}_WIFI=\"$wifi\""
  [ "$user"  != "null" ] && eval "${prefix}_USER=\"$user\""
  [ "$alias" != "null" ] && eval "${prefix}_HOST=\"$alias\""
  [ "$key"   != "null" ] && eval "${prefix}_KEY=\"$key\""
  [ "$jump"  != "null" ] && eval "${prefix}_JUMP=\"$jump\""
done < <(jq -r '
  .devices | to_entries[] |
  [.key,
   (.value.wg_ip // "null"),
   (.value.lan_ip // "null"),
   (.value.wifi_ip // "null"),
   (.value.ssh_user // "null"),
   (.value.ssh_alias // "null"),
   (.value.ssh_key // "null"),
   (.value.ssh_jump // "null")
  ] | @tsv
' "$OZZU_INFRA_JSON")

# Source secrets file (gitignored, owned by user). Failing-soft.
SECRETS_FILE="${OZZU_SECRETS:-$HOME/.ozzu-secrets}"
if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
fi
