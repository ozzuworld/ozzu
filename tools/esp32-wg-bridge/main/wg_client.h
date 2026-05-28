#pragma once

#include "esp_err.h"
#include "lwip/netif.h"

esp_err_t wg_client_start(void);

// After wg_client_start, returns the lwIP netif handle for the WG tunnel.
// Used by nat_forward to flag the WG side as the internal/LAN netif.
struct netif *wg_client_get_netif(void);
