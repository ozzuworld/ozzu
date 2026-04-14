idf_component_register(
    SRCS
        "main.c"
        "sma_driver.c"
        "gecko_gait.c"
        "camera.c"
        "thermal.c"
        "tof.c"
        "mic.c"
        "flash_store.c"
        "wifi_burst.c"
        "slam.c"
        "behavior.c"
    INCLUDE_DIRS
        "include"
    REQUIRES
        driver esp_wifi esp_timer nvs_flash esp_psram
        esp_adc spi_flash ulp
)
