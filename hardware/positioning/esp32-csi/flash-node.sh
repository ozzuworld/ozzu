#!/bin/bash
# flash-node.sh — Flash and configure an ESP32-S3 room node
# Usage: ./flash-node.sh <node_id> <room_name> <wifi_ssid> <wifi_pass> [hub_ip]
#
# Example: ./flash-node.sh 1 kitchen "MyWiFi" "password123" 10.0.50.1
#
# hub_ip defaults to the Rock Pi's hostapd AP IP (10.0.50.1) — the address
# ESP32 nodes see when they associate to the ozzu-nodes SSID.
#
# Prerequisites:
#   - ESP-IDF v5.1+ installed and sourced (. $IDF_PATH/export.sh)
#   - ESP32-S3 connected via USB
#   - esp-radar component will be auto-downloaded on first build

set -e

NODE_ID="${1:?Usage: $0 <node_id> <room_name> <wifi_ssid> <wifi_pass> [hub_ip]}"
ROOM_NAME="${2:?Missing room_name}"
WIFI_SSID="${3:?Missing wifi_ssid}"
WIFI_PASS="${4:?Missing wifi_pass}"
HUB_IP="${5:-10.0.50.1}"
HUB_PORT="${6:-5500}"
PORT="${IDF_PORT:-/dev/ttyUSB0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Ozzu Room Node Flash ==="
echo "  Node ID:    $NODE_ID"
echo "  Room:       $ROOM_NAME"
echo "  WiFi SSID:  $WIFI_SSID"
echo "  Hub:        $HUB_IP:$HUB_PORT"
echo "  Serial:     $PORT"
echo ""

# Build
echo "Building firmware..."
idf.py set-target esp32s3
idf.py build

# Flash
echo "Flashing..."
idf.py -p "$PORT" flash

# Write NVS config
echo "Writing node configuration to NVS..."
python3 - <<PYEOF
import subprocess, sys

nvs_cmds = [
    f'nvs_set ozzu_node room_name str "{ROOM_NAME}"',
    f'nvs_set ozzu_node node_id u8 {NODE_ID}',
    f'nvs_set ozzu_node wifi_ssid str "{WIFI_SSID}"',
    f'nvs_set ozzu_node wifi_pass str "{WIFI_PASS}"',
    f'nvs_set ozzu_node hub_ip str "{HUB_IP}"',
    f'nvs_set ozzu_node hub_port u16 {HUB_PORT}',
    f'nvs_set ozzu_node csi_interval u16 500',
    f'nvs_set ozzu_node ble_interval u16 3000',
    f'nvs_set ozzu_node ble_enabled u8 1',
    f'nvs_set ozzu_node csi_enabled u8 1',
]

# Use idf.py monitor's NVS commands via serial
# Alternative: generate NVS partition binary and flash it
import os
nvs_csv = os.path.join(os.path.dirname(os.path.abspath("__file__")), "nvs_config.csv")
with open(nvs_csv, "w") as f:
    f.write("key,type,encoding,value\\n")
    f.write("ozzu_node,namespace,,\\n")
    f.write(f'room_name,data,string,"{ROOM_NAME}"\\n')
    f.write(f"node_id,data,u8,{NODE_ID}\\n")
    f.write(f'wifi_ssid,data,string,"{WIFI_SSID}"\\n')
    f.write(f'wifi_pass,data,string,"{WIFI_PASS}"\\n')
    f.write(f'hub_ip,data,string,"{HUB_IP}"\\n')
    f.write(f"hub_port,data,u16,{HUB_PORT}\\n")
    f.write(f"csi_interval,data,u16,500\\n")
    f.write(f"ble_interval,data,u16,3000\\n")
    f.write(f"ble_enabled,data,u8,1\\n")
    f.write(f"csi_enabled,data,u8,1\\n")
print(f"NVS CSV written to {nvs_csv}")

# Generate NVS binary
subprocess.run([
    sys.executable, "-m", "esp_idf_nvs_generator",
    "generate", nvs_csv, "nvs_config.bin", "0x6000"
], check=True)
print("NVS binary generated")

# Flash NVS partition
subprocess.run([
    "esptool.py", "--port", "${PORT}", "write_flash", "0x9000", "nvs_config.bin"
], check=True)
print("NVS partition flashed")
PYEOF

echo ""
echo "=== Done! Node $NODE_ID ($ROOM_NAME) flashed and configured ==="
echo "Reset the board to start. Monitor with: idf.py -p $PORT monitor"
