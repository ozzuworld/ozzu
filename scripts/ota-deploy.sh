#!/bin/bash
# ota-deploy.sh — Export JS bundle and publish as OTA update via bridge server
# Devices pick up the update on next app launch (checkAutomatically: ON_LOAD)
# Usage: ./scripts/ota-deploy.sh [--restart]
#   --restart    Force-restart the app on all devices after publishing

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="/home/gcp/ozzu"
FRONTEND="$WORKDIR/frontend"
RUNTIME_VERSION="1.0.0"
UPDATES_DIR="/tmp/ozzu-bridge/updates/$RUNTIME_VERSION"
BRIDGE="http://localhost:3333"

RESTART=false
[[ "$1" == "--restart" ]] && RESTART=true

echo "=== OTA Deploy ==="

# Export JS bundle
echo "[1/3] Exporting JS bundle..."
cd "$FRONTEND"
rm -rf /tmp/ota-export
npx expo export --platform android --output-dir /tmp/ota-export 2>&1 | tail -5

# Verify export produced a valid bundle
METADATA="/tmp/ota-export/metadata.json"
if [ ! -f "$METADATA" ]; then
  echo "ERROR: Export produced no metadata.json — aborting"
  exit 1
fi
BUNDLE_REL=$(python3 -c "import json,sys; m=json.load(open('$METADATA')); print(m['fileMetadata']['android']['bundle'])" 2>/dev/null || true)
if [ -z "$BUNDLE_REL" ] || [ ! -f "/tmp/ota-export/$BUNDLE_REL" ]; then
  echo "ERROR: Bundle file missing from export — aborting"
  exit 1
fi
BUNDLE_SIZE=$(stat -c%s "/tmp/ota-export/$BUNDLE_REL" 2>/dev/null || echo 0)
if [ "$BUNDLE_SIZE" -lt 100000 ]; then
  echo "ERROR: Bundle too small ($BUNDLE_SIZE bytes), likely corrupt — aborting"
  exit 1
fi

# Publish to bridge updates directory
echo "[2/3] Publishing update..."
rm -rf "$UPDATES_DIR"
mkdir -p "$UPDATES_DIR"
cp -r /tmp/ota-export/* "$UPDATES_DIR/"
sync  # Flush writes to disk before restarting apps

echo "Published to $UPDATES_DIR"
echo "Bundle: $(du -sh "$UPDATES_DIR" | cut -f1) ($BUNDLE_SIZE bytes)"

# Restart apps on devices so they check for update on load
if [ "$RESTART" = true ]; then
  echo "[3/3] Restarting apps on devices..."

  # Brief pause to ensure bridge serves the new manifest
  sleep 2

  source "$SCRIPT_DIR/adb-discover.sh"
  PACKAGE="com.anonymous.ozzu"
  ACTIVITY=".MainActivity"

  for entry in "${KNOWN_DEVICES[@]}"; do
    name="${entry%%|*}"
    addr=$(get_device_addr "$name" 2>/dev/null) || true
    if [ -n "$addr" ]; then
      adb -s "$addr" shell am force-stop "$PACKAGE" 2>/dev/null || true
      sleep 1  # Let the process fully exit before restarting
      adb -s "$addr" shell am start -n "$PACKAGE/$ACTIVITY" 2>/dev/null || true
      echo "  [$name] restarted ($addr)"
    else
      echo "  [$name] not reachable"
    fi
  done
else
  echo "[3/3] Skipping restart (apps will pick up update on next launch)"
  echo "  Use --restart to force-restart all devices now"
fi

# Clean up
rm -rf /tmp/ota-export

echo ""
echo "OTA update published. Devices will load the new JS on next app start."
