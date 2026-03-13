// ble_scanner.h — BLE scanner + IRK enrollment for iOS device tracking
#pragma once

#include "config.h"

// Initialize NimBLE scanner
void ble_scanner_init(const node_config_t *cfg);

// Start scanning (runs in background, sends BLE reports via UDP)
void ble_scanner_start(void);

// Enter pairing mode — advertise as peripheral, accept bonding from phone.
// Extracts IRK on successful pairing. Exits back to scanning after timeout_sec.
void ble_scanner_enter_pair_mode(uint16_t timeout_sec);

// Load an IRK received from hub (for resolving addresses during scan)
// Returns true if added successfully.
bool ble_scanner_add_irk(const uint8_t irk[16], const uint8_t addr[6],
                         uint8_t addr_type, const char *label);

// Check if we're currently in pairing mode
bool ble_scanner_is_pairing(void);

// Get number of stored IRKs
int ble_scanner_irk_count(void);
