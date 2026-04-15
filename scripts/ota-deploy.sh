#!/bin/bash
# ota-deploy.sh — Export Android JS bundle and publish as OTA update
# This is the HOT deploy path — Android only, ~25s total.
# iOS builds are triggered separately via staging (build-ios.yml).
#
# Usage: ./scripts/ota-deploy.sh [--restart]
#   --restart    Force-restart + double-restart to apply OTA immediately

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="/home/gcp/ozzu"
FRONTEND="$WORKDIR/frontend"
RUNTIME_VERSION="1.0.0"
UPDATES_DIR="/tmp/ozzu-bridge/updates/$RUNTIME_VERSION"

RESTART=false
[[ "$1" == "--restart" ]] && RESTART=true

echo "=== OTA Deploy (Android) ==="

# Export Android JS bundle only — iOS is never OTA'd (sideloaded via AltStore)
echo "[1/3] Exporting JS bundle (Android only)..."
cd "$FRONTEND"
rm -rf /tmp/ota-export
npx expo export --platform android --output-dir /tmp/ota-export 2>&1 | tail -5

# Verify export produced a valid bundle
METADATA="/tmp/ota-export/metadata.json"
if [ ! -f "$METADATA" ]; then
  echo "ERROR: Export produced no metadata.json — aborting"
  exit 1
fi
BUNDLE_REL=$(node -e "const m=JSON.parse(require('fs').readFileSync('$METADATA','utf8')); console.log(m.fileMetadata.android.bundle)" 2>/dev/null || true)
if [ -z "$BUNDLE_REL" ] || [ ! -f "/tmp/ota-export/$BUNDLE_REL" ]; then
  echo "ERROR: Android bundle file missing from export — aborting"
  exit 1
fi
BUNDLE_SIZE=$(stat -c%s "/tmp/ota-export/$BUNDLE_REL" 2>/dev/null || echo 0)
if [ "$BUNDLE_SIZE" -lt 100000 ]; then
  echo "ERROR: Android bundle too small ($BUNDLE_SIZE bytes), likely corrupt — aborting"
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

# Double-restart: 1st downloads OTA, 2nd applies it
if [ "$RESTART" = true ]; then
  echo "[3/3] Double-restarting apps on devices..."

  # Brief pause to ensure bridge serves the new manifest
  sleep 2

  if command -v adb &>/dev/null && [ -f "$SCRIPT_DIR/adb-discover.sh" ]; then
    source "$SCRIPT_DIR/adb-discover.sh"
    PACKAGE="com.anonymous.ozzu"
    ACTIVITY=".MainActivity"

    for entry in "${KNOWN_DEVICES[@]}"; do
      name="${entry%%|*}"
      addr=$(get_device_addr "$name" 2>/dev/null) || true
      if [ -n "$addr" ]; then
        # 1st restart — app launches, downloads OTA in background
        adb -s "$addr" shell am force-stop "$PACKAGE" 2>/dev/null || true
        sleep 1
        adb -s "$addr" shell am start -n "$PACKAGE/$ACTIVITY" 2>/dev/null || true
        echo "  [$name] restart 1/2 — downloading OTA ($addr)"
      else
        echo "  [$name] not reachable"
      fi
    done

    # Wait for OTA download to complete
    sleep 8

    for entry in "${KNOWN_DEVICES[@]}"; do
      name="${entry%%|*}"
      addr=$(get_device_addr "$name" 2>/dev/null) || true
      if [ -n "$addr" ]; then
        # 2nd restart — app loads the downloaded update
        adb -s "$addr" shell am force-stop "$PACKAGE" 2>/dev/null || true
        sleep 1
        adb -s "$addr" shell am start -n "$PACKAGE/$ACTIVITY" 2>/dev/null || true
        echo "  [$name] restart 2/2 — applying update ($addr)"
      fi
    done
  else
    echo "  adb not available — devices will pick up update on next app launch"
  fi
else
  echo "[3/3] Skipping restart (apps will pick up update on next launch)"
  echo "  Use --restart to force double-restart all devices now"
fi

# Clean up
rm -rf /tmp/ota-export

echo ""
echo "OTA update published. Devices will load the new JS on next app start."
