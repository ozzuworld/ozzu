#!/usr/bin/env bash
# ozzu-telemetry-linux.sh — rich device telemetry agent for Linux hosts.
# Pushes CPU/memory/disk/thermal/network/processes/connections/USB to the bridge
# via POST /api/device-telemetry. Tiered collection: fast (60s), medium (5 cycles),
# slow (30 cycles). Replaces the thin heartbeat-reporter.sh for enrolled devices.
# dir_1782490126626
set -u

AGENT_VERSION="2.0.0"
DEVICE_ID="${TELEMETRY_DEVICE_ID:-$(hostname -s)}"
BRIDGE="${TELEMETRY_BRIDGE_URL:-http://localhost:3333/api/device-telemetry}"
TOKEN_FILE="${TELEMETRY_TOKEN_FILE:-/root/.ozzu-hb/token}"
ROLE="${TELEMETRY_ROLE:-server}"

FAST_INTERVAL=60
MEDIUM_EVERY=5
SLOW_EVERY=30

[ -r "$TOKEN_FILE" ] || { echo "no token at $TOKEN_FILE" >&2; exit 1; }
TOKEN="$(tr -d '\n' < "$TOKEN_FILE")"

jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g;s/"/\\"/g;s/\t/\\t/g' | tr -d '\n'; }
jstr() { printf '"%s"' "$(jesc "$1")"; }
jnum() { echo "${1:-null}"; }

collect_identity() {
  local model manufacturer serial cpu_model cpu_cores arch kernel os_name os_ver
  model=$(cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null || hostname -s || echo "unknown")
  manufacturer=$(cat /sys/devices/virtual/dmi/id/sys_vendor 2>/dev/null || echo "unknown")
  serial=$(cat /sys/devices/virtual/dmi/id/product_serial 2>/dev/null || echo "unknown")
  cpu_model=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ //' || echo "unknown")
  cpu_cores=$(nproc 2>/dev/null || echo 0)
  arch=$(uname -m)
  kernel=$(uname -r)
  os_name=$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)
  os_ver=$(. /etc/os-release 2>/dev/null && echo "$VERSION_ID" || uname -r)

  cat <<EOID
{"hardware":{"model":$(jstr "$model"),"manufacturer":$(jstr "$manufacturer"),"serial":$(jstr "$serial"),"cpu_model":$(jstr "$cpu_model"),"cpu_cores":$cpu_cores,"cpu_abi":$(jstr "$arch")},"os":{"version":$(jstr "$os_ver"),"name":$(jstr "$os_name"),"kernel":$(jstr "$kernel"),"arch":$(jstr "$arch")},"security":{"firewall":"$(command -v ufw >/dev/null && ufw status 2>/dev/null | head -1 || echo 'unknown')"},"agent":{"version":$(jstr "$AGENT_VERSION")}}
EOID
}

collect_cpu() {
  local load1 load5 load15 procs_total procs_running gov
  read -r load1 load5 load15 procs_field _ < /proc/loadavg
  procs_running=$(echo "$procs_field" | cut -d/ -f1)
  procs_total=$(echo "$procs_field" | cut -d/ -f2)
  gov=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo "unknown")

  local freqs=""
  for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq; do
    [ -r "$f" ] || continue
    local mhz=$(( $(cat "$f") / 1000 ))
    [ -n "$freqs" ] && freqs="$freqs,"
    freqs="$freqs$mhz"
  done

  local temp="null"
  if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
    local raw=$(cat /sys/class/thermal/thermal_zone0/temp)
    temp=$(awk "BEGIN{printf \"%.1f\", $raw/1000}")
  fi

  echo "{\"load_1m\":$load1,\"load_5m\":$load5,\"load_15m\":$load15,\"procs_total\":$procs_total,\"procs_running\":$procs_running,\"governor\":$(jstr "$gov"),\"freq_mhz\":[$freqs],\"temp_c\":$temp}"
}

collect_memory() {
  local total free avail buffers cached swap_total swap_free
  total=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
  free=$(awk '/^MemFree:/{print int($2/1024)}' /proc/meminfo)
  avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
  buffers=$(awk '/^Buffers:/{print int($2/1024)}' /proc/meminfo)
  cached=$(awk '/^Cached:/{print int($2/1024)}' /proc/meminfo)
  swap_total=$(awk '/^SwapTotal:/{print int($2/1024)}' /proc/meminfo)
  swap_free=$(awk '/^SwapFree:/{print int($2/1024)}' /proc/meminfo)
  local used_pct=$(awk "BEGIN{printf \"%.1f\", ($total-$avail)/$total*100}")

  echo "{\"total_mb\":$total,\"free_mb\":$free,\"available_mb\":$avail,\"buffers_mb\":$buffers,\"cached_mb\":$cached,\"swap_total_mb\":$swap_total,\"swap_free_mb\":$swap_free,\"used_pct\":$used_pct}"
}

