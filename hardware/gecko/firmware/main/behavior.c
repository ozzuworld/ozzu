#include "behavior.h"
#include "gecko_gait.h"
#include "camera.h"
#include "thermal.h"
#include "tof.h"
#include "mic.h"
#include "flash_store.h"
#include "wifi_burst.h"
#include "slam.h"
#include "gecko_pins.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_adc/adc_oneshot.h"

static const char *TAG = "behavior";
static robot_mode_t current_mode = MODE_BOOT;
static adc_oneshot_unit_handle_t adc_handle = NULL;

// Forward declarations
static void mode_boot(void);
static void mode_recon(void);
static void mode_overwatch(void);
static void mode_alert(trigger_type_t trigger);
static void mode_recharge(void);

uint8_t behavior_get_battery_pct(void) {
    int raw = 0;
    adc_oneshot_read(adc_handle, ADC_CHANNEL_5, &raw);  // GPIO46
    // 12-bit ADC, 3.3V ref, 2:1 divider → actual voltage = raw * 2 * 3300 / 4095
    uint32_t mv = (uint32_t)raw * 6600 / 4095;
    if (mv >= BATTERY_FULL_MV) return 100;
    if (mv <= BATTERY_EMPTY_MV) return 0;
    return (uint8_t)((mv - BATTERY_EMPTY_MV) * 100 / (BATTERY_FULL_MV - BATTERY_EMPTY_MV));
}

static void mode_boot(void) {
    ESP_LOGI(TAG, "=== GECKO BOOT ===");

    // Self-test: verify all sensors respond
    int err = 0;
    err |= camera_init(CAM_RES_QVGA);
    err |= thermal_init();
    err |= tof_init();
    err |= mic_init();
    err |= flash_store_init();

    if (err) {
        ESP_LOGE(TAG, "Sensor init failed (code %d) — entering emergency mode", err);
        current_mode = MODE_EMERGENCY;
        return;
    }

    // Init locomotion
    sma_init();
    gait_init();
    slam_init();

    ESP_LOGI(TAG, "All systems OK — battery %d%%", behavior_get_battery_pct());

    // Decide starting mode based on flash contents
    if (slam_coverage_pct() < 50) {
        current_mode = MODE_RECON;
    } else {
        current_mode = MODE_OVERWATCH;
    }
}

static void mode_recon(void) {
    ESP_LOGI(TAG, "RECON mode — exploring");

    tof_frame_t tof;
    thermal_frame_t thermal;
    uint8_t *jpeg = NULL;
    size_t jpeg_len = 0;
    uint32_t steps_since_capture = 0;

    while (current_mode == MODE_RECON) {
        // Check battery
        uint8_t batt = behavior_get_battery_pct();
        if (batt <= BATTERY_CRITICAL_PCT) {
            ESP_LOGW(TAG, "Battery critical (%d%%) — recharge", batt);
            current_mode = MODE_RECHARGE;
            break;
        }

        // Take one step forward
        gait_step_start(GAIT_FORWARD);
        while (!gait_tick()) {
            vTaskDelay(pdMS_TO_TICKS(5));
        }
        steps_since_capture++;

        // After every step, update SLAM with ToF
        tof_capture(&tof);
        pose_t pose = slam_get_pose();
        slam_step(3);  // ~3mm per step
        slam_update(&tof, &pose);

        // Every 10 steps, capture full sensor frame
        if (steps_since_capture >= 10) {
            camera_capture(&jpeg, &jpeg_len);
            thermal_capture(&thermal);

            frame_meta_t meta = {
                .timestamp_ms = (uint32_t)(esp_timer_get_time() / 1000),
                .jpeg_size = (uint16_t)jpeg_len,
                .mode = MODE_RECON,
                .trigger = TRIGGER_NONE,
                .max_thermal = thermal.ambient,
                .battery_pct = batt,
            };
            flash_store_frame(jpeg, jpeg_len, &meta);
            camera_release_frame();
            steps_since_capture = 0;
        }

        // Periodic WiFi burst to sync data
        static uint32_t last_burst = 0;
        uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
        if (now - last_burst > WIFI_BURST_INTERVAL_MS) {
            remote_cmd_t cmd = wifi_burst_sync();
            if (cmd == CMD_SET_MODE) {
                break;  // Mode changed remotely
            }
            last_burst = now;
        }

        // Check if map is complete enough
        if (slam_coverage_pct() >= 80) {
            ESP_LOGI(TAG, "Map %d%% complete — switching to overwatch", slam_coverage_pct());
            current_mode = MODE_OVERWATCH;
            break;
        }
    }
}

