// ota_update.c — HTTP OTA firmware update from Rock Pi hub
// Supports scheduled polling (30min) and instant trigger via UDP command
#include "ota_update.h"
#include "esp_ota_ops.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_app_desc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "lwip/sockets.h"
#include <string.h>

static const char *TAG = "ota";

// OTA server on Rock Pi hub
#define OTA_CHECK_INTERVAL_MS  (30 * 60 * 1000)  // 30 minutes
#define OTA_BUF_SIZE           4096
#define OTA_PORT               5501
#define OTA_CMD_PORT           5502  // UDP command listener

// Magic bytes for OTA trigger command
#define OTA_TRIGGER_MAGIC      0x4F544155  // "OTAU"

static char _ota_url[128];
static EventGroupHandle_t _ota_events;
#define OTA_CHECK_NOW_BIT      BIT0

static void ota_task(void *arg) {
    // Wait 60s after boot before first check (let WiFi stabilize)
    vTaskDelay(pdMS_TO_TICKS(60000));

    while (1) {
        ESP_LOGI(TAG, "Checking for firmware update at %s", _ota_url);

        esp_http_client_config_t http_cfg = {
            .url = _ota_url,
            .timeout_ms = 10000,
        };

        esp_http_client_handle_t client = esp_http_client_init(&http_cfg);
        if (!client) {
            ESP_LOGW(TAG, "Failed to init HTTP client");
            goto next;
        }

        // HEAD request first to check if firmware exists
        esp_http_client_set_method(client, HTTP_METHOD_HEAD);
        esp_err_t err = esp_http_client_perform(client);
        if (err != ESP_OK) {
            ESP_LOGD(TAG, "No firmware available (HTTP error)");
            esp_http_client_cleanup(client);
            goto next;
        }

        int status = esp_http_client_get_status_code(client);
        int content_len = esp_http_client_get_content_length(client);
        esp_http_client_cleanup(client);

        if (status != 200 || content_len < 1000) {
            ESP_LOGD(TAG, "No update available (status=%d, len=%d)", status, content_len);
            goto next;
        }

        ESP_LOGI(TAG, "Firmware found (%d bytes), starting OTA...", content_len);

        // Perform OTA
        esp_http_client_config_t ota_cfg = {
            .url = _ota_url,
            .timeout_ms = 30000,
        };

        esp_http_client_handle_t ota_client = esp_http_client_init(&ota_cfg);
        if (!ota_client) {
            ESP_LOGE(TAG, "Failed to init OTA client");
            goto next;
        }

        err = esp_http_client_open(ota_client, 0);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to open HTTP connection: %s", esp_err_to_name(err));
            esp_http_client_cleanup(ota_client);
            goto next;
        }

        int total_len = esp_http_client_fetch_headers(ota_client);
        if (total_len < 1000) {
            ESP_LOGE(TAG, "Invalid firmware size: %d", total_len);
            esp_http_client_cleanup(ota_client);
            goto next;
        }

        const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
        if (!update_partition) {
            ESP_LOGE(TAG, "No OTA partition available");
            esp_http_client_cleanup(ota_client);
            goto next;
        }

        ESP_LOGI(TAG, "Writing to partition '%s' at 0x%lx", update_partition->label, update_partition->address);

        esp_ota_handle_t ota_handle;
        err = esp_ota_begin(update_partition, OTA_SIZE_UNKNOWN, &ota_handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "OTA begin failed: %s", esp_err_to_name(err));
            esp_http_client_cleanup(ota_client);
            goto next;
        }

        char buf[OTA_BUF_SIZE];
        int received = 0;
        bool success = true;

        while (received < total_len) {
            int read_len = esp_http_client_read(ota_client, buf, OTA_BUF_SIZE);
            if (read_len <= 0) {
                ESP_LOGE(TAG, "HTTP read error at %d/%d bytes", received, total_len);
                success = false;
                break;
            }

            err = esp_ota_write(ota_handle, buf, read_len);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "OTA write failed: %s", esp_err_to_name(err));
                success = false;
                break;
            }

            received += read_len;
            if ((received % (100 * 1024)) == 0 || received == total_len) {
                ESP_LOGI(TAG, "OTA progress: %d/%d bytes (%d%%)", received, total_len, received * 100 / total_len);
            }
        }

        esp_http_client_cleanup(ota_client);

        if (success && received == total_len) {
            err = esp_ota_end(ota_handle);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "OTA end failed: %s", esp_err_to_name(err));
                goto next;
            }

            err = esp_ota_set_boot_partition(update_partition);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "Set boot partition failed: %s", esp_err_to_name(err));
                goto next;
            }

            ESP_LOGI(TAG, "OTA success! Rebooting in 3s...");
            vTaskDelay(pdMS_TO_TICKS(3000));
            esp_restart();
        } else {
            esp_ota_abort(ota_handle);
            ESP_LOGE(TAG, "OTA failed, will retry next cycle");
        }

next:
        // Wait for scheduled interval OR instant trigger, whichever comes first
        xEventGroupWaitBits(_ota_events, OTA_CHECK_NOW_BIT,
                            pdTRUE, pdFALSE,
                            pdMS_TO_TICKS(OTA_CHECK_INTERVAL_MS));
    }
}

// ── UDP command listener — triggers instant OTA check ──

static void ota_cmd_task(void *arg) {
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "OTA cmd socket failed: errno %d", errno);
        vTaskDelete(NULL);
        return;
    }

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(OTA_CMD_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };

    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "OTA cmd bind failed: errno %d", errno);
        close(sock);
        vTaskDelete(NULL);
        return;
    }

    ESP_LOGI(TAG, "OTA command listener on UDP :%d", OTA_CMD_PORT);

    uint8_t buf[16];
    while (1) {
        int len = recvfrom(sock, buf, sizeof(buf), 0, NULL, NULL);
        if (len >= 4) {
            uint32_t magic;
            memcpy(&magic, buf, 4);
            if (magic == OTA_TRIGGER_MAGIC) {
                ESP_LOGI(TAG, "OTA trigger received — checking for update now");
                xEventGroupSetBits(_ota_events, OTA_CHECK_NOW_BIT);
            }
        }
    }
}

void ota_update_init(const node_config_t *cfg) {
    _ota_events = xEventGroupCreate();
    snprintf(_ota_url, sizeof(_ota_url), "http://%s:%d/firmware.bin", cfg->hub_ip, OTA_PORT);
    xTaskCreate(ota_task, "ota", 8192, NULL, 2, NULL);
    xTaskCreate(ota_cmd_task, "ota_cmd", 2048, NULL, 3, NULL);
    ESP_LOGI(TAG, "OTA update task started (check every %ds, url=%s)", OTA_CHECK_INTERVAL_MS / 1000, _ota_url);
}
