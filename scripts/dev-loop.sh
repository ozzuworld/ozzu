#!/bin/bash
# dev-loop.sh — Auto-rebuild loop for dev dashboard
# Exports JS bundle + OTA publishes every cycle when changes detected
# Usage: ./scripts/dev-loop.sh [--interval SECONDS] [--force]
#   --interval N   Rebuild every N seconds (default: 15)
#   --force        Rebuild even if no changes detected
# Directive: dir_1776203161681

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="/home/gcp/ozzu"
FRONTEND="$WORKDIR/frontend"
RUNTIME_VERSION="1.0.0"
UPDATES_DIR="/tmp/ozzu-bridge/updates/$RUNTIME_VERSION"
BRIDGE="http://localhost:3333"
INTERVAL=15
FORCE=false
LAST_HASH=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --interval) INTERVAL="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    *) shift ;;
  esac
done

echo "=== Dev Loop — auto-rebuild every ${INTERVAL}s ==="
echo "Frontend: $FRONTEND"
echo "Press Ctrl+C to stop"
echo ""

function get_hash() {
  # Hash of all tracked + modified frontend files
  (cd "$FRONTEND" && git diff HEAD --stat 2>/dev/null | md5sum | cut -d' ' -f1)
}

function do_build() {
  local start=$(date +%s%N)
  echo "[$(date +%H:%M:%S)] Building..."

  cd "$FRONTEND"

  # Export Android JS bundle only (fastest path for Redroid dev)
  rm -rf /tmp/ota-dev-export
  if ! npx expo export --platform android --output-dir /tmp/ota-dev-export 2>&1 | tail -3; then
    echo "[$(date +%H:%M:%S)] BUILD FAILED — skipping publish"
    return 1
  fi

  # Verify bundle exists
  local metadata="/tmp/ota-dev-export/metadata.json"
  if [ ! -f "$metadata" ]; then
    echo "[$(date +%H:%M:%S)] No metadata — skipping"
    return 1
  fi

  # Publish: copy to updates dir
  mkdir -p "$UPDATES_DIR"
  rm -rf "${UPDATES_DIR:?}"/*
  cp -r /tmp/ota-dev-export/* "$UPDATES_DIR/"
  rm -rf /tmp/ota-dev-export

  local elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
  echo "[$(date +%H:%M:%S)] Published (${elapsed}ms)"

  # Force-restart app on device to pick up OTA
  local ADB_BIN="adb"
  [ -f "/app/adb" ] && ADB_BIN="/app/adb"

  # Find running Redroid devices
  for port in 5555 5556 5557 5558 5559 5560; do
    if $ADB_BIN -s "localhost:$port" shell echo ok 2>/dev/null | grep -q ok; then
      $ADB_BIN -s "localhost:$port" shell am force-stop host.exp.exponent 2>/dev/null || true
      $ADB_BIN -s "localhost:$port" shell am start -n host.exp.exponent/.experience.HomeActivity 2>/dev/null || true
      echo "[$(date +%H:%M:%S)] Restarted app on :$port"
    fi
  done

  return 0
}

# Main loop
while true; do
  CURRENT_HASH=$(get_hash)

  if [ "$FORCE" = true ] || [ "$CURRENT_HASH" != "$LAST_HASH" ]; then
    if [ "$CURRENT_HASH" != "$LAST_HASH" ]; then
      echo "[$(date +%H:%M:%S)] Changes detected"
    fi
    if do_build; then
      LAST_HASH="$CURRENT_HASH"
    fi
  fi

  sleep "$INTERVAL"
done
