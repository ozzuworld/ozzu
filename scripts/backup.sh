#!/bin/bash
# backup.sh — Create encrypted backup of all ozzu data
# Usage: ./scripts/backup.sh [--no-encrypt] [--output-dir /path]
#
# Backs up:
#   - PostgreSQL database (full dump)
#   - JSON state files (directives, approvals, epics, etc.)
#   - OSINT images (/tmp/ozzu-bridge/osint-images/)
#   - Business attachments (/tmp/ozzu-bridge/business-attachments/)
#   - Build artifacts (/home/gcp/ozzu/artifacts/)
#   - Home Assistant config (/home/gcp/ozzu/backend/config/)
#   - Environment files (.env, .env.local)
#   - Redis AOF snapshot
#   - private/ docs tier (legal/STATE/evidence; heavy dirs excluded) [2026-09-25]
#   - System configs (/etc/wireguard, data/adguardhome) [2026-09-25]
#   - Qdrant storage (face DB) [2026-09-25]
#   - Media-stack configs (/srv/media-stack/config: Jellyfin db/state, *arr, qbit) [2026-09-27]
# ⚠️ Passphrase = BRIDGE_API_KEY (backend/.env). On rotation, archive the OLD key value
#    beside the backups or they become undecryptable (offsite copy: OC ~/offsite-ozzu/RESTORE-KEY).

set -euo pipefail

PROJECT_ROOT="/home/gcp/ozzu"
BACKUP_DIR="${PROJECT_ROOT}/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="ozzu-backup-${TIMESTAMP}"
WORK_DIR="/tmp/ozzu-backup-${TIMESTAMP}"
ENCRYPT=true
OUTPUT_DIR=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-encrypt) ENCRYPT=false; shift ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[ -n "$OUTPUT_DIR" ] && BACKUP_DIR="$OUTPUT_DIR"
mkdir -p "$BACKUP_DIR" "$WORK_DIR"

echo "=== Ozzu Backup: ${BACKUP_NAME} ==="
echo "Timestamp: $(date -Iseconds)"

# 1. PostgreSQL dump
echo "[1/7] Dumping PostgreSQL..."
PGPASSWORD=ozzu_pg_s3cure pg_dump -h 127.0.0.1 -U ozzu -d ozzu -Fc -f "${WORK_DIR}/database.dump" 2>/dev/null || {
  # Try via docker if local pg_dump fails
  docker exec $(docker ps -qf "name=postgres" | head -1) pg_dump -U ozzu -d ozzu -Fc > "${WORK_DIR}/database.dump"
}
DB_SIZE=$(du -sh "${WORK_DIR}/database.dump" | cut -f1)
echo "  Database dump: ${DB_SIZE}"

# 2. JSON state files (directives, approvals, epics, orchestrator)
echo "[2/8] Backing up JSON state files..."
mkdir -p "${WORK_DIR}/state"
for f in directives.json approvals.json epics.json orchestrator-knowledge.json status.json; do
  [ -f "/tmp/ozzu-bridge/$f" ] && cp "/tmp/ozzu-bridge/$f" "${WORK_DIR}/state/$f"
done
STATE_COUNT=$(ls "${WORK_DIR}/state/" 2>/dev/null | wc -l)
echo "  State files: ${STATE_COUNT} files"

# 3. OSINT images
echo "[3/8] Backing up OSINT images..."
if [ -d /tmp/ozzu-bridge/osint-images ] && [ "$(ls -A /tmp/ozzu-bridge/osint-images 2>/dev/null)" ]; then
  tar -cf "${WORK_DIR}/osint-images.tar" -C /tmp/ozzu-bridge osint-images 2>/dev/null || true
  echo "  OSINT images: $(du -sh "${WORK_DIR}/osint-images.tar" 2>/dev/null | cut -f1)"
else
  echo "  OSINT images: (none)"
fi

# 4. Business attachments
echo "[4/8] Backing up business attachments..."
ATTACH_FOUND=false
for dir in business-attachments uploads; do
  if [ -d "/tmp/ozzu-bridge/$dir" ] && [ "$(ls -A "/tmp/ozzu-bridge/$dir" 2>/dev/null)" ]; then
    tar -cf "${WORK_DIR}/uploads.tar" -C /tmp/ozzu-bridge "$dir" 2>/dev/null || true
    echo "  Uploads ($dir): $(du -sh "${WORK_DIR}/uploads.tar" 2>/dev/null | cut -f1)"
    ATTACH_FOUND=true
    break
  fi
done
$ATTACH_FOUND || echo "  Uploads: (none)"

# 5. Build artifacts (latest IPA/APK) — skipped by default (large, rebuildable from CI)
echo "[5/8] Build artifacts: skipped (rebuildable from GitHub CI)"

