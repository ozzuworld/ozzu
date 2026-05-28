#pragma once

#include "esp_err.h"
#include "esp_netif.h"

// Enable SNAT on the STA netif. Packets arriving from another netif (the WG
// tunnel) get masqueraded to the STA's IP on the way out to the target LAN.
esp_err_t nat_forward_enable(esp_netif_t *sta_netif);
