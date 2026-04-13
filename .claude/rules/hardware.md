---
paths:
  - "hardware/**"
---

# Hardware / Positioning

## Indoor Positioning System
- 3 ESP32 nodes deployed → WiFi AP on Rock Pi (10.0.50.1) → hub.py → bridge /positioning/
- CSI (Channel State Information) based positioning
- Config: `hardware/positioning/esp32-csi/nvs-configs/`

## Rock Pi
- SSH: `root@172.168.0.55`
- NOT on VPN — reach via r605 iroute (192.168.2.0/24 → 10.8.0.2)
- Runs: WiFi AP (10.0.50.1), hub.py, OTA server for ESP32 nodes

## ESP32 Firmware
- Build: `cd hardware/positioning/esp32-csi && idf.py build`
- OTA push to nodes via Rock Pi
- USB flash Node 3 via dev-01 (physically connected)

## BLE IRK
- DO NOT attempt ESP32 BLE pairing — failed 55+ times over full day
- Use dev-01 BlueZ stack instead if BLE enrollment is needed

## Autojoint
- Hardware in `hardware/autojoint/` — separate subsystem
