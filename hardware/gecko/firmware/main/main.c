#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "behavior.h"
#include "wifi_burst.h"

static const char *TAG = "gecko";

// WiFi credentials (stored in NVS after first config)
#define WIFI_SSID       CONFIG_GECKO_WIFI_SSID
#define WIFI_PASS       CONFIG_GECKO_WIFI_PASS
#define BRIDGE_HOST     CONFIG_GECKO_BRIDGE_HOST

void app_main(void) {
    ESP_LOGI(TAG, "");
    ESP_LOGI(TAG, "  🦎 GECKO RECON UNIT");
    ESP_LOGI(TAG, "  Firmware v0.1.0");
    ESP_LOGI(TAG, "  SMA: 3x 0.050mm Nitinol");
    ESP_LOGI(TAG, "  Adhesion: Gecko dry adhesive");
    ESP_LOGI(TAG, "");

    // Init NVS for WiFi credential storage
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }

    // Init WiFi burst (radio starts off)
    wifi_burst_init(WIFI_SSID, WIFI_PASS, BRIDGE_HOST);

    // Init behavior controller (inits all sensors + locomotion)
    behavior_init();

    // Run main behavior loop (never returns)
    behavior_run();
}
