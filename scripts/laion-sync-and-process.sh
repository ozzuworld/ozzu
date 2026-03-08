#!/bin/bash
# Syncs LAION face URL files from GCP to dev-01 and processes them.
# Run on GCP. Watches for new URL files and sends them to dev-01 for processing.
#
# Epic: dir_1772936492816 | Phase 1: dir_1772936668030

URL_DIR="/home/gcp/ozzu/data/laion-face/urls"
REMOTE="dev-01"
REMOTE_DIR="/home/hadmin/laion-urls"
WORKER="/home/hadmin/laion-face-worker.py"
PROCESSED_LOG="/home/gcp/ozzu/data/laion-face/synced_parts.txt"

touch "$PROCESSED_LOG"

echo "=== LAION Sync & Process ==="
echo "URL dir: $URL_DIR"
echo "Remote: $REMOTE:$REMOTE_DIR"

# Ensure remote dir exists
ssh $REMOTE "mkdir -p $REMOTE_DIR" 2>/dev/null

while true; do
    # Find URL files not yet synced
    for f in "$URL_DIR"/face_urls_part_*.jsonl; do
        [ -f "$f" ] || continue
        basename=$(basename "$f")

        if grep -q "$basename" "$PROCESSED_LOG" 2>/dev/null; then
            continue
        fi

        echo "[$(date +%H:%M)] Syncing $basename to $REMOTE..."
        scp "$f" "$REMOTE:$REMOTE_DIR/$basename" 2>/dev/null

        if [ $? -eq 0 ]; then
            echo "[$(date +%H:%M)] Processing $basename on $REMOTE..."
            ssh $REMOTE "cd ~ && python3 $WORKER $REMOTE_DIR/$basename --batch-size 30" 2>/dev/null
            echo "$basename" >> "$PROCESSED_LOG"

            # Show Qdrant count
            count=$(curl -s http://localhost:6333/collections/faces 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['points_count'])" 2>/dev/null)
            echo "[$(date +%H:%M)] Qdrant faces: $count"
        else
            echo "[$(date +%H:%M)] Failed to sync $basename"
        fi
    done

    # Check if extraction is still running
    if ! pgrep -f "laion-face-pipeline" > /dev/null 2>&1; then
        remaining=$(ls "$URL_DIR"/face_urls_part_*.jsonl 2>/dev/null | wc -l)
        synced=$(wc -l < "$PROCESSED_LOG" 2>/dev/null || echo 0)
        if [ "$remaining" -eq "$synced" ]; then
            echo "[$(date +%H:%M)] All files processed. Done."
            break
        fi
    fi

    sleep 30
done

echo "=== Complete ==="
count=$(curl -s http://localhost:6333/collections/faces 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['points_count'])" 2>/dev/null)
echo "Final Qdrant faces: $count"
