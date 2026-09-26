#!/usr/bin/env bash
# /usr/local/bin/ozzu-media-watchdog — runs every 5 min from /etc/cron.d/ozzu-media-watchdog
#
# QUOTA-based media eviction for the bridge-01 rotation library (dir_1790443814736).
# Replaces the old dev-01 percentage-of-mount watchdog: bridge-01's root FS hosts the
# ENTIRE Ozzu core stack, so a %-trigger would endanger postgres/bridge/etc. This version
# enforces an ABSOLUTE GB budget on media dirs only.
#
# Behavior:
#   0. Always: purge stale /srv/downloads files older than STALE_DAYS (dead partials).
#   1. If media usage >= HIGH_GB: protect (a) items in active Jellyfin sessions and
#      (b) RESUMABLE items — unfinished playback markers must survive eviction
#      (KK's broker rule: leave mid-session → resume later, even after eviction of
#      everything else).
#   2. Stage 1: evict oldest-watched (DatePlayed asc).
#   3. Stage 2: still over? evict oldest-added (DateCreated asc), unwatched included —
#      KK ratified: re-downloading is fine, home bandwidth is free.
#   4. Emergency (Jellyfin API unreachable AND usage >= HIGH_GB + EMERG_GB): evict
#      oldest-mtime files in /srv/media blindly so the host disk can never fill.
#   5. Stop at LOW_GB.

set -euo pipefail

