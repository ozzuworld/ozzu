// config.c — NVS-backed node configuration
#include "config.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "config";
static const char *NVS_NAMESPACE = "ozzu_node";

void config_init(node_config_t *cfg) {
    // Set defaults
    memset(cfg, 0, sizeof(*cfg));
    strncpy(cfg->room_name, "unknown", MAX_ROOM_NAME_LEN - 1);
    cfg->node_id = 1;
    strncpy(cfg->hub_ip, "10.8.0.1", 15);  // Rock Pi via VPN
    cfg->hub_port = DEFAULT_HUB_PORT;
    cfg->csi_report_interval_ms = DEFAULT_CSI_REPORT_INTERVAL;
    cfg->ble_scan_interval_ms = DEFAULT_BLE_SCAN_INTERVAL;
    cfg->ble_enabled = true;
    cfg->csi_enabled = true;

    // Try to load from NVS
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "No saved config — using defaults");
        return;
    }

    size_t len;

    len = MAX_ROOM_NAME_LEN;
    nvs_get_str(handle, "room_name", cfg->room_name, &len);

    uint8_t u8;
    if (nvs_get_u8(handle, "node_id", &u8) == ESP_OK) cfg->node_id = u8;

    len = MAX_SSID_LEN;
    nvs_get_str(handle, "wifi_ssid", cfg->wifi_ssid, &len);

    len = MAX_PASS_LEN;
    nvs_get_str(handle, "wifi_pass", cfg->wifi_pass, &len);

    len = 16;
    nvs_get_str(handle, "hub_ip", cfg->hub_ip, &len);

    uint16_t u16;
    if (nvs_get_u16(handle, "hub_port", &u16) == ESP_OK) cfg->hub_port = u16;
    if (nvs_get_u16(handle, "csi_interval", &u16) == ESP_OK) cfg->csi_report_interval_ms = u16;
    if (nvs_get_u16(handle, "ble_interval", &u16) == ESP_OK) cfg->ble_scan_interval_ms = u16;

    if (nvs_get_u8(handle, "ble_enabled", &u8) == ESP_OK) cfg->ble_enabled = (u8 != 0);
    if (nvs_get_u8(handle, "csi_enabled", &u8) == ESP_OK) cfg->csi_enabled = (u8 != 0);

    nvs_close(handle);
    ESP_LOGI(TAG, "Loaded: node=%d room=%s hub=%s:%d", cfg->node_id, cfg->room_name, cfg->hub_ip, cfg->hub_port);
}

void config_save(const node_config_t *cfg) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to open NVS for write: %s", esp_err_to_name(err));
        return;
    }

    nvs_set_str(handle, "room_name", cfg->room_name);
    nvs_set_u8(handle, "node_id", cfg->node_id);
    nvs_set_str(handle, "wifi_ssid", cfg->wifi_ssid);
    nvs_set_str(handle, "wifi_pass", cfg->wifi_pass);
    nvs_set_str(handle, "hub_ip", cfg->hub_ip);
    nvs_set_u16(handle, "hub_port", cfg->hub_port);
    nvs_set_u16(handle, "csi_interval", cfg->csi_report_interval_ms);
    nvs_set_u16(handle, "ble_interval", cfg->ble_scan_interval_ms);
    nvs_set_u8(handle, "ble_enabled", cfg->ble_enabled ? 1 : 0);
    nvs_set_u8(handle, "csi_enabled", cfg->csi_enabled ? 1 : 0);

    nvs_commit(handle);
    nvs_close(handle);
    ESP_LOGI(TAG, "Config saved");
}
