// ota_update.h — Over-the-air firmware update via HTTP
#pragma once

#include "config.h"

// Start OTA check task (runs periodically in background)
void ota_update_init(const node_config_t *cfg);
