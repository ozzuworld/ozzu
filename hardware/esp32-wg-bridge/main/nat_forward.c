#include "nat_forward.h"

#include "esp_log.h"
#include "lwip/lwip_napt.h"
#include "lwip/netif.h"

static const char *TAG = "nat_forward";

esp_err_t nat_forward_enable(struct netif *wg_netif) {
    if (!wg_netif) {
        ESP_LOGE(TAG, "wg_netif is NULL");
        return ESP_FAIL;
    }

    ip_napt_enable_netif(wg_netif, 1);
    ESP_LOGI(TAG, "NAPT flag set on WG netif %c%c%d (internal/LAN side)",
             wg_netif->name[0], wg_netif->name[1], wg_netif->num);

    return ESP_OK;
}
