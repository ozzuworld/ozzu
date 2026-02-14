#!/bin/bash
# Deploy latest iOS IPA from GitHub Actions to iPhone via dev-01
# Uses Sideloader on dev-01 (172.168.0.59) for code signing + installation
#
# Usage: ./scripts/deploy-ios.sh [--local IPA_PATH]
#   --local IPA_PATH     Install from a local IPA file instead of downloading from GitHub
#
# Examples:
#   ./scripts/deploy-ios.sh                          # download latest CI build + install
#   ./scripts/deploy-ios.sh --local /tmp/ozzu.ipa    # install a local IPA

set -e

REPO="ozzuworld/ozzu"
DEV01="dev-01"  # SSH alias (hadmin@172.168.0.61)
IPA_DIR="/tmp/ozzu-ios"
REMOTE_IPA_DIR="/tmp/ozzu-ios"
ANISETTE_URL="http://10.8.0.1:6969"  # Anisette runs on GCP VM, reachable via VPN
IOS_BUNDLE_ID="com.ozzu.app"

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

# ── Step 3: Check prerequisites on dev-01 ──
echo "Checking sideloader on dev-01..."
SIDELOADER_BIN="\$HOME/bin/sideloader"
if ! ssh "$DEV01" "test -x $SIDELOADER_BIN" 2>/dev/null; then
  echo "Error: sideloader not found at $SIDELOADER_BIN on dev-01"
  echo "  Run ./scripts/setup-ios-sideloading.sh first"
  exit 1
fi

# ── Step 4: Transfer IPA to dev-01 ──
echo "Transferring IPA to dev-01..."
ssh "$DEV01" "mkdir -p $REMOTE_IPA_DIR"
scp -q "$IPA" "$DEV01:$REMOTE_IPA_DIR/ozzu.ipa"
echo "IPA transferred."

# ── Step 5: Install via Sideloader ──
echo ""
echo "Installing via sideloader on dev-01..."
echo "(iPhone must be connected via USB or previously paired)"
echo ""
# Sideloader extracts IPA to /tmp/{basename}/ — keep IPA in home dir to avoid
# collision with the extraction directory, and use a unique name to avoid
# stale root-owned dirs from previous runs
DEPLOY_NAME="ozzu-$(date +%s).ipa"
ssh "$DEV01" "mkdir -p \$HOME/ozzu-deploy && cp $REMOTE_IPA_DIR/ozzu.ipa \$HOME/ozzu-deploy/$DEPLOY_NAME"
ssh -t "$DEV01" "ALTSERVER_ANISETTE_SERVER=$ANISETTE_URL \$HOME/bin/sideloader install \$HOME/ozzu-deploy/$DEPLOY_NAME -i"
# Clean up
ssh "$DEV01" "rm -rf \$HOME/ozzu-deploy /tmp/$DEPLOY_NAME 2>/dev/null; true"

# ── Step 6: Verify ──
echo ""
echo "Install command complete."

# Cleanup
[ -d "$IPA_DIR" ] && rm -rf "$IPA_DIR"
ssh "$DEV01" "rm -rf $REMOTE_IPA_DIR" 2>/dev/null || true

echo ""
echo "Done. Open the ozzu app on iPhone to verify it connects to the bridge."
