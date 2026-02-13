#!/bin/bash
# Setup iOS sideloading tools on dev-01 (172.168.0.59)
# Run this script ON dev-01 (SSH in first), not on the GCP VM.
#
# Installs: libimobiledevice, usbmuxd, Sideloader CLI, Anisette server (Docker)
#
# After running this script, connect iPhone via USB and run:
#   ./scripts/pair-iphone.sh
#
# Usage: ./scripts/setup-ios-sideloading.sh

set -e

echo "=== iOS Sideloading Setup for dev-01 ==="
echo ""

# ── Phase 1.1: Install libimobiledevice + usbmuxd ──
echo "[1/4] Installing libimobiledevice and usbmuxd..."
sudo apt update -qq
sudo apt install -y usbmuxd libimobiledevice6 libimobiledevice-utils ideviceinstaller ifuse
echo "  Done."

# Start and enable usbmuxd
echo "[1/4] Enabling usbmuxd service..."
sudo systemctl start usbmuxd
sudo systemctl enable usbmuxd
echo "  Done."

# ── Phase 1.2: Install Sideloader CLI ──
echo ""
echo "[2/4] Installing Sideloader CLI..."
SIDELOADER_URL="https://github.com/Dadoum/Sideloader/releases/latest/download/sideloader-x86_64-linux"

if command -v sideloader >/dev/null 2>&1; then
  echo "  Sideloader already installed: $(which sideloader)"
  read -p "  Reinstall? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "  Skipping."
  else
    wget -q -O /tmp/sideloader "$SIDELOADER_URL"
    chmod +x /tmp/sideloader
    sudo mv /tmp/sideloader /usr/local/bin/sideloader
    echo "  Updated."
  fi
else
  wget -q -O /tmp/sideloader "$SIDELOADER_URL"
  chmod +x /tmp/sideloader
  sudo mv /tmp/sideloader /usr/local/bin/sideloader
  echo "  Installed to /usr/local/bin/sideloader"
fi

# ── Phase 1.3: Self-hosted Anisette Server ──
echo ""
echo "[3/4] Setting up Anisette server (Docker)..."
if docker ps --format '{{.Names}}' | grep -q "^anisette$"; then
  echo "  Anisette container already running."
else
  # Remove stopped container if exists
  docker rm -f anisette 2>/dev/null || true
  docker run -d \
    -v anisette_cache:/opt/lib/ \
    --restart=always \
    -p 6969:6969 \
    --name anisette \
    dadoum/anisette-server:latest
  echo "  Anisette server started on port 6969."
fi

# Verify anisette is responding
sleep 2
if curl -s -o /dev/null -w "%{http_code}" http://localhost:6969 | grep -q "200"; then
  echo "  Anisette server verified (HTTP 200)."
else
  echo "  Warning: Anisette server not responding yet. It may need a moment to start."
fi

# ── Phase 1.4: Download SideStore IPA ──
echo ""
echo "[4/4] Downloading SideStore IPA..."
SIDESTORE_DIR="/opt/ozzu/ios"
sudo mkdir -p "$SIDESTORE_DIR"
sudo chown "$(whoami)" "$SIDESTORE_DIR"

SIDESTORE_URL="https://github.com/SideStore/SideStore/releases/latest/download/SideStore.ipa"
if [ -f "$SIDESTORE_DIR/SideStore.ipa" ]; then
  echo "  SideStore.ipa already exists at $SIDESTORE_DIR/SideStore.ipa"
  read -p "  Re-download? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    wget -q -O "$SIDESTORE_DIR/SideStore.ipa" "$SIDESTORE_URL"
    echo "  Downloaded."
  fi
else
  wget -q -O "$SIDESTORE_DIR/SideStore.ipa" "$SIDESTORE_URL"
  echo "  Downloaded to $SIDESTORE_DIR/SideStore.ipa"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps (requires iPhone + USB cable):"
echo "  1. Connect iPhone to dev-01 via USB"
echo "  2. Unlock the iPhone screen"
echo "  3. Run: ./scripts/pair-iphone.sh"
echo ""
echo "Or manually:"
echo "  idevice_id --list              # Verify device detected"
echo "  idevicepair pair               # Tap 'Trust' on iPhone"
echo "  idevicepair validate           # Should say SUCCESS"
echo ""
echo "Then install SideStore:"
echo "  ALTSERVER_ANISETTE_SERVER=http://localhost:6969 sideloader install $SIDESTORE_DIR/SideStore.ipa -i"
