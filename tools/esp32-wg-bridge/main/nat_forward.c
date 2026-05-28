#include "nat_forward.h"

#include "esp_log.h"
#include "lwip/lwip_napt.h"
#include "lwip/netif.h"

static const char *TAG = "nat_forward";

// ESP-IDF NAPT semantics: napt=1 marks the LAN side. For this bridge, the
// LAN side is the WireGuard netif (where dev-01/bridge sit as "clients").
// The uplink is the WiFi STA netif. Outbound packets on the non-napt netif
// (STA) get their src IP rewritten to the STA IP via ip_napt_forward.
esp_err_t nat_forward_enable(struct netif *wg_netif) {
    if (!wg_netif) {
        ESP_LOGE(TAG, "wg_netif is NULL");
        return ESP_FAIL;
    }

    ip_napt_enable_netif(wg_netif, 1);
    ESP_LOGI(TAG, "NAPT enabled on WG netif %c%c%d (LAN side)",
             wg_netif->name[0], wg_netif->name[1], wg_netif->num);

    return ESP_OK;
}
