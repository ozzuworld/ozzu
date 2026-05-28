#include "wg_client.h"

#include "esp_log.h"
#include "esp_wireguard.h"

static const char *TAG = "wg_client";
static wireguard_ctx_t s_wg_ctx = { 0 };

esp_err_t wg_client_start(void) {
    wireguard_config_t cfg = ESP_WIREGUARD_CONFIG_DEFAULT();
    cfg.private_key       = CONFIG_ESP_WG_LOCAL_PRIVKEY;
    cfg.allowed_ip        = CONFIG_ESP_WG_LOCAL_IP;
    cfg.allowed_ip_mask   = CONFIG_ESP_WG_LOCAL_NETMASK;
    cfg.public_key        = CONFIG_ESP_WG_PEER_PUBKEY;
    cfg.endpoint          = CONFIG_ESP_WG_PEER_ENDPOINT;
    cfg.port              = CONFIG_ESP_WG_PEER_PORT;
    cfg.persistent_keepalive = CONFIG_ESP_WG_KEEPALIVE;

    ESP_LOGI(TAG, "WG init: local=%s/%s endpoint=%s:%d",
             cfg.allowed_ip, cfg.allowed_ip_mask, cfg.endpoint, cfg.port);

    esp_err_t err = esp_wireguard_init(&cfg, &s_wg_ctx);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wireguard_init failed: %d", err);
        return err;
    }

    err = esp_wireguard_connect(&s_wg_ctx);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wireguard_connect failed: %d", err);
        return err;
    }

    ESP_LOGI(TAG, "WG tunnel up, peer keepalive=%ds", CONFIG_ESP_WG_KEEPALIVE);
    return ESP_OK;
}
