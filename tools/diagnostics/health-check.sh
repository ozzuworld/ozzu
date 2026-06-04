#!/usr/bin/env bash
# health-check.sh — Step 8.11 (dir_1780600952872)
#
# One-command system snapshot. Runs all the diagnostics + regression suite,
# prints unified pass/fail per section. Use before any significant change
# to confirm the system is green.
#
# Sections:
#   1. Bridge container alive + healthy
#   2. Membrane historical audit (must be 0 breaches)
#   3. Fleet diagnostic (warns on issues, errors on errors)
#   4. Regression suite (run-all.sh — 4 smoke tests)
#
# Exit 0 = all green. Exit 1 = at least one section failed.

set -uo pipefail

GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

section() { echo; echo "${BOLD}═══ $1 ═══${RESET}"; }
pass() { echo "${GREEN}✓ PASS${RESET}  $*"; }
warn() { echo "${YELLOW}~ WARN${RESET}  $*"; }
fail() { echo "${RED}✗ FAIL${RESET}  $*"; FAILED=$((FAILED + 1)); }

# ─────────────────────────── 1. bridge alive ───────────────────────────
section "1. Bridge health"
if docker ps --filter "name=^bridge$" --format '{{.Names}}' | grep -q '^bridge$'; then
  uptime=$(docker ps --filter "name=^bridge$" --format '{{.Status}}' | grep -oP 'Up \K[^,]+')
  pass "bridge container running ($uptime)"
  HEALTH=$(curl -sf -m 3 http://localhost:3333/health 2>&1 || echo "FAIL")
  if [[ "$HEALTH" != "FAIL" ]]; then
    pass "bridge /health responds OK"
  else
    fail "bridge /health unreachable"
  fi
else
  fail "bridge container not running — skipping further checks"
  exit 1
fi

# ─────────────────────────── 2. membrane audit ───────────────────────────
section "2. Membrane historical audit"
docker cp "$ROOT/diagnostics/membrane-audit.js" bridge:/app/membrane-audit.js >/dev/null 2>&1
AUDIT_JSON=$(timeout 30 docker exec bridge node /app/membrane-audit.js --json 2>&1 | grep -m1 '{"total_rows"' || echo "{}")
BREACHES=$(echo "$AUDIT_JSON" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('total_breaches', '?'))" 2>/dev/null || echo "?")
ROWS=$(echo "$AUDIT_JSON" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('total_rows', '?'))" 2>/dev/null || echo "?")
if [[ "$BREACHES" == "0" ]]; then
  pass "membrane intact ($ROWS telemetry rows scanned, 0 breaches)"
elif [[ "$BREACHES" == "?" ]]; then
  fail "membrane audit returned malformed result"
else
  fail "MEMBRANE BREACH — $BREACHES breaches across $ROWS rows. Run membrane-audit.js for detail."
fi

# ─────────────────────────── 3. fleet diagnostic ───────────────────────────
section "3. Fleet diagnostic (active engagements)"
docker cp "$ROOT/diagnostics/telemetry-analyze.js" bridge:/app/telemetry-analyze.js >/dev/null 2>&1
FLEET_JSON=$(timeout 30 docker exec bridge node /app/telemetry-analyze.js --fleet --json 2>&1 | grep -m1 '{"n_engagements"' || echo "{}")
N=$(echo "$FLEET_JSON" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('n_engagements', '?'))" 2>/dev/null || echo "?")
ERRS=$(echo "$FLEET_JSON" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('total_errors', '?'))" 2>/dev/null || echo "?")
WARNS=$(echo "$FLEET_JSON" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('total_warns', '?'))" 2>/dev/null || echo "?")
if [[ "$ERRS" == "0" && "$WARNS" == "0" ]]; then
  pass "$N active engagements, 0 issues"
elif [[ "$ERRS" == "0" ]]; then
  warn "$N active engagements, $WARNS warnings (no errors)"
elif [[ "$ERRS" == "?" ]]; then
  fail "fleet diagnostic returned malformed result"
else
  fail "$N active engagements, $ERRS errors + $WARNS warnings"
fi

# ─────────────────────────── 4. regression suite ───────────────────────────
section "4. Regression suite (run-all.sh)"
if [[ ! -x "$ROOT/tests/run-all.sh" ]]; then
  fail "tools/tests/run-all.sh not found or not executable"
else
  TESTS_LOG=$(mktemp /tmp/health-check.tests.XXXXXX.log)
  if bash "$ROOT/tests/run-all.sh" >"$TESTS_LOG" 2>&1; then
    pass "all 4 smoke tests passed ($(grep -c '✓ PASS' "$TESTS_LOG") greens)"
  else
    fail "regression suite failed — see $TESTS_LOG (last lines below)"
    tail -10 "$TESTS_LOG" | sed 's/^/    | /'
  fi
fi

# ─────────────────────────── summary ───────────────────────────
echo
echo "═══════════════════════════════════════════════════════════════════"
if [[ "$FAILED" -eq 0 ]]; then
  echo "${GREEN}🎯 SYSTEM HEALTHY${RESET} — all sections green"
  exit 0
else
  echo "${RED}✗ $FAILED section(s) failed${RESET}"
  exit 1
fi