HIGH_GB=${HIGH_GB:-90}
LOW_GB=${LOW_GB:-70}
EMERG_GB=${EMERG_GB:-15}
STALE_DAYS=${STALE_DAYS:-14}
MEDIA_DIRS=${MEDIA_DIRS:-"/srv/media /srv/downloads /srv/media-stack/cache"}
JF_URL=${JF_URL:-http://localhost:8096}
TOKEN_FILE=${TOKEN_FILE:-/etc/ozzu/jellyfin-token}

LOG() { logger -t ozzu-media-watchdog "$*" 2>/dev/null || true; echo "$(date -Iseconds) $*"; }

usage_gb() {
  # shellcheck disable=SC2086
  du -sb $MEDIA_DIRS 2>/dev/null | awk '{s+=$1} END {printf "%d", s/1073741824}'
}

# --- Stage 0: stale download remnants (always safe, runs every invocation) ---
stale=$(find /srv/downloads -type f -mtime +"$STALE_DAYS" 2>/dev/null | wc -l)
if (( stale > 0 )); then
  find /srv/downloads -type f -mtime +"$STALE_DAYS" -delete 2>/dev/null || true
  LOG "stage0: purged $stale file(s) older than ${STALE_DAYS}d from /srv/downloads"
fi

current=$(usage_gb)
(( current < HIGH_GB )) && exit 0

LOG "trigger: media usage ${current}G (HIGH=${HIGH_GB}G); evicting until <=${LOW_GB}G"

JF_TOKEN=""
[[ -f "$TOKEN_FILE" ]] && JF_TOKEN=$(cat "$TOKEN_FILE")

# Jellyfin 12 rejects X-Emby-Token (even for /Auth/Keys API keys — verified 12.1.0,
# 2026-09-26). Only the MediaBrowser Authorization scheme is accepted.
jf_get() { curl -sf -m 10 "$JF_URL$1" -H "Authorization: MediaBrowser Token=$JF_TOKEN"; }

ADMIN_ID=""
if [[ -n "$JF_TOKEN" ]]; then
  ADMIN_ID=$(jf_get "/Users" | jq -r '.[0].Id // empty') || true
fi

PROTECT_IDS=""
if [[ -n "$ADMIN_ID" ]]; then
  # (a) active sessions — currently playing
  sess=$(jf_get "/Sessions" | jq -r '[.[] | select(.NowPlayingItem != null) | .NowPlayingItem.Id, .NowPlayingItem.SeriesId, .NowPlayingItem.SeasonId] | unique | .[]' 2>/dev/null | sort -u) || sess=""
  # (b) resumable — unfinished playback markers (broker rule: never evict mid-session items)
  resumable=$(jf_get "/Users/$ADMIN_ID/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Filters=IsResumable&Fields=SeriesId,SeasonId&Limit=500" \
    | jq -r '[.Items[]? | .Id, .SeriesId, .SeasonId] | unique | .[]' 2>/dev/null | sort -u) || resumable=""
  PROTECT_IDS=$(printf '%s\n%s\n' "$sess" "$resumable" | grep -v '^$' | sort -u) || true
  # grep -c prints 0 and exits 1 on no match; `|| echo 0` used to append a SECOND 0
  # → "0\n0" → arithmetic syntax error (caught in forced-run test 2026-09-26).
  n=$(grep -cv '^$' <<<"$PROTECT_IDS" 2>/dev/null) || n=0
  (( n > 0 )) && LOG "protecting $n id(s): active sessions + resumable markers" || true
fi

is_protected() {
  local id="$1"
  [[ -z "$PROTECT_IDS" || -z "$id" ]] && return 1
  grep -qx "$id" <<<"$PROTECT_IDS"
}

attempt_delete() {
  local row="$1" stage="$2"
  local id name path series season
  id=$(jq -r '.Id // ""' <<<"$row")
  name=$(jq -r '.Name // "(unnamed)"' <<<"$row")
  path=$(jq -r '.Path // ""' <<<"$row")
  series=$(jq -r '.SeriesId // ""' <<<"$row")
  season=$(jq -r '.SeasonId // ""' <<<"$row")

  for guard in "$id" "$series" "$season"; do
    if [[ -n "$guard" ]] && is_protected "$guard"; then
      LOG "skip (protected: session/resumable): '$name' [$stage]"
      return 1
    fi
  done

  [[ -z "$path" || ! -f "$path" ]] && return 1
  local size
  size=$(stat -c%s "$path" 2>/dev/null || echo 0)
  rm -f "$path"
  LOG "[$stage] deleted '$name' ($((size / 1024 / 1024)) MB) — $path"
  return 0
}

deleted_count=0

if [[ -n "$ADMIN_ID" ]]; then
  # Stage 1: oldest watched items
  LOG "stage 1: oldest watched items first"
  RESPONSE=$(jf_get "/Users/$ADMIN_ID/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Filters=IsPlayed&SortBy=DatePlayed&SortOrder=Ascending&Fields=Path,SeriesId,SeasonId&Limit=500") \
    || { LOG "ERR: Jellyfin /Items query failed"; RESPONSE=""; }

  if [[ -n "$RESPONSE" ]]; then
    while IFS= read -r row; do
      if attempt_delete "$row" "watched"; then
        deleted_count=$((deleted_count + 1))
        (( $(usage_gb) <= LOW_GB )) && break
      fi
    done < <(jq -c '.Items[]' <<<"$RESPONSE")
  fi

  # Stage 2: oldest-added (unwatched OK — re-download is cheap)
  if (( $(usage_gb) > LOW_GB )); then
    LOG "stage 2: watched pool exhausted, evicting oldest-added items"
    RESPONSE=$(jf_get "/Users/$ADMIN_ID/Items?Recursive=true&IncludeItemTypes=Movie,Episode&SortBy=DateCreated&SortOrder=Ascending&Fields=Path,SeriesId,SeasonId&Limit=500") || RESPONSE=""
    if [[ -n "$RESPONSE" ]]; then
      while IFS= read -r row; do
        if attempt_delete "$row" "oldest"; then
          deleted_count=$((deleted_count + 1))
          (( $(usage_gb) <= LOW_GB )) && break
        fi
      done < <(jq -c '.Items[]' <<<"$RESPONSE")
    fi
  fi
else
  LOG "WARN: Jellyfin API unreachable (no token or server down)"
fi

# Stage 3: emergency blind eviction — host disk integrity outranks library metadata
if (( $(usage_gb) > HIGH_GB + EMERG_GB )); then
  LOG "EMERGENCY: usage > $((HIGH_GB + EMERG_GB))G with Jellyfin unavailable/exhausted — evicting oldest-mtime files in /srv/media"
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    rm -f "$f"
    deleted_count=$((deleted_count + 1))
    LOG "[emergency] deleted $f"
    (( $(usage_gb) <= LOW_GB )) && break
  done < <(find /srv/media -type f \( -name '*.mkv' -o -name '*.mp4' -o -name '*.avi' \) -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2-)
fi

# Wrap up: rescan library so Jellyfin reflects deletions
if (( deleted_count > 0 )); then
  [[ -n "$JF_TOKEN" ]] && curl -sf -m 10 -X POST "$JF_URL/Library/Refresh" -H "Authorization: MediaBrowser Token=$JF_TOKEN" >/dev/null || true
  LOG "done: deleted $deleted_count file(s); now at $(usage_gb)G"
else
  LOG "no eligible items at ${current}G — everything protected (sessions/resumable) or library empty"
fi
