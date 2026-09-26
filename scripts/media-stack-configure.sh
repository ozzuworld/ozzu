#!/usr/bin/env bash
# Wire up the Ozzu media broker stack on bridge-01 via REST APIs. Idempotent.
# Run AFTER scripts/media-stack-deploy.sh, as root on bridge-01. dir_1790443814736.
# Replaces scripts/jellyfin-dev01-configure.sh (ssh era). Never prints secret values.
#
# Does: Jellyfin first-run (admin hadmin, libs, QuickSync/VAAPI) · qBittorrent
#       (permanent pass → /root/.ozzu-secrets, categories, ratio limits) · *arr LAN
#       auth bypass · root folders + download clients · Prowlarr (apps, FlareSolverr
#       proxy+tag, public indexers, sync) · quality-profile guard (no BR-DISK/Remux —
#       the 50-60GB grab footgun from 2026-06-15) · Bazarr → Sonarr/Radarr.

set -euo pipefail

SECRETS=/root/.ozzu-secrets
CFG=/srv/media-stack/config
JF=http://localhost:8096
JF_USER=hadmin
BANNED_QUALITIES='^(BR-DISK|Remux-2160p|Remux-1080p)$'

set -a; source "$SECRETS"; set +a
: "${JELLYFIN_ADMIN_PASS:?JELLYFIN_ADMIN_PASS missing from $SECRETS}"

# =============================================================================
echo "=== 1. Jellyfin first-run (Startup API — 12.x flow) ==="
# Jellyfin 12 changed the wizard API: POST /Startup/User no longer CREATES a user —
# it renames the EXISTING first user + sets its password (404 if none exists yet;
# GET /Startup/User triggers InitializeAsync which ensures one). Verified against
# StartupController.cs @ v12.1 (bridge-01 runs 12.1.0, 2026-09-26).
if curl -sf -m 5 "$JF/System/Info/Public" | jq -e '.StartupWizardCompleted == true' >/dev/null 2>&1; then
  echo "startup already complete — skipping"
else
  curl -sf -m 5 "$JF/Startup/User" >/dev/null 2>&1 || true   # ensure first user exists
  code=$(curl -s -m 10 -X POST "$JF/Startup/User" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg n "$JF_USER" --arg p "$JELLYFIN_ADMIN_PASS" '{Name:$n,Password:$p}')" \
    -o /dev/null -w '%{http_code}')
  case "$code" in
    204) echo "admin '$JF_USER' set (first user renamed + password)" ;;
    403) echo "WARN: first user already has a password — not touching it; auth loop below is the gate" ;;
    *)   echo "WARN: Startup/User returned HTTP $code — continuing; auth loop below is the gate" ;;
  esac
  curl -s -m 10 -X POST "$JF/Startup/Complete" -o /dev/null || true
  sleep 3
fi

echo "-- waiting for Jellyfin auth --"
JF_TOKEN=""
AUTH_BODY=$(jq -n --arg u "$JF_USER" --arg p "$JELLYFIN_ADMIN_PASS" '{Username:$u,Pw:$p}')
for i in $(seq 1 30); do
  JF_TOKEN=$(curl -sf -m 5 -X POST "$JF/Users/AuthenticateByName" \
    -H 'Content-Type: application/json' \
    -H 'Authorization: MediaBrowser Client="OzzuConfigure", Device="bridge01", DeviceId="media-configure", Version="1.0"' \
    -d "$AUTH_BODY" | jq -r '.AccessToken // empty') || true
  [[ -n "$JF_TOKEN" ]] && break
  printf .; sleep 2
done
[[ -n "$JF_TOKEN" ]] || { echo; echo "FATAL: cannot authenticate to Jellyfin"; exit 2; }
echo; echo "auth ok"
# Jellyfin 12 REJECTS X-Emby-Token / Bearer for user access tokens (401) — only the
# full MediaBrowser Authorization scheme works. (API keys still accept X-Emby-Token;
# the watchdog uses a real /Auth/Keys key.) Verified live on 12.1.0, 2026-09-26.
jfa() { curl -sf -m 20 "$@" -H "Authorization: MediaBrowser Token=$JF_TOKEN"; }

