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

# Export JS bundles for both platforms (export separately to avoid web bundler failure)
echo "[1/3] Exporting JS bundles (Android + iOS)..."
cd "$FRONTEND"
rm -rf /tmp/ota-export /tmp/ota-android /tmp/ota-ios
npx expo export --platform android --output-dir /tmp/ota-android 2>&1 | tail -5
npx expo export --platform ios --output-dir /tmp/ota-ios 2>&1 | tail -5

# Merge: start with Android, overlay iOS bundles + merge metadata
cp -r /tmp/ota-android /tmp/ota-export
cp -r /tmp/ota-ios/_expo/static/js/ios /tmp/ota-export/_expo/static/js/ 2>/dev/null || true

# Merge metadata.json from both platforms
python3 -c "
import json
a = json.load(open('/tmp/ota-android/metadata.json'))
b = json.load(open('/tmp/ota-ios/metadata.json'))
a['fileMetadata']['ios'] = b['fileMetadata']['ios']
json.dump(a, open('/tmp/ota-export/metadata.json', 'w'), indent=2)
print('Merged metadata: android + ios')
" 2>&1

rm -rf /tmp/ota-android /tmp/ota-ios

# Verify export produced a valid bundle
METADATA="/tmp/ota-export/metadata.json"
if [ ! -f "$METADATA" ]; then
  echo "ERROR: Export produced no metadata.json — aborting"
  exit 1
fi
BUNDLE_REL=$(python3 -c "import json,sys; m=json.load(open('$METADATA')); print(m['fileMetadata']['android']['bundle'])" 2>/dev/null || true)
if [ -z "$BUNDLE_REL" ] || [ ! -f "/tmp/ota-export/$BUNDLE_REL" ]; then
  echo "ERROR: Android bundle file missing from export — aborting"
  exit 1
fi
BUNDLE_SIZE=$(stat -c%s "/tmp/ota-export/$BUNDLE_REL" 2>/dev/null || echo 0)
if [ "$BUNDLE_SIZE" -lt 100000 ]; then
  echo "ERROR: Android bundle too small ($BUNDLE_SIZE bytes), likely corrupt — aborting"
  exit 1
fi

# Verify iOS bundle too
IOS_BUNDLE_REL=$(python3 -c "import json,sys; m=json.load(open('$METADATA')); print(m['fileMetadata']['ios']['bundle'])" 2>/dev/null || true)
if [ -z "$IOS_BUNDLE_REL" ] || [ ! -f "/tmp/ota-export/$IOS_BUNDLE_REL" ]; then
  echo "WARNING: iOS bundle not found in export — iOS devices won't get this OTA update"
else
  IOS_BUNDLE_SIZE=$(stat -c%s "/tmp/ota-export/$IOS_BUNDLE_REL" 2>/dev/null || echo 0)
  echo "  iOS bundle: $IOS_BUNDLE_SIZE bytes"
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
