#!/bin/bash
# ota-deploy.sh — Export JS bundle and publish as OTA update via bridge server
# Devices pick up the update on next app launch (checkAutomatically: ON_LOAD)
# Usage: ./scripts/ota-deploy.sh [--restart]
#   --restart    Force-restart the app on all devices after publishing

set -e

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

# Publish to bridge updates directory
echo "[2/3] Publishing update..."
rm -rf "$UPDATES_DIR"
mkdir -p "$UPDATES_DIR"
cp -r /tmp/ota-export/* "$UPDATES_DIR/"

echo "Published to $UPDATES_DIR"
echo "Bundle: $(du -sh "$UPDATES_DIR" | cut -f1)"

# Restart apps on devices so they check for update on load
if [ "$RESTART" = true ]; then
  echo "[3/3] Restarting apps on devices..."

  DEVICES=(
    "tab-roaming|172.168.0.53:44847"
    "tab-lroom|172.168.0.57:35897"
    "tv-lroom|172.168.0.56:36331"
  )
  PACKAGE="com.anonymous.ozzu"
  ACTIVITY=".MainActivity"

  for entry in "${DEVICES[@]}"; do
    name="${entry%%|*}"
    addr="${entry##*|}"
    adb connect "$addr" 2>/dev/null || true
    status=$(adb -s "$addr" get-state 2>&1 || true)
    if [ "$status" = "device" ]; then
      adb -s "$addr" shell am force-stop "$PACKAGE" 2>/dev/null || true
      adb -s "$addr" shell am start -n "$PACKAGE/$ACTIVITY" 2>/dev/null || true
      echo "  [$name] restarted"
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
