#!/usr/bin/env bash
# media-stack-health.sh — */5 visibility cron (SKYLINE-SOC-2026-075 audit, 2026-09-27).
# Complements ozzu-media-watchdog (quota/eviction): this writes a liveness + security-
# posture status JSON (data/infra/media-stack-status.json) the app/Ops surface can pick
# up, and logs posture-drift ALERTs to syslog. READ-ONLY: restarts nothing.
#
# Invariants checked (drift = something undid the audit hardening):
#   - flaresolverr must NOT answer on the LAN IP (localhost bind, compose audit note)
#   - media containers must resolve DNS (AdGuard path via compose dns:)
set -uo pipefail

OUT=/home/gcp/ozzu/data/infra/media-stack-status.json
SERVICES="jellyfin stremio-server qbittorrent prowlarr sonarr radarr bazarr jellyseerr maintainerr flaresolverr"

probe() { local out; out=$(curl -s -m 4 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null); echo "${out:-000}"; }

mkdir -p "$(dirname "$OUT")"
{
  echo '{'
  echo "  \"generated_at\": \"$(date -Iseconds)\","
  echo '  "containers": {'
  first=1
  for s in $SERVICES; do
    st=$(docker inspect "$s" --format '{{.State.Status}} restarts={{.RestartCount}}' 2>/dev/null || echo "missing")
    run=${st%% *}
    [ $first -eq 0 ] && echo ','
    first=0
    printf '    "%s": {"state": "%s", "detail": "%s"}' "$s" "$run" "$st"
  done
  echo ''
  echo '  },'
  echo '  "http": {'
  printf '    "jellyfin": "%s",\n'            "$(probe http://127.0.0.1:8096/System/Info/Public)"
  printf '    "stremio": "%s",\n'             "$(probe http://127.0.0.1:11470/)"
  printf '    "qbittorrent": "%s",\n'         "$(probe http://127.0.0.1:8080/api/v2/app/version)"
  printf '    "prowlarr": "%s",\n'            "$(probe http://127.0.0.1:9696/api/v1/system/status)"
  printf '    "flaresolverr_local": "%s",\n'  "$(probe http://127.0.0.1:8191/)"
  printf '    "seerr": "%s",\n'               "$(probe http://127.0.0.1:5055/api/v1/status)"
  printf '    "maintainerr": "%s"\n'          "$(probe http://127.0.0.1:6246/)"
  echo '  },'
  flare_lan=$(probe http://192.168.1.9:8191/)
  dns_ok=$(docker exec jellyfin getent hosts github.com >/dev/null 2>&1 && echo true || echo false)
  disk_gb=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')
  streams=$(ss -tn state established 2>/dev/null | grep -cE ':(8096|11470)' || true)
  printf '  "invariants": {"flaresolverr_not_on_lan": %s, "container_dns_ok": %s, "root_disk_free_gb": %s, "active_stream_conns": %s}\n' \
    "$([ "$flare_lan" = "000" ] && echo true || echo false)" "$dns_ok" "${disk_gb:-0}" "${streams:-0}"
  echo '}'
} > "${OUT}.tmp" && mv "${OUT}.tmp" "$OUT"

# syslog tripwires (picked up by journalctl watchers / future diff-alerts)
grep -q '"flaresolverr_not_on_lan": false' "$OUT" && logger -t media-health "ALERT: flaresolverr answers on LAN again — compose port bind drifted (audit SKYLINE-SOC-2026-075)"
grep -q '"container_dns_ok": false' "$OUT" && logger -t media-health "ALERT: media containers cannot resolve DNS — AdGuard dns: path broken"
for s in $SERVICES; do
  grep -q "\"$s\": {\"state\": \"running\"" "$OUT" || logger -t media-health "ALERT: media container $s not running"
done
exit 0
