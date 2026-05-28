idf_component_register(
    SRCS "main.c" "wifi_sta.c" "wg_client.c" "nat_forward.c"
    INCLUDE_DIRS "."
    REQUIRES nvs_flash esp_wifi esp_netif esp_event lwip esp_wireguard esp_driver_gpio
)
