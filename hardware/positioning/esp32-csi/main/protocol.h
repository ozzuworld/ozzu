// protocol.h — Binary UDP packet format between ESP32 nodes and Rock Pi hub
// Keep this in sync with hub/protocol.py
#pragma once

#include <stdint.h>

// Magic bytes for packet identification
#define OZZU_MAGIC_CSI  0x4F5A4301  // "OZC\x01"
#define OZZU_MAGIC_BLE  0x4F5A4201  // "OZB\x01"

// ── CSI presence report (sent every csi_report_interval_ms) ──
// Total: 20 bytes fixed header
typedef struct __attribute__((packed)) {
    uint32_t magic;           // OZZU_MAGIC_CSI
    uint8_t  node_id;
    uint8_t  presence;        // 0=empty, 1=static(person still), 2=moving
    uint8_t  motion_level;    // 0-255 amplitude of motion
    uint8_t  confidence;      // 0-100 confidence in presence detection
    int8_t   rssi;            // WiFi RSSI to AP
    uint8_t  _reserved[3];
    uint32_t uptime_sec;      // node uptime
    uint32_t seq;             // sequence number
} csi_report_t;

// Presence states
#define PRESENCE_EMPTY   0
#define PRESENCE_STATIC  1
#define PRESENCE_MOVING  2

// ── BLE sighting report (sent per scan cycle) ──
// Variable length: 12-byte header + N * 10-byte entries
typedef struct __attribute__((packed)) {
    uint32_t magic;           // OZZU_MAGIC_BLE
    uint8_t  node_id;
    uint8_t  device_count;    // number of BLE devices in this report
    uint16_t scan_duration_ms;
    uint32_t seq;
    // Followed by device_count * ble_device_t entries
} ble_report_header_t;

typedef struct __attribute__((packed)) {
    uint8_t  addr[6];         // BLE MAC address
    int8_t   rssi;            // signal strength
    uint8_t  addr_type;       // 0=public, 1=random
    uint16_t _reserved;
} ble_device_t;

// Max BLE devices per report (keep UDP under MTU)
#define MAX_BLE_DEVICES_PER_REPORT  50