# 6. Home Assistant config (exclude large DB WAL files, include core config)
echo "[6/8] Backing up Home Assistant config..."
if [ -d "${PROJECT_ROOT}/backend/config" ]; then
  tar -cf "${WORK_DIR}/ha-config.tar" \
    -C "${PROJECT_ROOT}/backend" \
    --exclude='config/.cloud' \
    --exclude='config/deps' \
    --exclude='config/__pycache__' \
    --exclude='config/tts' \
    --exclude='config/.storage/lovelace*' \
    config 2>/dev/null || true
  echo "  HA config: $(du -sh "${WORK_DIR}/ha-config.tar" 2>/dev/null | cut -f1)"
else
  echo "  HA config: (none)"
fi

# 7. Environment files
echo "[7/8] Backing up environment files..."
mkdir -p "${WORK_DIR}/env"
[ -f "${PROJECT_ROOT}/backend/.env" ] && cp "${PROJECT_ROOT}/backend/.env" "${WORK_DIR}/env/backend.env"
[ -f "${PROJECT_ROOT}/frontend/.env.local" ] && cp "${PROJECT_ROOT}/frontend/.env.local" "${WORK_DIR}/env/frontend.env.local"
[ -f "${PROJECT_ROOT}/frontend/.env" ] && cp "${PROJECT_ROOT}/frontend/.env" "${WORK_DIR}/env/frontend.env"
echo "  Env files: $(ls "${WORK_DIR}/env/" | wc -l) files"

# 8. Cipher memory (canonical mind store — single source of truth for every provider)
echo "[8/9] Backing up Cipher memory..."
if [ -d "${PROJECT_ROOT}/private/cipher-memory" ]; then
  tar -cf "${WORK_DIR}/cipher-memory.tar" -C "${PROJECT_ROOT}/private" cipher-memory 2>/dev/null || true
  echo "  Cipher memory: $(du -sh "${WORK_DIR}/cipher-memory.tar" 2>/dev/null | cut -f1)"
else
  echo "  Cipher memory: (none)"
fi

# 9. Redis snapshot
echo "[9/13] Snapshotting Redis..."
redis-cli -h 127.0.0.1 BGSAVE >/dev/null 2>&1 || true
sleep 1
REDIS_CONTAINER=$(docker ps -qf "name=redis" | head -1)
if [ -n "$REDIS_CONTAINER" ]; then
  docker cp "${REDIS_CONTAINER}:/data/appendonly.aof" "${WORK_DIR}/redis-appendonly.aof" 2>/dev/null || true
  docker cp "${REDIS_CONTAINER}:/data/dump.rdb" "${WORK_DIR}/redis-dump.rdb" 2>/dev/null || true
  echo "  Redis: $(du -sh "${WORK_DIR}/redis-dump.rdb" 2>/dev/null | cut -f1 || echo 'n/a')"
else
  echo "  Redis: (container not found)"
fi

# 10. Private docs tier (2026-09-25, CIS-11 fix: legal/STATE/evidence were single-copy on one disk)
# Heavy exclusions: cucm/expressway-evidence (23G, rebuildable corpora/rootfs), drone/backups (3.2G legacy images)
# 2026-09-27: + cucm/native-fuzz (5.8G regenerable fuzz corpora — ballooned the enc gen 1.5G→2.3G
# and pushed the OC offsite disk to 100%; same class as expressway-evidence).
echo "[10/13] Backing up private/ docs tier..."
if [ -d "${PROJECT_ROOT}/private" ]; then
  tar -cf "${WORK_DIR}/private-docs.tar" -C "${PROJECT_ROOT}" \
    --exclude='private/cucm/expressway-evidence' \
    --exclude='private/cucm/native-fuzz' \
    --exclude='private/drone/backups' \
    --exclude='*.vmdk' --exclude='*.iso' --exclude='*.vdi' \
    private 2>/dev/null || true
  echo "  Private docs: $(du -sh "${WORK_DIR}/private-docs.tar" 2>/dev/null | cut -f1 || echo 'n/a')"
else
  echo "  Private docs: (none)"
fi

# 11. System config tier (WG keys + AdGuard conf)
echo "[11/13] Backing up system configs..."
tar -cf "${WORK_DIR}/system-config.tar" \
  -C / etc/wireguard \
  -C "${PROJECT_ROOT}/data" adguardhome 2>/dev/null || true
echo "  System config: $(du -sh "${WORK_DIR}/system-config.tar" 2>/dev/null | cut -f1 || echo 'n/a')"

# 12. Qdrant storage (face DB embeddings)
echo "[12/13] Snapshotting qdrant storage..."
QDRANT_CONTAINER=$(docker ps -qf "name=qdrant" | head -1)
if [ -n "$QDRANT_CONTAINER" ]; then
  { docker cp "${QDRANT_CONTAINER}:/qdrant/storage" "${WORK_DIR}/qdrant-storage" 2>/dev/null \
    && tar -cf "${WORK_DIR}/qdrant-storage.tar" -C "${WORK_DIR}" qdrant-storage 2>/dev/null \
    && rm -rf "${WORK_DIR}/qdrant-storage"; } || true
  echo "  Qdrant: $(du -sh "${WORK_DIR}/qdrant-storage.tar" 2>/dev/null | cut -f1 || echo 'n/a')"
else
  echo "  Qdrant: (container not found)"
fi

