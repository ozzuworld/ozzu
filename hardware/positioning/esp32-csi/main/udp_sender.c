// udp_sender.c — UDP client for sending binary reports to Rock Pi hub
#include "udp_sender.h"
#include "esp_log.h"
#include "lwip/sockets.h"
#include <string.h>

static const char *TAG = "udp_sender";
static int _sock = -1;
static struct sockaddr_in _hub_addr;

void udp_sender_init(const node_config_t *cfg) {
    _sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (_sock < 0) {
        ESP_LOGE(TAG, "Failed to create socket: errno %d", errno);
        return;
    }

    memset(&_hub_addr, 0, sizeof(_hub_addr));
    _hub_addr.sin_family = AF_INET;
    _hub_addr.sin_port = htons(cfg->hub_port);
    inet_pton(AF_INET, cfg->hub_ip, &_hub_addr.sin_addr);

    ESP_LOGI(TAG, "UDP sender ready → %s:%d", cfg->hub_ip, cfg->hub_port);
}

void udp_send_csi_report(const csi_report_t *report) {
    if (_sock < 0) return;
    int sent = sendto(_sock, report, sizeof(csi_report_t), 0,
                      (struct sockaddr *)&_hub_addr, sizeof(_hub_addr));
    if (sent < 0) {
        ESP_LOGW(TAG, "CSI send failed: errno %d", errno);
    }
}

void udp_send_ble_report(const ble_report_header_t *header, const ble_device_t *devices) {
    if (_sock < 0 || header->device_count == 0) return;

    // Build contiguous buffer: header + devices
    size_t hdr_sz = sizeof(ble_report_header_t);
    size_t dev_sz = header->device_count * sizeof(ble_device_t);
    uint8_t buf[hdr_sz + dev_sz];

    memcpy(buf, header, hdr_sz);
    memcpy(buf + hdr_sz, devices, dev_sz);

    int sent = sendto(_sock, buf, hdr_sz + dev_sz, 0,
                      (struct sockaddr *)&_hub_addr, sizeof(_hub_addr));
    if (sent < 0) {
        ESP_LOGW(TAG, "BLE send failed: errno %d", errno);
    }
}

void udp_send_irk_report(const irk_header_t *header, const irk_entry_t *entries) {
    if (_sock < 0 || header->irk_count == 0) return;

    size_t hdr_sz = sizeof(irk_header_t);
    size_t ent_sz = header->irk_count * sizeof(irk_entry_t);
    uint8_t buf[hdr_sz + ent_sz];

    memcpy(buf, header, hdr_sz);
    memcpy(buf + hdr_sz, entries, ent_sz);

    int sent = sendto(_sock, buf, hdr_sz + ent_sz, 0,
                      (struct sockaddr *)&_hub_addr, sizeof(_hub_addr));
    if (sent < 0) {
        ESP_LOGW(TAG, "IRK send failed: errno %d", errno);
    }
}
