#!/usr/bin/env bash
# Cipher codebase analysis — Layer 1/2/3 runner.
# Layer 1 (off-the-shelf): repomix + knip + dependency-cruiser + jscpd → .cipher/layer1/
# Layer 2 (intent index):  LLM per-file purpose → postgres + qdrant. Run via cipher-build-intent.js.
# Layer 3 (drift checks):  semgrep / custom AST rules → .cipher/layer3/. Run via cipher-check-drift.sh.
#
# Usage:
#   scripts/cipher-analyze.sh layer1            # off-the-shelf indexers
#   scripts/cipher-analyze.sh layer2            # intent index (re-extracts changed files)
#   scripts/cipher-analyze.sh layer3            # drift checks
#   scripts/cipher-analyze.sh all               # all three
#   scripts/cipher-analyze.sh layer1 --full     # rebuild from scratch
#
# Outputs land in .cipher/{layer1,layer2,layer3}/. Cipher reads these before
# answering "read the codebase"-style questions.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${REPO_ROOT}/.cipher/tools"
LAYER1_DIR="${REPO_ROOT}/.cipher/layer1"
LAYER2_DIR="${REPO_ROOT}/.cipher/layer2"
LAYER3_DIR="${REPO_ROOT}/.cipher/layer3"

log() { echo "[cipher-analyze] $*" >&2; }
die() { echo "[cipher-analyze] ERROR: $*" >&2; exit 1; }

ensure_tools() {
  if [[ ! -d "${TOOLS_DIR}/node_modules" ]]; then
    log "tools not installed — running npm install in .cipher/tools"
    (cd "${TOOLS_DIR}" && npm install --no-audit --no-fund 2>&1 | tail -3)
  fi
}

run_layer1() {
  ensure_tools
  mkdir -p "${LAYER1_DIR}"
  cd "${TOOLS_DIR}"

  log "Layer 1.1: repomix → repo map"
  npx repomix --config repomix.config.json "${REPO_ROOT}" 2>&1 | tail -3 || log "repomix failed (non-fatal)"

  log "Layer 1.2: knip → dead exports (frontend)"
  (cd "${REPO_ROOT}/frontend" && "${TOOLS_DIR}/node_modules/.bin/knip" \
      --config "${TOOLS_DIR}/knip-frontend-inplace.json" \
      --reporter json --no-exit-code \
      > "${LAYER1_DIR}/knip-frontend.json" 2>"${LAYER1_DIR}/knip-frontend.log") || log "knip frontend produced warnings"

  log "Layer 1.3: knip → dead exports (backend bridge)"
  (cd "${REPO_ROOT}/backend/bridge" && "${TOOLS_DIR}/node_modules/.bin/knip" \
      --config "${TOOLS_DIR}/knip-backend-inplace.json" \
      --reporter json --no-exit-code \
      > "${LAYER1_DIR}/knip-backend.json" 2>"${LAYER1_DIR}/knip-backend.log") || log "knip backend produced warnings"

  log "Layer 1.4: dependency-cruiser → import graph (frontend)"
  (cd "${REPO_ROOT}/frontend" && "${TOOLS_DIR}/node_modules/.bin/depcruise" \
    --config "${TOOLS_DIR}/depcruiser.config.cjs" \
    --ts-pre-compilation-deps \
    --output-type json \
    --output-to "${LAYER1_DIR}/depcruise-frontend.json" \
    "app/**/*.{ts,tsx}" "components/**/*.{ts,tsx}" "lib/**/*.{ts,tsx}" 2>&1 | tail -3) || log "depcruise frontend failed (non-fatal)"

  log "Layer 1.5: dependency-cruiser → import graph (backend bridge)"
  (cd "${REPO_ROOT}/backend/bridge" && "${TOOLS_DIR}/node_modules/.bin/depcruise" \
    --config "${TOOLS_DIR}/depcruiser.config.cjs" \
    --output-type json \
    --output-to "${LAYER1_DIR}/depcruise-backend.json" \
    server.js agent-spawner.js routes 2>&1 | tail -3) || log "depcruise backend failed (non-fatal)"

  log "Layer 1.6: jscpd → copy-paste detection"
  rm -rf "${LAYER1_DIR}/jscpd"
  (cd "${REPO_ROOT}" && npx --prefix "${TOOLS_DIR}" jscpd \
    --config "${TOOLS_DIR}/jscpd.config.json" \
    --output "${LAYER1_DIR}/jscpd" \
    frontend/app frontend/components backend/bridge 2>&1 | tail -3) || log "jscpd finished with warnings"

  # Digest all outputs into one human-readable SUMMARY.md
  log "Layer 1.7: digesting → SUMMARY.md"
  node "${REPO_ROOT}/.cipher/bin/summarize-layer1.js"

  # Mark last-run timestamp
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "${LAYER1_DIR}/.last-run"
  log "Layer 1 done. Outputs in ${LAYER1_DIR}/"
  ls -lh "${LAYER1_DIR}" 2>&1 | tail -10 >&2
}

run_layer2() {
  mkdir -p "${LAYER2_DIR}"
  log "Layer 2: extracting per-file intent via Claude Haiku (incremental)"
  local extra_args=()
  if [[ "${1:-}" == "--full" ]]; then extra_args+=("--full"); fi
  node "${REPO_ROOT}/.cipher/bin/build-intent.js" "${extra_args[@]}"
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "${LAYER2_DIR}/.last-run"
  log "Layer 2 done. Query via: .cipher/bin/query-intent.sh '<terms>'"
}

run_layer3() {
  mkdir -p "${LAYER3_DIR}"
  log "Layer 3: drift checks (hardcoded hex, dup layout constants, dup format helpers, broken routes)"
  node "${REPO_ROOT}/.cipher/bin/check-drift.js"
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "${LAYER3_DIR}/.last-run"
  log "Layer 3 done. See ${LAYER3_DIR}/SUMMARY.md"

  # Layer 3.5 — LLM-judge rules. Skip in post-commit auto-runs (env hint),
  # run on-demand via `scripts/cipher-analyze.sh layer3-llm`.
  if [[ "${CIPHER_RUN_LLM_JUDGE:-0}" == "1" ]]; then
    log "Layer 3.5: LLM-judge semantic drift checks (this takes ~3-5 min)"
    node "${REPO_ROOT}/.cipher/bin/llm-judge.js"
  fi
}

run_layer3_llm() {
  mkdir -p "${LAYER3_DIR}"
  log "Layer 3.5: LLM-judge semantic drift checks"
  node "${REPO_ROOT}/.cipher/bin/llm-judge.js" "$@"
  log "Layer 3.5 done. See ${LAYER3_DIR}/SUMMARY-LLM.md"
}

main() {
  local cmd="${1:-all}"
  case "${cmd}" in
    layer1) run_layer1 ;;
    layer2) run_layer2 ;;
    layer3) run_layer3 ;;
    layer3-llm) shift; run_layer3_llm "$@" ;;
    all)    run_layer1; run_layer2 || true; run_layer3 || true ;;
    *) die "Unknown command: ${cmd}. Use: layer1 | layer2 | layer3 | layer3-llm | all" ;;
  esac
}

main "$@"
