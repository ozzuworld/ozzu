// config.h — Node configuration (stored in NVS, overridable at runtime)
#pragma once

#include <stdint.h>
#include <stdbool.h>

// Node identity
#define MAX_ROOM_NAME_LEN 32
#define MAX_SSID_LEN      32
#define MAX_PASS_LEN      64

typedef struct {
    char     room_name[MAX_ROOM_NAME_LEN];   // e.g., "kitchen", "bedroom", "living"
    uint8_t  node_id;                         // 1-255, unique per node
    char     wifi_ssid[MAX_SSID_LEN];         // AP to connect to (for CSI capture)
    char     wifi_pass[MAX_PASS_LEN];
    char     hub_ip[16];                       // Rock Pi hub IP (UDP target)
    uint16_t hub_port;                         // UDP port (default 5500)
    uint16_t csi_report_interval_ms;           // How often to send CSI summary (default 500)
    uint16_t ble_scan_interval_ms;             // BLE scan window (default 3000)
    bool     ble_enabled;
    bool     csi_enabled;
} node_config_t;

// Default config — overridden by NVS
#define DEFAULT_HUB_PORT              5500
#define DEFAULT_CSI_REPORT_INTERVAL   500
#define DEFAULT_BLE_SCAN_INTERVAL     3000

// Load config from NVS, or use defaults
void config_init(node_config_t *cfg);

// Save config to NVS
void config_save(const node_config_t *cfg);
