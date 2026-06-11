#!/usr/bin/env bash
# dir_1781203380739 — Phase 2b diversity harvest. Opus plays each vulhub variant N times,
# end-to-end, against the re-flagged labs. Uses the FIXED play-engagement.js (2500-char full
# context, no replay) so the data is full-context AND consistent. Runs on the bridge VM
# (docker exec bridge) like the v1/v2 harvest. Winning trajectories -> the diverse SFT set.
#
# Env knobs: PER (engagements/variant, default 5), CONC (concurrency, default 6),
#            MAXITER (default 15), CONFIG (variants json).
set -uo pipefail
CONFIG="${CONFIG:-/home/gcp/ozzu/tools/oracle/vulhub-variants.json}"
PER="${PER:-5}"; CONC="${CONC:-6}"; MAXITER="${MAXITER:-15}"
OUT="/home/gcp/ozzu/private/oracle-trajectories/phase2b-harvest.jsonl"
STAGE="/home/gcp/ozzu/private/oracle-trajectories/staging-2b"
LOG="/home/gcp/ozzu/private/oracle-trajectories/phase2b-harvest.log"
mkdir -p "$STAGE"; : > "$LOG"

VARIANTS=$(node -e 'console.log(Object.keys(require(process.argv[1])).join(" "))' "$CONFIG")
# Round-robin (interleave classes) so concurrent workers hit DIFFERENT containers, not the
# same one N times. Same-class concurrency on one container collides and all-misses
# (dir_1781203380739: 6 concurrent drupal engagements on one box -> 0/5).
work=(); for i in $(seq 1 "$PER"); do for v in $VARIANTS; do work+=("$v:$i"); done; done
echo "[2b] $(date +%H:%M:%S) start: ${#work[@]} engagements ($PER x $(echo "$VARIANTS" | wc -w) variants), conc=$CONC maxiter=$MAXITER" | tee -a "$LOG"

run_one() {
  local v="${1%:*}" i="${1#*:}"
  local id="2B-${v}-$(date +%s)-$i"
  local tmpf="$STAGE/play-$id.jsonl"
  docker exec -e NODE_PATH=/app/node_modules -w /home/gcp/ozzu/tools/oracle bridge \
    node play-engagement.js --variant "$v" --variants-config vulhub-variants.json \
    --max-iter "$MAXITER" --id "$id" --out "$tmpf" > "$STAGE/play-$id.log" 2>&1
  if [ -s "$tmpf" ]; then
    cat "$tmpf" >> "$OUT"
    if grep -q '"flag_captured":true' "$tmpf"; then echo "[2b] $(date +%H:%M:%S) WIN  $v #$i" | tee -a "$LOG"
    else echo "[2b] $(date +%H:%M:%S) miss $v #$i" | tee -a "$LOG"; fi
    rm -f "$tmpf"
  else echo "[2b] $(date +%H:%M:%S) FAIL $v #$i" | tee -a "$LOG"; fi
}

running_pids=()
for w in "${work[@]}"; do
  while [ "${#running_pids[@]}" -ge "$CONC" ]; do
    new=(); for p in "${running_pids[@]}"; do kill -0 "$p" 2>/dev/null && new+=("$p"); done
    running_pids=("${new[@]}"); [ "${#running_pids[@]}" -ge "$CONC" ] && sleep 2
  done
  run_one "$w" & running_pids+=("$!")
done
wait
echo "[2b] $(date +%H:%M:%S) DONE: $(grep -c 'WIN ' "$LOG") wins / ${#work[@]} engagements" | tee -a "$LOG"
