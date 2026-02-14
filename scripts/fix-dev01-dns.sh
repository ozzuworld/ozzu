#!/bin/bash
# Fix DNS resolution on dev-01
# Run this ON dev-01 (requires sudo)
#
# Problem: /etc/resolv.conf -> /run/systemd/resolve/stub-resolv.conf (doesn't exist)
# Solution: Create the target file with the home router as nameserver

set -e

echo "Fixing DNS on dev-01..."
sudo mkdir -p /run/systemd/resolve
sudo bash -c 'echo "nameserver 172.168.0.1" > /run/systemd/resolve/stub-resolv.conf'

# Verify
if dig @172.168.0.1 google.com +short >/dev/null 2>&1; then
  echo "DNS is working! (via router 172.168.0.1)"
else
  echo "Warning: DNS test failed"
fi

# Also verify the normal resolution path works
if getent hosts google.com >/dev/null 2>&1; then
  echo "System DNS resolution is working!"
else
  echo "Warning: System DNS resolution still broken"
fi
