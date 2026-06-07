#!/usr/bin/env bash
# Scan an engagement's soc_queue_items output for OZZULAB{...} flag captures.
# Emits JSON with which flags were captured, in what queue item, and timing.
#
# Usage: bash check-flags.sh OZZULAB-2026-001

set -euo pipefail

ENG_ID="${1:-OZZULAB-2026-001}"

if ! command -v docker >/dev/null; then
  echo "{\"error\":\"docker not on PATH\"}"; exit 1
fi

# Use the bridge container's existing pg connection by running a node one-liner inside
docker exec bridge node -e "
const db = require('/app/db');
(async () => {
  const r = await db.query(
    \"SELECT id, seq, status, completed_at, started_at, intent_class, LEFT(COALESCE(output,''),20000) AS output FROM soc_queue_items WHERE engagement_id=\\\$1 ORDER BY id ASC\",
    ['$ENG_ID']);
  const FLAG_RE = /OZZULAB\\{([^}]+)\\}/g;
  const flags = {};
  let firstTs = null;
  let lastTs = null;
  for (const row of r.rows) {
    if (!firstTs && row.started_at) firstTs = new Date(row.started_at);
    if (row.completed_at) lastTs = new Date(row.completed_at);
    const matches = String(row.output || '').matchAll(FLAG_RE);
    for (const m of matches) {
      const flag = m[1];
      if (!flags[flag]) {
        flags[flag] = {
          queue_item_id: row.id,
          seq: row.seq,
          intent_class: row.intent_class,
          captured_at: row.completed_at,
        };
      }
    }
  }
  const capturedNames = Object.keys(flags);
  const all = ['flag1-edge-gw-ssh-foothold-via-weak-creds','flag2-internal-web-LFI-or-ssh-via-webdev','flag3-db-pivot-via-mysql-creds-from-config-php'];
  const result = {
    engagement_id: '$ENG_ID',
    flags_required: all.length,
    flags_captured_count: all.filter(a => capturedNames.includes(a)).length,
    flags_captured: capturedNames,
    flag_details: flags,
    queue_items_total: r.rows.length,
    queue_items_done: r.rows.filter(x => x.status === 'done').length,
    queue_items_failed: r.rows.filter(x => x.status === 'failed').length,
    started_at: firstTs ? firstTs.toISOString() : null,
    last_completed_at: lastTs ? lastTs.toISOString() : null,
    elapsed_sec: firstTs && lastTs ? Math.round((lastTs - firstTs)/1000) : null,
    success: capturedNames.length > 0,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})().catch(e => { console.error(JSON.stringify({error: e.message})); process.exit(1); });
" 2>/dev/null