static void mode_overwatch(void) {
    ESP_LOGI(TAG, "OVERWATCH mode — parking and monitoring");

    // Find best overwatch position
    uint8_t ow_x, ow_y;
    if (slam_find_overwatch(&ow_x, &ow_y)) {
        ESP_LOGI(TAG, "Overwatch target: grid(%d,%d)", ow_x, ow_y);
        // TODO: path planning to overwatch position
    }

    // Power down non-essential sensors
    camera_sleep();
    thermal_sleep();
    tof_set_frequency(1);  // 1Hz — minimal power

    // Configure mic as wake source
    mic_configure_wake(500);  // RMS threshold

    tof_frame_t prev_tof, curr_tof;
    tof_capture(&prev_tof);

    while (current_mode == MODE_OVERWATCH) {
        // Check battery
        if (behavior_get_battery_pct() <= BATTERY_LOW_PCT) {
            current_mode = MODE_RECHARGE;
            break;
        }

        // Light sleep — wake on mic or timer
        esp_sleep_enable_timer_wakeup(5000000);  // 5 second check interval
        esp_light_sleep_start();

        // Check what woke us
        if (mic_was_wake_source()) {
            mode_alert(TRIGGER_SOUND);
            continue;
        }

        // Check ToF for motion
        tof_capture(&curr_tof);
        if (tof_detect_motion(&curr_tof, &prev_tof, 200)) {
            mode_alert(TRIGGER_MOTION);
        }
        prev_tof = curr_tof;

        // Periodic burst
        static uint32_t last_burst = 0;
        uint32_t now = (uint32_t)(esp_timer_get_time() / 1000);
        if (now - last_burst > WIFI_BURST_INTERVAL_MS) {
            remote_cmd_t cmd = wifi_burst_sync();
            if (cmd == CMD_SET_MODE) break;
            last_burst = now;
        }
    }

    // Wake sensors back up when leaving overwatch
    camera_wake();
    thermal_wake();
}

static void mode_alert(trigger_type_t trigger) {
    ESP_LOGW(TAG, "ALERT — trigger=%d", trigger);

    // Wake all sensors
    camera_wake();
    thermal_wake();

    // Capture everything
    uint8_t *jpeg = NULL;
    size_t jpeg_len = 0;
    camera_capture(&jpeg, &jpeg_len);

    thermal_frame_t thermal;
    thermal_capture(&thermal);

    int16_t max_temp = 0;
    thermal_detect_presence(&thermal, &max_temp);

    tof_frame_t tof;
    tof_capture(&tof);

    // Find min distance
    uint16_t min_dist = 4000;
    for (int i = 0; i < TOF_ZONES; i++) {
        if (tof.distance_mm[i] > 0 && tof.distance_mm[i] < min_dist) {
            min_dist = tof.distance_mm[i];
        }
    }

    // Store frame
    frame_meta_t meta = {
        .timestamp_ms = (uint32_t)(esp_timer_get_time() / 1000),
        .jpeg_size = (uint16_t)jpeg_len,
        .mode = MODE_ALERT,
        .trigger = trigger,
        .max_thermal = max_temp,
        .battery_pct = behavior_get_battery_pct(),
    };
    flash_store_frame(jpeg, jpeg_len, &meta);

    // Immediate WiFi alert to bridge
    alert_payload_t alert = {
        .trigger = trigger,
        .battery_pct = meta.battery_pct,
        .max_thermal = max_temp,
        .tof_min_mm = min_dist,
        .mic_rms = mic_get_rms(),
        .timestamp_ms = meta.timestamp_ms,
    };
    wifi_burst_alert(&alert, jpeg, jpeg_len);

    camera_release_frame();

    // Back to overwatch if still in that mode
    if (current_mode == MODE_OVERWATCH) {
        camera_sleep();
        thermal_sleep();
    }
}

static void mode_recharge(void) {
    ESP_LOGI(TAG, "RECHARGE mode — heading to dock");
    // TODO: navigate to dock using SLAM map
    // TODO: align with pogo pins using magnetic attraction
    // For now, just stop and wait
    gait_stop();

    while (current_mode == MODE_RECHARGE) {
        uint8_t batt = behavior_get_battery_pct();
        ESP_LOGI(TAG, "Charging... %d%%", batt);

        if (batt >= BATTERY_RECHARGE_PCT) {
            ESP_LOGI(TAG, "Charged to %d%% — resuming", batt);
            current_mode = MODE_RECON;
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(30000));  // Check every 30s
    }
}

void behavior_init(void) {
    // Init battery ADC
    adc_oneshot_unit_init_cfg_t adc_cfg = {
        .unit_id = ADC_UNIT_1,
    };
    adc_oneshot_new_unit(&adc_cfg, &adc_handle);
    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    adc_oneshot_config_channel(adc_handle, ADC_CHANNEL_5, &chan_cfg);

    current_mode = MODE_BOOT;
}

void behavior_run(void) {
    while (1) {
        switch (current_mode) {
        case MODE_BOOT:      mode_boot(); break;
        case MODE_RECON:     mode_recon(); break;
        case MODE_OVERWATCH: mode_overwatch(); break;
        case MODE_RECHARGE:  mode_recharge(); break;
        case MODE_MANUAL:    vTaskDelay(pdMS_TO_TICKS(100)); break;
        case MODE_EMERGENCY:
            gait_stop();
            ESP_LOGE(TAG, "EMERGENCY — halted");
            vTaskDelay(pdMS_TO_TICKS(5000));
            break;
        default:
            vTaskDelay(pdMS_TO_TICKS(100));
        }
    }
}

void behavior_set_mode(robot_mode_t mode) {
    ESP_LOGI(TAG, "Mode change: %d -> %d", current_mode, mode);
    current_mode = mode;
}

robot_mode_t behavior_get_mode(void) {
    return current_mode;
}
