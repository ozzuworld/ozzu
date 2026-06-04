#!/usr/bin/env bash
# run-all.sh — Step 8.3 (dir_1780599065297)
#
# Run both agent-path smoke tests back-to-back. Unified pass/fail report.
# Exits non-zero if either test fails.
#
# Usage:
#   bash /home/gcp/ozzu/tools/tests/run-all.sh

set -uo pipefail   # NOT -e — we WANT to keep running if one test fails

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'

run_in_bridge() {
  local label="$1" file="$2"
  echo
  echo "═══════════════════════════════════════════════════════════════════"
  echo "  Running: ${label} (in bridge container)"
  echo "  Source:  ${file}"
  echo "═══════════════════════════════════════════════════════════════════"
  if ! docker cp "$file" "bridge:/app/$(basename "$file")" >/dev/null 2>&1; then
    echo "${RED}✗ FAIL${RESET}  could not docker cp $file → bridge"
    return 1
  fi
  if timeout 90 docker exec bridge node "/app/$(basename "$file")" 2>&1 | tee /tmp/${label}.last.log | tail -25; then
    if grep -q "SMOKE TEST PASSED" /tmp/${label}.last.log; then
      echo "${GREEN}✓ PASS${RESET}  ${label}"
      return 0
    fi
  fi
  echo "${RED}✗ FAIL${RESET}  ${label} (see /tmp/${label}.last.log for full output)"
  return 1
}

run_local() {
  local label="$1" file="$2"
  echo
  echo "═══════════════════════════════════════════════════════════════════"
  echo "  Running: ${label} (local)"
  echo "  Source:  ${file}"
  echo "═══════════════════════════════════════════════════════════════════"
  if bash "$file" 2>&1 | tee /tmp/${label}.last.log | tail -25; then
    if grep -q "ALL .* PASSED" /tmp/${label}.last.log; then
      echo "${GREEN}✓ PASS${RESET}  ${label}"
      return 0
    fi
  fi
  echo "${RED}✗ FAIL${RESET}  ${label} (see /tmp/${label}.last.log for full output)"
  return 1
}

START=$(date +%s)
FAILED=0
echo "Cipher agent-loop regression suite — $(date)"
echo "Tests run inside the bridge container; bridge must be running."

if ! docker ps --filter "name=^bridge$" --format '{{.Names}}' | grep -q '^bridge$'; then
  echo "${RED}FATAL${RESET}: bridge container not running"
  exit 2
fi

run_in_bridge "step-8-1-multiagent"      "$ROOT/agent-smoke.js"            || FAILED=$((FAILED + 1))
run_in_bridge "step-8-2-legacy-toolcall" "$ROOT/agent-toolcall-smoke.js"   || FAILED=$((FAILED + 1))
run_local     "step-9-14-dataset-pipeline" "$ROOT/finetune-dataset-smoke.sh" || FAILED=$((FAILED + 1))
run_local     "step-6-1-api-routes"        "$ROOT/api-routes-smoke.sh"     || FAILED=$((FAILED + 1))

ELAPSED=$(($(date +%s) - START))
echo
echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAILED" -eq 0 ]; then
  echo "${GREEN}🎯 ALL TESTS PASSED${RESET} — agent paths + dataset pipeline mechanically correct (${ELAPSED}s)"
  exit 0
else
  echo "${RED}✗ ${FAILED} test(s) failed${RESET} — see logs in /tmp/step-*.last.log (${ELAPSED}s)"
  exit 1
fi
