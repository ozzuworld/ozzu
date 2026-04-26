#!/usr/bin/env bash
# Install the disk watchdog on dev-01:
# 1. Mint a long-lived Jellyfin API token (POST /Auth/Keys with admin auth)
# 2. Save token to /etc/ozzu/jellyfin-token (root:root 600)
# 3. Install /usr/local/bin/ozzu-disk-watchdog
# 4. Install /etc/cron.d/ozzu-disk-watchdog (every 5 min as root)
# 5. Bring up maintainerr container (already added to compose)
#
# Idempotent — safe to re-run. Token is rotated each run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG="$REPO_ROOT/infra/jellyfin-dev01/disk-watchdog.sh"
SUDO_PASS="Pokemon123!"
JELLYFIN_USER="hadmin"
JELLYFIN_PASS="Pokemon123!"

[[ -f "$WATCHDOG" ]] || { echo "missing $WATCHDOG"; exit 1; }

echo "=== 1. Mint Jellyfin API token (admin-issued, no expiry) ==="
JF_AUTH=$(ssh dev-01 "curl -s -X POST 'http://localhost:8096/Users/AuthenticateByName' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: MediaBrowser Client=\"OzzuWatchdogInstall\", Device=\"dev01\", DeviceId=\"watchdog-install\", Version=\"1.0\"' \
  -d '{\"Username\":\"$JELLYFIN_USER\",\"Pw\":\"$JELLYFIN_PASS\"}'")
ADMIN_TOKEN=$(jq -r .AccessToken <<<"$JF_AUTH")
[[ -z "$ADMIN_TOKEN" || "$ADMIN_TOKEN" == "null" ]] && { echo "Jellyfin auth failed"; echo "$JF_AUTH" | head; exit 2; }

# Mint a long-lived API key. Pre-rotate any prior 'ozzu-watchdog' key so retries are clean.
ssh dev-01 "
EXISTING=\$(curl -s 'http://localhost:8096/Auth/Keys' -H 'X-Emby-Token: $ADMIN_TOKEN' | jq -r '.Items[]? | select(.AppName==\"ozzu-watchdog\") | .AccessToken')
if [[ -n \"\$EXISTING\" ]]; then
  curl -s -X DELETE \"http://localhost:8096/Auth/Keys/\$EXISTING\" -H 'X-Emby-Token: $ADMIN_TOKEN'
fi
curl -s -X POST 'http://localhost:8096/Auth/Keys?App=ozzu-watchdog' -H 'X-Emby-Token: $ADMIN_TOKEN'
NEW=\$(curl -s 'http://localhost:8096/Auth/Keys' -H 'X-Emby-Token: $ADMIN_TOKEN' | jq -r '.Items[] | select(.AppName==\"ozzu-watchdog\") | .AccessToken')
echo \$NEW
" > /tmp/ozzu-jf-token
WATCHDOG_TOKEN=$(tail -1 /tmp/ozzu-jf-token | tr -d '\n\r')
[[ -z "$WATCHDOG_TOKEN" ]] && { echo "API key mint failed"; cat /tmp/ozzu-jf-token; exit 3; }
echo "minted (first 8): ${WATCHDOG_TOKEN:0:8}..."

echo
echo "=== 2. Save token to /etc/ozzu/jellyfin-token on dev-01 ==="
ssh dev-01 "echo '$SUDO_PASS' | sudo -S bash -c '
  install -d -m 0700 /etc/ozzu
  echo -n \"$WATCHDOG_TOKEN\" > /etc/ozzu/jellyfin-token
  chmod 600 /etc/ozzu/jellyfin-token
'"

echo
echo "=== 3. Install /usr/local/bin/ozzu-disk-watchdog ==="
scp "$WATCHDOG" dev-01:/tmp/ozzu-disk-watchdog
ssh dev-01 "echo '$SUDO_PASS' | sudo -S install -m 0755 /tmp/ozzu-disk-watchdog /usr/local/bin/ozzu-disk-watchdog"

echo
echo "=== 4. Install cron entry (every 5 min) ==="
ssh dev-01 "echo '$SUDO_PASS' | sudo -S bash -c '
cat > /etc/cron.d/ozzu-disk-watchdog <<CRON
# Ozzu Jellyfin disk watchdog — keeps /srv from filling up.
# Configure thresholds via environment in the script itself.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root /usr/local/bin/ozzu-disk-watchdog >> /var/log/ozzu-disk-watchdog.log 2>&1
CRON
chmod 0644 /etc/cron.d/ozzu-disk-watchdog
touch /var/log/ozzu-disk-watchdog.log
chmod 0644 /var/log/ozzu-disk-watchdog.log
service cron reload 2>/dev/null || systemctl reload cron 2>/dev/null || true
'"

echo
echo "=== 5. Apply compose change (brings up maintainerr) ==="
scp "$REPO_ROOT/infra/jellyfin-dev01/docker-compose.yml" dev-01:/srv/jellyfin/docker-compose.yml
ssh dev-01 "cd /srv/jellyfin && docker compose up -d 2>&1 | tail -10"

echo
echo "=== 6. Sanity test: dry-run watchdog with HIGH=0 (forces eviction trigger) ==="
ssh dev-01 "echo '$SUDO_PASS' | sudo -S HIGH_PCT=0 LOW_PCT=0 /usr/local/bin/ozzu-disk-watchdog 2>&1 | head -3"

echo
cat <<EOF
=== DONE ===

Disk watchdog:
  Script:  /usr/local/bin/ozzu-disk-watchdog
  Cron:    /etc/cron.d/ozzu-disk-watchdog (every 5 min as root)
  Token:   /etc/ozzu/jellyfin-token (mode 600, ozzu-watchdog API key)
  Log:     /var/log/ozzu-disk-watchdog.log

  Defaults: trigger at 90% / clean to 80%. Override per-cron with HIGH_PCT/LOW_PCT envs.

Maintainerr:
  http://192.168.1.11:6246
  Wizard on first visit: paste the Jellyfin/Sonarr/Radarr details below.
  (Sign in with your Jellyfin admin: hadmin / Pokemon123!)

Connection details for the maintainerr wizard:
  Jellyfin URL:  http://jellyfin:8096    (or http://192.168.1.11:8096 from outside)
  Jellyfin API:  $WATCHDOG_TOKEN
  Sonarr URL:    http://sonarr:8989
  Sonarr API:    9f2b6bf1bc1346789ccf83794f408702
  Radarr URL:    http://radarr:7878
  Radarr API:    d6da14abb77f46188dd528808fc37fc8

Suggested rules to start with (set in maintainerr UI):
  - "watched movies older than 30 days" -> delete
  - "watched TV episodes older than 14 days" -> delete
  - "tag 'Favorite' on Jellyfin" -> never delete (Jellyfin tag carries through)
EOF
