#!/bin/bash
# Install SideStore and ozzu app on iPhone via dev-01
# Run from GCP VM after:
#   1. DNS is fixed on dev-01 (./scripts/fix-dev01-dns.sh)
#   2. iPhone is paired with dev-01 (./scripts/pair-iphone.sh)
#
# This is interactive — requires Apple ID + app-specific password input.
# Usage: ./scripts/install-ios-apps.sh [--skip-sidestore]

set -e

# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/lib/infra.sh"

DEV01="${DEV_01_HOST:-dev-01}"
ANISETTE_URL="${ANISETTE_URL:-http://${GCP_WG_IP}:${ANISETTE_PORT}}"
SIDELOADER_BIN="\$HOME/bin/sideloader"

SKIP_SIDESTORE=false
for arg in "$@"; do
  [ "$arg" = "--skip-sidestore" ] && SKIP_SIDESTORE=true
done

# ── Preflight checks ──
echo "=== iOS App Installation ==="
echo ""

echo "[1] Checking dev-01 connectivity..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$DEV01" true 2>/dev/null; then
  echo "Error: Cannot SSH to $DEV01"
  exit 1
fi
echo "  OK"

echo "[2] Checking DNS on dev-01..."
DNS_OK=$(ssh "$DEV01" 'getent hosts apps.mzstatic.com >/dev/null 2>&1 && echo YES || echo NO')
if [ "$DNS_OK" != "YES" ]; then
  echo "Error: DNS not working on dev-01."
  echo "  Fix it: ssh dev-01 then run: sudo mkdir -p /run/systemd/resolve && sudo bash -c 'echo \"nameserver 172.168.0.1\" > /run/systemd/resolve/stub-resolv.conf'"
  exit 1
fi
echo "  OK"

echo "[3] Checking Anisette server..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:6969 2>/dev/null || echo "000")
if [ "$HTTP_CODE" != "200" ]; then
  echo "Error: Anisette server not responding (HTTP $HTTP_CODE)"
  exit 1
fi
echo "  OK"

echo "[4] Checking iPhone connection..."
APPLE_USB=$(ssh "$DEV01" 'lsusb 2>/dev/null | grep -i "apple\|iphone\|ipad"' || true)
if [ -z "$APPLE_USB" ]; then
  echo "Error: No Apple USB device on dev-01. Connect iPhone via USB."
  exit 1
fi
echo "  Found: $APPLE_USB"

echo ""

# ── Install SideStore ──
if [ "$SKIP_SIDESTORE" = false ]; then
  echo "=== Installing SideStore ==="
  echo "(You will be prompted for Apple ID + app-specific password)"
  echo ""
  ssh -t "$DEV01" "ALTSERVER_ANISETTE_SERVER=$ANISETTE_URL $SIDELOADER_BIN install \$HOME/ozzu-ios-setup/SideStore.ipa -i"
  echo ""
  echo "SideStore installed. Open it on iPhone and sign in to enable auto-refresh."
  echo ""
fi

# ── Install ozzu app ──
echo "=== Installing ozzu app ==="

# Check if IPA exists on dev-01
IPA_EXISTS=$(ssh "$DEV01" 'test -f /tmp/ozzu-ios/ozzu.ipa && echo YES || echo NO')
if [ "$IPA_EXISTS" != "YES" ]; then
  echo "Downloading latest iOS IPA from GitHub Actions..."
  rm -rf /tmp/ozzu-ios && mkdir -p /tmp/ozzu-ios
  gh run download --name ozzu-ios --dir /tmp/ozzu-ios
  ssh "$DEV01" "mkdir -p /tmp/ozzu-ios"
  scp -q /tmp/ozzu-ios/ozzu.ipa "$DEV01:/tmp/ozzu-ios/ozzu.ipa"
fi

echo "(You will be prompted for Apple ID + app-specific password)"
echo ""
ssh -t "$DEV01" "ALTSERVER_ANISETTE_SERVER=$ANISETTE_URL $SIDELOADER_BIN install /tmp/ozzu-ios/ozzu.ipa -i"

echo ""
echo "=== Done ==="
echo "Open the ozzu app on iPhone to verify it connects to the bridge."
echo "Check bridge logs: docker compose -f /home/gcp/ozzu/backend/docker-compose.yml logs bridge --tail 20"
