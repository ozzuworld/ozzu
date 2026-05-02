#!/bin/bash
# ota-deploy.sh — Build and deploy firmware OTA to all ESP32 nodes
# Usage: ./ota-deploy.sh [--trigger]
# Builds firmware in Docker, copies to Rock Pi OTA server.
# With --trigger: sends UDP broadcast to make nodes update immediately.
# Without --trigger: nodes will pick it up within 30 minutes (or on next reboot).

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$(cd "$SCRIPT_DIR/../../.." && pwd)/scripts/lib/infra.sh"
ROCK_PI="${ROCKPI_USER}@${ROCKPI_LAN}"
SSH_JUMP_FLAG="${ROCKPI_JUMP:+-J $ROCKPI_JUMP}"
SCP_JUMP_FLAG="${ROCKPI_JUMP:+-o ProxyJump=$ROCKPI_JUMP}"
OTA_DIR="/opt/ozzu-ota"
OTA_CMD_PORT=5502
BROADCAST="10.0.50.255"

TRIGGER=false
for arg in "$@"; do
  if [ "$arg" = "--trigger" ]; then TRIGGER=true; fi
done

echo "=== Building firmware ==="
cd "$SCRIPT_DIR/.."
docker run --rm -v "$(pwd)/esp32-csi:/project" -w /project espressif/idf:v5.4.1 \
    bash -c "idf.py build" 2>&1 | tail -5

echo ""
echo "=== Deploying to Rock Pi OTA server ==="
# shellcheck disable=SC2086
scp $SCP_JUMP_FLAG "$SCRIPT_DIR/build/ozzu-room-node.bin" "${ROCK_PI}:${OTA_DIR}/firmware.bin"

if [ "$TRIGGER" = true ]; then
  echo ""
  echo "=== Triggering instant OTA on all nodes ==="
  # Send OTA trigger magic (0x4F544155 = "OTAU") via UDP broadcast
  # shellcheck disable=SC2086
  ssh $SSH_JUMP_FLAG "$ROCK_PI" "python3 -c \"
import socket, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
s.sendto(struct.pack('<I', 0x4F544155), ('${BROADCAST}', ${OTA_CMD_PORT}))
s.close()
print('OTA trigger broadcast sent to ${BROADCAST}:${OTA_CMD_PORT}')
\""
  echo "Nodes will start updating within seconds."
else
  echo ""
  echo "Nodes will update within 30 minutes or on next reboot."
  echo "Use --trigger to force immediate update."
fi

echo ""
echo "=== Done! ==="
