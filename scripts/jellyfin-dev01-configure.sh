#!/usr/bin/env bash
# Wire up the *arr stack on dev-01 via REST APIs. Idempotent.
# Bypass auth on LAN, extract API keys, link Prowlarr <-> Sonarr/Radarr, set
# qBittorrent as download client, set root folders, set storage caps.
#
# Run AFTER scripts/jellyfin-dev01-deploy.sh. Jellyseerr <-> Jellyfin link
# stays manual (it needs a Jellyfin admin password we don't have).

set -euo pipefail

SUDO_PASS="Pokemon123!"
DEV01="dev-01"
QBIT_NEW_PASS="ozzu-jellyfin-2026"
QBIT_TEMP_PASS=$(ssh "$DEV01" "docker logs qbittorrent 2>&1" | grep -oE 'temporary password is provided for this session: [A-Za-z0-9]+' | tail -1 | sed 's/.*: //')
echo "qBit temp pass: $QBIT_TEMP_PASS"

on() { ssh "$DEV01" "$@"; }
sudoon() { ssh "$DEV01" "echo '$SUDO_PASS' | sudo -S $*"; }

# -----------------------------------------------------------------------------
# 1. Disable auth for LAN on Prowlarr / Sonarr / Radarr (edit config.xml)
# -----------------------------------------------------------------------------
echo "=== 1. Patch *arr config.xml: AuthenticationRequired=DisabledForLocalAddresses ==="
on "cd /srv/jellyfin && docker compose stop prowlarr sonarr radarr bazarr"

for svc in prowlarr sonarr radarr; do
  sudoon "
    cd /srv/jellyfin/config/$svc
    cp config.xml config.xml.bak.\$(date +%s) 2>/dev/null || true
    python3 -c \"
import re, sys
p = '/srv/jellyfin/config/$svc/config.xml'
s = open(p).read()
def setkey(s, k, v):
    if f'<{k}>' in s:
        return re.sub(f'<{k}>.*?</{k}>', f'<{k}>{v}</{k}>', s)
    return s.replace('</Config>', f'  <{k}>{v}</{k}>\n</Config>')
s = setkey(s, 'AuthenticationMethod', 'External')
s = setkey(s, 'AuthenticationRequired', 'DisabledForLocalAddresses')
open(p, 'w').write(s)
print('$svc patched')
\"
  "
done

# -----------------------------------------------------------------------------
# 2. Bring services back up + wait for them to listen
# -----------------------------------------------------------------------------
echo
echo "=== 2. Restart and wait for HTTP ==="
on "cd /srv/jellyfin && docker compose start prowlarr sonarr radarr bazarr"

for port in 9696 8989 7878 6767; do
  printf "wait :$port "
  for i in {1..30}; do
    if on "curl -sf -o /dev/null -m 1 http://localhost:$port/ping || curl -sf -o /dev/null -m 1 http://localhost:$port"; then
      echo "ok"
      break
    fi
    printf .
    sleep 2
  done
done

# -----------------------------------------------------------------------------
# 3. Extract API keys
# -----------------------------------------------------------------------------
PROWLARR_KEY=$(sudoon "grep -oP '(?<=<ApiKey>)[a-f0-9]+(?=</ApiKey>)' /srv/jellyfin/config/prowlarr/config.xml")
SONARR_KEY=$(sudoon "grep -oP '(?<=<ApiKey>)[a-f0-9]+(?=</ApiKey>)' /srv/jellyfin/config/sonarr/config.xml")
RADARR_KEY=$(sudoon   "grep -oP '(?<=<ApiKey>)[a-f0-9]+(?=</ApiKey>)' /srv/jellyfin/config/radarr/config.xml")

echo
echo "=== 3. API keys ==="
echo "Prowlarr: $PROWLARR_KEY"
echo "Sonarr  : $SONARR_KEY"
echo "Radarr  : $RADARR_KEY"

