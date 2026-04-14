#include "sma_driver.h"
#include "gecko_pins.h"
#include "driver/ledc.h"
#include "esp_timer.h"
#include "esp_log.h"

static const char *TAG = "sma";

static const int sma_pins[SMA_CHANNEL_COUNT] = {
    [SMA_SPINE]     = PIN_SMA_SPINE,
    [SMA_FRONT_PAD] = PIN_SMA_FRONT_PAD,
    [SMA_REAR_PAD]  = PIN_SMA_REAR_PAD,
};

// Track when each wire was last deactivated (for cooling check)
static int64_t sma_off_time_us[SMA_CHANNEL_COUNT] = {0};
static bool sma_active[SMA_CHANNEL_COUNT] = {false};

void sma_init(void) {
    // Configure LEDC timer for PWM (25kHz — inaudible)
    ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_8_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 25000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ledc_timer_config(&timer);

    // Configure each SMA channel as a LEDC PWM output
    for (int ch = 0; ch < SMA_CHANNEL_COUNT; ch++) {
        ledc_channel_config_t channel = {
            .speed_mode = LEDC_LOW_SPEED_MODE,
            .channel = (ledc_channel_t)ch,
            .timer_sel = LEDC_TIMER_0,
            .intr_type = LEDC_INTR_DISABLE,
            .gpio_num = sma_pins[ch],
            .duty = 0,
            .hpoint = 0,
        };
        ledc_channel_config(&channel);
        sma_off_time_us[ch] = esp_timer_get_time();
    }
    ESP_LOGI(TAG, "SMA driver initialized (3 channels, 0.050mm wire)");
}

void sma_contract(sma_channel_t channel) {
    if (channel >= SMA_CHANNEL_COUNT) return;

    // Full power to heat quickly
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)channel, SMA_MAX_DUTY_CYCLE);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)channel);
    sma_active[channel] = true;

    ESP_LOGD(TAG, "CH%d contract (duty=%d)", channel, SMA_MAX_DUTY_CYCLE);

    // After initial heating, reduce to hold duty to save power
    vTaskDelay(pdMS_TO_TICKS(SMA_HEAT_TIME_MS));
    if (sma_active[channel]) {
        ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)channel, SMA_HOLD_DUTY_CYCLE);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)channel);
    }
}

void sma_release(sma_channel_t channel) {
    if (channel >= SMA_CHANNEL_COUNT) return;

    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)channel, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)channel);
    sma_active[channel] = false;
    sma_off_time_us[channel] = esp_timer_get_time();

    ESP_LOGD(TAG, "CH%d released", channel);
}

void sma_activate(sma_channel_t channel, uint32_t duration_ms) {
    sma_contract(channel);
    vTaskDelay(pdMS_TO_TICKS(duration_ms));
    sma_release(channel);
}

bool sma_is_ready(sma_channel_t channel) {
    if (channel >= SMA_CHANNEL_COUNT) return false;
    if (sma_active[channel]) return false;

    int64_t elapsed_us = esp_timer_get_time() - sma_off_time_us[channel];
    return (elapsed_us >= (SMA_COOL_TIME_MS * 1000));
}

void sma_wait_cool(sma_channel_t channel) {
    while (!sma_is_ready(channel)) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

void sma_emergency_stop(void) {
    for (int ch = 0; ch < SMA_CHANNEL_COUNT; ch++) {
        ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)ch, 0);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)ch);
        sma_active[ch] = false;
    }
    ESP_LOGW(TAG, "EMERGENCY STOP — all wires released");
}
