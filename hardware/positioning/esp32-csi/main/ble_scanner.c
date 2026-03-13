// ble_scanner.c — BLE passive scanner, reports device sightings to Rock Pi hub
#include "ble_scanner.h"
#include "udp_sender.h"
#include "protocol.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_gap.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <string.h>

static const char *TAG = "ble_scan";

static const node_config_t *_cfg;
static SemaphoreHandle_t _devices_mutex;

// Discovered devices buffer
static ble_device_t _devices[MAX_BLE_DEVICES_PER_REPORT];
static int _device_count = 0;
static uint32_t _ble_seq = 0;

// ── BLE GAP event handler ──

static int ble_gap_event(struct ble_gap_event *event, void *arg) {
    if (event->type != BLE_GAP_EVENT_DISC) return 0;

    const struct ble_gap_disc_desc *desc = &event->disc;

    xSemaphoreTake(_devices_mutex, portMAX_DELAY);

    // Check if we already have this device (update RSSI)
    bool found = false;
    for (int i = 0; i < _device_count; i++) {
        if (memcmp(_devices[i].addr, desc->addr.val, 6) == 0) {
            _devices[i].rssi = desc->rssi;  // update with latest RSSI
            found = true;
            break;
        }
    }

    // Add new device if space
    if (!found && _device_count < MAX_BLE_DEVICES_PER_REPORT) {
        ble_device_t *d = &_devices[_device_count];
        memcpy(d->addr, desc->addr.val, 6);
        d->rssi = desc->rssi;
        d->addr_type = desc->addr.type;
        d->_reserved = 0;
        _device_count++;
    }

    xSemaphoreGive(_devices_mutex);
    return 0;
}

// ── Scan cycle task ──

static void ble_scan_task(void *arg) {
    struct ble_gap_disc_params scan_params = {
        .itvl = 0x50,             // 50ms interval
        .window = 0x30,           // 30ms window
        .filter_policy = BLE_HCI_SCAN_FILT_NO_WL,
        .limited = 0,
        .passive = 1,             // passive scan — don't send scan requests
        .filter_duplicates = 0,   // we handle dedup ourselves
    };

    while (1) {
        // Clear device buffer
        xSemaphoreTake(_devices_mutex, portMAX_DELAY);
        _device_count = 0;
        xSemaphoreGive(_devices_mutex);

        // Start scan
        int rc = ble_gap_disc(BLE_OWN_ADDR_PUBLIC, _cfg->ble_scan_interval_ms,
                              &scan_params, ble_gap_event, NULL);
        if (rc != 0 && rc != BLE_HS_EALREADY) {
            ESP_LOGW(TAG, "Scan start failed: %d", rc);
        }

        // Wait for scan duration
        vTaskDelay(pdMS_TO_TICKS(_cfg->ble_scan_interval_ms));

        // Stop scan
        ble_gap_disc_cancel();

        // Send report
        xSemaphoreTake(_devices_mutex, portMAX_DELAY);
        if (_device_count > 0) {
            ble_report_header_t header = {
                .magic = OZZU_MAGIC_BLE,
                .node_id = _cfg->node_id,
                .device_count = (uint8_t)_device_count,
                .scan_duration_ms = _cfg->ble_scan_interval_ms,
                .seq = ++_ble_seq,
            };
            udp_send_ble_report(&header, _devices);
            ESP_LOGD(TAG, "Sent %d BLE devices", _device_count);
        }
        xSemaphoreGive(_devices_mutex);

        // Brief pause between scan cycles
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

// ── NimBLE host task ──

static void nimble_host_task(void *param) {
    nimble_port_run();
    nimble_port_freertos_deinit();
}

// ── Public API ──

void ble_scanner_init(const node_config_t *cfg) {
    _cfg = cfg;
    _devices_mutex = xSemaphoreCreateMutex();
    _device_count = 0;

    // NimBLE init
    esp_err_t ret = nimble_port_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "NimBLE init failed: %s", esp_err_to_name(ret));
        return;
    }

    // Start NimBLE host task
    nimble_port_freertos_init(nimble_host_task);
    ESP_LOGI(TAG, "BLE scanner initialized (interval=%dms)", cfg->ble_scan_interval_ms);
}

void ble_scanner_start(void) {
    xTaskCreatePinnedToCore(ble_scan_task, "ble_scan", 4096, NULL, 4, NULL, 0);
    ESP_LOGI(TAG, "BLE scan task started");
}
