#!/usr/bin/env bash
# media-stack-update.sh — MONTHLY image refresh, health-gated, auto-rollback.
# KK decision 2026-09-27 (SKYLINE-SOC-2026-075 item 4 — rolling :latest tag risk, f1010):
#   keep :latest tags (security patches flow) but pull only on a schedule, record every
#   image digest before/after, and roll back automatically if the stack comes up sick.
# Cron: /etc/cron.d/ozzu-media-update — 1st of month 10:17 UTC (05:17 Bogota, low usage).
# Digest log: /home/gcp/ozzu/private/media-stack-audit/image-digests.log (rides tier-13-adjacent
#   private-docs backup). Syslog tag: media-update.
set -uo pipefail
cd /srv/media-stack || exit 1

STAMP=$(date +%Y%m%d_%H%M%S)
DIGEST_LOG=/home/gcp/ozzu/private/media-stack-audit/image-digests.log
SERVICES="jellyfin stremio-server jellyseerr prowlarr flaresolverr sonarr radarr bazarr qbittorrent maintainerr"
mkdir -p "$(dirname "$DIGEST_LOG")"

# Guard: never recreate under an active stream (JF :8096 / stremio :11470 conns).
active=$(ss -tn state established 2>/dev/null | grep -cE ':(8096|11470)' || true)
if [ "${active:-0}" -gt 0 ]; then
  logger -t media-update "SKIP: $active active stream connections — not updating this window"
  exit 0
fi

record_digests() { # $1 = label
  { echo "=== $1 $STAMP ==="
    for s in $SERVICES; do
      img=$(docker inspect "$s" --format '{{.Config.Image}}' 2>/dev/null || echo "?")
      id=$(docker inspect "$s" --format '{{.Image}}' 2>/dev/null || echo "?")
      echo "$s $img $id"
    done
  } >> "$DIGEST_LOG"
}

health_ok() {
  local s
  for s in $SERVICES; do
    [ "$(docker inspect -f '{{.State.Running}}' "$s" 2>/dev/null)" = "true" ] || return 1
  done
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8096/System/Info/Public)" = "200" ] || return 1
  # no restart loops: every container restarted at most once since the update began
  for s in $SERVICES; do
    [ "$(docker inspect -f '{{.RestartCount}}' "$s" 2>/dev/null || echo 99)" -le 1 ] || return 1
  done
  return 0
}

rollback() {
  logger -t media-update "ALERT: post-update unhealthy — rolling back to pre-update images ($STAMP)"
  while read -r name img id; do
    [ -n "$id" ] && [ "$id" != "?" ] && docker tag "$id" "$img" 2>/dev/null
  done < <(awk "/^=== pre-update $STAMP ===/{f=1;next} /^===/{f=0} f" "$DIGEST_LOG")
  docker compose up -d 2>&1 | tail -3
  sleep 30
  if health_ok; then
    record_digests post-rollback-ok
    logger -t media-update "Rollback OK ($STAMP) — stack healthy on previous images"
  else
    logger -t media-update "CRITICAL: rollback FAILED ($STAMP) — manual intervention needed on bridge-01"
  fi
}

record_digests pre-update
docker compose pull 2>&1 | tail -11
docker compose up -d 2>&1 | tail -11
# give JF/*arrs time to boot before the health gate
for i in $(seq 1 12); do
  sleep 10
  code=$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:8096/System/Info/Public 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
done
sleep 15

if health_ok; then
  record_digests post-update-ok
  logger -t media-update "Monthly update OK ($STAMP) — all 10 services healthy"
else
  rollback
fi
exit 0
