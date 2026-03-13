idf_component_register(
    SRCS "main.c" "csi_radar.c" "ble_scanner.c" "udp_sender.c" "config.c"
    INCLUDE_DIRS "."
    REQUIRES esp_wifi esp_event esp_netif nvs_flash esp_timer driver bt
)
