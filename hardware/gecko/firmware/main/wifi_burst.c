#include "wifi_burst.h"
#include "esp_log.h"
#include "esp_wifi.h"

static const char *TAG = "wifi";
static uint32_t burst_interval = WIFI_BURST_INTERVAL_MS;

int wifi_burst_init(const char *ssid, const char *password,
                    const char *bridge_host) {
    ESP_LOGI(TAG, "WiFi burst init — SSID=%s bridge=%s", ssid, bridge_host);
    ESP_LOGI(TAG, "Radio OFF (will wake on burst schedule)");
    // Real: init WiFi in STA mode but don't connect yet
    // Store credentials for burst connections
    return 0;
}

remote_cmd_t wifi_burst_sync(void) {
    ESP_LOGI(TAG, "Burst sync — stub");
    // Real implementation:
    // 1. esp_wifi_start() + esp_wifi_connect()
    // 2. Wait for IP (timeout 5s)
    // 3. HTTP POST frames to bridge: POST /api/gecko/frames
    // 4. HTTP GET commands: GET /api/gecko/commands
    // 5. esp_wifi_disconnect() + esp_wifi_stop()
    return CMD_NONE;
}

int wifi_burst_alert(const alert_payload_t *alert,
                     const uint8_t *jpeg, size_t jpeg_len) {
    ESP_LOGW(TAG, "ALERT burst — trigger=%d, jpeg=%u bytes",
             alert->trigger, (unsigned)jpeg_len);
    // Real: immediate WiFi wake + POST to bridge
    // POST /api/gecko/alert { payload + jpeg attachment }
    (void)jpeg;
    return 0;
}

void wifi_burst_set_interval(uint32_t interval_ms) {
    burst_interval = interval_ms;
    ESP_LOGI(TAG, "Burst interval: %lums", (unsigned long)burst_interval);
}

void wifi_radio_off(void) {
    ESP_LOGD(TAG, "Radio OFF");
}
