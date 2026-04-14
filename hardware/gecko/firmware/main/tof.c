#include "tof.h"
#include "gecko_pins.h"
#include "esp_log.h"
#include <string.h>
#include <stdlib.h>

static const char *TAG = "tof";

int tof_init(void) {
    ESP_LOGI(TAG, "VL53L8CX init (addr=0x%02X) — stub", VL53L8CX_I2C_ADDR);
    return 0;
}

int tof_capture(tof_frame_t *frame) {
    memset(frame, 0, sizeof(*frame));
    frame->timestamp_ms = 0;
    return 0;
}

void tof_set_frequency(uint8_t hz) {
    ESP_LOGD(TAG, "Set frequency %dHz", hz);
}

void tof_set_mode(tof_mode_t mode) {
    ESP_LOGD(TAG, "Set mode %d", mode);
}

bool tof_detect_motion(const tof_frame_t *current,
                       const tof_frame_t *previous,
                       uint16_t threshold_mm) {
    for (int i = 0; i < TOF_ZONES; i++) {
        if (current->distance_mm[i] == 0 || previous->distance_mm[i] == 0)
            continue;
        int delta = abs((int)current->distance_mm[i] - (int)previous->distance_mm[i]);
        if (delta > threshold_mm) return true;
    }
    return false;
}

void tof_sleep(void) { ESP_LOGD(TAG, "Sleep"); }
void tof_wake(void) { ESP_LOGD(TAG, "Wake"); }
