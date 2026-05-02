#!/usr/bin/env bash
# Bootstrap the Jellyfin + *arr stack on dev-01.
# Idempotent — re-run to apply compose changes.
# Reads compose from infra/jellyfin-dev01/docker-compose.yml and ships it to dev-01:/srv/jellyfin/.
#
# Prereqs on dev-01: docker (28+), VPN tunnel up, hadmin in docker group. All confirmed Apr 2026.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/lib/infra.sh"
COMPOSE="$REPO_ROOT/infra/jellyfin-dev01/docker-compose.yml"
SUDO_PASS="${HADMIN_SUDO_PASS:?HADMIN_SUDO_PASS not set; copy infra/secrets.example to \$HOME/.ozzu-secrets and fill in}"

[[ -f "$COMPOSE" ]] || { echo "missing $COMPOSE" >&2; exit 1; }

echo "=== 1. Apply lid-close fix on dev-01 (server stays up with lid closed) ==="
ssh dev-01 "echo '$SUDO_PASS' | sudo -S bash -c '
  sed -i \"s/^#\\?HandleLidSwitch=.*/HandleLidSwitch=ignore/\" /etc/systemd/logind.conf
  sed -i \"s/^#\\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/\" /etc/systemd/logind.conf
  sed -i \"s/^#\\?HandleLidSwitchDocked=.*/HandleLidSwitchDocked=ignore/\" /etc/systemd/logind.conf
  systemctl restart systemd-logind
'"

echo
echo "=== 2. Create directory layout on dev-01 ==="
ssh dev-01 "echo '$SUDO_PASS' | sudo -S bash -c '
  mkdir -p /srv/jellyfin/config
  mkdir -p /srv/downloads
  mkdir -p /srv/media/movies /srv/media/tv
  chown -R hadmin:hadmin /srv/jellyfin /srv/downloads /srv/media
'"

echo
echo "=== 3. Ensure docker compose v2 plugin is installed (Kali doesn't ship it) ==="
ssh dev-01 "echo '$SUDO_PASS' | sudo -S bash -c '
  if ! docker compose version >/dev/null 2>&1; then
    install -d /usr/local/lib/docker/cli-plugins
    curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  fi
  docker compose version
'"

echo
echo "=== 4. Sanity-check render group GID matches compose ==="
RENDER_GID=$(ssh dev-01 "getent group render | cut -d: -f3")
COMPOSE_GID=$(grep -E 'render group on this Kali' "$COMPOSE" | grep -oE '"[0-9]+"' | tr -d '\"')
echo "dev-01 render GID: $RENDER_GID | compose has: $COMPOSE_GID"
[[ "$RENDER_GID" == "$COMPOSE_GID" ]] || { echo "GID mismatch — edit infra/jellyfin-dev01/docker-compose.yml" >&2; exit 1; }

echo
echo "=== 5. Push compose file ==="
scp "$COMPOSE" dev-01:/srv/jellyfin/docker-compose.yml

echo
echo "=== 6. Pull images (slow on first run, ~3-4 GB total) ==="
ssh dev-01 "cd /srv/jellyfin && docker compose pull 2>&1 | tail -10"

echo
echo "=== 7. Bring up the stack ==="
ssh dev-01 "cd /srv/jellyfin && docker compose up -d 2>&1 | tail -20"

echo
echo "=== 8. Verify all containers running ==="
sleep 5
ssh dev-01 "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E '(jellyfin|sonarr|radarr|prowlarr|bazarr|qbittorrent|flaresolverr|jellyseerr)'"

echo
echo "=== 9. URLs (LAN, from any device on FAMILIA SUAREZ WiFi) ==="
cat <<EOF
  Jellyfin       http://192.168.1.11:8096
  Jellyseerr     http://192.168.1.11:5055   (Netflix-style request UI)
  Prowlarr       http://192.168.1.11:9696   (indexer aggregator)
  Sonarr         http://192.168.1.11:8989   (TV automation)
  Radarr         http://192.168.1.11:7878   (movie automation)
  Bazarr         http://192.168.1.11:6767   (subtitles)
  qBittorrent    http://192.168.1.11:8080   (downloader)

First-run notes:
  - qBittorrent admin password — first 60 sec of logs:
      ssh dev-01 'docker logs qbittorrent 2>&1 | grep -A1 "temporary password"'
  - Jellyfin first-run wizard: open the URL, create admin, point at /media on the wizard.
  - HW transcode: in Jellyfin Admin -> Playback -> Transcoding, enable Intel QuickSync VAAPI.
EOF
