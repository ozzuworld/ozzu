#!/bin/bash
# pair-device.sh — Trigger BLE pairing mode on ESP32 nodes
# Usage: ./pair-device.sh [node_ip] [timeout_sec]
#
# Examples:
#   ./pair-device.sh                    # Broadcast to all nodes (60s timeout)
#   ./pair-device.sh 10.0.50.21        # Specific node, 60s timeout
#   ./pair-device.sh 10.0.50.21 120    # Specific node, 120s timeout
#   ./pair-device.sh broadcast 90      # All nodes, 90s timeout

set -e

TARGET="${1:-broadcast}"
TIMEOUT="${2:-60}"
CMD_PORT=5502

# "PAIR" magic = 0x50414952 (little-endian)
PAIR_MAGIC="\x52\x49\x41\x50"
TIMEOUT_LE=$(printf '\\x%02x\\x%02x' $((TIMEOUT & 0xFF)) $(((TIMEOUT >> 8) & 0xFF)))

PAYLOAD="${PAIR_MAGIC}${TIMEOUT_LE}"

if [ "$TARGET" = "broadcast" ]; then
    echo "Broadcasting PAIR command to all nodes (timeout=${TIMEOUT}s)..."
    echo -ne "$PAYLOAD" | socat - UDP-DATAGRAM:10.0.50.255:${CMD_PORT},broadcast
else
    echo "Sending PAIR command to ${TARGET} (timeout=${TIMEOUT}s)..."
    echo -ne "$PAYLOAD" | socat - UDP-SENDTO:${TARGET}:${CMD_PORT}
fi

echo ""
echo "Pairing mode active for ${TIMEOUT}s."
echo "On your iPhone:"
echo "  1. Open Settings → Bluetooth"
echo "  2. Look for 'Ozzu-Node-X' in Other Devices"
echo "  3. Tap to pair"
echo ""
echo "Once paired, the node extracts the IRK and distributes it"
echo "to all other nodes automatically."
