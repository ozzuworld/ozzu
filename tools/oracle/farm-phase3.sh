#!/bin/bash
# dir_1781203380739: autonomous CROSS-CLASS (phase 3) demo farmer. Runs one harvest window per
# invocation, accumulates real wins into phase3-wins-cum.jsonl (dedup by engagement_id). Cron-safe:
# skips if dev-01 is down, a harvest is already running, or the target is reached. Failed/quota-dead
# windows add ZERO bad data (only complete, real, deduped wins are appended).
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

OT=/home/gcp/ozzu/private/oracle-trajectories
CFG=/home/gcp/ozzu/tools/oracle/phase3-variants-config.json
CUM=$OT/phase3-wins-cum.jsonl
LOG=$OT/farm-phase3.log
TARGET=${PHASE3_TARGET:-60}                 # ~20/class across the 3 pilot classes
VARIANTS=${PHASE3_VARIANTS:-sqli-i1,ssti-i1,redis-i1}
ts(){ date '+%Y-%m-%d %H:%M:%S'; }
cd /home/gcp/ozzu

ping -c1 -W3 10.9.0.5 >/dev/null 2>&1 || { echo "$(ts) SKIP: dev-01 unreachable" >>"$LOG"; exit 0; }
pgrep -f 'tools/oracle/play-parallel.sh' >/dev/null && { echo "$(ts) SKIP: harvest already running" >>"$LOG"; exit 0; }
have=$(wc -l < "$CUM" 2>/dev/null || echo 0)
if [ "$have" -ge "$TARGET" ]; then echo "$(ts) DONE: have $have (>=$TARGET) — farmer idle" >>"$LOG"; exit 0; fi

echo "$(ts) farming a window (have $have / $TARGET)..." >>"$LOG"
bash tools/oracle/play-parallel.sh --total 30 --concurrency 4 --max-iter 30 \
  --variants "$VARIANTS" --variants-config "$CFG" \
  --out "$OT/phase3-batch.jsonl" >>"$LOG" 2>&1 || true

python3 - "$CUM" "$OT/phase3-batch.jsonl" >>"$LOG" 2>&1 <<'PY'
import json, sys, os
cum, batch = sys.argv[1], sys.argv[2]
seen=set(); out=[]
if os.path.exists(cum):
    for l in open(cum):
        try: t=json.loads(l); seen.add(t['engagement_id']); out.append(l if l.endswith('\n') else l+'\n')
        except Exception: pass
added=0
if os.path.exists(batch):
    for l in open(batch):
        try:
            t=json.loads(l)
            if t.get('flag_captured') and t.get('engagement_id') not in seen:
                seen.add(t['engagement_id']); out.append(l if l.endswith('\n') else l+'\n'); added+=1
        except Exception: pass
open(cum,'w').writelines(out)
from collections import Counter
c=Counter(json.loads(l).get('variant') for l in out)
print(f"+{added} new wins; cum={len(out)} per-class={dict(c)}")
PY
echo "$(ts) window done, cum=$(wc -l < "$CUM" 2>/dev/null || echo 0)" >>"$LOG"
