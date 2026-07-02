#!/system/bin/sh
# ozzu-telemetry-android.sh — Ozzu fleet telemetry agent for rooted Android.
#
# Canonical Android agent (all devices). Toybox-safe: uses only sh, sed, cut,
# grep, head, tail, tr, cat, df, getprop, dumpsys, ip, ping — NO awk.
#
# Transport is the static `ozzu-curl` binary (a real HTTP client), NOT toybox
# `nc`. Toybox `nc` closes on stdin-EOF before reading the reply and does not
# reliably deliver the request on MTK/Android-8 (kernel 4.4) — see FLEET.md.
# Provision ozzu-curl via scripts/telemetry/onboard-device.sh.
#
# Reports the uniform telemetry contract to POST /api/device-telemetry.
# Identity is derived server-side from the per-device token, NOT the body.
#
# Config (env, all optional — safe defaults for the fleet):
#   TELEMETRY_DEVICE_ID   label for meta only (identity comes from the token)
#   TELEMETRY_BRIDGE_URL  full ingest URL (default http://10.9.0.1:3333/api/device-telemetry)
#   TELEMETRY_TOKEN_FILE  per-device bearer token file
#   TELEMETRY_CURL        path to the static curl binary
#   TELEMETRY_ROLE        role label for meta (default "phone")

AGENT_VERSION="2.1.0-android"
DEVICE_ID="${TELEMETRY_DEVICE_ID:-android}"
BRIDGE="${TELEMETRY_BRIDGE_URL:-http://10.9.0.1:3333/api/device-telemetry}"
TOKEN_FILE="${TELEMETRY_TOKEN_FILE:-/data/adb/ozzu/hb-token}"
CURL="${TELEMETRY_CURL:-/data/adb/ozzu/ozzu-curl}"
ROLE="${TELEMETRY_ROLE:-phone}"

FAST_INTERVAL=60      # vitals every tick
MEDIUM_EVERY=5        # disk every 5 cycles
SLOW_EVERY=30         # identity/full every 30 cycles

# ── Preflight: the agent MUST have curl + a token, else it is useless. ──
if [ ! -x "$CURL" ]; then
  echo "ozzu-telemetry: no executable curl at $CURL — run onboard-device.sh" >&2
  exit 1
fi
if [ ! -r "$TOKEN_FILE" ]; then
  echo "ozzu-telemetry: no token at $TOKEN_FILE" >&2
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE" | tr -d '\n')"

jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g;s/"/\\"/g' | tr -d '\n'; }
jstr() { printf '"%s"' "$(jesc "$1")"; }

# http_post — reads the JSON body from stdin and POSTs it via the static curl.
# Bounded (-m 15) so a tick can never wedge; small retry rides transient drops.
# Body via --data-binary @- avoids ARG_MAX and toybox nc's HTTP entirely.
http_post() {
  "$CURL" -sS -m 15 --retry 2 --retry-delay 2 \
    -X POST "$BRIDGE" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @- 2>/dev/null
}

collect_identity() {
  local model=$(getprop ro.product.model 2>/dev/null || echo "unknown")
  local mfr=$(getprop ro.product.manufacturer 2>/dev/null || echo "unknown")
  local serial=$(getprop ro.serialno 2>/dev/null || echo "unknown")
  local arch=$(getprop ro.product.cpu.abi 2>/dev/null || uname -m)
  local kernel=$(uname -r 2>/dev/null || echo "unknown")
  local api=$(getprop ro.build.version.sdk 2>/dev/null || echo "0")
  local aver=$(getprop ro.build.version.release 2>/dev/null || echo "unknown")
  local cores=$(grep -c "^processor" /proc/cpuinfo 2>/dev/null || echo "0")
  echo "{\"hardware\":{\"model\":$(jstr "$model"),\"manufacturer\":$(jstr "$mfr"),\"serial\":$(jstr "$serial"),\"cpu_cores\":$cores,\"cpu_abi\":$(jstr "$arch")},\"os\":{\"version\":$(jstr "$aver"),\"name\":\"Android\",\"kernel\":$(jstr "$kernel"),\"api_level\":$api},\"agent\":{\"version\":$(jstr "$AGENT_VERSION")}}"
}

