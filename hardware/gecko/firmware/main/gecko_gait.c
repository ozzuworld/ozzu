#include "gecko_gait.h"
#include "sma_driver.h"
#include "esp_timer.h"
#include "esp_log.h"

static const char *TAG = "gait";

static gait_state_t state = GAIT_IDLE;
static gait_direction_t direction = GAIT_STOP;
static gait_profile_t profile = GAIT_PROFILE_DEFAULT;
static int64_t state_enter_time = 0;

// Which pads to actuate based on direction
// Forward:  release rear → contract → release front → extend
// Backward: release front → contract → release rear → extend
static sma_channel_t first_pad(void) {
    return (direction == GAIT_FORWARD) ? SMA_REAR_PAD : SMA_FRONT_PAD;
}

static sma_channel_t second_pad(void) {
    return (direction == GAIT_FORWARD) ? SMA_FRONT_PAD : SMA_REAR_PAD;
}

void gait_init(void) {
    state = GAIT_IDLE;
    direction = GAIT_STOP;
    ESP_LOGI(TAG, "Gait controller initialized");
}

void gait_step_start(gait_direction_t dir) {
    direction = dir;
    state = GAIT_RELEASE_REAR;
    state_enter_time = esp_timer_get_time();
    ESP_LOGD(TAG, "Step start dir=%d", dir);
}

bool gait_tick(void) {
    int64_t elapsed_us = esp_timer_get_time() - state_enter_time;
    uint32_t elapsed_ms = (uint32_t)(elapsed_us / 1000);

    switch (state) {
    case GAIT_IDLE:
        return true;

    case GAIT_RELEASE_REAR:
        // Peel first pad off wall
        sma_contract(first_pad());
        state = GAIT_CONTRACT_SPINE;
        state_enter_time = esp_timer_get_time();
        break;

    case GAIT_CONTRACT_SPINE:
        // Wait for pad to fully release, then contract spine
        if (elapsed_ms >= profile.heat_ms) {
            sma_contract(SMA_SPINE);
            state = GAIT_ATTACH_REAR;
            state_enter_time = esp_timer_get_time();
        }
        break;

    case GAIT_ATTACH_REAR:
        // Spine contracted, first pad moved — release SMA to re-stick
        if (elapsed_ms >= profile.heat_ms) {
            sma_release(first_pad());
            state = GAIT_RELEASE_FRONT;
            state_enter_time = esp_timer_get_time();
        }
        break;

    case GAIT_RELEASE_FRONT:
        // Wait for pad to settle, then release second pad
        if (elapsed_ms >= profile.settle_ms + profile.cool_ms) {
            sma_contract(second_pad());
            state = GAIT_EXTEND_SPINE;
            state_enter_time = esp_timer_get_time();
        }
        break;

    case GAIT_EXTEND_SPINE:
        // Second pad released, now let spine extend (release SMA)
        if (elapsed_ms >= profile.heat_ms) {
            sma_release(SMA_SPINE);
            state = GAIT_ATTACH_FRONT;
            state_enter_time = esp_timer_get_time();
        }
        break;

    case GAIT_ATTACH_FRONT:
        // Spine extended, second pad moved — release to re-stick
        if (elapsed_ms >= profile.heat_ms) {
            sma_release(second_pad());
            state = GAIT_CYCLE_COMPLETE;
            state_enter_time = esp_timer_get_time();
        }
        break;

    case GAIT_CYCLE_COMPLETE:
        // Wait for everything to cool and settle
        if (elapsed_ms >= profile.cool_ms + profile.settle_ms) {
            state = GAIT_IDLE;
            ESP_LOGD(TAG, "Step complete");
            return true;
        }
        break;
    }
    return false;
}

void gait_walk(gait_direction_t dir, uint32_t steps) {
    for (uint32_t i = 0; i < steps; i++) {
        gait_step_start(dir);
        while (!gait_tick()) {
            vTaskDelay(pdMS_TO_TICKS(5));
        }
        ESP_LOGI(TAG, "Step %lu/%lu complete", (unsigned long)(i + 1),
                 (unsigned long)steps);
    }
}

void gait_stop(void) {
    // Release all SMA wires — both pads re-attach
    sma_emergency_stop();
    state = GAIT_IDLE;
    direction = GAIT_STOP;
    ESP_LOGI(TAG, "Gait stopped — both pads attached");
}

gait_state_t gait_get_state(void) {
    return state;
}

void gait_set_profile(const gait_profile_t *p) {
    profile = *p;
    ESP_LOGI(TAG, "Profile: heat=%lums cool=%lums settle=%lums",
             (unsigned long)p->heat_ms, (unsigned long)p->cool_ms,
             (unsigned long)p->settle_ms);
}