collect_thermal() {
  local zones=""
  for z in /sys/class/thermal/thermal_zone*; do
    [ -d "$z" ] || continue
    local type=$(cat "$z/type" 2>/dev/null || echo "unknown")
    local temp_raw=$(cat "$z/temp" 2>/dev/null || echo 0)
    local temp_c=$(awk "BEGIN{printf \"%.1f\", $temp_raw/1000}")
    [ -n "$zones" ] && zones="$zones,"
    zones="$zones{\"zone\":$(jstr "$type"),\"temp_c\":$temp_c}"
  done
  # Add lm-sensors data if available
  if command -v sensors >/dev/null 2>&1; then
    local sensor_temps
    sensor_temps=$(sensors 2>/dev/null | awk -F'[: +°]' '/^\S/{chip=$1} /temp[0-9]|Core|CPU|GPU|Composite|NVMe/{gsub(/^ +/,"",$2); if($3+0 > 0) print chip":"$3}' || true)
    local line
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local sname="${line%%:*}"
      local sval="${line#*:}"
      [ -z "$sval" ] && continue
      [ -n "$zones" ] && zones="$zones,"
      zones="$zones{\"zone\":$(jstr "$sname"),\"temp_c\":$sval}"
    done <<< "$sensor_temps"
  fi
  echo "[$zones]"
}

collect_network() {
  local lan_ip wg_ip public_ip wifi_ssid
  lan_ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -vE '^10\.9\.' | head -1 || true)
  wg_ip=$(ip -4 -o addr show dev wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true)
  public_ip=$(curl -sS -m 5 https://ifconfig.me 2>/dev/null || true)

  # WiFi (if wireless interface exists)
  local wifi="null"
  local wlan=$(ip -o link show 2>/dev/null | awk -F': ' '/wl/{print $2}' | head -1)
  if [ -n "$wlan" ] && command -v iw >/dev/null 2>&1; then
    local ssid=$(iw dev "$wlan" link 2>/dev/null | awk '/SSID:/{print $2}')
    local signal=$(iw dev "$wlan" link 2>/dev/null | awk '/signal:/{print $2}')
    local freq=$(iw dev "$wlan" link 2>/dev/null | awk '/freq:/{print $2}')
    local bssid=$(iw dev "$wlan" link 2>/dev/null | awk '/Connected to/{print $3}')
    if [ -n "$ssid" ]; then
      wifi="{\"ssid\":$(jstr "$ssid"),\"signal_dbm\":${signal:-null},\"freq_mhz\":${freq:-null},\"bssid\":$(jstr "${bssid:-}")}"
    fi
  fi

  # Traffic counters
  local traffic=""
  for iface in $(ip -o link show up 2>/dev/null | awk -F': ' '{print $2}' | grep -v '^lo$'); do
    local rx=$(cat /sys/class/net/$iface/statistics/rx_bytes 2>/dev/null || echo 0)
    local tx=$(cat /sys/class/net/$iface/statistics/tx_bytes 2>/dev/null || echo 0)
    [ -n "$traffic" ] && traffic="$traffic,"
    traffic="$traffic$(jstr "$iface"):{\"rx_bytes\":$rx,\"tx_bytes\":$tx}"
  done

  # DNS
  local dns1=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null || true)

  echo "{\"wifi\":$wifi,\"lan_ip\":$(jstr "${lan_ip:-}"),\"wg_ip\":$(jstr "${wg_ip:-}"),\"public_ip\":$(jstr "${public_ip:-}"),\"traffic\":{$traffic},\"dns\":[$(jstr "${dns1:-}")]}"
}

collect_uptime() {
  awk '{printf "%d", $1}' /proc/uptime
}

# ── Medium tier ──