collect_cpu() {
  local loadline=$(cat /proc/loadavg 2>/dev/null || echo "0 0 0")
  local l1=$(echo "$loadline" | cut -d' ' -f1)
  local l5=$(echo "$loadline" | cut -d' ' -f2)
  local l15=$(echo "$loadline" | cut -d' ' -f3)
  local temp="null"
  for z in /sys/class/thermal/thermal_zone*/temp; do
    [ -r "$z" ] || continue
    local raw=$(cat "$z" 2>/dev/null || echo 0)
    if [ "$raw" -gt 1000 ] 2>/dev/null; then
      local whole=$((raw / 1000))
      local frac=$((raw % 1000 / 100))
      temp="${whole}.${frac}"
      break
    fi
  done
  echo "{\"load_1m\":$l1,\"load_5m\":$l5,\"load_15m\":$l15,\"temp_c\":$temp}"
}

collect_memory() {
  local total=$(grep "^MemTotal:" /proc/meminfo | sed 's/[^0-9]//g')
  local free=$(grep "^MemFree:" /proc/meminfo | sed 's/[^0-9]//g')
  local avail=$(grep "^MemAvailable:" /proc/meminfo | sed 's/[^0-9]//g')
  total=$((total / 1024))
  free=$((free / 1024))
  [ -n "$avail" ] && avail=$((avail / 1024)) || avail=$free
  local used=$((total - avail))
  local pct=0
  [ "$total" -gt 0 ] 2>/dev/null && pct=$((used * 100 / total))
  echo "{\"total_mb\":$total,\"free_mb\":$free,\"available_mb\":$avail,\"used_pct\":$pct}"
}

collect_battery() {
  local pct=$(cat /sys/class/power_supply/battery/capacity 2>/dev/null || echo "null")
  local status=$(cat /sys/class/power_supply/battery/status 2>/dev/null || echo "unknown")
  local temp_raw=$(cat /sys/class/power_supply/battery/temp 2>/dev/null || echo "0")
  local whole=$((temp_raw / 10))
  local frac=$((temp_raw % 10))
  echo "{\"pct\":$pct,\"status\":$(jstr "$status"),\"temp_c\":${whole}.${frac}}"
}

collect_thermal() {
  local zones=""
  for z in /sys/class/thermal/thermal_zone*; do
    [ -d "$z" ] || continue
    local type=$(cat "$z/type" 2>/dev/null || echo "unknown")
    local raw=$(cat "$z/temp" 2>/dev/null || echo 0)
    local whole=$((raw / 1000))
    local frac=$((raw % 1000 / 100))
    [ -n "$zones" ] && zones="$zones,"
    zones="$zones{\"zone\":$(jstr "$type"),\"temp_c\":${whole}.${frac}}"
  done
  echo "[$zones]"
}

collect_network() {
  local lan_ip=$(ip -4 -o addr show scope global 2>/dev/null | grep -v "tun0" | head -1 | tr -s ' ' | cut -d' ' -f4 | cut -d/ -f1)
  local wg_ip=$(ip -4 -o addr show dev tun0 2>/dev/null | head -1 | tr -s ' ' | cut -d' ' -f4 | cut -d/ -f1)
  # public_ip intentionally left empty — the agent makes ZERO unbounded external
  # calls (the old ifconfig.me fetch wedged the tick). The bridge sees the source IP.
  local public_ip=""

  local winfo=$(dumpsys wifi 2>/dev/null | grep "mWifiInfo" | head -1 || true)
  local wifi_ssid=""
  if [ -n "$winfo" ]; then
    wifi_ssid=$(echo "$winfo" | sed 's/.*[^B]SSID: //;s/,.*//' | tr -d '"' || true)
    [ "$wifi_ssid" = "<unknown ssid>" ] && wifi_ssid=""
  fi

  local wifi="null"
  if [ -n "$wifi_ssid" ]; then
    local signal=$(echo "$winfo" | sed 's/.*RSSI: //;s/[^0-9-].*//' || true)
    local freq=$(echo "$winfo" | sed 's/.*Frequency: //;s/[^0-9].*//' || true)
    wifi="{\"ssid\":$(jstr "$wifi_ssid"),\"signal_dbm\":${signal:-null},\"freq_mhz\":${freq:-null}}"
  fi

  # Coarse local WG reachability. Authoritative handshake age is server-side
  # (host wg-poller -> wg-state.json -> /infra/heartbeats), so this is enrichment.
  local wg_hs="null"
  if [ -n "$wg_ip" ]; then
    if ping -c1 -W3 10.9.0.1 >/dev/null 2>&1; then wg_hs=0; else wg_hs=9999; fi
  fi

  echo "{\"wifi\":$wifi,\"lan_ip\":$(jstr "${lan_ip:-}"),\"wg_ip\":$(jstr "${wg_ip:-}"),\"public_ip\":$(jstr "${public_ip:-}"),\"wg_handshake_age_s\":$wg_hs,\"wifi_ssid\":$(jstr "${wifi_ssid:-}")}"
}

