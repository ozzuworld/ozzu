#!/usr/bin/env bash
# api-routes-smoke.sh — Step 6.1 (dir_1780600347679)
#
# HTTP-level smoke test for SOC REST routes. Bypasses the bridge process
# layer and hits the actual /soc/* endpoints via curl + asserts shapes.
# Catches routing/middleware bugs the in-process smokes miss.
#
# Pick a known-good engagement to assert against. Falls back to the
# fleet's first in_progress engagement if SMOKE_ENGAGEMENT_ID unset.

set -uo pipefail
GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3333}"
BRIDGE_TOKEN="${BRIDGE_TOKEN:-}"
if [[ -z "$BRIDGE_TOKEN" && -f /home/gcp/ozzu/.env ]]; then
  BRIDGE_TOKEN=$(grep -E '^BRIDGE_TOKEN=' /home/gcp/ozzu/.env | head -1 | cut -d= -f2- | tr -d '"' || true)
fi
[[ -z "$BRIDGE_TOKEN" && -f /home/gcp/ozzu/backend/.env ]] && \
  BRIDGE_TOKEN=$(grep -E '^BRIDGE_API_KEY=' /home/gcp/ozzu/backend/.env | head -1 | cut -d= -f2- | tr -d '"' || true)

AUTH=()
[[ -n "$BRIDGE_TOKEN" ]] && AUTH=(-H "Authorization: Bearer $BRIDGE_TOKEN")

log() { echo "[api-smoke] $*"; }
pass() { echo "${GREEN}✓ PASS${RESET}  $*"; }
fail() { echo "${RED}✗ FAIL${RESET}  $*"; exit 1; }

# ─────────────────────────── pick an engagement ───────────────────────────
SMOKE_ENGAGEMENT_ID="${SMOKE_ENGAGEMENT_ID:-}"
if [[ -z "$SMOKE_ENGAGEMENT_ID" ]]; then
  # Pull the most-recently-updated in_progress engagement
  SMOKE_ENGAGEMENT_ID=$(curl -sf "${AUTH[@]}" "$BRIDGE_URL/soc/engagements" 2>/dev/null \
    | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  active = [e for e in (d.get('engagements') or []) if e.get('status') == 'in_progress']
  print(active[0]['id'] if active else '')
except Exception: pass
" || true)
fi
if [[ -z "$SMOKE_ENGAGEMENT_ID" ]]; then
  log "${YELLOW}~ WARN${RESET}: no in_progress engagement found — running only the 'unknown id' negative case."
fi

# ─────────────────────────── tests ───────────────────────────

log "GET $BRIDGE_URL/soc/engagements"
LIST=$(curl -sf "${AUTH[@]}" "$BRIDGE_URL/soc/engagements") || fail "GET /soc/engagements failed (curl exit $?)"
echo "$LIST" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
n = len(d.get('engagements') or [])
print(f'  engagements count: {n}')
assert n >= 0, 'engagements should be a list'
" || fail "/soc/engagements response shape wrong"
pass "GET /soc/engagements returns engagements list"

# Test against the real engagement (if one exists)
if [[ -n "$SMOKE_ENGAGEMENT_ID" ]]; then
  log "GET $BRIDGE_URL/soc/engagements/$SMOKE_ENGAGEMENT_ID"
  ENG=$(curl -sf "${AUTH[@]}" "$BRIDGE_URL/soc/engagements/$SMOKE_ENGAGEMENT_ID") \
    || fail "GET /soc/engagements/$SMOKE_ENGAGEMENT_ID failed"
  echo "$ENG" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
e = d.get('engagement', {})
assert e.get('id'), 'engagement.id missing'
# Step 5+8 columns added by dir_1780589262481 + dir_1780594102481 should be in SELECT *
have_phase = 'engagement_phase' in e
have_status = 'agent_status' in e
print(f'  id={e[\"id\"]} agent_status={e.get(\"agent_status\")} phase={e.get(\"engagement_phase\")}')
assert have_phase, 'engagement_phase missing from response'
assert have_status, 'agent_status missing from response'
" || fail "/soc/engagements/:id shape wrong"
  pass "GET /soc/engagements/:id includes agent_status + engagement_phase"

  log "GET $BRIDGE_URL/soc/engagements/$SMOKE_ENGAGEMENT_ID/task-graph"
  TG=$(curl -sf "${AUTH[@]}" "$BRIDGE_URL/soc/engagements/$SMOKE_ENGAGEMENT_ID/task-graph") \
    || fail "GET /soc/engagements/$SMOKE_ENGAGEMENT_ID/task-graph failed"
  echo "$TG" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
assert 'tasks' in d and isinstance(d['tasks'], list), 'tasks not a list'
assert 'unblocked' in d and isinstance(d['unblocked'], list), 'unblocked not a list'
assert 'total' in d and isinstance(d['total'], int), 'total not int'
print(f'  tasks={d[\"total\"]} unblocked={len(d[\"unblocked\"])}')
" || fail "/soc/engagements/:id/task-graph shape wrong"
  pass "GET /soc/engagements/:id/task-graph returns {tasks, unblocked, total}"
fi

# Negative: unknown id → 404
log "GET $BRIDGE_URL/soc/engagements/__UNKNOWN__ (should 404)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${AUTH[@]}" "$BRIDGE_URL/soc/engagements/__UNKNOWN__")
if [[ "$STATUS" == "404" ]]; then
  pass "unknown engagement returns 404"
else
  fail "unknown engagement returned HTTP $STATUS (expected 404)"
fi

# task-graph for non-existent engagement should return {tasks:[], total:0} not 404
log "GET $BRIDGE_URL/soc/engagements/__UNKNOWN__/task-graph (should return empty graph)"
TG_NULL=$(curl -sf "${AUTH[@]}" "$BRIDGE_URL/soc/engagements/__UNKNOWN__/task-graph") \
  || fail "task-graph on unknown id failed (should return empty graph, not error)"
echo "$TG_NULL" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
assert d['total'] == 0, f'expected total=0 got {d[\"total\"]}'
assert d['tasks'] == [], f'expected tasks=[] got {d[\"tasks\"]}'
" || fail "task-graph on unknown id shape wrong"
pass "task-graph on unknown id returns empty graph (not 404)"

echo
echo "${GREEN}🎯 ALL API ROUTES SMOKE TESTS PASSED${RESET}"
