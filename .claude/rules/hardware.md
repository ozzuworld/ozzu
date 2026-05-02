---
paths:
  - "hardware/**"
---

# Hardware / Positioning

> **Infra facts (Rock Pi IP / SSH path, ESP32 node IPs, dev-01 access) live in `~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md` — read it before assuming any address. This file describes hardware/firmware architecture only.**

## Indoor Positioning System
- 3 ESP32 nodes deployed → WiFi AP on Rock Pi → hub.py → bridge /positioning/
- CSI (Channel State Information) based positioning
- Config: `hardware/positioning/esp32-csi/nvs-configs/`

## Rock Pi
- See registry §1 (Rock Pi 4B) and §2 (How to reach devices from GCP) for the current SSH path.
  As of 2026-05-02, Rock Pi is **not** a WG peer; reach it via `ssh -J dev-01 root@172.168.0.55` (LAN jump). The old r605-iroute-over-OpenVPN path is gone (OpenVPN decommissioned).
- Runs: WiFi AP, hub.py, OTA server for ESP32 nodes

## ESP32 Firmware
- Build: `cd hardware/positioning/esp32-csi && idf.py build`
- OTA push to nodes via Rock Pi
- USB flash Node 3 via dev-01 (physically connected)

## BLE IRK
- DO NOT attempt ESP32 BLE pairing — failed 55+ times over full day
- Use dev-01 BlueZ stack instead if BLE enrollment is needed

## Autojoint
- Hardware in `hardware/autojoint/` — separate subsystem