collect_disk() {
  local disks=""
  while IFS= read -r line; do
    local fs=$(echo "$line" | awk '{print $1}')
    local size=$(echo "$line" | awk '{print $2}')
    local used=$(echo "$line" | awk '{print $3}')
    local avail=$(echo "$line" | awk '{print $4}')
    local pct=$(echo "$line" | awk '{print $5}' | tr -d '%')
    local mount=$(echo "$line" | awk '{print $6}')
    [ -n "$disks" ] && disks="$disks,"
    disks="$disks{\"fs\":$(jstr "$fs"),\"mount\":$(jstr "$mount"),\"size_kb\":$size,\"used_kb\":$used,\"avail_kb\":$avail,\"use_pct\":${pct:-0}}"
  done < <(df -k --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2)
  echo "$disks"
}

collect_processes() {
  local count=$(ps -e --no-headers 2>/dev/null | wc -l)
  local top5=""
  while IFS= read -r line; do
    local cpu=$(echo "$line" | awk '{print $1}')
    local pid=$(echo "$line" | awk '{print $2}')
    local rss=$(echo "$line" | awk '{print $3}')
    local name=$(echo "$line" | awk '{print $4}')
    [ -n "$top5" ] && top5="$top5,"
    top5="$top5{\"pid\":$pid,\"name\":$(jstr "$name"),\"cpu_pct\":$cpu,\"rss_kb\":$rss}"
  done < <(ps -eo pcpu,pid,rss,comm --sort=-pcpu --no-headers 2>/dev/null | head -5)
  echo "{\"count\":$count,\"top_cpu\":[$top5]}"
}

collect_connections() {
  local listening=""
  while IFS= read -r line; do
    local addr=$(echo "$line" | awk '{print $4}')
    local port=$(echo "$addr" | rev | cut -d: -f1 | rev)
    local proto=$(echo "$line" | awk '{print $1}')
    [ -n "$listening" ] && listening="$listening,"
    listening="$listening{\"addr\":$(jstr "$addr"),\"port\":$port,\"proto\":$(jstr "$proto")}"
  done < <(ss -tlnp 2>/dev/null | tail -n +2 | head -30)
  local established=$(ss -t state established 2>/dev/null | tail -n +2 | wc -l)
  echo "{\"listening\":[$listening],\"established_count\":$established}"
}

# ── Slow tier ──

collect_packages() {
  local count=0
  if command -v dpkg >/dev/null 2>&1; then
    count=$(dpkg -l 2>/dev/null | grep '^ii' | wc -l)
  elif command -v rpm >/dev/null 2>&1; then
    count=$(rpm -qa 2>/dev/null | wc -l)
  fi
  echo "{\"count\":$count}"
}

collect_usb() {
  local devs=""
  if command -v lsusb >/dev/null 2>&1; then
    while IFS= read -r line; do
      local ids=$(echo "$line" | grep -oP 'ID \K\S+' || true)
      local name=$(echo "$line" | sed 's/.*ID [0-9a-f:]* *//')
      [ -z "$ids" ] && continue
      [ -n "$devs" ] && devs="$devs,"
      devs="$devs{\"id\":$(jstr "$ids"),\"name\":$(jstr "$name")}"
    done < <(lsusb 2>/dev/null)
  fi
  echo "[$devs]"
}

collect_docker() {
  local containers=""
  if command -v docker >/dev/null 2>&1; then
    while IFS='|' read -r name state status image; do
      [ -z "$name" ] && continue
      [ -n "$containers" ] && containers="$containers,"
      containers="$containers{\"name\":$(jstr "$name"),\"state\":$(jstr "$state"),\"status\":$(jstr "$status"),\"image\":$(jstr "$image")}"
    done < <(docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}' 2>/dev/null)
  fi
  echo "[$containers]"
}

