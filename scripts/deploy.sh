#!/bin/bash
# Deploy latest Android APK from GitHub Actions to both devices
# Usage: ./scripts/deploy.sh [--local]
#   --local  Install from local build instead of downloading from GitHub

set -e

TABLET="172.168.0.53:41107"
TV="172.168.0.56:34387"
REPO="ozzuworld/ozzu"
APK_DIR="/tmp/ozzu-apk"
LOCAL_APK="frontend/android/app/build/outputs/apk/debug/app-debug.apk"
PACKAGE="com.anonymous.ozzu"
ACTIVITY=".MainActivity"

if [ "$1" = "--local" ]; then
  APK="$LOCAL_APK"
  if [ ! -f "$APK" ]; then
    echo "No local APK found at $APK"
    exit 1
  fi
  echo "Using local APK: $APK"
else
  echo "Downloading latest APK from GitHub Actions..."
  rm -rf "$APK_DIR"
  gh run download --name ozzu-android --dir "$APK_DIR" -R "$REPO"
  APK="$APK_DIR/app-debug.apk"
fi

echo "APK size: $(du -h "$APK" | cut -f1)"

# Ensure devices are connected
for device in "$TABLET" "$TV"; do
  adb connect "$device" 2>/dev/null || true
done

sleep 1

# Install in parallel
echo "Installing on tablet ($TABLET) and TV ($TV) in parallel..."
adb -s "$TABLET" install -r "$APK" &
PID_TABLET=$!
adb -s "$TV" install -r "$APK" &
PID_TV=$!

# Wait and report
wait $PID_TABLET && echo "Tablet: installed" || echo "Tablet: FAILED"
wait $PID_TV && echo "TV: installed" || echo "TV: FAILED"

# Launch on both
for device in "$TABLET" "$TV"; do
  adb -s "$device" shell am force-stop "$PACKAGE" 2>/dev/null || true
  adb -s "$device" shell am start -n "$PACKAGE/$ACTIVITY"
done

# Cleanup
[ -d "$APK_DIR" ] && rm -rf "$APK_DIR"

echo "Done."
