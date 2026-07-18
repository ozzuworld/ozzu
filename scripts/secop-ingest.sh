#!/usr/bin/env bash
# SECOP II ingest — refresh the open-licitaciones index from Colombia's open-data
# portal. Runs the ingester inside the bridge container (has node, pg, POSTGRES_PASSWORD,
# and host-network access to postgres). Safe to run on a cron; flock prevents overlap.
#
# Suggested cron (every 6h):  0 */6 * * *  /home/gcp/ozzu/scripts/secop-ingest.sh
# Manual full refresh:        ./scripts/secop-ingest.sh
# Re-apply overlay.json only: ./scripts/secop-ingest.sh --recategorize
set -uo pipefail

LOG_DIR="/home/gcp/ozzu/data/logs"
LOG="$LOG_DIR/secop-ingest.log"
LOCK="/tmp/secop-ingest.lock"
mkdir -p "$LOG_DIR"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Is) [secop-ingest] already running — skip" >>"$LOG"
  exit 0
fi

echo "$(date -Is) [secop-ingest] START ${*:-full}" >>"$LOG"
docker exec bridge node /app/secop/ingest.js "$@" >>"$LOG" 2>&1
rc=$?
echo "$(date -Is) [secop-ingest] END rc=$rc" >>"$LOG"
exit $rc
