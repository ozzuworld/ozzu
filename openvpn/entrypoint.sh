#!/bin/sh
set -e

# Create TUN device if missing
if [ ! -c /dev/net/tun ]; then
    mkdir -p /dev/net
    mknod /dev/net/tun c 10 200
    chmod 600 /dev/net/tun
fi

# Enable IP forwarding (best-effort; host may mount /proc/sys read-only)
sysctl -w net.ipv4.ip_forward=1 2>/dev/null || true

# Add MASQUERADE rule for VPN subnet (idempotent)
if ! iptables -t nat -C POSTROUTING -s 10.8.0.0/24 -j MASQUERADE 2>/dev/null; then
    iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -j MASQUERADE
fi

exec "$@"