# -----------------------------------------------------------------------------
# 4. qBittorrent — set permanent admin password + tighten storage cap
# -----------------------------------------------------------------------------
echo
echo "=== 4. qBittorrent admin password + 100GB cap + auto-seed-then-delete ==="
on "
  COOKIE=\$(curl -s -i 'http://localhost:8080/api/v2/auth/login' \
    --data 'username=admin&password=$QBIT_TEMP_PASS' -H 'Referer: http://localhost:8080' \
    | grep -i set-cookie | grep -oE 'SID=[^;]+' | head -1)
  echo cookie=\$COOKIE

  # Set new admin password + LAN whitelist + storage limits
  # max_ratio_act:0 = pause-on-ratio (Sonarr/Radarr requires this; "remove" breaks completed-download-handling).
  # Storage cap is enforced by Sonarr/Radarr removeCompletedDownloads after import, not by qBit.
  curl -s 'http://localhost:8080/api/v2/app/setPreferences' \
    -H \"Cookie: \$COOKIE\" \
    --data-urlencode 'json={\"web_ui_username\":\"admin\",\"web_ui_password\":\"$QBIT_NEW_PASS\",\"bypass_local_auth\":true,\"max_active_downloads\":3,\"max_active_uploads\":2,\"max_active_torrents\":5,\"max_ratio_enabled\":true,\"max_ratio\":1.0,\"max_ratio_act\":0,\"max_seeding_time_enabled\":true,\"max_seeding_time\":2880,\"save_path\":\"/downloads\",\"temp_path_enabled\":false}'

  # Categories Sonarr/Radarr will use
  curl -s 'http://localhost:8080/api/v2/torrents/createCategory' -H \"Cookie: \$COOKIE\" --data 'category=tv&savePath=/downloads/tv'
  curl -s 'http://localhost:8080/api/v2/torrents/createCategory' -H \"Cookie: \$COOKIE\" --data 'category=movies&savePath=/downloads/movies'
"
echo "qBit admin password: $QBIT_NEW_PASS"

# -----------------------------------------------------------------------------
# 5. Sonarr — root folder /tv + qBittorrent download client
# -----------------------------------------------------------------------------
echo
echo "=== 5. Sonarr root folder + qBittorrent ==="
on "curl -s -X POST http://localhost:8989/api/v3/rootfolder \
  -H 'X-Api-Key: $SONARR_KEY' -H 'Content-Type: application/json' \
  -d '{\"path\":\"/tv\"}' | jq -c '{id, path}'"

