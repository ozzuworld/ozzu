// main.c — Ozzu Room Node: WiFi CSI presence + BLE scanner
// ESP32 firmware for indoor positioning system
// Reports to Rock Pi hub via UDP binary packets
//
// Safety: OTA rollback support + connectivity watchdog.
// If WiFi doesn't connect within 90s of OTA boot, rolls back to previous firmware.

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
#include "esp_ota_ops.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

static const char *TAG = "main";

static EventGroupHandle_t _wifi_events;
#define WIFI_CONNECTED_BIT BIT0

static node_config_t _cfg;
static volatile bool _wifi_connected = false;

// ── OTA rollback validation ──
// After OTA update, new firmware must prove it's healthy.
// If WiFi doesn't connect within 90s, rollback to previous firmware.

static void _validate_ota_or_rollback(void) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;

    if (esp_ota_get_state_partition(running, &state) != ESP_OK) {
        return;  // not an OTA partition (factory), nothing to validate
    }

    if (state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGW(TAG, "OTA firmware pending validation — waiting for WiFi...");

        // Wait up to 90s for WiFi
        for (int i = 0; i < 90; i++) {
            if (_wifi_connected) {
                esp_ota_mark_app_valid_cancel_rollback();
                ESP_LOGI(TAG, "OTA firmware VALIDATED — WiFi connected, rollback cancelled");
                return;
            }
            vTaskDelay(pdMS_TO_TICKS(1000));
        }

        // WiFi never connected — this firmware is bad, rollback
        ESP_LOGE(TAG, "OTA firmware FAILED validation — rolling back!");
        esp_ota_mark_app_invalid_rollback_and_reboot();
        // never reaches here
    } else if (state == ESP_OTA_IMG_VALID) {
        ESP_LOGI(TAG, "Running validated OTA firmware");
    }
}

// ── Connectivity watchdog ──
// If WiFi drops for >5 minutes straight, reboot.
// Prevents nodes from silently going offline.

static void _watchdog_task(void *arg) {
    int disconnect_seconds = 0;
    const int max_disconnect = 300;  // 5 minutes

    // Skip first 120s to let boot settle
    vTaskDelay(pdMS_TO_TICKS(120000));

    while (1) {
        if (_wifi_connected) {
            disconnect_seconds = 0;
        } else {
            disconnect_seconds += 10;
            if (disconnect_seconds >= max_disconnect) {
                ESP_LOGE(TAG, "WiFi disconnected for %ds — rebooting!", max_disconnect);
                vTaskDelay(pdMS_TO_TICKS(1000));
                esp_restart();
            }
            ESP_LOGW(TAG, "WiFi down for %ds/%ds before reboot", disconnect_seconds, max_disconnect);
        }
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}

// ── WiFi event handler ──

static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t event_id, void *event_data) {
    if (base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_STA_START:
                esp_wifi_connect();
                break;
            case WIFI_EVENT_STA_DISCONNECTED:
                _wifi_connected = false;
                // Don't reconnect during BLE pairing mode — pairing needs WiFi off
                if (ble_scanner_is_pairing()) {
                    ESP_LOGW(TAG, "WiFi disconnected (pairing mode active — not reconnecting)");
                } else {
                    ESP_LOGW(TAG, "WiFi disconnected — reconnecting...");
                    vTaskDelay(pdMS_TO_TICKS(1000));
                    esp_wifi_connect();
                }
                break;
        }
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        _wifi_connected = true;
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

// ── Status task ──

static void status_task(void *arg) {
    while (1) {
        csi_report_t state;
        csi_radar_get_state(&state);

        const char *presence_str = state.presence == PRESENCE_MOVING ? "MOVING" :
                                   state.presence == PRESENCE_STATIC ? "STATIC" : "EMPTY";

        ESP_LOGI(TAG, "[%s] node=%d presence=%s confidence=%d%% motion=%d rssi=%d seq=%" PRIu32 " irks=%d",
                 _cfg.room_name, _cfg.node_id, presence_str,
                 state.confidence, state.motion_level, state.rssi, state.seq,
                 ble_scanner_irk_count());

        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

// ── Entry point ──

void app_main(void) {
    ESP_LOGI(TAG, "=== Ozzu Room Node v1.2 — IRK enrollment fix ===");

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

    // Validate OTA firmware (runs in background, rolls back if WiFi fails)
    _validate_ota_or_rollback();

    // Connectivity watchdog — reboot if WiFi drops for 5+ minutes
    xTaskCreate(_watchdog_task, "watchdog", 2048, NULL, 1, NULL);

    // Status logging task
    xTaskCreate(status_task, "status", 2048, NULL, 1, NULL);

    ESP_LOGI(TAG, "All systems running. Reporting to %s:%d", _cfg.hub_ip, _cfg.hub_port);
}
