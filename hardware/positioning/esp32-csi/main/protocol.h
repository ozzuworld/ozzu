// protocol.h — Binary UDP packet format between ESP32 nodes and Rock Pi hub
// Keep this in sync with hub/protocol.py
#pragma once

#include <stdint.h>

// Magic bytes for packet identification
#define OZZU_MAGIC_CSI  0x4F5A4301  // "OZC\x01"
#define OZZU_MAGIC_BLE  0x4F5A4201  // "OZB\x01"
#define OZZU_MAGIC_IRK  0x4F5A4B01  // "OZK\x01" — IRK key exchange

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

// ── IRK key exchange (for resolving iOS randomized MACs) ──
// Sent after pairing extracts IRK, or from hub to sync IRKs across nodes

#define IRK_LEN  16
#define MAX_TRACKED_IRKS  8

// Direction: node → hub (after pairing) or hub → node (sync)
typedef struct __attribute__((packed)) {
    uint32_t magic;           // OZZU_MAGIC_IRK
    uint8_t  node_id;         // originating node
    uint8_t  action;          // 0=report_new, 1=sync_from_hub, 2=request_pair_mode
    uint8_t  irk_count;       // number of IRK entries (1 for report, N for sync)
    uint8_t  _reserved;
    // Followed by irk_count * irk_entry_t
} irk_header_t;

typedef struct __attribute__((packed)) {
    uint8_t  irk[IRK_LEN];   // 128-bit Identity Resolving Key
    uint8_t  addr[6];         // identity address (real MAC from bond)
    uint8_t  addr_type;       // 0=public, 1=random static
    uint8_t  _reserved;
    char     label[16];       // human label, e.g., "kk_iphone"
} irk_entry_t;

// IRK actions
#define IRK_ACTION_REPORT     0  // node extracted IRK from pairing → send to hub
#define IRK_ACTION_SYNC       1  // hub distributing IRK to all nodes
#define IRK_ACTION_PAIR_MODE  2  // hub tells node to enter pairing mode

// UDP command port for pairing trigger (reuse OTA port)
#define OZZU_CMD_PORT  5502
#define OZZU_CMD_PAIR  0x50414952  // "PAIR" — enter pairing mode
