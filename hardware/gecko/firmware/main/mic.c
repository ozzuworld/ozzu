#include "mic.h"
#include "gecko_pins.h"
#include "esp_log.h"
#include <string.h>
#include <math.h>

static const char *TAG = "mic";
static bool wake_source = false;

int mic_init(void) {
    ESP_LOGI(TAG, "INMP441 init (I2S, %dHz) — stub", MIC_SAMPLE_RATE);
    return 0;
}

int mic_read(int16_t *samples, size_t max_samples) {
    memset(samples, 0, max_samples * sizeof(int16_t));
    return (int)max_samples;
}

uint16_t mic_get_rms(void) {
    return 0;  // Stub — real impl reads I2S DMA buffer
}

void mic_configure_wake(uint16_t rms_threshold) {
    ESP_LOGI(TAG, "ULP wake threshold: RMS > %u", rms_threshold);
    // Real: program ULP RISC-V coprocessor to sample ADC and compare
}

void mic_start_monitor(void) { ESP_LOGD(TAG, "Monitor start"); }
void mic_stop_monitor(void) { ESP_LOGD(TAG, "Monitor stop"); }

bool mic_was_wake_source(void) {
    bool was = wake_source;
    wake_source = false;
    return was;
}

void mic_sleep(void) { ESP_LOGD(TAG, "Sleep"); }
void mic_wake(void) { ESP_LOGD(TAG, "Wake"); }
