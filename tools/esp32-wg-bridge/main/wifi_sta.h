#pragma once

#include "esp_err.h"
#include "esp_netif.h"

esp_err_t wifi_sta_start(esp_netif_t **out_netif);

void wifi_sta_wait_connected(void);
