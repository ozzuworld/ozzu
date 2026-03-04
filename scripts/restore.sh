#!/bin/bash
# restore.sh — Restore ozzu from encrypted backup
# Usage: ./scripts/restore.sh <backup-file> [--components db,uploads,osint,artifacts,ha,env,redis]
#
# Restores any combination of:
#   db        - PostgreSQL database
#   uploads   - Business attachments
#   osint     - OSINT images
#   artifacts - Build artifacts (IPA/APK)
#   ha        - Home Assistant config
#   env       - Environment files
#   redis     - Redis data
#
# Default: restores ALL components

set -euo pipefail

PROJECT_ROOT="/home/gcp/ozzu"
BACKUP_FILE=""
COMPONENTS="all"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --components) COMPONENTS="$2"; shift 2 ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *) BACKUP_FILE="$1"; shift ;;
  esac
done

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 <backup-file> [--components db,uploads,osint,artifacts,ha,env,redis]"
  echo ""
  echo "Available backups:"
  ls -lh "${PROJECT_ROOT}/backups/"ozzu-backup-*.tar.gz* 2>/dev/null || echo "  (none found in ${PROJECT_ROOT}/backups/)"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: Backup file not found: $BACKUP_FILE"
  exit 1
fi

WORK_DIR="/tmp/ozzu-restore-$$"
mkdir -p "$WORK_DIR"
trap "rm -rf $WORK_DIR" EXIT

echo "=== Ozzu Restore ==="
echo "Backup: $BACKUP_FILE"
echo "Components: $COMPONENTS"
echo ""

# Decrypt if needed
ARCHIVE="$BACKUP_FILE"
if [[ "$BACKUP_FILE" == *.enc ]]; then
  echo "[*] Decrypting backup..."
  PASSPHRASE=$(grep '^BRIDGE_API_KEY=' "${PROJECT_ROOT}/backend/.env" | cut -d= -f2)
  if [ -z "$PASSPHRASE" ]; then
    echo "Error: BRIDGE_API_KEY not found in backend/.env — needed for decryption"
    exit 1
  fi
  ARCHIVE="${WORK_DIR}/decrypted.tar.gz"
  openssl enc -aes-256-cbc -d -salt -pbkdf2 -iter 100000 \
    -in "$BACKUP_FILE" -out "$ARCHIVE" -pass "pass:${PASSPHRASE}"
fi

# Extract
echo "[*] Extracting archive..."
tar -xzf "$ARCHIVE" -C "$WORK_DIR"
BACKUP_CONTENT=$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)

if [ -z "$BACKUP_CONTENT" ]; then
  echo "Error: No backup content found in archive"
  exit 1
fi

# Show manifest
if [ -f "${BACKUP_CONTENT}/manifest.json" ]; then
  echo ""
  echo "Backup manifest:"
  cat "${BACKUP_CONTENT}/manifest.json" | python3 -m json.tool 2>/dev/null || cat "${BACKUP_CONTENT}/manifest.json"
  echo ""
fi

should_restore() {
  [ "$COMPONENTS" = "all" ] && return 0
  echo ",$COMPONENTS," | grep -q ",$1," && return 0
  return 1
}

# 1. PostgreSQL
if should_restore "db" && [ -f "${BACKUP_CONTENT}/database.dump" ]; then
  echo "[1/7] Restoring PostgreSQL database..."
  echo "  WARNING: This will overwrite the current database!"

  # Drop and recreate
  PGPASSWORD=ozzu_pg_s3cure dropdb -h 127.0.0.1 -U ozzu --if-exists ozzu 2>/dev/null || \
    docker exec $(docker ps -qf "name=postgres" | head -1) dropdb -U ozzu --if-exists ozzu

  PGPASSWORD=ozzu_pg_s3cure createdb -h 127.0.0.1 -U ozzu ozzu 2>/dev/null || \
    docker exec $(docker ps -qf "name=postgres" | head -1) createdb -U ozzu ozzu

  PGPASSWORD=ozzu_pg_s3cure pg_restore -h 127.0.0.1 -U ozzu -d ozzu --no-owner --no-acl "${BACKUP_CONTENT}/database.dump" 2>/dev/null || {
    docker cp "${BACKUP_CONTENT}/database.dump" $(docker ps -qf "name=postgres" | head -1):/tmp/database.dump
    docker exec $(docker ps -qf "name=postgres" | head -1) pg_restore -U ozzu -d ozzu --no-owner --no-acl /tmp/database.dump
  }
  echo "  Database restored"
