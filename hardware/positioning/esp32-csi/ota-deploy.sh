#!/bin/bash
# ota-deploy.sh — Build and deploy firmware OTA to all ESP32 nodes
# Usage: ./ota-deploy.sh [--trigger]
# Builds firmware in Docker, copies to Rock Pi OTA server.
# With --trigger: sends UDP broadcast to make nodes update immediately.
# Without --trigger: nodes will pick it up within 30 minutes (or on next reboot).

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROCK_PI="root@172.168.0.55"
OTA_DIR="/opt/ozzu-positioning/ota"
OTA_CMD_PORT=5502
BROADCAST="10.0.50.255"

TRIGGER=false
for arg in "$@"; do
  if [ "$arg" = "--trigger" ]; then TRIGGER=true; fi
done

echo "=== Building firmware ==="
cd "$SCRIPT_DIR/.."
docker run --rm -v "$(pwd)/esp32-csi:/project" -w /project espressif/idf:v5.2.3 \
    bash -c "idf.py build" 2>&1 | tail -5

echo ""
echo "=== Deploying to Rock Pi OTA server ==="
scp "$SCRIPT_DIR/build/ozzu-room-node.bin" "${ROCK_PI}:${OTA_DIR}/firmware.bin"

if [ "$TRIGGER" = true ]; then
  echo ""
  echo "=== Triggering instant OTA on all nodes ==="
  # Send OTA trigger magic (0x4F544155 = "OTAU") via UDP broadcast
  ssh "$ROCK_PI" "python3 -c \"
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
