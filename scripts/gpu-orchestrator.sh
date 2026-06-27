#!/bin/bash
# gpu-orchestrator.sh — Unattended multi-dataset face embedding pipeline
# Designed to run for 2+ days without intervention.
#
# Features:
#   - Sequential dataset processing with auto-recovery
#   - Per-shard crash recovery (restarts from last completed shard)
#   - Disk cleanup between datasets
#   - Heartbeat to bridge for watchdog monitoring
#   - Detailed logging with timestamps
#
# Usage: nohup bash gpu-orchestrator.sh > /root/orchestrator.log 2>&1 &

set -o pipefail

# Auto-detect nvidia lib paths from python's site-packages
NVIDIA_LIBS=$(python3 -c "import site; import glob; dirs=[]
for s in site.getsitepackages()+[site.getusersitepackages()]:
    dirs.extend(glob.glob(s+'/nvidia/*/lib'))
print(':'.join(dirs))" 2>/dev/null)
export LD_LIBRARY_PATH="${NVIDIA_LIBS}:/usr/local/cuda/lib64:${LD_LIBRARY_PATH}"
export QDRANT_URL="${QDRANT_URL:-http://home.ozzu.world:6333}"
export BRIDGE_URL="${BRIDGE_URL:-http://home.ozzu.world:3333}"
export ONNXRUNTIME_LOG_LEVEL=3
export HF_HOME=/root/.cache/huggingface

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMBED_SCRIPT="${SCRIPT_DIR}/embed-hf-dataset.py"
PARQUET_SCRIPT="${SCRIPT_DIR}/embed-parquet-dataset.py"
STATE_FILE="/root/.orchestrator-state.json"
LOG_FILE="/root/orchestrator.log"
MAX_RETRIES=5
RETRY_DELAY=30

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

notify_bridge() {
    local msg="$1"
    curl -s -X POST "${BRIDGE_URL}/api/pipeline-state" \
        -H "Content-Type: application/json" \
        -d "{\"orchestrator\": true, \"message\": \"$msg\", \"timestamp\": $(date +%s)}" \
        --connect-timeout 5 --max-time 10 >/dev/null 2>&1 || true
}

qdrant_count() {
    curl -s "${QDRANT_URL}/collections/faces" --connect-timeout 5 2>/dev/null | \
        python3 -c "import json,sys; print(json.load(sys.stdin)['result']['points_count'])" 2>/dev/null || echo "?"
}

save_state() {
    local dataset="$1" shard="$2" status="$3"
    cat > "$STATE_FILE" <<EOF
{"dataset":"$dataset","last_shard":$shard,"status":"$status","timestamp":"$(ts)"}
EOF
}

load_state() {
    local dataset="$1"
    if [ -f "$STATE_FILE" ]; then
        local saved_ds=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('dataset',''))" 2>/dev/null)
        if [ "$saved_ds" = "$dataset" ]; then
            python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('last_shard',0))" 2>/dev/null
            return
        fi
    fi
    echo "0"
}

cleanup_dataset_cache() {
    local name="$1"
    local dir="/root/$name"
    if [ -d "$dir" ]; then
        local size=$(du -sh "$dir" 2>/dev/null | cut -f1)
        log "[cleanup] Removing $dir ($size)"
        rm -rf "$dir"
    fi
    # Also clean HF cache for this dataset
    find /root/.cache/huggingface/hub -name "*.tar*" -mmin +30 -delete 2>/dev/null || true
}

