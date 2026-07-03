#!/usr/bin/env bash
# onboard-device.sh — add a device to the Ozzu fleet-telemetry system.
#
# One command to onboard any device: mints a per-device token, deploys the agent
# (+ a static curl on Android), installs supervision (systemd on Linux, a Magisk
# service.d watchdog on Android), starts it, and verifies telemetry lands.
#
#   scripts/telemetry/onboard-device.sh <device_id> <os> <target> [role]
#
#     device_id  fleet id, e.g. cat-s41, tablet-p610, rock-pi-sbc
#     os         android | linux
#     target     android: adb serial reached via the bridge over WG, e.g. 10.9.0.22:5555
#                linux:   ssh host (e.g. dev-01) or "local" for the bridge host itself
#     role       optional label (default: phone [android] / server [linux])
#
# Runs from the bridge host: Android goes through `docker exec bridge adb` (the
# bridge holds the WG route + adb); Linux uses ssh (the bridge mounts /root/.ssh).
# Re-running is idempotent — it ROTATES the token and re-deploys. See FLEET.md.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TEL="$REPO/scripts/telemetry"
BRIDGE_INGEST="http://10.9.0.1:3333/api/device-telemetry"

DEVICE_ID="${1:-}"
OS="${2:-}"
TARGET="${3:-}"
ROLE="${4:-}"

if [ -z "$DEVICE_ID" ] || [ -z "$OS" ] || [ -z "$TARGET" ]; then
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20
  exit 2
fi

say() { printf '\033[1;36m[onboard %s]\033[0m %s\n' "$DEVICE_ID" "$1"; }
die() { printf '\033[1;31m[onboard %s] FAILED:\033[0m %s\n' "$DEVICE_ID" "$1" >&2; exit 1; }

# ── 1. mint per-device token ────────────────────────────────────────────────
say "minting token (scope heartbeat:write)…"
TOKEN="$(docker exec bridge node scripts/issue-device-token.js "$DEVICE_ID" "onboarded $OS/$TARGET" 2>/dev/null)" \
  || die "token mint failed (is the bridge up?)"
[ -n "$TOKEN" ] || die "token mint returned empty"
say "token minted (${TOKEN:0:8}…)"

verify_landing() {
  # Poll device_state for a fresh row from this device (up to ~90s).
  say "verifying telemetry lands…"
  local i secs
  for i in $(seq 1 18); do
    sleep 5
    secs="$(docker exec ozzu-postgres psql -U ozzu -d ozzu -tAc \
      "SELECT EXTRACT(EPOCH FROM (NOW()-last_seen))::int FROM device_state WHERE device_id='$DEVICE_ID'" 2>/dev/null || echo "")"
    if [ -n "$secs" ] && [ "$secs" -lt 90 ] 2>/dev/null; then
      say "✅ telemetry landing — device_state fresh (${secs}s ago)"
      return 0
    fi
  done
  die "no fresh telemetry after 90s — check the agent log on the device"
}

# ── 2+3. deploy + supervise, per OS ─────────────────────────────────────────
case "$OS" in
  android)
    ROLE="${ROLE:-phone}"
    ABX() { docker exec bridge adb -s "$TARGET" "$@"; }
    say "checking adb reachability ($TARGET)…"
    ABX get-state >/dev/null 2>&1 || die "adb cannot reach $TARGET (WG down? device off?)"

    # Stage files + generate the per-device env and an on-device installer, so the
    # root-side moves happen on the phone (no host-side su -c quoting hell).
    local_stage() { ABX push "$1" "/data/local/tmp/$2" >/dev/null; }
    say "pushing agent + static curl + supervisor…"
    local_stage "$TEL/ozzu-telemetry-android.sh" ozzu-telemetry-android.sh
    local_stage "$TEL/bin/ozzu-curl-aarch64"     ozzu-curl
    local_stage "$TEL/03-ozzu-telemetry.sh"      03-ozzu-telemetry.sh

    # Stage under /tmp/ozzu-bridge — bind-mounted into the bridge at the SAME path,
    # so `adb push` (which runs inside the container) can read these generated files.
    mkdir -p /tmp/ozzu-bridge
    TMP="$(mktemp -d /tmp/ozzu-bridge/onboard.XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
    printf '%s\n' "$TOKEN" > "$TMP/hb-token"
    cat > "$TMP/telemetry.env" <<ENV
TELEMETRY_DEVICE_ID="$DEVICE_ID"
TELEMETRY_BRIDGE_URL="$BRIDGE_INGEST"
TELEMETRY_TOKEN_FILE="/data/adb/ozzu/hb-token"
TELEMETRY_CURL="/data/adb/ozzu/ozzu-curl"
TELEMETRY_ROLE="$ROLE"
TELEMETRY_AGENT="/data/adb/ozzu/ozzu-telemetry-android.sh"
ENV
    cat > "$TMP/ozzu-install.sh" <<'INSTALL'
