#!/bin/bash
# Pair an iPhone with dev-01 for sideloading
# Run ON dev-01 with iPhone connected via USB and screen unlocked.
#
# Usage: ./scripts/pair-iphone.sh

set -e

echo "=== iPhone Pairing ==="
echo ""

# Check usbmuxd is running
if ! systemctl is-active --quiet usbmuxd; then
  echo "Starting usbmuxd..."
  sudo systemctl start usbmuxd
  sleep 2
fi

# Detect device
echo "Looking for connected iOS devices..."
UDID=$(idevice_id --list 2>/dev/null | head -1)

if [ -z "$UDID" ]; then
  echo "Error: No iOS device detected."
  echo ""
  echo "Checklist:"
  echo "  - Is the iPhone plugged in via USB?"
  echo "  - Is the iPhone screen unlocked?"
  echo "  - Is usbmuxd running? (sudo systemctl status usbmuxd)"
  echo "  - Try: sudo usbmuxd -f -v  (foreground with verbose logging)"
  exit 1
fi

echo "Found device: $UDID"
echo ""

# Pair
echo "Initiating pairing..."
echo ">>> LOOK AT THE IPHONE — tap 'Trust This Computer' and enter passcode <<<"
echo ""

if idevicepair pair 2>&1 | grep -q "SUCCESS"; then
  echo "Pairing successful!"
else
  echo "First pair attempt sent. Waiting for Trust dialog..."
  echo "Tap 'Trust' on the iPhone now, then press Enter here."
  read -r

  if idevicepair pair 2>&1 | grep -q "SUCCESS"; then
    echo "Pairing successful!"
  else
    echo "Pairing may have failed. Trying validate..."
  fi
fi

# Validate
echo ""
echo "Validating pairing..."
if idevicepair validate 2>&1 | grep -q "SUCCESS"; then
  echo "Pairing VALIDATED."
else
  echo "Warning: Pairing validation failed."
  echo "  Try: idevicepair unpair && idevicepair pair"
  exit 1
fi

# Show device info
echo ""
echo "Device info:"
ideviceinfo -k DeviceName 2>/dev/null && echo ""
ideviceinfo -k ProductType 2>/dev/null && echo ""
ideviceinfo -k ProductVersion 2>/dev/null && echo ""

# Check developer mode
echo ""
echo "IMPORTANT: Ensure Developer Mode is enabled on the iPhone:"
echo "  Settings → Privacy & Security → Developer Mode → ON"
echo "  (iPhone will restart, then confirm the prompt)"
echo ""

# Generate pairing file for SideStore Wi-Fi refresh
echo "Generating pairing file for SideStore Wi-Fi refresh..."
PAIRING_DIR="/opt/ozzu/ios"
mkdir -p "$PAIRING_DIR"

if command -v sideloader >/dev/null 2>&1; then
  echo "Run this to generate the pairing file:"
  echo "  sideloader tool run 0"
  echo ""
  echo "Then transfer the .mobiledevicepairing file to the iPhone via SideStore."
else
  echo "Sideloader not installed — run setup-ios-sideloading.sh first."
fi

echo ""
echo "=== Pairing Complete ==="
echo ""
echo "Next: Install SideStore on the iPhone:"
echo "  ALTSERVER_ANISETTE_SERVER=http://localhost:6969 sideloader install /opt/ozzu/ios/SideStore.ipa -i"
echo ""
echo "Then install ozzu app:"
echo "  ./scripts/deploy-ios.sh"
