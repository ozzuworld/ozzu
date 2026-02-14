#!/bin/bash
# Deploy latest iOS IPA from GitHub Actions to iPhone via dev-01
# Uses AltServer-Linux on dev-01 for code signing + installation
#
# Usage: ./scripts/deploy-ios.sh [--local IPA_PATH]
#   --local IPA_PATH     Install from a local IPA file instead of downloading from GitHub
#
# Requires: APPLE_ID, APPLE_PASSWORD, IPHONE_UDID env vars (or in .env)

set -e

REPO="ozzuworld/ozzu"
DEV01="dev-01"  # SSH alias (hadmin@172.168.0.61)
IPA_DIR="/tmp/ozzu-ios"
REMOTE_IPA_DIR="/tmp/ozzu-ios"
ANISETTE_URL="http://10.8.0.1:6969"  # Anisette runs on GCP VM, reachable via VPN

# Load credentials from .env if not already set
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$WORKDIR/backend/.env" ]; then
  source "$WORKDIR/backend/.env"
fi

APPLE_ID="${APPLE_ID:-eng.ozzu@icloud.com}"
APPLE_PASSWORD="${APPLE_PASSWORD:-}"
IPHONE_UDID="${IPHONE_UDID:-00008140-000A449C02E8801C}"

if [ -z "$APPLE_PASSWORD" ]; then
  # Try reading from dev-01's install script as fallback
  APPLE_PASSWORD=$(ssh "$DEV01" "grep -- '-p ' ~/install-ozzu.sh 2>/dev/null | sed 's/.*-p //' | awk '{print \$1}'" 2>/dev/null || true)
fi

if [ -z "$APPLE_PASSWORD" ]; then
  echo "Error: APPLE_PASSWORD not set. Add it to backend/.env or export it."
  exit 1
fi

# Parse args
USE_LOCAL=false
LOCAL_IPA=""
for arg in "$@"; do
  case "$arg" in
    --local)
      USE_LOCAL=true
      ;;
    *)
      if [ "$USE_LOCAL" = true ] && [ -z "$LOCAL_IPA" ]; then
        LOCAL_IPA="$arg"
      else
        echo "Unknown argument: $arg"
        exit 1
      fi
      ;;
  esac
done

if [ "$USE_LOCAL" = true ] && [ -z "$LOCAL_IPA" ]; then
  echo "Error: --local requires an IPA path"
  echo "Usage: ./scripts/deploy-ios.sh --local /path/to/ozzu.ipa"
  exit 1
fi

# ── Step 1: Get the IPA ──
if [ "$USE_LOCAL" = true ]; then
  IPA="$LOCAL_IPA"
  [ ! -f "$IPA" ] && echo "Error: IPA not found at $IPA" && exit 1
  echo "Using local IPA: $IPA"
else
  echo "Downloading latest iOS IPA from GitHub Actions..."
  rm -rf "$IPA_DIR"
  mkdir -p "$IPA_DIR"
  if ! gh run download --name ozzu-ios --dir "$IPA_DIR" -R "$REPO"; then
    echo "Error: Failed to download iOS artifact. Has the iOS build workflow run?"
    echo "  Trigger it:  gh workflow run build-ios.yml -R $REPO"
    echo "  Check runs:  gh run list --workflow=build-ios.yml -R $REPO --limit 5"
    exit 1
  fi
  IPA="$IPA_DIR/ozzu.ipa"
fi

[ ! -f "$IPA" ] && echo "Error: IPA not found at $IPA" && exit 1
echo "IPA size: $(du -h "$IPA" | cut -f1)"

# ── Step 2: Check dev-01 is reachable ──
echo ""
echo "Checking dev-01 ($DEV01) connectivity..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$DEV01" true 2>/dev/null; then
  echo "Error: Cannot SSH to $DEV01"
  echo "  Ensure dev-01 is online and SSH key is configured"
  exit 1
fi
echo "dev-01 is reachable."

# ── Step 3: Check AltServer on dev-01 ──
echo "Checking AltServer on dev-01..."
if ! ssh "$DEV01" "test -x \$HOME/bin/AltServer" 2>/dev/null; then
  echo "Error: AltServer not found at ~/bin/AltServer on dev-01"
  echo "  Run ./scripts/setup-ios-sideloading.sh first"
  exit 1
fi

# ── Step 4: Transfer IPA to dev-01 ──
echo "Transferring IPA to dev-01..."
ssh "$DEV01" "mkdir -p $REMOTE_IPA_DIR"
scp -q "$IPA" "$DEV01:$REMOTE_IPA_DIR/ozzu.ipa"
echo "IPA transferred."

# ── Step 5: Install via AltServer ──
echo ""
echo "Installing via AltServer on dev-01..."
echo "(iPhone must be connected via USB or previously paired)"
echo ""
ssh "$DEV01" "ALTSERVER_ANISETTE_SERVER=$ANISETTE_URL \$HOME/bin/AltServer -u $IPHONE_UDID -a $APPLE_ID -p '$APPLE_PASSWORD' $REMOTE_IPA_DIR/ozzu.ipa" 2>&1
INSTALL_EXIT=$?

# ── Step 6: Cleanup ──
[ -d "$IPA_DIR" ] && rm -rf "$IPA_DIR"
ssh "$DEV01" "rm -rf $REMOTE_IPA_DIR" 2>/dev/null || true

echo ""
if [ $INSTALL_EXIT -eq 0 ]; then
  echo "iOS app installed successfully! Open ozzu on iPhone to verify."
else
  echo "AltServer install exited with code $INSTALL_EXIT"
  echo "Check: is the iPhone connected via USB to dev-01?"
  exit $INSTALL_EXIT
fi