# 13. Media-stack configs (SKYLINE-SOC-2026-075 audit 2026-09-27: Jellyfin db + watched
# state, *arr configs/API keys, qbit torrent state — ~82M raw, was single-copy on /srv).
# Excluded: regenerable caches/metadata/logs/transcodes and the media files themselves
# (rotation library is re-downloadable; ozzu-media-watchdog caps its growth).
echo "[13/13] Backing up media-stack configs..."
if [ -d /srv/media-stack/config ]; then
  tar -cf "${WORK_DIR}/media-stack-config.tar" -C /srv/media-stack \
    --exclude='config/jellyfin/cache' \
    --exclude='config/jellyfin/log' \
    --exclude='config/jellyfin/data/metadata' \
    --exclude='config/jellyfin/data/transcodes' \
    --exclude='config/jellyfin/data/plugins' \
    --exclude='config/*/logs' --exclude='config/*/Logs' \
    config 2>/dev/null || true
  echo "  Media-stack config: $(du -sh "${WORK_DIR}/media-stack-config.tar" 2>/dev/null | cut -f1 || echo 'n/a')"
else
  echo "  Media-stack config: (dir not found)"
fi

# Create manifest
echo "[*] Creating manifest..."
cat > "${WORK_DIR}/manifest.json" <<MANIFEST
{
  "version": "1.0",
  "timestamp": "$(date -Iseconds)",
  "hostname": "$(hostname)",
  "components": {
    "database": $([ -f "${WORK_DIR}/database.dump" ] && echo "true" || echo "false"),
    "state_files": $([ -d "${WORK_DIR}/state" ] && echo "true" || echo "false"),
    "osint_images": $([ -f "${WORK_DIR}/osint-images.tar" ] && echo "true" || echo "false"),
    "uploads": $([ -f "${WORK_DIR}/uploads.tar" ] && echo "true" || echo "false"),
    "artifacts": $([ -f "${WORK_DIR}/artifacts.tar" ] && echo "true" || echo "false"),
    "ha_config": $([ -f "${WORK_DIR}/ha-config.tar" ] && echo "true" || echo "false"),
    "cipher_memory": $([ -f "${WORK_DIR}/cipher-memory.tar" ] && echo "true" || echo "false"),
    "env_files": true,
    "redis": $([ -f "${WORK_DIR}/redis-dump.rdb" ] && echo "true" || echo "false"),
    "private_docs": $([ -f "${WORK_DIR}/private-docs.tar" ] && echo "true" || echo "false"),
    "system_config": $([ -f "${WORK_DIR}/system-config.tar" ] && echo "true" || echo "false"),
    "qdrant": $([ -f "${WORK_DIR}/qdrant-storage.tar" ] && echo "true" || echo "false"),
    "media_stack_config": $([ -f "${WORK_DIR}/media-stack-config.tar" ] && echo "true" || echo "false")
  },
  "sizes": {
    "database": "$(du -sh "${WORK_DIR}/database.dump" 2>/dev/null | cut -f1 || echo '0')",
    "total_uncompressed": "$(du -sh "${WORK_DIR}" | cut -f1)"
  }
}
MANIFEST

# Package into single archive
echo "[*] Compressing backup..."
ARCHIVE="${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"
tar -czf "$ARCHIVE" -C /tmp "ozzu-backup-${TIMESTAMP}"

if [ "$ENCRYPT" = true ]; then
  echo "[*] Encrypting backup..."
  # Use AES-256 with the bridge API key as passphrase
  # Try .env first, fall back to .env.email, fall back to env var
  PASSPHRASE=$(grep '^BRIDGE_API_KEY=' "${PROJECT_ROOT}/backend/.env" 2>/dev/null | cut -d= -f2 || true)
  [ -z "$PASSPHRASE" ] && PASSPHRASE=$(grep '^BRIDGE_API_KEY=' "${PROJECT_ROOT}/backend/.env.email" 2>/dev/null | cut -d= -f2 || true)
  [ -z "$PASSPHRASE" ] && PASSPHRASE="${BRIDGE_API_KEY:-}"
  if [ -z "$PASSPHRASE" ]; then
    echo "  WARNING: No BRIDGE_API_KEY found, skipping encryption"
  else
    openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
      -in "$ARCHIVE" -out "${ARCHIVE}.enc" -pass "pass:${PASSPHRASE}"
    rm "$ARCHIVE"
    ARCHIVE="${ARCHIVE}.enc"
    echo "  Encrypted with AES-256-CBC (PBKDF2)"
  fi
fi

# Cleanup work dir
rm -rf "$WORK_DIR"

# Prune old backups (keep last 7)
echo "[*] Pruning old backups (keeping last 7)..."
ls -t "${BACKUP_DIR}"/ozzu-backup-*.tar.gz* 2>/dev/null | tail -n +8 | xargs -r rm -f

FINAL_SIZE=$(du -sh "$ARCHIVE" | cut -f1)
echo ""
echo "=== Backup Complete ==="
echo "File: ${ARCHIVE}"
echo "Size: ${FINAL_SIZE}"
echo "Checksum: $(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
