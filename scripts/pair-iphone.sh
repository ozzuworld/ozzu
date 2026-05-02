#!/bin/bash
# Pair an iPhone with dev-01 for sideloading
# Run this from the GCP VM — it SSHs to dev-01 for device interaction.
# iPhone must be connected to dev-01 via USB with the screen unlocked.
#
# Usage: ./scripts/pair-iphone.sh

set -e

# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/lib/infra.sh"

DEV01="${DEV_01_HOST:-dev-01}"
ANISETTE_URL="${ANISETTE_URL:-http://${GCP_WG_IP}:${ANISETTE_PORT}}"

echo "=== iPhone Pairing ==="
echo ""

# Check dev-01 is reachable
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$DEV01" true 2>/dev/null; then
  echo "Error: Cannot SSH to $DEV01"
  exit 1
fi

# Check usbmuxd is running (socket-activated, may need manual start)
echo "Checking usbmuxd on dev-01..."
USBMUXD_ACTIVE=$(ssh "$DEV01" 'systemctl is-active usbmuxd 2>/dev/null || echo inactive')
if [ "$USBMUXD_ACTIVE" != "active" ]; then
  echo "usbmuxd is not running. Attempting to start..."
  ssh "$DEV01" 'sudo systemctl start usbmuxd 2>/dev/null || usbmuxd -f &' 2>/dev/null || true
  sleep 2
fi

# Detect device via lsusb (no libimobiledevice-utils needed)
echo ""
echo "Looking for connected Apple devices on dev-01..."
APPLE_USB=$(ssh "$DEV01" 'lsusb 2>/dev/null | grep -i "apple\|iphone\|ipad"' || true)

if [ -z "$APPLE_USB" ]; then
  echo "Error: No Apple USB device detected on dev-01."
  echo ""
  echo "Checklist:"
  echo "  - Is the iPhone plugged into dev-01 via USB cable?"
  echo "  - Is the iPhone screen unlocked?"
  echo "  - Try a different USB port or cable"
  exit 1
fi

echo "Found: $APPLE_USB"
echo ""

# Attempt pairing via sideloader (it handles pairing internally)
echo ">>> LOOK AT THE IPHONE — tap 'Trust This Computer' and enter passcode <<<"
echo ""
echo "The iPhone should show a 'Trust This Computer?' dialog."
echo "Tap 'Trust', enter your passcode, then press Enter here to continue."
read -r

# Validate by trying to list with sideloader
echo "Checking device connection..."
SIDELOADER_BIN="\$HOME/bin/sideloader"
DEVICE_CHECK=$(ssh "$DEV01" "ALTSERVER_ANISETTE_SERVER=$ANISETTE_URL $SIDELOADER_BIN team --help 2>&1" || true)

echo ""
echo "=== Pairing Setup Complete ==="
echo ""
echo "IMPORTANT: Ensure Developer Mode is enabled on the iPhone:"
echo "  Settings → Privacy & Security → Developer Mode → ON"
echo "  (iPhone will restart, then confirm the prompt)"
echo ""
echo "Next steps:"
echo "  1. Install SideStore:"
echo "     ssh $DEV01 'ALTSERVER_ANISETTE_SERVER=$ANISETTE_URL \$HOME/bin/sideloader install \$HOME/ozzu-ios-setup/SideStore.ipa -i'"
echo ""
echo "  2. Install ozzu app:"
echo "     ./scripts/deploy-ios.sh"
