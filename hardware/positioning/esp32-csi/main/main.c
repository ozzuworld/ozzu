// main.c — Ozzu Room Node: WiFi CSI presence + BLE scanner
// ESP32 firmware for indoor positioning system
// Reports to Rock Pi hub via UDP binary packets

#include <inttypes.h>
#include <string.h>
#include "config.h"
#include "csi_radar.h"
#include "ble_scanner.h"
#include "udp_sender.h"
#include "ota_update.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

static const char *TAG = "main";

static EventGroupHandle_t _wifi_events;
#define WIFI_CONNECTED_BIT BIT0

static node_config_t _cfg;

// ── WiFi event handler ──

static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t event_id, void *event_data) {
    if (base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_STA_START:
                esp_wifi_connect();
                break;
            case WIFI_EVENT_STA_DISCONNECTED:
                ESP_LOGW(TAG, "WiFi disconnected — reconnecting...");
                vTaskDelay(pdMS_TO_TICKS(1000));
                esp_wifi_connect();
                break;
        }
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(_wifi_events, WIFI_CONNECTED_BIT);
    }
}

static void wifi_init_sta(void) {
    _wifi_events = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t wifi_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wifi_cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    wifi_config_t sta_cfg = {};
    strncpy((char *)sta_cfg.sta.ssid, _cfg.wifi_ssid, sizeof(sta_cfg.sta.ssid) - 1);
    strncpy((char *)sta_cfg.sta.password, _cfg.wifi_pass, sizeof(sta_cfg.sta.password) - 1);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "Connecting to WiFi '%s'...", _cfg.wifi_ssid);

    // Wait for connection (30s timeout)
    EventBits_t bits = xEventGroupWaitBits(_wifi_events, WIFI_CONNECTED_BIT,
                                            pdFALSE, pdTRUE, pdMS_TO_TICKS(30000));
    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "WiFi connected");
    } else {
        ESP_LOGE(TAG, "WiFi connection timeout — will keep retrying in background");
    }
}

// ── Status LED blink (optional — uses built-in LED if available) ──

static void status_task(void *arg) {
    while (1) {
        csi_report_t state;
        csi_radar_get_state(&state);

        const char *presence_str = state.presence == PRESENCE_MOVING ? "MOVING" :
                                   state.presence == PRESENCE_STATIC ? "STATIC" : "EMPTY";

        ESP_LOGI(TAG, "[%s] node=%d presence=%s confidence=%d%% motion=%d rssi=%d seq=%" PRIu32,
                 _cfg.room_name, _cfg.node_id, presence_str,
                 state.confidence, state.motion_level, state.rssi, state.seq);

        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

// ── Entry point ──

void app_main(void) {
    ESP_LOGI(TAG, "=== Ozzu Room Node v1.0 ===");

    // Initialize NVS
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // Load config
    config_init(&_cfg);
    ESP_LOGI(TAG, "Node: id=%d room='%s' hub=%s:%d", _cfg.node_id, _cfg.room_name,
             _cfg.hub_ip, _cfg.hub_port);

    if (_cfg.wifi_ssid[0] == '\0') {
        ESP_LOGE(TAG, "No WiFi SSID configured! Set via NVS or menuconfig.");
        ESP_LOGE(TAG, "Use: idf.py menuconfig, or flash NVS partition with config.");
        return;
    }

    // Connect to WiFi
    wifi_init_sta();

    // Initialize UDP sender
    udp_sender_init(&_cfg);

    // Initialize and start CSI radar
    if (_cfg.csi_enabled) {
        csi_radar_init(&_cfg);
        csi_radar_start();
    } else {
        ESP_LOGW(TAG, "CSI disabled in config");
    }

    // Initialize and start BLE scanner
    if (_cfg.ble_enabled) {
        ble_scanner_init(&_cfg);
        ble_scanner_start();
    } else {
        ESP_LOGW(TAG, "BLE disabled in config");
    }

    // OTA update checker
    ota_update_init(&_cfg);

    // Status logging task
    xTaskCreate(status_task, "status", 2048, NULL, 1, NULL);

    ESP_LOGI(TAG, "All systems running. Reporting to %s:%d", _cfg.hub_ip, _cfg.hub_port);
}