#!/system/bin/sh
# on-device installer (runs as root): move staged files into the standard layout,
# strip legacy telemetry-start from 02-keepalive (03 owns telemetry now), (re)start.
mkdir -p /data/adb/ozzu /data/adb/service.d
cp /data/local/tmp/ozzu-curl                 /data/adb/ozzu/ozzu-curl
cp /data/local/tmp/ozzu-telemetry-android.sh /data/adb/ozzu/ozzu-telemetry-android.sh
cp /data/local/tmp/hb-token                  /data/adb/ozzu/hb-token
cp /data/local/tmp/telemetry.env             /data/adb/ozzu/telemetry.env
cp /data/local/tmp/03-ozzu-telemetry.sh      /data/adb/service.d/03-ozzu-telemetry.sh
chmod 755 /data/adb/ozzu/ozzu-curl /data/adb/ozzu/ozzu-telemetry-android.sh /data/adb/service.d/03-ozzu-telemetry.sh
chmod 600 /data/adb/ozzu/hb-token /data/adb/ozzu/telemetry.env
# de-dupe: an older keepalive may also start telemetry and fight the supervisor.
KA=/data/adb/service.d/02-ozzuwg-keepalive.sh
if [ -f "$KA" ]; then
  grep -v 'ozzu-telemetry-android.sh' "$KA" | grep -v 'telemetry reporter started' > /data/local/tmp/ka.new
  cp /data/local/tmp/ka.new "$KA"; chmod 755 "$KA"; rm -f /data/local/tmp/ka.new
fi
# Kill ALL telemetry procs — the new agent, any supervisor, AND a legacy agent under
# a different name (e.g. the tablet's ozzu-telemetry.sh) — then start fresh below.
# Proc-scan, NOT `pkill -f`: toybox/busybox pkill -f cmdline matching varies across
# builds (worked on the CAT's toybox, silently no-op on the tablet's toybox 0.8.12).
for p in /proc/[0-9]*; do
  c=$(cat "$p/cmdline" 2>/dev/null | tr '\0' ' ')
  case "$c" in *ozzu-telemetry*) kill -9 "${p#/proc/}" 2>/dev/null;; esac
done
sleep 1
echo ozzu-telemetry > /sys/power/wake_lock 2>/dev/null
# start the supervisor (boot-persist/watchdog) AND kick the agent now (supervisor
# sleeps 45s before its first check, so the first tick shouldn't wait for it).
setsid sh /data/adb/service.d/03-ozzu-telemetry.sh >/dev/null 2>&1 &
. /data/adb/ozzu/telemetry.env
export TELEMETRY_DEVICE_ID TELEMETRY_BRIDGE_URL TELEMETRY_TOKEN_FILE TELEMETRY_CURL TELEMETRY_ROLE
setsid sh /data/adb/ozzu/ozzu-telemetry-android.sh >> /data/local/tmp/telemetry.log 2>&1 &
echo "install-done"
INSTALL
    local_stage "$TMP/hb-token"       hb-token
    local_stage "$TMP/telemetry.env"  telemetry.env
    local_stage "$TMP/ozzu-install.sh" ozzu-install.sh

    say "installing on device (root)…"
    ABX shell "su -c 'sh /data/local/tmp/ozzu-install.sh'" 2>&1 | sed 's/^/    /'
    # scrub the staged token from world-readable /data/local/tmp
    ABX shell "su -c 'rm -f /data/local/tmp/hb-token /data/local/tmp/telemetry.env /data/local/tmp/ozzu-install.sh'" >/dev/null 2>&1 || true
    verify_landing
    ;;

  linux)
    ROLE="${ROLE:-server}"
    if [ "$TARGET" = "local" ]; then
      RUN() { "$@"; }; PUT() { install -Dm755 "$1" "$2"; }; PUTMODE() { install -Dm"$3" "$1" "$2"; }
    else
      RUN() { ssh "$TARGET" "$@"; }
      PUT() { scp -q "$1" "$TARGET:$2" && ssh "$TARGET" "chmod 755 $2"; }
      PUTMODE() { scp -q "$1" "$TARGET:$2" && ssh "$TARGET" "chmod $3 $2"; }
    fi
    say "checking reachability ($TARGET)…"
    RUN true 2>/dev/null || die "cannot reach $TARGET (ssh)"

    say "deploying agent → /usr/local/bin/ozzu-telemetry-linux.sh…"
    PUT "$TEL/ozzu-telemetry-linux.sh" /usr/local/bin/ozzu-telemetry-linux.sh

    say "writing token → /root/.ozzu-hb/token (0600)…"
    RUN "mkdir -p /root/.ozzu-hb && chmod 700 /root/.ozzu-hb && printf '%s\n' '$TOKEN' > /root/.ozzu-hb/token && chmod 600 /root/.ozzu-hb/token"

    say "installing systemd unit + starting…"
    UNIT="$(sed -e "s/__DEVICE_ID__/$DEVICE_ID/" -e "s/__ROLE__/$ROLE/" "$TEL/ozzu-telemetry.service")"
    if [ "$TARGET" = "local" ]; then printf '%s\n' "$UNIT" > /etc/systemd/system/ozzu-telemetry.service
    else printf '%s\n' "$UNIT" | ssh "$TARGET" "cat > /etc/systemd/system/ozzu-telemetry.service"; fi
    RUN "systemctl daemon-reload && systemctl enable --now ozzu-telemetry.service"
    verify_landing
    ;;

  *) die "unknown os '$OS' (want android|linux)" ;;
esac

say "done. registered in device_credentials; agent supervised + reporting."
