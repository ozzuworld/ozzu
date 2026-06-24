---
paths:
  - "hardware/**"
---

# Hardware / Positioning

> **Infra facts (Rock Pi IP / SSH path, ESP32 node IPs, dev-01 access) live in `~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md` — read it before assuming any address. This file describes hardware/firmware architecture only.**

## Indoor Positioning System
- 3 ESP32 nodes were deployed for CSI positioning — **decommissioned** with the Colombia LAN (2026-04-09)
- Config: `hardware/positioning/esp32-csi/nvs-configs/`

## Rock Pi 4B
- **IS a WG peer** (10.9.0.21) since 2026-05-28 — configured as portable WG bridge
- wpa_supplicant has FAMILIA SUAREZ + EDIFICIO LAURA WiFi configs
- Boot-to-tunnel ~60-70s
- Direct SSH: `ssh root@10.9.0.21` (over WG)

## ESP32 Firmware
- Build: `cd hardware/positioning/esp32-csi && idf.py build`
- ESP32 positioning nodes decommissioned with Colombia LAN

## BLE IRK
- DO NOT attempt ESP32 BLE pairing — failed 55+ times over full day
- Use dev-01 BlueZ stack instead if BLE enrollment is needed

## Autojoint
- Hardware in `hardware/autojoint/` — separate subsystem