collect_wifi_scan() {
  local aps=""
  if command -v iw >/dev/null 2>&1; then
    local wlan=$(ip -o link show 2>/dev/null | awk -F': ' '/wl/{print $2}' | head -1)
    if [ -n "$wlan" ]; then
      while IFS='|' read -r ssid signal freq; do
        [ -z "$ssid" ] && continue
        [ -n "$aps" ] && aps="$aps,"
        aps="$aps{\"ssid\":$(jstr "$ssid"),\"signal_dbm\":${signal:-null},\"freq_mhz\":${freq:-null}}"
      done < <(iw dev "$wlan" scan 2>/dev/null | awk '
        /^BSS /{sig=""; freq=""; ssid=""}
        /signal:/{sig=$2}
        /freq:/{freq=$2}
        /SSID:/{ssid=$2; if(ssid!="" && sig!="") print ssid"|"sig"|"freq}
      ' | sort -t'|' -k2 -n | head -15)
    fi
  fi
  echo "$aps"
}

collect_security() {
  local fw="unknown"
  if command -v ufw >/dev/null 2>&1; then
    fw=$(ufw status 2>/dev/null | head -1 | awk '{print $2}')
  elif command -v iptables >/dev/null 2>&1; then
    local rules=$(iptables -L -n 2>/dev/null | wc -l)
    fw="iptables:${rules}rules"
  fi
  local selinux="disabled"
  [ -f /sys/fs/selinux/enforce ] && selinux=$(cat /sys/fs/selinux/enforce 2>/dev/null | sed 's/1/Enforcing/;s/0/Permissive/')
  local ssh_keys=0
  [ -f /root/.ssh/authorized_keys ] && ssh_keys=$(wc -l < /root/.ssh/authorized_keys)
  echo "{\"firewall\":$(jstr "$fw"),\"selinux\":$(jstr "$selinux"),\"ssh_authorized_keys\":$ssh_keys}"
}

# ── Main loop ──

CYCLE=0
LAST_IDENTITY_FP=""

while true; do
  # ── Fast tier (every cycle) ──
  CPU=$(collect_cpu)
  MEM=$(collect_memory)
  THERMAL=$(collect_thermal)
  NET=$(collect_network)
  UPTIME=$(collect_uptime)

  VITALS="{\"cpu\":$CPU,\"memory\":$MEM,\"thermal\":$THERMAL,\"network\":$NET,\"uptime_s\":$UPTIME}"

  # ── Identity (boot + on change) ──
  SEND_IDENTITY=0
  if [ $CYCLE -eq 0 ]; then
    SEND_IDENTITY=1
  elif [ $((CYCLE % SLOW_EVERY)) -eq 0 ]; then
    FP=$(uname -r; cat /etc/os-release 2>/dev/null | head -3)
    if [ "$FP" != "$LAST_IDENTITY_FP" ]; then
      SEND_IDENTITY=1
    fi
  fi

  # ── Medium tier ──
  SYSTEM="null"
  if [ $((CYCLE % MEDIUM_EVERY)) -eq 0 ]; then
    DISK=$(collect_disk)
    PROCS=$(collect_processes)
    CONNS=$(collect_connections)
    SYSTEM="{\"disk\":[$DISK],\"processes\":$PROCS,\"connections\":$CONNS}"
  fi

  # ── Slow tier ──
  INV_DATA="null"
  if [ $((CYCLE % SLOW_EVERY)) -eq 0 ]; then
    PKGS=$(collect_packages)
    USB=$(collect_usb)
    DOCKER=$(collect_docker)
    SEC=$(collect_security)
    WSCAN=$(collect_wifi_scan)
    INV_DATA="{\"packages\":$PKGS,\"usb\":$USB,\"docker\":$DOCKER,\"security\":$SEC,\"wifi_scan\":[$WSCAN]}"
  fi

  # ── Tier label ──
  TIER="fast"
  [ $((CYCLE % SLOW_EVERY)) -eq 0 ] && TIER="full"
  [ $((CYCLE % MEDIUM_EVERY)) -eq 0 ] && [ "$TIER" = "fast" ] && TIER="medium"

  # ── Identity ──
  IDENTITY_JSON="null"
  if [ $SEND_IDENTITY -eq 1 ]; then
    IDENTITY_JSON=$(collect_identity)
    LAST_IDENTITY_FP=$(uname -r; cat /etc/os-release 2>/dev/null | head -3)
  fi

  # ── Build payload ──
  BODY="{\"tier\":\"$TIER\""
  [ "$IDENTITY_JSON" != "null" ] && BODY="$BODY,\"identity\":$IDENTITY_JSON"
  BODY="$BODY,\"vitals\":$VITALS"
  [ "$SYSTEM" != "null" ] && BODY="$BODY,\"system\":$SYSTEM"
  [ "$INV_DATA" != "null" ] && BODY="$BODY,\"inventory_data\":$INV_DATA"
  BODY="$BODY,\"meta\":{\"source\":\"ozzu-telemetry\",\"role\":$(jstr "$ROLE"),\"agent_version\":$(jstr "$AGENT_VERSION"),\"cycle\":$CYCLE,\"tier\":$(jstr "$TIER")}}"

  # ── POST ──
  curl -sS -m 15 -X POST "$BRIDGE" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$BODY" >/dev/null 2>&1 || true

  CYCLE=$((CYCLE + 1))
  sleep $FAST_INTERVAL
done
