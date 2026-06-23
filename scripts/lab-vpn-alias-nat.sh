#!/usr/bin/env bash
# lab-vpn-alias-nat.sh — durable host-side NAT alias so VPN clients can reach the
# EDIFICIO physical lab WITHOUT a subnet collision. dir_1782251823762.
#
# The problem: VPN clients (and other infra) already live on / route 192.168.1.0/24
# for their own purposes, so a VPN client cannot just talk to the lab's 192.168.1.0/24
# directly — the two /24s collide. The alias gives the lab a *shadow* /24 (10.66.1.0/24)
# that VPN clients address instead. The last octet is preserved 1:1:
#
#     VPN client dials  10.66.1.X   <=>   lab host  192.168.1.X
#
# How it works (two NAT rules on the HOST, in the `nat` table):
#   PREROUTING : packets arriving on wg0 addressed to 10.66.1.0/24 are NETMAP'd
#                to 192.168.1.0/24 (rewrites dest, preserving the host octet).
#   POSTROUTING: replies / forwarded traffic leaving on wg0 toward 192.168.1.0/24
#                are MASQUERADE'd so the lab sees the bridge as the source and
#                return traffic comes back through us.
#
# These rules survive container deploys (they're host rules, not container rules)
# but do NOT survive a host reboot. This script re-applies them idempotently and
# is wired to a root @reboot cron entry for durability. It is safe to run at any
# time — it only ADDS a rule when that exact rule is missing (`iptables -C || -A`),
# so a normal run when both rules are already present is a no-op with exit 0.
#
# It intentionally does NOT touch /etc/wireguard/wg0.conf — the live tunnel (and
# King Kazuma's SSH that rides it) must not be disturbed.

set -euo pipefail

IFACE="${WG_IFACE:-wg0}"
LAB_REAL="192.168.1.0/24"   # the physical EDIFICIO lab /24
LAB_ALIAS="10.66.1.0/24"    # the shadow /24 VPN clients address (octet preserved)

log() { printf '%s lab-vpn-alias-nat: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# 1) Wait for wg0 to exist (boot ordering — WireGuard may come up after cron @reboot).
#    Bounded loop, ~60s max, so we never hang a boot indefinitely.
deadline=$((SECONDS + 60))
until ip link show "$IFACE" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    log "ERROR: $IFACE did not appear within 60s — leaving NAT rules untouched"
    exit 1
  fi
  log "waiting for $IFACE to appear..."
  sleep 3
done
log "$IFACE is up"

# 2) Ensure the NETMAP match module is loaded (PREROUTING rule needs xt_NETMAP).
#    Ignore failure — it may be built in or already loaded; the -C/-A below is the
#    real source of truth for whether the rule can be applied.
modprobe xt_NETMAP 2>/dev/null || true

# 3) Add each rule ONLY if it is not already present. -C returns success when the
#    exact rule exists, so the `|| -A` branch fires only on a genuine miss.
if iptables -t nat -C PREROUTING -i "$IFACE" -d "$LAB_ALIAS" -j NETMAP --to "$LAB_REAL" 2>/dev/null; then
  log "PREROUTING NETMAP $LAB_ALIAS -> $LAB_REAL already present"
else
  iptables -t nat -A PREROUTING -i "$IFACE" -d "$LAB_ALIAS" -j NETMAP --to "$LAB_REAL"
  log "PREROUTING NETMAP $LAB_ALIAS -> $LAB_REAL added"
fi

if iptables -t nat -C POSTROUTING -o "$IFACE" -d "$LAB_REAL" -j MASQUERADE 2>/dev/null; then
  log "POSTROUTING MASQUERADE -> $LAB_REAL on $IFACE already present"
else
  iptables -t nat -A POSTROUTING -o "$IFACE" -d "$LAB_REAL" -j MASQUERADE
  log "POSTROUTING MASQUERADE -> $LAB_REAL on $IFACE added"
fi

log "done — lab VPN alias NAT in place ($LAB_ALIAS <-> $LAB_REAL via $IFACE)"
