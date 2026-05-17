#!/usr/bin/env bash
# Cipher post-commit hook — refresh Layer 1 + Layer 3 indexes in background.
# Layer 2 (LLM-based) is incremental and skipped here to avoid blocking commits;
# refresh it on-demand with `scripts/cipher-analyze.sh layer2`.
set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
LOG="${REPO_ROOT}/.cipher/.post-commit.log"

# Don't run on cipher's own internal commits to avoid churn
LAST_MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")
if [[ "${LAST_MSG}" == *"[skip-cipher-index]"* ]]; then exit 0; fi

# Spawn in background, detached
(
  echo "[post-commit] $(date -u +%FT%TZ) — refreshing Layer 1 + Layer 3"
  "${REPO_ROOT}/scripts/cipher-analyze.sh" layer1 2>&1 || true
  "${REPO_ROOT}/scripts/cipher-analyze.sh" layer3 2>&1 || true
  echo "[post-commit] $(date -u +%FT%TZ) — done"
) >> "${LOG}" 2>&1 &
disown

exit 0
