#!/bin/bash
# Resume Sprint 2c curation from where workers left off.
# Idempotent — just compute remaining scenarios per chunk and restart 4 workers.
#
# Usage:
#   bash /home/gcp/ozzu/tools/oracle/resume-curation.sh
#
# Will exit early if 4 workers already running, or if all 915 scenarios are done.

set -e

DIR=/home/gcp/ozzu/private/oracle-trajectories
CHUNKS=$DIR/chunks
SCENARIOS=$DIR/batch1h-scenarios.jsonl

if [ ! -f "$SCENARIOS" ]; then
  echo "FATAL: $SCENARIOS missing — nothing to resume."
  exit 1
fi

ALIVE=$(docker exec bridge ps -ef 2>/dev/null | grep generate-trajectories-v2 | grep -v grep | wc -l)
if [ "$ALIVE" -ge 4 ]; then
  echo "4 workers already running — nothing to do."
  exit 0
fi

# Kill any partial workers so we restart cleanly
if [ "$ALIVE" -gt 0 ]; then
  echo "killing $ALIVE stale worker(s)..."
  docker exec bridge sh -c 'pkill -f generate-trajectories-v2' || true
  sleep 2
fi

# Compute remaining per chunk
TOTAL_DONE=0
for i in 00 01 02 03; do
  done=$(wc -l < "$DIR/curated-v2-chunk-$i.jsonl" 2>/dev/null || echo 0)
  rej=$(wc -l < "$DIR/rejected-v2-chunk-$i.jsonl" 2>/dev/null || echo 0)
  processed=$((done + rej))
  total=$(wc -l < "$CHUNKS/chunk-$i" 2>/dev/null || echo 0)
  TOTAL_DONE=$((TOTAL_DONE + done))

  if [ "$processed" -ge "$total" ]; then
    echo "chunk-$i: $processed/$total — DONE, skip"
    continue
  fi

  skip=$((processed + 1))
  tail -n +$skip "$CHUNKS/chunk-$i" > "$CHUNKS/remaining-$i"
  rem=$(wc -l < "$CHUNKS/remaining-$i")
  echo "chunk-$i: $processed/$total done, $rem remaining → launching worker"

  docker exec -d -w /app -e NODE_PATH=/app/node_modules bridge \
    node /home/gcp/ozzu/tools/oracle/generate-trajectories-v2.js \
    "$CHUNKS/remaining-$i" \
    --out "$DIR/curated-v2-chunk-$i.jsonl" \
    --rej "$DIR/rejected-v2-chunk-$i.jsonl" \
    --min-score 6
done

sleep 3
NEW_ALIVE=$(docker exec bridge ps -ef 2>/dev/null | grep generate-trajectories-v2 | grep -v grep | wc -l)
echo
echo "workers now running: $NEW_ALIVE"
echo "total curated so far: $TOTAL_DONE / 915"
echo
echo "Watch progress with:"
echo "  watch 'cat $DIR/curated-v2-chunk-*.jsonl | wc -l'"
