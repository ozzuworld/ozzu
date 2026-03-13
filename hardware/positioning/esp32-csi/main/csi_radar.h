// csi_radar.h — WiFi CSI-based room presence and motion detection
// Uses Espressif's esp-radar component under the hood
#pragma once

#include "config.h"
#include "protocol.h"

// Initialize CSI capture on the connected WiFi station interface
void csi_radar_init(const node_config_t *cfg);

// Start the CSI processing task (runs in background, sends reports via UDP)
void csi_radar_start(void);

// Get latest presence state (thread-safe)
void csi_radar_get_state(csi_report_t *out);
