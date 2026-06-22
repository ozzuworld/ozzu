#!/bin/bash
# ota-deploy.sh — Export the JS bundle (iOS + Android) and publish as an OTA update.
# HOT deploy path for JS-only changes (~25s). Both platforms pull the new JS on next
# app launch (iPhone included — it's the primary device). Native changes (app.json /
# native modules / new native deps) still need a full CI build + sideload; this script
# does NOT cover those — bump runtimeVersion and build instead.
#
# Usage: ./scripts/ota-deploy.sh [--restart]
#   --restart    Double-restart Android devices via adb to apply OTA immediately.
#                (iPhone applies on its own next launch — no adb path.)

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
cd "$FRONTEND"

# Ensure deps are installed before invoking expo. Without node_modules/expo,
# `npx expo export` silently fails with "module expo is not installed".
# Handles fresh clones, mounts that don't carry node_modules, post-cleanup state.
if [ ! -d "$FRONTEND/node_modules/expo" ]; then
  echo "[0/3] frontend/node_modules missing — running npm ci (one-time, ~40s)..."
  npm ci --no-audit --no-fund 2>&1 | tail -3
fi

echo "[1/3] Exporting JS bundle (iOS + Android)..."
rm -rf /tmp/ota-export
npx expo export --output-dir /tmp/ota-export 2>&1 | tail -5

# Verify export produced a valid bundle
METADATA="/tmp/ota-export/metadata.json"
if [ ! -f "$METADATA" ]; then
  echo "ERROR: Export produced no metadata.json — aborting"
  exit 1
fi
# iPhone is the primary device — verify the iOS bundle specifically.
BUNDLE_REL=$(node -e "const m=JSON.parse(require('fs').readFileSync('$METADATA','utf8')); console.log(m.fileMetadata.ios.bundle)" 2>/dev/null || true)
if [ -z "$BUNDLE_REL" ] || [ ! -f "/tmp/ota-export/$BUNDLE_REL" ]; then
  echo "ERROR: iOS bundle file missing from export — aborting"
  exit 1
fi
BUNDLE_SIZE=$(stat -c%s "/tmp/ota-export/$BUNDLE_REL" 2>/dev/null || echo 0)
if [ "$BUNDLE_SIZE" -lt 100000 ]; then
  echo "ERROR: iOS bundle too small ($BUNDLE_SIZE bytes), likely corrupt — aborting"
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
