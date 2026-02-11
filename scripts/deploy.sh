#!/bin/bash
# Deploy latest Android APK from GitHub Actions to all devices
# Usage: ./scripts/deploy.sh [--local] [DEVICE_NAME...]
#   --local              Install from local build instead of downloading from GitHub
#   DEVICE_NAME          One or more device names to target (default: all)
#
# Examples:
#   ./scripts/deploy.sh                        # deploy to all devices
#   ./scripts/deploy.sh tab-roaming            # deploy to roaming tablet only
#   ./scripts/deploy.sh tab-lroom tv-lroom     # deploy to living room devices
#   ./scripts/deploy.sh --local tab-roaming    # local build, roaming tablet only

set -e

# ── Device registry ──
# Format: NAME|IP:PORT
DEVICES=(
  "tab-roaming|172.168.0.53:44847"
  "tab-lroom|172.168.0.57:35897"
  "tv-lroom|172.168.0.56:36331"
)

REPO="ozzuworld/ozzu"
APK_DIR="/tmp/ozzu-apk"
LOCAL_APK="frontend/android/app/build/outputs/apk/debug/app-debug.apk"
PACKAGE="com.anonymous.ozzu"
ACTIVITY=".MainActivity"

# Parse args
USE_LOCAL=false
FILTER=()
for arg in "$@"; do
  case "$arg" in
    --local) USE_LOCAL=true ;;
    *) FILTER+=("$arg") ;;
  esac
done

# Build target list
TARGETS=()
for entry in "${DEVICES[@]}"; do
  name="${entry%%|*}"
  addr="${entry##*|}"
  if [ ${#FILTER[@]} -eq 0 ]; then
    TARGETS+=("$name|$addr")
  else
    for f in "${FILTER[@]}"; do
      if [[ "$name" == *"$f"* ]]; then
        TARGETS+=("$name|$addr")
        break
      fi
    done
  fi
done

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "No devices matched. Available:"
  for entry in "${DEVICES[@]}"; do echo "  ${entry%%|*}"; done
  exit 1
fi

# Get APK
if [ "$USE_LOCAL" = true ]; then
  APK="$LOCAL_APK"
  [ ! -f "$APK" ] && echo "No local APK at $APK" && exit 1
  echo "Using local APK"
else
  echo "Downloading latest APK from GitHub Actions..."
  rm -rf "$APK_DIR"
  gh run download --name ozzu-android --dir "$APK_DIR" -R "$REPO"
  APK="$APK_DIR/app-debug.apk"
fi
echo "APK size: $(du -h "$APK" | cut -f1)"

# Verify devices are reachable
echo ""
LIVE=()
for entry in "${TARGETS[@]}"; do
  name="${entry%%|*}"
  addr="${entry##*|}"
  adb connect "$addr" 2>/dev/null || true
  status=$(adb -s "$addr" get-state 2>&1 || true)
  if [ "$status" != "device" ]; then
    echo "SKIP  $name ($addr) — not reachable"
  else
    echo "OK    $name ($addr)"
    LIVE+=("$entry")
  fi
done

if [ ${#LIVE[@]} -eq 0 ]; then
  echo "No devices reachable. Aborting."
  exit 1
fi

# Install with progress
echo ""
install_device() {
  local name=$1
  local addr=$2
  echo "[$name] Pushing APK..."
  adb -s "$addr" push "$APK" /data/local/tmp/ozzu.apk 2>&1 | grep -E "%" || true
  echo "[$name] Installing..."
  result=$(adb -s "$addr" shell pm install -r /data/local/tmp/ozzu.apk 2>&1)
  if echo "$result" | grep -q "Success"; then
    echo "[$name] SUCCESS"
    adb -s "$addr" shell rm /data/local/tmp/ozzu.apk 2>/dev/null || true
    adb -s "$addr" shell am force-stop "$PACKAGE" 2>/dev/null || true
    adb -s "$addr" shell am start -n "$PACKAGE/$ACTIVITY" 2>/dev/null
  else
    echo "[$name] FAILED: $result"
  fi
}

for entry in "${LIVE[@]}"; do
  name="${entry%%|*}"
  addr="${entry##*|}"
  install_device "$name" "$addr" &
done
wait

# Cleanup
[ -d "$APK_DIR" ] && rm -rf "$APK_DIR"

echo ""
echo "Done."
