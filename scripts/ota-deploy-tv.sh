#!/bin/bash
# ota-deploy-tv.sh — Export JS bundle and publish as OTA update for TV app
# TV picks up the update on next app launch (checkAutomatically: ON_LOAD)
# Usage: ./scripts/ota-deploy-tv.sh

set -e

WORKDIR="/home/gcp/ozzu"
TV_DIR="$WORKDIR/tv"
RUNTIME_VERSION="tv-1.0.0"
UPDATES_DIR="/tmp/ozzu-bridge/updates/$RUNTIME_VERSION"

echo "=== TV OTA Deploy ==="

# Export JS bundle (Android only — TV is always Android)
echo "[1/3] Exporting JS bundle (Android)..."
cd "$TV_DIR"
rm -rf /tmp/ota-tv-export
npx expo export --platform android --output-dir /tmp/ota-tv-export 2>&1 | tail -5

# Verify export produced a valid bundle
METADATA="/tmp/ota-tv-export/metadata.json"
if [ ! -f "$METADATA" ]; then
  echo "ERROR: Export produced no metadata.json — aborting"
  exit 1
fi
BUNDLE_REL=$(node -e "const m=JSON.parse(require('fs').readFileSync('$METADATA','utf8')); console.log(m.fileMetadata.android.bundle)" 2>/dev/null || true)
if [ -z "$BUNDLE_REL" ] || [ ! -f "/tmp/ota-tv-export/$BUNDLE_REL" ]; then
  echo "ERROR: Android bundle file missing from export — aborting"
  exit 1
fi
BUNDLE_SIZE=$(stat -c%s "/tmp/ota-tv-export/$BUNDLE_REL" 2>/dev/null || echo 0)
if [ "$BUNDLE_SIZE" -lt 10000 ]; then
  echo "ERROR: Android bundle too small ($BUNDLE_SIZE bytes), likely corrupt — aborting"
  exit 1
fi

# Publish to bridge updates directory
echo "[2/3] Publishing update..."
rm -rf "$UPDATES_DIR"
mkdir -p "$UPDATES_DIR"
cp -r /tmp/ota-tv-export/* "$UPDATES_DIR/"
sync

echo "Published to $UPDATES_DIR"
echo "Bundle: $(du -sh "$UPDATES_DIR" | cut -f1) ($BUNDLE_SIZE bytes)"

# Clean up
rm -rf /tmp/ota-tv-export

echo "[3/3] Done — TV will pick up update on next app launch"
echo ""
echo "TV OTA update published. The TV app checks for updates on launch + every 5 minutes."
