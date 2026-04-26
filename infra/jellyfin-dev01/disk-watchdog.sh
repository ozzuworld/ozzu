#!/usr/bin/env bash
# /usr/local/bin/ozzu-disk-watchdog — runs every 5 min from /etc/cron.d/ozzu-disk-watchdog
# Disk eviction so Jellyfin playback never breaks at 100% disk.
#
# Behavior:
#   1. If /srv >= HIGH_PCT, query Jellyfin /Sessions for active streams (NowPlayingItem.Id, ItemId
#      of next-up trailers, etc.) — those are EXCLUDED from deletion.
#   2. Query Jellyfin /Users/{adminId}/Items where Played=true, sorted by DatePlayed asc.
#   3. Delete oldest-watched files (skipping anything currently playing or in someone's session).
#   4. Stop when /srv <= LOW_PCT.
#   5. If the watched-pool is exhausted, fall back to oldest-by-DateAdded items (unwatched too
#      — King Kazuma said re-downloading is fine, bandwidth is free at home).

set -euo pipefail

HIGH_PCT=${HIGH_PCT:-80}
LOW_PCT=${LOW_PCT:-60}
JF_URL=${JF_URL:-http://localhost:8096}
TOKEN_FILE=${TOKEN_FILE:-/etc/ozzu/jellyfin-token}
TARGET_PATH=${TARGET_PATH:-/srv}

LOG() { logger -t ozzu-disk-watchdog "$*"; echo "$(date -Iseconds) $*"; }

[[ -f "$TOKEN_FILE" ]] || { LOG "FATAL: missing $TOKEN_FILE"; exit 2; }
JF_TOKEN=$(cat "$TOKEN_FILE")

usage_pct() {
  df --output=pcent "$TARGET_PATH" | tail -1 | tr -dc '0-9'
}

current=$(usage_pct)
(( current < HIGH_PCT )) && exit 0

LOG "trigger: ${TARGET_PATH} at ${current}% (HIGH=${HIGH_PCT}%); evicting until <=${LOW_PCT}%"

# 1. Get the admin user id (single-user assumption; first user is owner)
ADMIN_ID=$(curl -sf "$JF_URL/Users" -H "X-Emby-Token: $JF_TOKEN" | jq -r '.[0].Id')
[[ -z "$ADMIN_ID" || "$ADMIN_ID" == "null" ]] && { LOG "ERR: no admin user"; exit 3; }

# 2. Items currently being streamed — these are NEVER deleted
PROTECT_IDS=$(curl -sf "$JF_URL/Sessions" -H "X-Emby-Token: $JF_TOKEN" \
  | jq -r '[.[] | select(.NowPlayingItem != null) | .NowPlayingItem.Id, .NowPlayingItem.SeriesId, .NowPlayingItem.SeasonId] | unique | .[]' \
  | sort -u)
if [[ -n "$PROTECT_IDS" ]]; then
  LOG "protecting (currently playing): $(echo "$PROTECT_IDS" | wc -l) item(s)"
fi

is_protected() {
  local id="$1"
  [[ -z "$PROTECT_IDS" ]] && return 1
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
      LOG "skip (in active session): '$name' [$stage]"
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

# 3. Stage 1: oldest watched items
LOG "stage 1: oldest watched items first"
RESPONSE=$(curl -sf "$JF_URL/Users/$ADMIN_ID/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Filters=IsPlayed&SortBy=DatePlayed&SortOrder=Ascending&Fields=Path,SeriesId,SeasonId&Limit=500" \
  -H "X-Emby-Token: $JF_TOKEN") || { LOG "ERR: Jellyfin /Items query failed"; exit 4; }

while IFS= read -r row; do
  if attempt_delete "$row" "watched"; then
    deleted_count=$((deleted_count + 1))
    (( $(usage_pct) <= LOW_PCT )) && break
  fi
done < <(jq -c '.Items[]' <<<"$RESPONSE")

# 4. Stage 2: still over threshold? Fall back to oldest-by-DateAdded (re-download is cheap)
if (( $(usage_pct) > LOW_PCT )); then
  LOG "stage 2: watched pool exhausted, evicting oldest-added items (re-download is fine)"
  RESPONSE=$(curl -sf "$JF_URL/Users/$ADMIN_ID/Items?Recursive=true&IncludeItemTypes=Movie,Episode&SortBy=DateCreated&SortOrder=Ascending&Fields=Path,SeriesId,SeasonId&Limit=500" \
    -H "X-Emby-Token: $JF_TOKEN") || true
  while IFS= read -r row; do
    if attempt_delete "$row" "oldest"; then
      deleted_count=$((deleted_count + 1))
      (( $(usage_pct) <= LOW_PCT )) && break
    fi
  done < <(jq -c '.Items[]' <<<"$RESPONSE")
fi

# 5. Wrap up: tell Jellyfin to rescan so library reflects the deletions
if (( deleted_count > 0 )); then
  curl -sf -X POST "$JF_URL/Library/Refresh" -H "X-Emby-Token: $JF_TOKEN" >/dev/null || true
  LOG "done: deleted $deleted_count files; now at $(usage_pct)%"
else
  LOG "no eligible items found while at ${current}% — likely all items are protected (in active sessions)"
fi