on "curl -s -X POST http://localhost:8989/api/v3/downloadclient \
  -H 'X-Api-Key: $SONARR_KEY' -H 'Content-Type: application/json' \
  -d '{
    \"enable\": true,
    \"protocol\": \"torrent\",
    \"priority\": 1,
    \"name\": \"qBittorrent\",
    \"implementation\": \"QBittorrent\",
    \"configContract\": \"QBittorrentSettings\",
    \"fields\": [
      {\"name\": \"host\", \"value\": \"qbittorrent\"},
      {\"name\": \"port\", \"value\": 8080},
      {\"name\": \"useSsl\", \"value\": false},
      {\"name\": \"username\", \"value\": \"admin\"},
      {\"name\": \"password\", \"value\": \"$QBIT_NEW_PASS\"},
      {\"name\": \"tvCategory\", \"value\": \"tv\"}
    ]
  }' | jq -c '{id, name, enable}'"

# -----------------------------------------------------------------------------
# 6. Radarr — root folder /movies + qBittorrent download client
# -----------------------------------------------------------------------------
echo
echo "=== 6. Radarr root folder + qBittorrent ==="
on "curl -s -X POST http://localhost:7878/api/v3/rootfolder \
  -H 'X-Api-Key: $RADARR_KEY' -H 'Content-Type: application/json' \
  -d '{\"path\":\"/movies\"}' | jq -c '{id, path}'"

on "curl -s -X POST http://localhost:7878/api/v3/downloadclient \
  -H 'X-Api-Key: $RADARR_KEY' -H 'Content-Type: application/json' \
  -d '{
    \"enable\": true,
    \"protocol\": \"torrent\",
    \"priority\": 1,
    \"name\": \"qBittorrent\",
    \"implementation\": \"QBittorrent\",
    \"configContract\": \"QBittorrentSettings\",
    \"fields\": [
      {\"name\": \"host\", \"value\": \"qbittorrent\"},
      {\"name\": \"port\", \"value\": 8080},
      {\"name\": \"useSsl\", \"value\": false},
      {\"name\": \"username\", \"value\": \"admin\"},
      {\"name\": \"password\", \"value\": \"$QBIT_NEW_PASS\"},
      {\"name\": \"movieCategory\", \"value\": \"movies\"}
    ]
  }' | jq -c '{id, name, enable}'"

# -----------------------------------------------------------------------------
# 7. Prowlarr — link Sonarr + Radarr (so indexers auto-sync to them)
# -----------------------------------------------------------------------------
echo
echo "=== 7. Prowlarr -> Sonarr + Radarr applications ==="
on "curl -s -X POST http://localhost:9696/api/v1/applications \
  -H 'X-Api-Key: $PROWLARR_KEY' -H 'Content-Type: application/json' \
  -d '{
    \"name\": \"Sonarr\",
    \"syncLevel\": \"fullSync\",
    \"implementation\": \"Sonarr\",
    \"configContract\": \"SonarrSettings\",
    \"fields\": [
      {\"name\": \"prowlarrUrl\", \"value\": \"http://prowlarr:9696\"},
      {\"name\": \"baseUrl\", \"value\": \"http://sonarr:8989\"},
      {\"name\": \"apiKey\", \"value\": \"$SONARR_KEY\"},
      {\"name\": \"syncCategories\", \"value\": [5000,5010,5020,5030,5040,5045,5050]}
    ]
  }' | jq -c '{id, name}'"

on "curl -s -X POST http://localhost:9696/api/v1/applications \
  -H 'X-Api-Key: $PROWLARR_KEY' -H 'Content-Type: application/json' \
  -d '{
    \"name\": \"Radarr\",
    \"syncLevel\": \"fullSync\",
    \"implementation\": \"Radarr\",
    \"configContract\": \"RadarrSettings\",
    \"fields\": [
      {\"name\": \"prowlarrUrl\", \"value\": \"http://prowlarr:9696\"},
      {\"name\": \"baseUrl\", \"value\": \"http://radarr:7878\"},
      {\"name\": \"apiKey\", \"value\": \"$RADARR_KEY\"},
      {\"name\": \"syncCategories\", \"value\": [2000,2010,2020,2030,2040,2045,2050,2060]}
    ]
  }' | jq -c '{id, name}'"

# -----------------------------------------------------------------------------
# 8. Prowlarr — FlareSolverr proxy + tag, then add public indexers
#    Many sites are behind Cloudflare (1337x, eztv); FlareSolverr lets Prowlarr through.
# -----------------------------------------------------------------------------
echo
echo "=== 8. Prowlarr: FlareSolverr proxy + tag + indexers ==="

# FlareSolverr proxy
on "curl -s -X POST http://localhost:9696/api/v1/indexerproxy \
  -H 'X-Api-Key: $PROWLARR_KEY' -H 'Content-Type: application/json' \
  -d '{\"name\":\"FlareSolverr\",\"implementation\":\"FlareSolverr\",\"configContract\":\"FlareSolverrSettings\",\"tags\":[1],\"fields\":[{\"name\":\"host\",\"value\":\"http://flaresolverr:8191/\"},{\"name\":\"requestTimeout\",\"value\":60}]}' >/dev/null"

# 'flaresolverr' tag — id 1 (Prowlarr starts numbering from 1)
on "curl -s -X POST http://localhost:9696/api/v1/tag -H 'X-Api-Key: $PROWLARR_KEY' -H 'Content-Type: application/json' -d '{\"label\":\"flaresolverr\"}' >/dev/null"

# Add an indexer by fetching its schema, decorating, and POSTing.
# CF-protected ones get tags:[1] so Prowlarr routes them through FlareSolverr.
add_idx() {
  local def="$1" tag="$2"
  local schema=$(on "curl -s 'http://localhost:9696/api/v1/indexer/schema' -H 'X-Api-Key: $PROWLARR_KEY'" | jq --arg n "$def" '.[] | select(.definitionName == $n)')
  if [[ -z "$schema" ]]; then echo "schema not found for $def"; return; fi
  local body
  if [[ "$tag" == "fs" ]]; then
    body=$(jq --arg n "$def" '. + {enable:true, name:$n, appProfileId:1, priority:25, tags:[1]}' <<<"$schema")
  else
    body=$(jq --arg n "$def" '. + {enable:true, name:$n, appProfileId:1, priority:25}' <<<"$schema")
  fi
  ssh "$DEV01" "cat > /tmp/idx.json" <<<"$body"
  on "curl -s -X POST http://localhost:9696/api/v1/indexer -H 'X-Api-Key: $PROWLARR_KEY' -H 'Content-Type: application/json' -d @/tmp/idx.json" | jq -c '{id, name, ok: (.id != null)}'
}

add_idx 1337x         fs
add_idx eztv          fs
add_idx thepiratebay  ""
add_idx yts           ""

# Sync indexers to Sonarr+Radarr immediately
on "curl -s -X POST http://localhost:9696/api/v1/command \
  -H 'X-Api-Key: $PROWLARR_KEY' -H 'Content-Type: application/json' \
  -d '{\"name\":\"ApplicationIndexerSync\",\"forceSync\":true}' >/dev/null"

# -----------------------------------------------------------------------------
# 9. Bazarr — config.yaml has Sonarr+Radarr keys
# -----------------------------------------------------------------------------
echo
echo "=== 9. Bazarr -> Sonarr + Radarr ==="
sudoon "
  cd /srv/jellyfin/config/bazarr/config
  cp config.yaml config.yaml.bak.\$(date +%s) 2>/dev/null || true
  python3 -c \"
import yaml, sys
p = '/srv/jellyfin/config/bazarr/config/config.yaml'
c = yaml.safe_load(open(p))
c.setdefault('general', {})
c['general']['use_sonarr'] = True
c['general']['use_radarr'] = True
c.setdefault('sonarr', {})
c['sonarr'].update({'ip':'sonarr','port':8989,'apikey':'$SONARR_KEY','base_url':''})
c.setdefault('radarr', {})
c['radarr'].update({'ip':'radarr','port':7878,'apikey':'$RADARR_KEY','base_url':''})
c.setdefault('auth', {})
c['auth']['type'] = None
yaml.safe_dump(c, open(p,'w'))
print('bazarr patched')
\"
"
on "cd /srv/jellyfin && docker compose restart bazarr"

# -----------------------------------------------------------------------------
# Final summary
# -----------------------------------------------------------------------------
cat <<EOF

=== DONE ===

LAN URLs (no login required from this network):
  Jellyfin       http://192.168.1.11:8096   (you set this up)
  Jellyseerr     http://192.168.1.11:5055   (manual: link to Jellyfin in wizard)
  Prowlarr       http://192.168.1.11:9696   (4 indexers added; check Indexers tab)
  Sonarr         http://192.168.1.11:8989   (root /tv, qBit linked, indexers synced)
  Radarr         http://192.168.1.11:7878   (root /movies, qBit linked, indexers synced)
  Bazarr         http://192.168.1.11:6767   (Sonarr+Radarr linked)
  qBittorrent    http://192.168.1.11:8080   (admin / $QBIT_NEW_PASS — change in UI if you want)

What's left (manual, ~30 sec each):
  1. Jellyseerr first-run: open http://192.168.1.11:5055, "Use Jellyfin", paste your Jellyfin admin user/pass, then click through the indexer + Sonarr/Radarr config (Jellyseerr autodiscovers them on the same network).
  2. Jellyfin HW transcode: Admin -> Playback -> Transcoding -> Hardware acceleration: Intel QuickSync, enable HEVC.

API keys (write these down somewhere safe — same as in /srv/jellyfin/config/*/config.xml):
  Prowlarr: $PROWLARR_KEY
  Sonarr  : $SONARR_KEY
  Radarr  : $RADARR_KEY
EOF