run_dataset() {
    local name="$1"
    local start="${2:-0}"
    local end="${3:-}"
    local script="${4:-$EMBED_SCRIPT}"
    local attempt=0

    log "============================================"
    log "DATASET: $name (start_shard=$start, script=$(basename $script))"
    log "============================================"
    notify_bridge "Starting $name (shard $start)"

    # Resume from last state if crashed
    local resume_shard=$(load_state "$name")
    if [ "$resume_shard" -gt "$start" ] 2>/dev/null; then
        log "[resume] Resuming $name from shard $resume_shard (was at $start)"
        start=$resume_shard
    fi

    while [ $attempt -lt $MAX_RETRIES ]; do
        attempt=$((attempt + 1))
        log "[attempt $attempt/$MAX_RETRIES] python3 $(basename $script) $name $start $end"

        local cmd="python3 -u $script $name $start"
        [ -n "$end" ] && cmd="$cmd $end"

        # Run with output monitoring — capture exit code
        eval "$cmd" 2>&1 | while IFS= read -r line; do
            echo "$line"
            # Track shard progress for recovery
            if echo "$line" | grep -qP '^\[shard \d{4,5}\]'; then
                local shard_num=$(echo "$line" | grep -oP '\[shard \K\d+')
                save_state "$name" "$shard_num" "running"
            fi
        done
        local exit_code=${PIPESTATUS[0]}

        if [ $exit_code -eq 0 ]; then
            log "[done] $name completed successfully"
            save_state "$name" "9999" "completed"
            notify_bridge "$name completed"
            return 0
        fi

        log "[crash] $name exited with code $exit_code (attempt $attempt)"
        notify_bridge "$name crashed (attempt $attempt/$MAX_RETRIES)"

        # Load last successful shard for retry
        local last=$(load_state "$name")
        if [ "$last" -gt "$start" ] 2>/dev/null; then
            start=$((last + 1))
            log "[recover] Restarting from shard $start"
        fi

        if [ $attempt -lt $MAX_RETRIES ]; then
            log "[wait] Retrying in ${RETRY_DELAY}s..."
            sleep $RETRY_DELAY
        fi
    done

    log "[FAIL] $name failed after $MAX_RETRIES attempts"
    notify_bridge "$name FAILED after $MAX_RETRIES attempts"
    return 1
}

# ═══════════════════════════════════════════
# MAIN PIPELINE
# ═══════════════════════════════════════════

log "═══════════════════════════════════════════"
log "GPU ORCHESTRATOR — UNATTENDED PIPELINE"
log "Started: $(ts)"
log "Qdrant: $QDRANT_URL"
log "Bridge: $BRIDGE_URL"
log "═══════════════════════════════════════════"

COUNT_BEFORE=$(qdrant_count)
log "Qdrant faces before: $COUNT_BEFORE"
notify_bridge "Orchestrator started — $COUNT_BEFORE faces in Qdrant"

# ── Phase 1: Wait for MS1MV3 if still running ──
if pgrep -f "embed-ms1mv3.py" > /dev/null 2>&1; then
    log "[wait] MS1MV3 still running (PID $(pgrep -f embed-ms1mv3.py)), waiting..."
    notify_bridge "Waiting for MS1MV3 to finish"
    while pgrep -f "embed-ms1mv3.py" > /dev/null 2>&1; do
        sleep 60
    done
    log "[done] MS1MV3 finished at $(ts)"
    COUNT_AFTER_MS1MV3=$(qdrant_count)
    log "Qdrant after MS1MV3: $COUNT_AFTER_MS1MV3"
    notify_bridge "MS1MV3 done — $COUNT_AFTER_MS1MV3 faces"
fi

# ── Install dependencies for parquet datasets ──
log "[deps] Installing pyarrow for parquet datasets..."
pip install pyarrow -q 2>/dev/null || log "[warn] pyarrow install failed — parquet datasets may not work"

# ── Phase 2: VGGFace2 (3.3M faces, Parquet from logasja/VGGFace2) ──
run_dataset "vggface2" 0 "" "$PARQUET_SCRIPT"
cleanup_dataset_cache "vggface2"
log "Qdrant after VGGFace2: $(qdrant_count)"

# ── Phase 3: MS1MV2 (5.8M faces, WebDataset from LSIbabnikz/ms1mv2_wds) ──
run_dataset "ms1mv2" 0 "" "$EMBED_SCRIPT"
cleanup_dataset_cache "ms1mv2"
log "Qdrant after MS1MV2: $(qdrant_count)"

# ── Phase 4: CASIA-WebFace (491K faces, Parquet from SaffalPoosh) ──
run_dataset "casia" 0 "" "$PARQUET_SCRIPT"
cleanup_dataset_cache "casia"
log "Qdrant after CASIA: $(qdrant_count)"

# ── Phase 5: IMDB-Wiki (512K faces, Parquet from ljnlonoljpiljm) ──
run_dataset "imdb_wiki" 0 "" "$PARQUET_SCRIPT"
cleanup_dataset_cache "imdb_wiki"
log "Qdrant after IMDB-Wiki: $(qdrant_count)"

# ── Done ──
COUNT_FINAL=$(qdrant_count)
log ""
log "═══════════════════════════════════════════"
log "PIPELINE COMPLETE"
log "Started: $COUNT_BEFORE faces"
log "Final:   $COUNT_FINAL faces"
log "Finished: $(ts)"
log "═══════════════════════════════════════════"
notify_bridge "Pipeline complete — $COUNT_FINAL total faces"
