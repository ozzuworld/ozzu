// ble_scanner.h — BLE passive scanner for phone RSSI tracking
#pragma once

#include "config.h"

// Initialize NimBLE scanner
void ble_scanner_init(const node_config_t *cfg);

// Start scanning (runs in background, sends BLE reports via UDP)
void ble_scanner_start(void);
