#!/bin/bash
# Deploy latest iOS IPA from GitHub Actions to iPhone via dev-01
# Uses AltServer-Linux on dev-01 for code signing + installation
#
# Usage: ./scripts/deploy-ios.sh [OPTIONS]
#   --local IPA_PATH     Install from a local IPA file instead of downloading from GitHub
#   --check              Health check only: test dev-01 SSH, AltServer, iPhone USB connection
#   --stage              If dev-01 is unreachable, stage IPA at /tmp/ozzu-ios-staged/ instead of failing
#
# Requires: APPLE_ID, APPLE_PASSWORD, IPHONE_UDID env vars (or in backend/.env)
# All operations are non-interactive — suitable for automated pipeline use.

set -e

REPO="ozzuworld/ozzu"
DEV01="dev-01"  # SSH alias (hadmin@172.168.0.61)
IPA_DIR="/tmp/ozzu-ios"
REMOTE_IPA_DIR="/tmp/ozzu-ios"
STAGED_IPA_DIR="/tmp/ozzu-ios-staged"
ANISETTE_URL="http://10.8.0.1:6969"  # Anisette runs on GCP VM, reachable via VPN

# Load credentials from .env if not already set
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="$(dirname "$SCRIPT_DIR")"
# Try the main repo .env first (decrypted on GCP VM), then worktree copy
if [ -f "/home/gcp/ozzu/backend/.env" ]; then
  source "/home/gcp/ozzu/backend/.env"
elif [ -f "$WORKDIR/backend/.env" ]; then
  source "$WORKDIR/backend/.env"
fi

APPLE_ID="${APPLE_ID:-eng.ozzu@icloud.com}"
APPLE_PASSWORD="${APPLE_PASSWORD:-}"
IPHONE_UDID="${IPHONE_UDID:-00008140-000A449C02E8801C}"

if [ -z "$APPLE_PASSWORD" ]; then
  # Try reading from dev-01's install script as fallback
  APPLE_PASSWORD=$(ssh -o ConnectTimeout=5 -o BatchMode=yes "$DEV01" "grep -- '-p ' ~/install-ozzu.sh 2>/dev/null | sed 's/.*-p //' | awk '{print \$1}'" 2>/dev/null || true)
fi

if [ -z "$APPLE_PASSWORD" ]; then
  echo "Error: APPLE_PASSWORD not set. Add it to backend/.env or export it."
  exit 1
fi

# Parse args
USE_LOCAL=false
LOCAL_IPA=""
CHECK_ONLY=false
STAGE_ON_FAIL=false
for arg in "$@"; do
  case "$arg" in
    --local)
      USE_LOCAL=true
      ;;
    --check)
      CHECK_ONLY=true
      ;;
    --stage)
      STAGE_ON_FAIL=true
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

# ── Health check function (reused by --check and deploy flow) ──
check_dev01() {
  local result='{"ssh":false,"altserver":false,"iphone_usb":false}'

  # SSH connectivity
  if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$DEV01" true 2>/dev/null; then
    echo "$result"
    return 1
  fi

  # Run all checks in one SSH call for speed
  local checks
  checks=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$DEV01" '
    echo -n "SSH_OK "
    if test -x ~/bin/AltServer; then echo -n "ALTSERVER_OK "; else echo -n "ALTSERVER_MISSING "; fi
    if lsusb 2>/dev/null | grep -qi "apple"; then echo -n "IPHONE_OK"; else echo -n "IPHONE_MISSING"; fi
  ' 2>/dev/null) || { echo "$result"; return 1; }

  local ssh_ok=false altserver_ok=false iphone_ok=false
  [[ "$checks" == *"SSH_OK"* ]] && ssh_ok=true
  [[ "$checks" == *"ALTSERVER_OK"* ]] && altserver_ok=true
  [[ "$checks" == *"IPHONE_OK"* ]] && iphone_ok=true

  echo "{\"ssh\":$ssh_ok,\"altserver\":$altserver_ok,\"iphone_usb\":$iphone_ok}"
  if [ "$ssh_ok" = true ] && [ "$altserver_ok" = true ] && [ "$iphone_ok" = true ]; then
    return 0
  fi
  return 1
}

# ── --check mode: just report health and exit ──
if [ "$CHECK_ONLY" = true ]; then
  echo "Checking dev-01 health..."
  HEALTH=$(check_dev01)
  EXIT=$?
  echo "$HEALTH"
  exit $EXIT
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
echo "Checking dev-01 ($DEV01) health..."
HEALTH=$(check_dev01)
DEV01_EXIT=$?

if [ $DEV01_EXIT -ne 0 ]; then
  echo "dev-01 health: $HEALTH"

  if [ "$STAGE_ON_FAIL" = true ]; then
    echo ""
    echo "dev-01 is not fully ready — staging IPA for later install."
    mkdir -p "$STAGED_IPA_DIR"
    cp "$IPA" "$STAGED_IPA_DIR/ozzu.ipa"
    echo "IPA staged at: $STAGED_IPA_DIR/ozzu.ipa"
    echo "To install later: ./scripts/deploy-ios.sh --local $STAGED_IPA_DIR/ozzu.ipa"
    # Exit 2 = staged (not a hard failure, pipeline can distinguish)
    exit 2
  fi

  # Parse what's wrong for a helpful message
  if echo "$HEALTH" | grep -q '"ssh":false'; then
    echo "Error: Cannot SSH to $DEV01. Is dev-01 powered on and connected to the network?"
  elif echo "$HEALTH" | grep -q '"altserver":false'; then
    echo "Error: AltServer not found on dev-01. Run ./scripts/setup-ios-sideloading.sh"
  elif echo "$HEALTH" | grep -q '"iphone_usb":false'; then
    echo "Error: iPhone not detected via USB on dev-01. Connect iPhone to dev-01."
  fi
  exit 1
fi
echo "dev-01 ready: $HEALTH"

# ── Step 3: Transfer IPA to dev-01 ──
echo ""
echo "Transferring IPA to dev-01..."
ssh -o BatchMode=yes "$DEV01" "mkdir -p $REMOTE_IPA_DIR"
scp -q "$IPA" "$DEV01:$REMOTE_IPA_DIR/ozzu.ipa"
echo "IPA transferred."

# ── Step 4: Install via AltServer ──
echo ""
echo "Installing via AltServer on dev-01..."
INSTALL_OUTPUT=$(ssh -o BatchMode=yes "$DEV01" "ALTSERVER_ANISETTE_SERVER=$ANISETTE_URL \$HOME/bin/AltServer -u $IPHONE_UDID -a $APPLE_ID -p '$APPLE_PASSWORD' $REMOTE_IPA_DIR/ozzu.ipa" 2>&1)
INSTALL_EXIT=$?
echo "$INSTALL_OUTPUT"

# AltServer may exit 0 even on failure — check output for errors
if echo "$INSTALL_OUTPUT" | grep -qi "could not \(install\|find\)\|error:"; then
  INSTALL_EXIT=1
fi

# ── Step 5: Cleanup ──
[ -d "$IPA_DIR" ] && rm -rf "$IPA_DIR"
ssh -o BatchMode=yes "$DEV01" "rm -rf $REMOTE_IPA_DIR" 2>/dev/null || true

echo ""
if [ $INSTALL_EXIT -eq 0 ]; then
  echo "iOS app installed successfully! Open ozzu on iPhone to verify."
else
  echo "AltServer install failed."
  echo "Check: is the iPhone connected via USB to dev-01?"
  exit 1
fi
