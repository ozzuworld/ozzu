#!/system/bin/sh
# 03-ozzu-telemetry.sh — Magisk service.d supervisor for the Ozzu telemetry agent.
#
# Install to /data/adb/service.d/03-ozzu-telemetry.sh (chmod 755). Magisk runs
# service.d scripts late in boot AS ROOT — exactly the supervision the agent
# lacked: nothing used to respawn it, so one OOM/kill left the device dark on the
# fleet even while WireGuard stayed up.
#
# Provides the three things the bare `nohup agent &` never had:
#   1. boot-persist  — starts the agent on every boot (Magisk service.d)
#   2. wakelock      — partial CPU wakelock so the 60s ticks fire under doze
#                      (fleet devices are expected powered/always-on)
#   3. watchdog      — respawns the agent within 30s if it ever dies/hangs
#
# Per-device config is sourced from telemetry.env (written by onboard-device.sh),
# so THIS script is identical on every device — the paths/ids differ only in the
# env file. That is what makes onboarding uniform. Defaults target the standard
# /data/adb/ozzu layout; the CAT (legacy /data/local/tmp) just gets a different env.
#
# Toybox-safe: no pgrep, no awk. Scans /proc for the agent by cmdline.

TELEMETRY_ENV="${TELEMETRY_ENV:-/data/adb/ozzu/telemetry.env}"
[ -r "$TELEMETRY_ENV" ] && . "$TELEMETRY_ENV"

# Export so the agent (started below) inherits the per-device config.
export TELEMETRY_DEVICE_ID TELEMETRY_BRIDGE_URL TELEMETRY_TOKEN_FILE TELEMETRY_CURL TELEMETRY_ROLE

AGENT="${TELEMETRY_AGENT:-/data/adb/ozzu/ozzu-telemetry-android.sh}"
LOG="${TELEMETRY_LOG:-/data/local/tmp/telemetry.log}"
WAKELOCK=ozzu-telemetry

log() { echo "[$(date 2>/dev/null || echo boot)] $1" >> "$LOG"; }

agent_running() {
  for p in /proc/[0-9]*; do
    c=$(cat "$p/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$c" in *ozzu-telemetry-android*) return 0;; esac
  done
  return 1
}

# Run the whole supervisor detached so Magisk's service.d pass returns promptly.
(
  sleep 45   # let WiFi + WireGuard (app VpnService) come up after boot

  # Partial wakelock: keep the CPU alive so `sleep 60` in the agent is not
  # stretched to the next doze maintenance window. Idempotent with the WG keepalive.
  echo "$WAKELOCK" > /sys/power/wake_lock 2>/dev/null

  log "supervisor: online (agent=$AGENT env=$TELEMETRY_ENV)"
  while true; do
    if ! agent_running; then
      log "supervisor: agent not running -> (re)starting"
      setsid sh "$AGENT" >> "$LOG" 2>&1 &
    fi
    sleep 30
  done
) &
