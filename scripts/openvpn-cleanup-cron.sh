#!/usr/bin/env bash
# openvpn-cleanup-cron.sh — 2-week post-decommission cleanup of backend/openvpn/.
#
# Scheduled to run once around 2026-05-16 via crontab. Pre-flight gates:
#   1. Decommission commit (dir_1777733704381) is in main history.
#   2. backend/docker-compose.yml does NOT contain an active openvpn service.
#   3. backend/openvpn/ directory still exists (else cleanup is already done).
#   4. WireGuard server is healthy (wg0 up + at least one peer handshook recently).
#
# If all pass → opens a PR via gh CLI removing backend/openvpn/ and the tombstone
# comment. PR body includes a manual-verification checklist (live wg/docker/firewall).
#
# If any check fails → logs the reason and exits non-zero. No destructive action.
#
# Run mode: install via crontab (one-shot at 2026-05-16 15:24 UTC):
#   24 15 16 5 *  /home/gcp/ozzu/scripts/openvpn-cleanup-cron.sh >> /tmp/ozzu-openvpn-cleanup.log 2>&1
# Or trigger manually:
#   ./scripts/openvpn-cleanup-cron.sh

set -uo pipefail

REPO=/home/gcp/ozzu
LOG=/tmp/ozzu-openvpn-cleanup.log
DIRECTIVE_REF=dir_1777733704381
BRANCH=cipher/openvpn-archival-cleanup

cd "$REPO" || { echo "$(date -u +%FT%TZ) ERROR: cannot cd $REPO" >&2; exit 1; }

log() { echo "$(date -u +%FT%TZ) $*"; }

log "=== OpenVPN cleanup cron starting ==="

# ── Pre-flight 1: decommission commit in main ──
git fetch origin main >/dev/null 2>&1 || { log "ABORT: git fetch failed"; exit 2; }
if ! git log origin/main --oneline | grep -q "$DIRECTIVE_REF"; then
  log "ABORT: directive $DIRECTIVE_REF not found in origin/main history"
  exit 2
fi
log "✓ decommission commit present in main"

# ── Pre-flight 2: openvpn service not re-introduced ──
git show origin/main:backend/docker-compose.yml 2>/dev/null \
  | awk '/^[a-zA-Z]/{flag=0} /^  openvpn:/{flag=1} flag' > /tmp/.ovpn-block
if [ -s /tmp/.ovpn-block ]; then
  log "ABORT: backend/docker-compose.yml has an active openvpn service block — re-introduced?"
  cat /tmp/.ovpn-block | sed 's/^/    /' | tee -a "$LOG"
  exit 2
fi
log "✓ no active openvpn service in docker-compose"

# ── Pre-flight 3: backend/openvpn/ directory still exists ──
if ! git show origin/main:backend/openvpn/ >/dev/null 2>&1; then
  log "INFO: backend/openvpn/ already removed — cleanup is no-op, exiting clean"
  exit 0
fi
log "✓ backend/openvpn/ exists (cleanup target present)"

# ── Pre-flight 4: WireGuard healthy ──
if ! command -v wg >/dev/null 2>&1; then
  log "ABORT: wg command not in PATH — cannot verify WG state"
  exit 2
fi
WG_STATE=$(sudo -n wg show wg0 2>&1)
if [ $? -ne 0 ] || [ -z "$WG_STATE" ]; then
  log "ABORT: 'wg show wg0' failed (sudo NOPASSWD missing or wg0 down):"
  echo "$WG_STATE" | tee -a "$LOG"
  exit 2
fi
RECENT_HANDSHAKE=$(echo "$WG_STATE" | awk '/latest handshake/ && (/seconds? ago/ || /minute(,| ago)/)')
if [ -z "$RECENT_HANDSHAKE" ]; then
  log "ABORT: no WG peer handshook in the last few minutes — WG looks broken, not removing OpenVPN archive"
  echo "$WG_STATE" | tee -a "$LOG"
  exit 2
fi
log "✓ WG healthy — recent handshakes:"
echo "$RECENT_HANDSHAKE" | sed 's/^/    /' | tee -a "$LOG"

# ── Open the cleanup PR ──
log "All pre-flight checks passed. Opening cleanup PR via gh."

git checkout main >/dev/null 2>&1
git pull origin main >/dev/null 2>&1
git branch -D "$BRANCH" 2>/dev/null
git checkout -b "$BRANCH" >/dev/null 2>&1

git rm -r backend/openvpn/ >/dev/null
# Strip the tombstone comment block from docker-compose.yml.
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("backend/docker-compose.yml")
text = p.read_text()
new = re.sub(
  r"^  # openvpn: DECOMMISSIONED 2026-05-02.*?(?=^  #|^[a-zA-Z])",
  "",
  text, flags=re.M | re.S
)
p.write_text(new)
PY

git add -A
git commit -m "Remove backend/openvpn/ archival dir — 2-week post-decommission cleanup — $DIRECTIVE_REF

Follow-up to $DIRECTIVE_REF (OpenVPN → WireGuard migration on 2026-05-02).
The 2-week emergency-rollback window has closed. Removes:
- backend/openvpn/ (server build context, certs archive, configs)
- Tombstone comment in backend/docker-compose.yml (no longer needed)" >/dev/null

git push -u origin "$BRANCH" 2>&1 | tee -a "$LOG"

PR_URL=$(gh pr create \
  --base main \
  --head "$BRANCH" \
  --title "Remove backend/openvpn/ archival dir — 2-week post-decommission cleanup" \
  --body "$(cat <<EOF
Follow-up to $DIRECTIVE_REF (OpenVPN → WireGuard migration on 2026-05-02).
The 2-week emergency-rollback window has closed.

This PR removes:
- \`backend/openvpn/\` — server build context, certs archive, configs.
- Tombstone comment in \`backend/docker-compose.yml\`.

## Pre-merge checks (King Kazuma must verify on the GCP VM)
- [ ] \`sudo wg show wg0\` lists dev-01 (10.9.0.5) and orangepi5 (10.9.0.6) with handshakes within the last 5 minutes
- [ ] \`docker ps -a --filter name=openvpn\` returns empty (container not present)
- [ ] \`ip -br addr show tun0\` returns "does not exist"
- [ ] GCP firewall rule \`allow-ozzu-public\` does NOT include udp:1194
- [ ] No regression — bridge ↔ devices over WG still working

Pre-flight ran on $(date -u +%FT%TZ) — all 4 gates passed before this PR was opened.
EOF
)" 2>&1 | tee -a "$LOG" | grep -oE 'https://github.com/[^[:space:]]+' | head -1)

log "✓ PR opened: ${PR_URL:-<unknown — check log>}"
log "=== OpenVPN cleanup cron done ==="
