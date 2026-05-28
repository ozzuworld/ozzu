#include "esp_log.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "lwip/inet.h"
#include <string.h>

#include "wifi_sta.h"
#include "wg_client.h"
#include "nat_forward.h"

// Send a tiny UDP probe through the WG tunnel — forces ESP32 to initiate
// the WireGuard handshake. Without this, the chip waits passively forever
// while the bridge's handshakes hit a stale NAT mapping on the home router.
static void wg_handshake_kick(void) {
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0) return;
    struct sockaddr_in dst = {0};
    dst.sin_family = AF_INET;
    dst.sin_port = htons(1);
    dst.sin_addr.s_addr = inet_addr("10.9.0.1");
    const char *probe = "wg-kick";
    sendto(s, probe, strlen(probe), 0, (struct sockaddr *)&dst, sizeof(dst));
    close(s);
}

static const char *TAG = "esp32-wg-bridge";

void app_main(void) {
    ESP_LOGI(TAG, "boot: esp32-wg-bridge");

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    esp_netif_t *sta_netif = NULL;
    ESP_ERROR_CHECK(wifi_sta_start(&sta_netif));
    wifi_sta_wait_connected();
    ESP_LOGI(TAG, "STA connected");

    ESP_ERROR_CHECK(wg_client_start());

    // Give the tunnel a moment to come up before turning on forwarding
    vTaskDelay(pdMS_TO_TICKS(2000));

    struct netif *wg_netif = wg_client_get_netif();
    ESP_LOGI(TAG, "wg_netif handle = %p", wg_netif);
    if (wg_netif) {
        ESP_LOGI(TAG, "wg_netif name=%c%c%d, flags=0x%02x, up=%d",
                 wg_netif->name[0], wg_netif->name[1], wg_netif->num,
                 wg_netif->flags, netif_is_up(wg_netif));
    }
    esp_err_t nat_err = nat_forward_enable(wg_netif);
    ESP_LOGI(TAG, "nat_forward_enable returned %d (0=ESP_OK)", nat_err);
    (void)sta_netif;
    ESP_LOGI(TAG, "bridge active — forwarding WG -> STA with SNAT");

    // Trigger initial WG handshake every 5s until the bridge starts logging
    // an "alive" message (which means handshakes completed and we're idle).
    int kicks = 0;
    while (kicks < 6) {
        wg_handshake_kick();
        ESP_LOGI(TAG, "wg handshake kick %d", ++kicks);
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(30000));
        wg_handshake_kick();
        ESP_LOGI(TAG, "alive");
    }
}
