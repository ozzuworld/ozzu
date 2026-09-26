#!/usr/bin/env bash
# Install the quota-based media watchdog on bridge-01 (dir_1790443814736):
# 1. Mint a long-lived Jellyfin API token (admin auth) → /etc/ozzu/jellyfin-token (600)
# 2. Install infra/media-stack/disk-watchdog.sh → /usr/local/bin/ozzu-media-watchdog
# 3. Cron every 5 min as root
# Idempotent; token rotates each run. Requires: Jellyfin admin exists
# (run scripts/media-stack-configure.sh first).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG="$REPO_ROOT/infra/media-stack/disk-watchdog.sh"
SECRETS=/root/.ozzu-secrets
JELLYFIN_USER=hadmin
JF=http://localhost:8096

[[ -f "$WATCHDOG" ]] || { echo "missing $WATCHDOG"; exit 1; }
set -a; source "$SECRETS"; set +a
: "${JELLYFIN_ADMIN_PASS:?JELLYFIN_ADMIN_PASS missing from $SECRETS}"

echo "=== 1. Jellyfin auth + mint watchdog API key ==="
JF_AUTH=$(curl -sf -X POST "$JF/Users/AuthenticateByName" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: MediaBrowser Client="OzzuWatchdogInstall", Device="bridge01", DeviceId="watchdog-install", Version="1.0"' \
  -d "$(jq -n --arg u "$JELLYFIN_USER" --arg p "$JELLYFIN_ADMIN_PASS" '{Username:$u,Pw:$p}')")
ADMIN_TOKEN=$(jq -r .AccessToken <<<"$JF_AUTH")
[[ -n "$ADMIN_TOKEN" && "$ADMIN_TOKEN" != "null" ]] || { echo "Jellyfin auth failed"; exit 2; }

EXISTING=$(curl -sf "$JF/Auth/Keys" -H "Authorization: MediaBrowser Token=$ADMIN_TOKEN" | jq -r '.Items[]? | select(.AppName=="ozzu-watchdog") | .AccessToken')
if [[ -n "$EXISTING" ]]; then
  curl -sf -X DELETE "$JF/Auth/Keys/$EXISTING" -H "Authorization: MediaBrowser Token=$ADMIN_TOKEN" >/dev/null
fi
curl -sf -X POST "$JF/Auth/Keys?App=ozzu-watchdog" -H "Authorization: MediaBrowser Token=$ADMIN_TOKEN" >/dev/null
WATCHDOG_TOKEN=$(curl -sf "$JF/Auth/Keys" -H "Authorization: MediaBrowser Token=$ADMIN_TOKEN" | jq -r '.Items[] | select(.AppName=="ozzu-watchdog") | .AccessToken' | tail -1)
[[ -n "$WATCHDOG_TOKEN" && "$WATCHDOG_TOKEN" != "null" ]] || { echo "API key mint failed"; exit 3; }
echo "minted (first 8): ${WATCHDOG_TOKEN:0:8}..."

echo
echo "=== 2. Token → /etc/ozzu/jellyfin-token ==="
install -d -m 0700 /etc/ozzu
printf '%s' "$WATCHDOG_TOKEN" > /etc/ozzu/jellyfin-token
chmod 600 /etc/ozzu/jellyfin-token

echo
echo "=== 3. Install /usr/local/bin/ozzu-media-watchdog ==="
install -m 0755 "$WATCHDOG" /usr/local/bin/ozzu-media-watchdog

echo
echo "=== 4. Cron entry (every 5 min) ==="
cat > /etc/cron.d/ozzu-media-watchdog <<'CRON'
# Ozzu media quota watchdog — keeps /srv/media + /srv/downloads inside the GB budget
# (bridge-01 root FS hosts the whole Ozzu core stack; NEVER use %-of-mount triggers here).
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root /usr/local/bin/ozzu-media-watchdog >> /var/log/ozzu-media-watchdog.log 2>&1
CRON
chmod 0644 /etc/cron.d/ozzu-media-watchdog
touch /var/log/ozzu-media-watchdog.log && chmod 0644 /var/log/ozzu-media-watchdog.log
systemctl reload cron 2>/dev/null || true

echo
echo "=== 5. Dry-run sanity (HIGH_GB=9999 → expect clean no-trigger exit) ==="
HIGH_GB=9999 /usr/local/bin/ozzu-media-watchdog && echo "watchdog OK"

cat <<EOF
=== DONE ===
  Script: /usr/local/bin/ozzu-media-watchdog (quotas: HIGH_GB=90 LOW_GB=70, override via env in cron)
  Cron:   /etc/cron.d/ozzu-media-watchdog · Log: /var/log/ozzu-media-watchdog.log
  Token:  /etc/ozzu/jellyfin-token (ozzu-watchdog key, rotates each install run)
EOF
