#!/bin/bash
# Deploy latest Android APK from GitHub Actions to both devices
# Usage: ./scripts/deploy.sh [--local] [--tablet-only] [--tv-only]
#   --local        Install from local build instead of downloading from GitHub
#   --tablet-only  Only deploy to tablet
#   --tv-only      Only deploy to TV

set -e

TABLET="172.168.0.53:44847"
TV="172.168.0.56:36331"
REPO="ozzuworld/ozzu"
APK_DIR="/tmp/ozzu-apk"
LOCAL_APK="frontend/android/app/build/outputs/apk/debug/app-debug.apk"
PACKAGE="com.anonymous.ozzu"
ACTIVITY=".MainActivity"

# Parse args
USE_LOCAL=false
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --local) USE_LOCAL=true ;;
    --tablet-only) TARGETS=("$TABLET") ;;
    --tv-only) TARGETS=("$TV") ;;
  esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("$TABLET" "$TV")

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

# Verify devices are reachable before slow install
echo ""
for device in "${TARGETS[@]}"; do
  adb connect "$device" 2>/dev/null || true
  status=$(adb -s "$device" get-state 2>&1 || true)
  if [ "$status" != "device" ]; then
    echo "SKIP $device — not reachable (status: $status)"
    # Remove from targets
    TARGETS=("${TARGETS[@]/$device/}")
  else
    echo "OK   $device — connected"
  fi
done

# Filter empty entries
LIVE=()
for t in "${TARGETS[@]}"; do [ -n "$t" ] && LIVE+=("$t"); done

if [ ${#LIVE[@]} -eq 0 ]; then
  echo "No devices reachable. Aborting."
  exit 1
fi

# Install with progress (push + pm install for better feedback)
echo ""
install_device() {
  local device=$1
  local label=$2
  echo "[$label] Pushing APK..."
  adb -s "$device" push "$APK" /data/local/tmp/ozzu.apk 2>&1 | grep -E "%" || true
  echo "[$label] Installing..."
  result=$(adb -s "$device" shell pm install -r /data/local/tmp/ozzu.apk 2>&1)
  if echo "$result" | grep -q "Success"; then
    echo "[$label] SUCCESS"
    adb -s "$device" shell rm /data/local/tmp/ozzu.apk 2>/dev/null || true
    adb -s "$device" shell am force-stop "$PACKAGE" 2>/dev/null || true
    adb -s "$device" shell am start -n "$PACKAGE/$ACTIVITY" 2>/dev/null
  else
    echo "[$label] FAILED: $result"
  fi
}

for device in "${LIVE[@]}"; do
  if [ "$device" = "$TABLET" ]; then
    install_device "$device" "Tablet" &
  else
    install_device "$device" "TV" &
  fi
done
wait

# Cleanup
[ -d "$APK_DIR" ] && rm -rf "$APK_DIR"

echo ""
echo "Done."
