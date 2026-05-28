#include "esp_log.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "wifi_sta.h"
#include "wg_client.h"
#include "nat_forward.h"

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

    ESP_ERROR_CHECK(nat_forward_enable(sta_netif));
    ESP_LOGI(TAG, "bridge active — forwarding WG -> STA with SNAT");

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(60000));
        ESP_LOGI(TAG, "alive");
    }
}
