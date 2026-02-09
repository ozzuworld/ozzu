#!/usr/bin/env bash
# setup-host.sh — One-time host prerequisites for a fresh GCP VM
# Run as root or with sudo
set -euo pipefail

echo "=== Installing Docker ==="
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
    echo "Docker installed."
else
    echo "Docker already installed, skipping."
fi

echo "=== Installing Docker Compose plugin ==="
if ! docker compose version &>/dev/null; then
    apt-get update && apt-get install -y docker-compose-plugin
    echo "Docker Compose plugin installed."
else
    echo "Docker Compose plugin already installed, skipping."
fi

echo "=== Installing git-crypt ==="
if ! command -v git-crypt &>/dev/null; then
    apt-get update && apt-get install -y git-crypt
    echo "git-crypt installed."
else
    echo "git-crypt already installed, skipping."
fi

echo "=== Configuring sysctl (ip_forward) ==="
if ! grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf; then
    echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
    sysctl -p
    echo "ip_forward enabled persistently."
else
    echo "ip_forward already set, skipping."
fi

echo "=== Configuring UFW ==="
if command -v ufw &>/dev/null; then
    ufw allow 22/tcp    comment 'SSH'
    ufw allow 1194/udp  comment 'OpenVPN'
    ufw allow 8123/tcp  comment 'Home Assistant'
    ufw --force enable
    echo "UFW rules applied."
else
    echo "UFW not installed, skipping firewall setup."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Clone the repo:    git clone <repo-url> /home/gcp/ozzu"
echo "  2. Unlock secrets:    cd /home/gcp/ozzu && git-crypt unlock /path/to/ozzu-git-crypt.key"
echo "  3. Start the stack:   docker compose up -d"
echo "  4. Export key backup:  git-crypt export-key ~/ozzu-git-crypt.key"
