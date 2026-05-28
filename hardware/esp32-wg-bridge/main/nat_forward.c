#include "nat_forward.h"

#include "esp_log.h"
#include "lwip/lwip_napt.h"
#include "lwip/netif.h"

static const char *TAG = "nat_forward";

// DIAGNOSTIC: skip NAPT entirely to confirm WG handshake works in isolation.
// We'll re-enable NAPT once handshake is stable end-to-end again.
esp_err_t nat_forward_enable(struct netif *wg_netif) {
    (void)wg_netif;
    ESP_LOGW(TAG, "NAPT disabled (diagnostic) — handshake-only test");
    return ESP_OK;
}