else
  echo "[1/7] Skipping PostgreSQL (not selected or dump missing)"
fi

# 2. OSINT images
if should_restore "osint" && [ -f "${BACKUP_CONTENT}/osint-images.tar" ]; then
  echo "[2/7] Restoring OSINT images..."
  mkdir -p /tmp/ozzu-bridge
  tar -xf "${BACKUP_CONTENT}/osint-images.tar" -C /tmp/ozzu-bridge
  echo "  OSINT images restored to /tmp/ozzu-bridge/osint-images/"
else
  echo "[2/7] Skipping OSINT images"
fi

# 3. Business uploads
if should_restore "uploads" && [ -f "${BACKUP_CONTENT}/uploads.tar" ]; then
  echo "[3/7] Restoring business attachments..."
  mkdir -p /tmp/ozzu-bridge
  tar -xf "${BACKUP_CONTENT}/uploads.tar" -C /tmp/ozzu-bridge
  echo "  Uploads restored to /tmp/ozzu-bridge/uploads/"
else
  echo "[3/7] Skipping business attachments"
fi

# 4. Build artifacts
if should_restore "artifacts" && [ -f "${BACKUP_CONTENT}/artifacts.tar" ]; then
  echo "[4/7] Restoring build artifacts..."
  tar -xf "${BACKUP_CONTENT}/artifacts.tar" -C "${PROJECT_ROOT}"
  echo "  Artifacts restored to ${PROJECT_ROOT}/artifacts/"
else
  echo "[4/7] Skipping build artifacts"
fi

# 5. Home Assistant config
if should_restore "ha" && [ -f "${BACKUP_CONTENT}/ha-config.tar" ]; then
  echo "[5/7] Restoring Home Assistant config..."
  echo "  Stopping Home Assistant container..."
  docker stop $(docker ps -qf "name=homeassistant" 2>/dev/null) 2>/dev/null || true
  tar -xf "${BACKUP_CONTENT}/ha-config.tar" -C "${PROJECT_ROOT}/backend/"
  echo "  Restarting Home Assistant..."
  docker start $(docker ps -aqf "name=homeassistant" 2>/dev/null) 2>/dev/null || true
  echo "  HA config restored"
else
  echo "[5/7] Skipping Home Assistant config"
fi

# 6. Environment files
if should_restore "env" && [ -d "${BACKUP_CONTENT}/env" ]; then
  echo "[6/7] Restoring environment files..."
  [ -f "${BACKUP_CONTENT}/env/backend.env" ] && cp "${BACKUP_CONTENT}/env/backend.env" "${PROJECT_ROOT}/backend/.env"
  [ -f "${BACKUP_CONTENT}/env/frontend.env.local" ] && cp "${BACKUP_CONTENT}/env/frontend.env.local" "${PROJECT_ROOT}/frontend/.env.local"
  [ -f "${BACKUP_CONTENT}/env/frontend.env" ] && cp "${BACKUP_CONTENT}/env/frontend.env" "${PROJECT_ROOT}/frontend/.env"
  echo "  Env files restored"
else
  echo "[6/7] Skipping environment files"
fi

# 7. Redis
if should_restore "redis" && [ -f "${BACKUP_CONTENT}/redis-dump.rdb" ]; then
  echo "[7/7] Restoring Redis data..."
  REDIS_CONTAINER=$(docker ps -qf "name=redis" | head -1)
  if [ -n "$REDIS_CONTAINER" ]; then
    docker cp "${BACKUP_CONTENT}/redis-dump.rdb" "${REDIS_CONTAINER}:/data/dump.rdb"
    [ -f "${BACKUP_CONTENT}/redis-appendonly.aof" ] && \
      docker cp "${BACKUP_CONTENT}/redis-appendonly.aof" "${REDIS_CONTAINER}:/data/appendonly.aof"
    docker restart "$REDIS_CONTAINER"
    echo "  Redis data restored and container restarted"
  else
    echo "  Redis container not found — skipping"
  fi
else
  echo "[7/7] Skipping Redis"
fi

echo ""
echo "=== Restore Complete ==="
echo "You may need to restart services: docker compose restart bridge"