collect_uptime() {
  local up=$(cat /proc/uptime 2>/dev/null | cut -d. -f1)
  echo "${up:-0}"
}

collect_disk() {
  local line=$(df /data 2>/dev/null | tail -1)
  local total=$(echo "$line" | tr -s ' ' | cut -d' ' -f2)
  local used=$(echo "$line" | tr -s ' ' | cut -d' ' -f3)
  local avail=$(echo "$line" | tr -s ' ' | cut -d' ' -f4)
  local pct=0
  [ "$total" -gt 0 ] 2>/dev/null && pct=$((used * 100 / total))
  echo "{\"fs\":\"/data\",\"mount\":\"/data\",\"size_kb\":${total:-0},\"used_kb\":${used:-0},\"avail_kb\":${avail:-0},\"use_pct\":$pct}"
}

# ── Main loop ──
CYCLE=0

while true; do
  CPU=$(collect_cpu)
  MEM=$(collect_memory)
  BATT=$(collect_battery)
  THERMAL=$(collect_thermal)
  NET=$(collect_network)
  UPTIME=$(collect_uptime)

  VITALS="{\"cpu\":$CPU,\"memory\":$MEM,\"battery\":$BATT,\"thermal\":$THERMAL,\"network\":$NET,\"uptime_s\":$UPTIME}"

  SEND_IDENTITY=0
  [ $((CYCLE % SLOW_EVERY)) -eq 0 ] && SEND_IDENTITY=1

  SYSTEM="null"
  if [ $((CYCLE % MEDIUM_EVERY)) -eq 0 ]; then
    DISK=$(collect_disk)
    SYSTEM="{\"disk\":[$DISK]}"
  fi

  TIER="fast"
  [ $((CYCLE % SLOW_EVERY)) -eq 0 ] && TIER="full"
  [ $((CYCLE % MEDIUM_EVERY)) -eq 0 ] && [ "$TIER" = "fast" ] && TIER="medium"

  IDENTITY_JSON="null"
  [ $SEND_IDENTITY -eq 1 ] && IDENTITY_JSON=$(collect_identity)

  BODY="{\"tier\":\"$TIER\""
  [ "$IDENTITY_JSON" != "null" ] && BODY="$BODY,\"identity\":$IDENTITY_JSON"
  BODY="$BODY,\"vitals\":$VITALS"
  [ "$SYSTEM" != "null" ] && BODY="$BODY,\"system\":$SYSTEM"
  BODY="$BODY,\"meta\":{\"source\":\"ozzu-telemetry\",\"role\":$(jstr "$ROLE"),\"device_hint\":$(jstr "$DEVICE_ID"),\"agent_version\":$(jstr "$AGENT_VERSION"),\"cycle\":$CYCLE,\"tier\":$(jstr "$TIER")}}"

  printf '%s' "$BODY" | http_post >/dev/null 2>&1 || true

  CYCLE=$((CYCLE + 1))
  sleep $FAST_INTERVAL
done
