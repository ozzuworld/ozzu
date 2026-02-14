#!/bin/bash
# Setup iOS sideloading tools
# Run this on the GCP VM — it downloads tools and SCPs them to dev-01.
# dev-01 has no internet DNS, so all downloads go through GCP.
#
# Architecture:
#   GCP VM: runs Anisette server (Docker, port 6969)
#   dev-01: runs Sideloader CLI + usbmuxd (iPhone connected via USB)
#   Sideloader on dev-01 talks to Anisette at http://10.8.0.1:6969 (VPN)
#
# After running this script, connect iPhone via USB and run:
#   ./scripts/pair-iphone.sh
#
# Usage: ./scripts/setup-ios-sideloading.sh

set -e

DEV01="dev-01"  # SSH alias (hadmin@172.168.0.61)
SIDELOADER_VERSION="1.0-pre4"
SIDELOADER_URL="https://github.com/Dadoum/Sideloader/releases/download/${SIDELOADER_VERSION}/sideloader-cli-x86_64-linux-gnu.zip"
SIDESTORE_VERSION="0.6.2"
SIDESTORE_URL="https://github.com/SideStore/SideStore/releases/download/${SIDESTORE_VERSION}/SideStore.ipa"

echo "=== iOS Sideloading Setup ==="
echo ""

# ── Step 1: Check dev-01 connectivity ──
echo "[1/5] Checking dev-01 connectivity..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$DEV01" true 2>/dev/null; then
  echo "Error: Cannot SSH to $DEV01"
  echo "  Check ~/.ssh/config for dev-01 entry"
  exit 1
fi
echo "  dev-01 is reachable."

# ── Step 2: Download Sideloader CLI ──
echo ""
echo "[2/5] Downloading Sideloader CLI v${SIDELOADER_VERSION}..."
TMPDIR=$(mktemp -d)
wget -q -O "$TMPDIR/sideloader-cli.zip" "$SIDELOADER_URL"
unzip -o -j "$TMPDIR/sideloader-cli.zip" "sideloader-cli-x86_64-linux-gnu" -d "$TMPDIR"
chmod +x "$TMPDIR/sideloader-cli-x86_64-linux-gnu"
echo "  Downloaded."

# ── Step 3: Download SideStore IPA ──
echo ""
echo "[3/5] Downloading SideStore v${SIDESTORE_VERSION}..."
wget -q -O "$TMPDIR/SideStore.ipa" "$SIDESTORE_URL"
echo "  Downloaded."

# ── Step 4: Transfer to dev-01 ──
echo ""
echo "[4/5] Transferring files to dev-01..."
ssh "$DEV01" "mkdir -p ~/bin ~/ozzu-ios-setup"
scp -q "$TMPDIR/sideloader-cli-x86_64-linux-gnu" "$DEV01:~/bin/sideloader"
scp -q "$TMPDIR/SideStore.ipa" "$DEV01:~/ozzu-ios-setup/SideStore.ipa"
ssh "$DEV01" "chmod +x ~/bin/sideloader"
echo "  Sideloader installed to ~/bin/sideloader on dev-01"
echo "  SideStore.ipa saved to ~/ozzu-ios-setup/ on dev-01"

# ── Step 5: Start Anisette on GCP VM ──
echo ""
echo "[5/5] Setting up Anisette v3 server on GCP VM..."
if docker ps --format '{{.Names}}' | grep -q "^anisette$"; then
  echo "  Anisette container already running."
else
  docker rm -f anisette 2>/dev/null || true
  docker pull dadoum/anisette-v3-server:latest 2>/dev/null
  docker run -d \
    --restart=always \
    --name anisette \
    -p 6969:6969 \
    --volume anisette-v3_data:/home/Alcoholic/.config/anisette-v3/lib/ \
    dadoum/anisette-v3-server:latest
  echo "  Anisette v3 server started on port 6969."
fi

# Verify anisette is responding
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:6969 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo "  Anisette server verified (HTTP 200)."
else
  echo "  Warning: Anisette server returned HTTP $HTTP_CODE. May need more time to provision."
fi

# Verify dev-01 can reach Anisette
REMOTE_CODE=$(ssh "$DEV01" 'curl -s -o /dev/null -w "%{http_code}" http://10.8.0.1:6969 2>/dev/null' || echo "000")
if [ "$REMOTE_CODE" = "200" ]; then
  echo "  dev-01 can reach Anisette via VPN (HTTP 200)."
else
  echo "  Warning: dev-01 cannot reach Anisette (HTTP $REMOTE_CODE). Check VPN."
fi

# Cleanup
rm -rf "$TMPDIR"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps (requires iPhone + USB cable):"
echo "  1. Connect iPhone to dev-01 via USB"
echo "  2. Unlock the iPhone screen"
echo "  3. Run: ./scripts/pair-iphone.sh"
echo ""
echo "Then install SideStore + ozzu:"
echo "  ssh $DEV01 'ALTSERVER_ANISETTE_SERVER=http://10.8.0.1:6969 ~/bin/sideloader install ~/ozzu-ios-setup/SideStore.ipa -i'"
echo "  ./scripts/deploy-ios.sh"
