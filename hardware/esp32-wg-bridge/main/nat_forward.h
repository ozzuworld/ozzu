#pragma once

#include "esp_err.h"
#include "esp_netif.h"
#include "lwip/netif.h"

// Flag the WG netif as the internal LAN side. In ESP-IDF's NAPT semantics,
// napt=1 marks the LAN (clients) and the OPPOSITE netif (uplink, here STA)
// then performs SNAT on outbound and reverse-NAT on inbound. STA's IP
// becomes the externally-visible source for any traffic transiting from WG.
esp_err_t nat_forward_enable(struct netif *wg_netif);
