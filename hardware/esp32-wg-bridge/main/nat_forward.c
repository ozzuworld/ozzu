#include "nat_forward.h"

#include "esp_log.h"
#include "esp_netif_net_stack.h"
#include "lwip/lwip_napt.h"
#include "lwip/netif.h"

static const char *TAG = "nat_forward";

esp_err_t nat_forward_enable(esp_netif_t *sta_netif) {
    struct netif *sta = esp_netif_get_netif_impl(sta_netif);
    if (!sta) {
        ESP_LOGE(TAG, "could not resolve STA lwIP netif");
        return ESP_FAIL;
    }

    ip_napt_enable_netif(sta, 1);
    ESP_LOGI(TAG, "NAPT enabled on STA netif %c%c%d", sta->name[0], sta->name[1], sta->num);

    return ESP_OK;
}
