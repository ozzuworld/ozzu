#!/bin/bash
# Publish OTA JS update — no APK rebuild needed!
# Usage: ./scripts/publish-update.sh [--message "description"]
#
# This exports the JS bundle + assets and copies them to the bridge server's
# update directory. Devices pick up the new JS on next app launch.
# Takes ~30 seconds instead of 10+ minutes for a full APK rebuild.
#
# NOTE: Only works for JS/TS changes. Native changes (Kotlin, new native
# modules, SDK upgrades) still require a full APK rebuild + deploy.

set -e

FRONTEND_DIR="/home/gcp/ozzu/frontend"
UPDATES_DIR="/tmp/ozzu-bridge/updates"
RUNTIME_VERSION="1.0.0"
MESSAGE=""

for arg in "$@"; do
  case "$arg" in
    --message) shift; MESSAGE="$1" ;;
  esac
  shift 2>/dev/null || true
done

echo "Exporting JS bundle..."
cd "$FRONTEND_DIR"
rm -rf dist
npx expo export --platform android --output-dir dist 2>&1 | tail -5

if [ ! -f dist/metadata.json ]; then
  echo "FAILED: No metadata.json generated"
  exit 1
fi

echo "Publishing update (runtimeVersion: $RUNTIME_VERSION)..."
TARGET="$UPDATES_DIR/$RUNTIME_VERSION"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -r dist/* "$TARGET/"

# Save expo config alongside the update
node -e "
  const { getConfig } = require('expo/config');
  const { exp } = getConfig('.', { isPublicConfig: true });
  require('fs').writeFileSync('$TARGET/expoConfig.json', JSON.stringify(exp));
" 2>/dev/null || echo "(skipped expoConfig export)"

echo "Restarting bridge server to pick up new files..."
cd /home/gcp/ozzu/backend
docker compose restart bridge 2>&1 | tail -1

BUNDLE_SIZE=$(du -sh "$TARGET" | cut -f1)
echo ""
echo "Published! ($BUNDLE_SIZE)"
echo "  Runtime: $RUNTIME_VERSION"
echo "  Path:    $TARGET"
[ -n "$MESSAGE" ] && echo "  Message: $MESSAGE"
echo ""
echo "Devices will pick up the update on next app launch."
echo "To force reload: adb shell am force-stop com.anonymous.ozzu"
