#include "thermal.h"
#include "gecko_pins.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "thermal";

int thermal_init(void) {
    ESP_LOGI(TAG, "MLX90640 init (addr=0x%02X) — stub", MLX90640_I2C_ADDR);
    // Real: configure I2C, read EEPROM calibration, set 8Hz refresh
    return 0;
}

int thermal_capture(thermal_frame_t *frame) {
    memset(frame, 0, sizeof(*frame));
    frame->ambient = 2500;  // 25.00°C stub
    frame->timestamp_ms = 0;
    return 0;
}

bool thermal_detect_presence(const thermal_frame_t *frame, int16_t *max_temp) {
    int16_t max = frame->pixels[0];
    for (int i = 1; i < THERMAL_PIXELS; i++) {
        if (frame->pixels[i] > max) max = frame->pixels[i];
    }
    if (max_temp) *max_temp = max;
    // Human body ~37°C = 3700 centi-degrees, threshold at 30°C
    return max > 3000;
}

int16_t thermal_region_avg(const thermal_frame_t *frame,
                           uint8_t x, uint8_t y, uint8_t w, uint8_t h) {
    int32_t sum = 0;
    int count = 0;
    for (uint8_t row = y; row < y + h && row < THERMAL_ROWS; row++) {
        for (uint8_t col = x; col < x + w && col < THERMAL_COLS; col++) {
            sum += frame->pixels[row * THERMAL_COLS + col];
            count++;
        }
    }
    return count > 0 ? (int16_t)(sum / count) : 0;
}

void thermal_sleep(void) { ESP_LOGD(TAG, "Sleep"); }
void thermal_wake(void) { ESP_LOGD(TAG, "Wake"); }
