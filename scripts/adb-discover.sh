#!/bin/bash
# adb-discover.sh — Discover ADB wireless debugging ports for known devices
# Strategy: (1) check already-connected adb devices, (2) try cached port, (3) scan via nmap
# Usage:
#   source scripts/adb-discover.sh    # Loads get_device_addr() function
#   get_device_addr "tab-roaming"     # Returns "172.168.0.53:PORT" or empty

CACHE_FILE="/tmp/ozzu-adb-ports.cache"
CACHE_TTL=86400  # 24 hours — ports only change on device reboot

# Known devices: NAME|IP
KNOWN_DEVICES=(
  "tab-roaming|172.168.0.53"
  "tab-lroom|172.168.0.57"
  "tv-lroom|172.168.0.56"
)

# Port range for Android wireless debugging
PORT_MIN=30000
PORT_MAX=50000

_cache_get() {
  local ip=$1
  [ ! -f "$CACHE_FILE" ] && return 1
  local age=$(( $(date +%s) - $(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0) ))
  [ "$age" -gt "$CACHE_TTL" ] && return 1
  grep "^${ip}:" "$CACHE_FILE" 2>/dev/null | cut -d: -f2
}

_cache_set() {
  local ip=$1 port=$2
  [ -f "$CACHE_FILE" ] && grep -v "^${ip}:" "$CACHE_FILE" > "${CACHE_FILE}.tmp" 2>/dev/null && mv "${CACHE_FILE}.tmp" "$CACHE_FILE"
  echo "${ip}:${port}" >> "$CACHE_FILE"
}

_try_connect() {
  local addr=$1
  adb connect "$addr" >/dev/null 2>&1
  local status
  status=$(adb -s "$addr" get-state 2>&1 || true)
  [ "$status" = "device" ]
}

# Check if device is already connected to adb (fastest path)
_check_connected() {
  local ip=$1
  adb devices 2>/dev/null | grep "^${ip}:" | grep -w "device" | head -1 | cut -f1 | cut -d: -f2
}

# Scan for open port via nmap TCP connect (works over VPN unlike SYN scan)
_scan_adb_port() {
  local ip=$1
  local port
  port=$(nmap -sT -p ${PORT_MIN}-${PORT_MAX} --open -T5 --min-rate 3000 --max-retries 1 -n "$ip" 2>/dev/null \
    | grep "^[0-9]" | head -1 | cut -d/ -f1)
  [ -n "$port" ] && echo "$port"
}

# Get the IP for a device name
_get_device_ip() {
  local name=$1
  for entry in "${KNOWN_DEVICES[@]}"; do
    local n="${entry%%|*}"
    local ip="${entry##*|}"
    if [[ "$n" == *"$name"* ]]; then
      echo "$ip"
      return
    fi
  done
}

# Main function: returns "IP:PORT" for a device name, or empty string
get_device_addr() {
  local name=$1
  local ip
  ip=$(_get_device_ip "$name")
  [ -z "$ip" ] && return 1

  # 1) Check already-connected adb devices (instant)
  local connected_port
  connected_port=$(_check_connected "$ip")
  if [ -n "$connected_port" ]; then
    _cache_set "$ip" "$connected_port"
    echo "${ip}:${connected_port}"
    return 0
  fi

  # 2) Try cached port (fast — just adb connect)
  local cached_port
  cached_port=$(_cache_get "$ip")
  if [ -n "$cached_port" ]; then
    if _try_connect "${ip}:${cached_port}"; then
      echo "${ip}:${cached_port}"
      return 0
    fi
  fi

  # 3) Scan for new port (slow — nmap TCP connect scan)
  local port
  port=$(_scan_adb_port "$ip")
  if [ -n "$port" ] && _try_connect "${ip}:${port}"; then
    _cache_set "$ip" "$port"
    echo "${ip}:${port}"
    return 0
  fi

  return 1
}

# Discover all devices, print results
discover_all() {
  for entry in "${KNOWN_DEVICES[@]}"; do
    local name="${entry%%|*}"
    local addr
    addr=$(get_device_addr "$name" 2>/dev/null)
    if [ -n "$addr" ]; then
      echo "OK    $name  $addr"
    else
      echo "FAIL  $name  (not found)"
    fi
  done
}

# Seed ports manually: ./scripts/adb-discover.sh seed IP:PORT [IP:PORT ...]
# Example: ./scripts/adb-discover.sh seed 172.168.0.53:33377 172.168.0.57:39821
seed_ports() {
  for addr in "$@"; do
    local ip="${addr%%:*}"
    local port="${addr##*:}"
    adb connect "$addr" >/dev/null 2>&1 || true
    _cache_set "$ip" "$port"
    echo "Cached $addr"
  done
  touch "$CACHE_FILE"  # refresh TTL
}

# If run directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [ "$1" = "seed" ]; then
    shift
    seed_ports "$@"
  else
    echo "Scanning for ADB devices..."
    discover_all
  fi
fi