echo
echo "=== 2. Jellyfin libraries + QuickSync (VAAPI) ==="
# 12.x: AddVirtualFolderDto = {LibraryOptions} only; name/collectionType/refreshLibrary
# are query params; paths live in LibraryOptions.PathInfos.
VLIBS=$(jfa "$JF/Library/VirtualFolders" || echo '[]')
for spec in 'Movies:movies:/media/movies' 'Shows:tv:/media/tv'; do
  IFS=: read -r name ctype path <<<"$spec"
  if jq -e --arg n "$name" '.[] | select(.Name==$n)' <<<"$VLIBS" >/dev/null 2>&1; then
    echo "library '$name' exists"
  else
    if jfa -X POST "$JF/Library/VirtualFolders?name=$name&collectionType=$ctype&refreshLibrary=true" \
      -H 'Content-Type: application/json' \
      -d "$(jq -n --arg p "$path" '{LibraryOptions:{PathInfos:[{Path:$p}]}}')" >/dev/null; then
      echo "library '$name' created ($path)"
    else
      echo "WARN: library '$name' creation failed (HTTP error) — fix manually in dashboard"
    fi
  fi
done
# 12.x: encoding config lives under /System/Configuration/{key}; EnableHardwareDecoding
# is gone — hardware decode is HardwareDecodingCodecs[] (null = defaults).
if ENC=$(jfa "$JF/System/Configuration/encoding"); then
  if [[ "$(jq -r .HardwareAccelerationType <<<"$ENC")" == "vaapi" ]]; then
    echo "VAAPI already configured"
  else
    PATCHED=$(jq '.HardwareAccelerationType="vaapi" | .EnableHardwareEncoding=true
      | .HardwareDecodingCodecs=["h264","hevc","vp9","av1","mpeg2video"]' <<<"$ENC")
    if jfa -X POST "$JF/System/Configuration/encoding" -H 'Content-Type: application/json' -d "$PATCHED" >/dev/null; then
      echo "VAAPI (Intel QuickSync) HW encode+decode enabled"
    else
      echo "WARN: encoding config POST failed — set VAAPI manually in dashboard"
    fi
  fi
else
  echo "WARN: could not read encoding config"
fi

# =============================================================================
echo
echo "=== 3. qBittorrent: permanent password + limits + categories ==="
qlogin() { # $1=password → sets QCOOKIE
  # qBit 5.x names the session cookie QBT_SID_<port>= (was SID=) — match both.
  QCOOKIE=$(curl -s -i -m 10 'http://localhost:8080/api/v2/auth/login' \
    --data "username=admin&password=$1" -H 'Referer: http://localhost:8080' \
    | grep -i set-cookie | grep -oE '[A-Za-z0-9_]*SID[A-Za-z0-9_]*=[^;]+' | head -1)
  [[ -n "$QCOOKIE" ]]
}
QBIT_PASS="${MEDIA_QBIT_PASS:-}"
if [[ -n "$QBIT_PASS" ]] && qlogin "$QBIT_PASS"; then
  echo "already configured (MEDIA_QBIT_PASS in secrets works)"
else
  TEMP=$(docker logs qbittorrent 2>&1 | grep -oE 'temporary password is provided for this session: [A-Za-z0-9]+' | tail -1 | sed 's/.*: //')
  [[ -n "$TEMP" ]] || { echo "FATAL: no qbit temp password in logs and no MEDIA_QBIT_PASS"; exit 3; }
  qlogin "$TEMP" || { echo "FATAL: qbit temp login failed"; exit 3; }
  QBIT_PASS=$(openssl rand -hex 12)
  curl -s -m 10 'http://localhost:8080/api/v2/app/setPreferences' -H "Cookie: $QCOOKIE" \
    --data-urlencode "json={\"web_ui_username\":\"admin\",\"web_ui_password\":\"$QBIT_PASS\",\"bypass_local_auth\":true,\"max_active_downloads\":3,\"max_active_uploads\":2,\"max_active_torrents\":5,\"max_ratio_enabled\":true,\"max_ratio\":1.0,\"max_ratio_act\":0,\"max_seeding_time_enabled\":true,\"max_seeding_time\":2880,\"save_path\":\"/downloads\",\"temp_path_enabled\":false}" >/dev/null
  if grep -q '^MEDIA_QBIT_PASS=' "$SECRETS"; then
    sed -i "s/^MEDIA_QBIT_PASS=.*/MEDIA_QBIT_PASS=$QBIT_PASS/" "$SECRETS"
  else
    echo "MEDIA_QBIT_PASS=$QBIT_PASS" >> "$SECRETS"
  fi
  chmod 600 "$SECRETS"
  echo "new admin password generated → stored in $SECRETS (MEDIA_QBIT_PASS)"
  sleep 2
  qlogin "$QBIT_PASS" || echo "WARN: re-login with new pass failed (may need container restart)"
fi
for cat in tv movies; do
  curl -s -m 10 'http://localhost:8080/api/v2/torrents/createCategory' -H "Cookie: $QCOOKIE" \
    --data "category=$cat&savePath=/downloads/$cat" >/dev/null 2>&1 || true
done
echo "categories tv/movies ensured"

# =============================================================================
echo
echo "=== 4. *arr LAN auth bypass (config.xml) ==="
needs_patch=false
for svc in prowlarr sonarr radarr; do
  grep -q '<AuthenticationRequired>DisabledForLocalAddresses</AuthenticationRequired>' "$CFG/$svc/config.xml" 2>/dev/null || needs_patch=true
done
if $needs_patch; then
  docker compose -f /srv/media-stack/docker-compose.yml stop prowlarr sonarr radarr bazarr >/dev/null 2>&1
  for svc in prowlarr sonarr radarr; do
    [[ -f "$CFG/$svc/config.xml" ]] || { echo "  $svc: config.xml not found yet — restart stack and re-run"; continue; }
    python3 - "$svc" <<'PY'
import re, sys
svc = sys.argv[1]
p = f"/srv/media-stack/config/{svc}/config.xml"
s = open(p).read()
def setkey(s, k, v):
    if f"<{k}>" in s:
        return re.sub(f"<{k}>.*?</{k}>", f"<{k}>{v}</{k}>", s)
    return s.replace("</Config>", f"  <{k}>{v}</{k}>\n</Config>")
s = setkey(s, "AuthenticationMethod", "External")
s = setkey(s, "AuthenticationRequired", "DisabledForLocalAddresses")
open(p, "w").write(s)
print(f"  {svc} patched")
PY
  done
  docker compose -f /srv/media-stack/docker-compose.yml start prowlarr sonarr radarr bazarr >/dev/null 2>&1
else
  echo "already patched"
fi
for port in 9696 8989 7878 6767; do
  printf "wait :$port "
  for i in $(seq 1 30); do
    curl -sf -o /dev/null -m 2 "http://localhost:$port/ping" && { echo ok; break; }
    printf .; sleep 2
    (( i == 30 )) && echo " TIMEOUT"
  done
done

echo
echo "=== 5. API keys ==="
keyof() { grep -oP '(?<=<ApiKey>)[a-f0-9]+(?=</ApiKey>)' "$CFG/$1/config.xml"; }
PROWLARR_KEY=$(keyof prowlarr); SONARR_KEY=$(keyof sonarr); RADARR_KEY=$(keyof radarr)
echo "extracted (values stay on host; see config.xml)"

# =============================================================================
echo
echo "=== 6. Root folders + download clients ==="
arr_post() { curl -sf -m 20 -X POST "$1" -H "X-Api-Key: $2" -H 'Content-Type: application/json' -d "$3" >/dev/null && echo "  ok" || echo "  exists/failed (non-fatal)"; }
arr_get() { curl -sf -m 20 "$1" -H "X-Api-Key: $2"; }

for spec in "sonarr:$SONARR_KEY:8989:/tv:tvCategory:tv" "radarr:$RADARR_KEY:7878:/movies:movieCategory:movies"; do
  IFS=: read -r svc key port root catfield catval <<<"$spec"
  base="http://localhost:$port/api/v3"
  if arr_get "$base/rootfolder" "$key" | jq -e --arg p "$root" '.[] | select(.path==$p)' >/dev/null 2>&1; then
    echo "  $svc root $root exists"
  else
    arr_post "$base/rootfolder" "$key" "{\"path\":\"$root\"}" && echo "  $svc root $root added"
  fi
  if arr_get "$base/downloadclient" "$key" | jq -e '.[] | select(.name=="qBittorrent")' >/dev/null 2>&1; then
    echo "  $svc qBittorrent client exists"
  else
    arr_post "$base/downloadclient" "$key" "{
      \"enable\": true, \"protocol\": \"torrent\", \"priority\": 1,
      \"name\": \"qBittorrent\", \"implementation\": \"QBittorrent\", \"configContract\": \"QBittorrentSettings\",
      \"fields\": [
        {\"name\": \"host\", \"value\": \"qbittorrent\"}, {\"name\": \"port\", \"value\": 8080},
        {\"name\": \"useSsl\", \"value\": false}, {\"name\": \"username\", \"value\": \"admin\"},
        {\"name\": \"password\", \"value\": \"$QBIT_PASS\"}, {\"name\": \"$catfield\", \"value\": \"$catval\"}
      ]}"
    echo "  $svc qBittorrent client added"
  fi
done

echo
echo "=== 7. Prowlarr: applications, FlareSolverr, indexers ==="
P=http://localhost:9696/api/v1
pa() { curl -sf -m 240 "$@" -H "X-Api-Key: $PROWLARR_KEY"; }   # 240s: FlareSolverr-tested indexer adds can take ~140s cold

if pa "$P/applications" | jq -e '.[] | select(.name=="Sonarr")' >/dev/null 2>&1; then
  echo "  app Sonarr exists"
else
  pa -X POST "$P/applications" -H 'Content-Type: application/json' -d "{
    \"name\":\"Sonarr\",\"syncLevel\":\"fullSync\",\"implementation\":\"Sonarr\",\"configContract\":\"SonarrSettings\",
    \"fields\":[{\"name\":\"prowlarrUrl\",\"value\":\"http://prowlarr:9696\"},{\"name\":\"baseUrl\",\"value\":\"http://sonarr:8989\"},
    {\"name\":\"apiKey\",\"value\":\"$SONARR_KEY\"},{\"name\":\"syncCategories\",\"value\":[5000,5010,5020,5030,5040,5045,5050]}]}" >/dev/null && echo "  app Sonarr added"
fi
if pa "$P/applications" | jq -e '.[] | select(.name=="Radarr")' >/dev/null 2>&1; then
  echo "  app Radarr exists"
else
  pa -X POST "$P/applications" -H 'Content-Type: application/json' -d "{
    \"name\":\"Radarr\",\"syncLevel\":\"fullSync\",\"implementation\":\"Radarr\",\"configContract\":\"RadarrSettings\",
    \"fields\":[{\"name\":\"prowlarrUrl\",\"value\":\"http://prowlarr:9696\"},{\"name\":\"baseUrl\",\"value\":\"http://radarr:7878\"},
    {\"name\":\"apiKey\",\"value\":\"$RADARR_KEY\"},{\"name\":\"syncCategories\",\"value\":[2000,2010,2020,2030,2040,2045,2050,2060]}]}" >/dev/null && echo "  app Radarr added"
fi

TAGID=$(pa "$P/tag" | jq -r '.[] | select(.label=="flaresolverr") | .id' | head -1)
if [[ -z "$TAGID" ]]; then
  TAGID=$(pa -X POST "$P/tag" -H 'Content-Type: application/json' -d '{"label":"flaresolverr"}' | jq -r '.id // empty')
  [[ -n "$TAGID" ]] || TAGID=$(pa "$P/tag" | jq -r '.[] | select(.label=="flaresolverr") | .id' | head -1)
fi
if pa "$P/indexerproxy" | jq -e '.[] | select(.name=="FlareSolverr")' >/dev/null 2>&1; then
  echo "  FlareSolverr proxy exists"
else
  pa -X POST "$P/indexerproxy" -H 'Content-Type: application/json' \
    -d "{\"name\":\"FlareSolverr\",\"implementation\":\"FlareSolverr\",\"configContract\":\"FlareSolverrSettings\",\"tags\":[$TAGID],\"fields\":[{\"name\":\"host\",\"value\":\"http://flaresolverr:8191/\"},{\"name\":\"requestTimeout\",\"value\":60}]}" >/dev/null \
    && echo "  FlareSolverr proxy added (tag $TAGID)"
fi

SCHEMA=$(pa "$P/indexer/schema")
add_idx() { # $1=definitionName $2=fs|""
  local def="$1" tag="$2"
  if pa "$P/indexer" | jq -e --arg n "$def" '.[] | select(.name==$n)' >/dev/null 2>&1; then
    echo "  indexer $def exists"; return
  fi
  local body
  body=$(jq --arg n "$def" '.[] | select(.definitionName==$n)' <<<"$SCHEMA" | head -c 100000)
  [[ -n "$body" ]] || { echo "  WARN: no schema for $def"; return; }
  if [[ "$tag" == "fs" ]]; then
    body=$(jq --arg n "$def" --argjson t "$TAGID" '. + {enable:true, name:$n, appProfileId:1, priority:25, tags:[$t]}' <<<"$body")
  else
    body=$(jq --arg n "$def" '. + {enable:true, name:$n, appProfileId:1, priority:25}' <<<"$body")
  fi
  pa -X POST "$P/indexer" -H 'Content-Type: application/json' -d "$body" | jq -c '{id, name}' 2>/dev/null && echo "  indexer $def added" || echo "  WARN: $def add failed"
}
add_idx 1337x fs
add_idx eztv fs
add_idx thepiratebay ""
add_idx yts ""

pa -X POST "$P/command" -H 'Content-Type: application/json' -d '{"name":"ApplicationIndexerSync","forceSync":true}' >/dev/null \
  && echo "  indexer→app sync triggered"

# =============================================================================
echo
echo "=== 8. Quality-profile guard: disable BR-DISK / Remux (50-60GB footgun) ==="
for spec in "sonarr:$SONARR_KEY:8989" "radarr:$RADARR_KEY:7878"; do
  IFS=: read -r svc key port <<<"$spec"
  base="http://localhost:$port/api/v3"
  # Profile items are two-level: group entries have quality:null + nested items[].
  # Recursive descent, null-safe names — plain .items[].quality.name crashes jq.
  # Radarr rejects PUTs whose cutoff points at a disallowed quality ("Cutoff must be
  # an allowed quality or group") → when the cutoff is banned, move it to the largest
  # still-allowed quality by size. (Bit us on the Ultra-HD profile: cutoff=Remux-2160p.)
  n=0
  while IFS= read -r prof; do
    pid=$(jq -r .id <<<"$prof")
    if jq -e --arg b "$BANNED_QUALITIES" \
      '[.. | objects | select(.quality? != null and .allowed? == true) | select((.quality.name? // "") | test($b))] | length > 0' \
      <<<"$prof" >/dev/null 2>&1; then
      fixed=$(jq --arg b "$BANNED_QUALITIES" '
        .cutoff as $cut
        | ([.. | objects | select(.quality? != null and ((.quality.name? // "") | test($b))) | .quality.id]) as $bids
        | (.. | objects | select(.quality? != null and ((.quality.name? // "") | test($b))) | .allowed) = false
        | if ($cut != null) and ($bids | index($cut)) then
            ([.. | objects | select(.quality? != null and .allowed? == true and (((.quality.name? // "") | test($b)) | not)) | {id: .quality.id, size: (.quality.size // 0)}] | sort_by(.size) | last) as $best
            | if $best then .cutoff = $best.id else . end
          else . end
      ' <<<"$prof")
      curl -sf -m 20 -X PUT "$base/qualityprofile/$pid" -H "X-Api-Key: $key" -H 'Content-Type: application/json' -d "$fixed" >/dev/null && n=$((n+1))
    fi
  done < <(arr_get "$base/qualityprofile" "$key" | jq -c '.[]')
  echo "  $svc: $n profile(s) updated"
done

# =============================================================================
echo
echo "=== 9. Bazarr → Sonarr + Radarr ==="
BZ="$CFG/bazarr/config/config.yaml"
if [[ -f "$BZ" ]]; then
  python3 - "$SONARR_KEY" "$RADARR_KEY" <<'PY'
import sys, yaml
sonarr_key, radarr_key = sys.argv[1], sys.argv[2]
p = "/srv/media-stack/config/bazarr/config/config.yaml"
c = yaml.safe_load(open(p)) or {}
c.setdefault("general", {})
c["general"]["use_sonarr"] = True
c["general"]["use_radarr"] = True
c.setdefault("sonarr", {}).update({"ip": "sonarr", "port": 8989, "apikey": sonarr_key, "base_url": ""})
c.setdefault("radarr", {}).update({"ip": "radarr", "port": 7878, "apikey": radarr_key, "base_url": ""})
c.setdefault("auth", {})["type"] = None
yaml.safe_dump(c, open(p, "w"))
print("  bazarr patched")
PY
  docker restart bazarr >/dev/null && echo "  bazarr restarted"
else
  echo "  config.yaml not present yet — wait ~60s after first boot, re-run this script"
fi

cat <<EOF

=== DONE ===
LAN URLs (auth bypassed from local/LAN addresses on the *arrs):
  Jellyfin     http://192.168.1.9:8096   (admin: $JF_USER / pass in $SECRETS: JELLYFIN_ADMIN_PASS)
  Jellyseerr   http://192.168.1.9:5055   (manual first-run: pick Jellyfin, $JF_USER + same pass)
  qBittorrent  http://192.168.1.9:8080   (admin / pass in $SECRETS: MEDIA_QBIT_PASS)
  Maintainerr  http://192.168.1.9:6246   (manual wizard: Jellyfin http://jellyfin:8096 + key from /etc/ozzu/jellyfin-token)
Next: scripts/media-stack-watchdog-install.sh
EOF
