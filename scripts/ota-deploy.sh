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

# Export BOTH iOS + Android JS bundles. iOS IS OTA'd via expo-updates even though the
# app is sideloaded (AltStore) — expo-updates delivers JS independent of how the app was
# installed, so the 7-day sideload signing expiry never touches OTA.
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
# --clear wipes Metro's transformer cache first. WITHOUT it, `expo export` can ship a
# STALE bundle (old screen code) even when the working tree is current — Metro's cache
# does not reliably invalidate after a git checkout/merge. Cost a full session 2026-06-22
# (shipped the OLD SOC tab over OTA; the app even ran old JS below its embedded build).
# Always export clean for OTA — the few extra seconds beat ever shipping stale JS.
npx expo export --clear --output-dir /tmp/ota-export 2>&1 | tail -5

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

# expo-updates' manifest needs the resolved app config (expoClient). `expo export` does
# NOT emit it, so generate it explicitly — without this the OTA manifest ships an empty
# expoClient ({}) and the app REJECTS the update (fetches the manifest, downloads 0 assets).
# Cost a full debugging session 2026-06-22.
echo "[1b/3] Generating expoConfig.json (expoClient) for the manifest..."
npx expo config --json 2>/dev/null > /tmp/ota-export-config.json || true
node -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync('/tmp/ota-export-config.json','utf8'));fs.writeFileSync('/tmp/ota-export/expoConfig.json',JSON.stringify(c.expo||c));console.log('  expoConfig.json written ('+((c.expo||c).name)+')');}catch(e){console.log('  WARN: expoConfig.json generation failed:',e.message);}"

# Publish to bridge updates directory
echo "[2/3] Publishing update..."
rm -rf "$UPDATES_DIR"
mkdir -p "$UPDATES_DIR"
cp -r /tmp/ota-export/* "$UPDATES_DIR/"
sync  # Flush writes to disk before restarting apps

echo "Published to $UPDATES_DIR"
echo "Bundle: $(du -sh "$UPDATES_DIR" | cut -f1) ($BUNDLE_SIZE bytes)"

# Sanity-check that the bridge actually serves the new manifest for iOS (the primary
# device). /api/manifest is a public path (no auth). Soft check — warn, don't abort.
# The bridge returns the expo-updates manifest as multipart/mixed (boundary=ota-boundary),
# NOT plain JSON — so grep the body for "launchAsset" (the bundle ref), not a JSON key.
MANIFEST_JSON=$(curl -s --max-time 5 -H "expo-platform: ios" -H "expo-runtime-version: $RUNTIME_VERSION" http://localhost:3333/api/manifest 2>/dev/null || true)
if echo "$MANIFEST_JSON" | grep -q '"launchAsset"'; then
  echo "  manifest served OK — $(echo "$MANIFEST_JSON" | grep -oE '"id":"[^"]+"' | head -1)"
else
  echo "  WARN: bridge did not return a valid iOS manifest — check the bridge is up and serving $UPDATES_DIR"
fi

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
