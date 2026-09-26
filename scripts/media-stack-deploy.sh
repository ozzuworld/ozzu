#!/usr/bin/env bash
# Bootstrap/update the Ozzu media broker stack LOCALLY on bridge-01. Idempotent.
# Run as root on bridge-01. Compose source: infra/media-stack/docker-compose.yml
# Deploy target: /srv/media-stack (configs + cache), /srv/media (library), /srv/downloads.
# dir_1790443814736 — replaces scripts/jellyfin-dev01-deploy.sh (ssh-to-dev-01 era).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/infra/media-stack/docker-compose.yml"
DEPLOY_DIR=/srv/media-stack

[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }
[[ "$(hostname)" == "bridge-01" ]] || echo "WARN: not on bridge-01 ($(hostname)) — continuing anyway"

echo "=== 1. Directory layout ==="
# /srv/downloads/{tv,movies} MUST pre-exist: qbit categories point at them and
# Sonarr/Radarr's RemotePathMappingCheck health-errors if they're missing (2026-09-26).
mkdir -p "$DEPLOY_DIR/config" "$DEPLOY_DIR/cache/stremio" /srv/downloads /srv/downloads/tv /srv/downloads/movies /srv/media/movies /srv/media/tv
chown -R 1000:1000 "$DEPLOY_DIR" /srv/downloads /srv/media
chmod 755 /srv/media /srv/downloads

echo
echo "=== 2. Compose file ==="
if [[ -f "$DEPLOY_DIR/docker-compose.yml" ]] && cmp -s "$SRC" "$DEPLOY_DIR/docker-compose.yml"; then
  echo "unchanged"
else
  cp "$SRC" "$DEPLOY_DIR/docker-compose.yml"
  echo "updated $DEPLOY_DIR/docker-compose.yml"
fi

echo
echo "=== 3. Pull images (~3-4 GB first run) ==="
docker compose -f "$DEPLOY_DIR/docker-compose.yml" pull --quiet 2>&1 | tail -5 || \
  docker compose -f "$DEPLOY_DIR/docker-compose.yml" pull 2>&1 | tail -15

echo
echo "=== 4. Up ==="
docker compose -f "$DEPLOY_DIR/docker-compose.yml" up -d 2>&1 | tail -15

echo
echo "=== 5. Verify ==="
sleep 8
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'jellyfin|stremio|sonarr|radarr|prowlarr|bazarr|qbittorrent|flaresolverr|jellyseerr|maintainerr' || true

cat <<'EOF'

=== URLs (LAN — bridge-01 is 192.168.1.9; WG mesh: 10.9.0.5) ===
  Jellyfin       http://192.168.1.9:8096
  Jellyseerr     http://192.168.1.9:5055   (Netflix-style request UI)
  stremio-server http://192.168.1.9:11470  (broker stream engine: /stream/<infoHash>/<fileIdx>)
  Prowlarr       http://192.168.1.9:9696
  Sonarr         http://192.168.1.9:8989
  Radarr         http://192.168.1.9:7878
  Bazarr         http://192.168.1.9:6767
  qBittorrent    http://192.168.1.9:8080
  Maintainerr    http://192.168.1.9:6246

Next: scripts/media-stack-configure.sh  (API wiring, idempotent)
EOF
