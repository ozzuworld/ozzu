// csi_radar.c — WiFi CSI presence/motion detection using amplitude analysis
// Uses ESP-IDF WiFi CSI callback directly (esp-radar component provides helpers)
#include "csi_radar.h"
#include "udp_sender.h"
#include "esp_wifi.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <math.h>
#include <string.h>

static const char *TAG = "csi_radar";

// ── CSI processing state ──

#define CSI_SUBCARRIERS    52
#define CSI_HISTORY_LEN    20    // sliding window for variance
#define MOTION_THRESHOLD   8.0f  // amplitude variance threshold for motion
#define PRESENCE_THRESHOLD 3.0f  // amplitude variance threshold for presence (still)

static float _amplitude_history[CSI_HISTORY_LEN][CSI_SUBCARRIERS];
static int   _history_idx = 0;
static int   _history_count = 0;
static float _baseline[CSI_SUBCARRIERS];
static bool  _baseline_set = false;
static int   _baseline_samples = 0;
#define BASELINE_SAMPLES_NEEDED 50  // first 50 frames = calibrate empty room

static SemaphoreHandle_t _state_mutex;
static csi_report_t _current_state;
static uint32_t _seq = 0;
static uint32_t _boot_time;

static const node_config_t *_cfg;

// ── CSI amplitude extraction ──

static void extract_amplitudes(const int8_t *raw_csi, int len, float *amplitudes) {
    // CSI data: pairs of (imaginary, real) for each subcarrier
    int pairs = len / 2;
    if (pairs > CSI_SUBCARRIERS) pairs = CSI_SUBCARRIERS;

    for (int i = 0; i < pairs; i++) {
        float imag = (float)raw_csi[i * 2];
        float real = (float)raw_csi[i * 2 + 1];
        amplitudes[i] = sqrtf(imag * imag + real * real);
    }
    // Zero-fill remaining
    for (int i = pairs; i < CSI_SUBCARRIERS; i++) {
        amplitudes[i] = 0.0f;
    }
}

// ── Presence/motion detection from amplitude variance ──

static void detect_presence(float *amplitudes) {
    // Store in history ring buffer
    memcpy(_amplitude_history[_history_idx], amplitudes, sizeof(float) * CSI_SUBCARRIERS);
    _history_idx = (_history_idx + 1) % CSI_HISTORY_LEN;
    if (_history_count < CSI_HISTORY_LEN) _history_count++;

    // Baseline calibration (empty room)
    if (!_baseline_set) {
        // Accumulate into baseline
        for (int s = 0; s < CSI_SUBCARRIERS; s++) {
            _baseline[s] += amplitudes[s];
        }
        _baseline_samples++;
        if (_baseline_samples >= BASELINE_SAMPLES_NEEDED) {
            for (int s = 0; s < CSI_SUBCARRIERS; s++) {
                _baseline[s] /= (float)_baseline_samples;
            }
            _baseline_set = true;
            ESP_LOGI(TAG, "Baseline calibrated (%d samples)", _baseline_samples);
        }
        return;
    }

    if (_history_count < 5) return;  // need some history

    // Compute variance across recent history for each subcarrier
    float total_variance = 0.0f;
    float total_deviation = 0.0f;

    for (int s = 0; s < CSI_SUBCARRIERS; s++) {
        // Mean of recent amplitudes
        float mean = 0.0f;
        for (int h = 0; h < _history_count; h++) {
            mean += _amplitude_history[h][s];
        }
        mean /= (float)_history_count;

        // Variance
        float var = 0.0f;
        for (int h = 0; h < _history_count; h++) {
            float d = _amplitude_history[h][s] - mean;
            var += d * d;
        }
        var /= (float)_history_count;
        total_variance += var;

        // Deviation from baseline
        float dev = fabsf(mean - _baseline[s]);
        total_deviation += dev;
    }

    float avg_variance = total_variance / CSI_SUBCARRIERS;
    float avg_deviation = total_deviation / CSI_SUBCARRIERS;

    // Classify
    uint8_t presence;
    uint8_t motion_level;
    uint8_t confidence;

    if (avg_variance > MOTION_THRESHOLD) {
        presence = PRESENCE_MOVING;
        motion_level = (uint8_t)(avg_variance > 255.0f ? 255 : (int)avg_variance);
        confidence = (avg_variance > MOTION_THRESHOLD * 2) ? 95 : 75;
    } else if (avg_deviation > PRESENCE_THRESHOLD || avg_variance > PRESENCE_THRESHOLD * 0.5f) {
        presence = PRESENCE_STATIC;
        motion_level = (uint8_t)(avg_variance > 255.0f ? 255 : (int)avg_variance);
        confidence = (avg_deviation > PRESENCE_THRESHOLD * 2) ? 85 : 60;
    } else {
        presence = PRESENCE_EMPTY;
        motion_level = 0;
        confidence = (avg_variance < PRESENCE_THRESHOLD * 0.2f) ? 90 : 50;
    }

    // Update state (thread-safe)
    xSemaphoreTake(_state_mutex, portMAX_DELAY);
    _current_state.magic = OZZU_MAGIC_CSI;
    _current_state.node_id = _cfg->node_id;
    _current_state.presence = presence;
    _current_state.motion_level = motion_level;
    _current_state.confidence = confidence;
    _current_state.uptime_sec = (uint32_t)((esp_timer_get_time() / 1000000ULL));
    _current_state.seq = ++_seq;
    xSemaphoreGive(_state_mutex);
}

// ── WiFi CSI callback (called from WiFi task) ──

static void csi_callback(void *ctx, wifi_csi_info_t *info) {
    if (!info || !info->buf || info->len < 4) return;

    float amplitudes[CSI_SUBCARRIERS];
    extract_amplitudes((const int8_t *)info->buf, info->len, amplitudes);

    // Update RSSI
    xSemaphoreTake(_state_mutex, portMAX_DELAY);
    _current_state.rssi = info->rx_ctrl.rssi;
    xSemaphoreGive(_state_mutex);

    detect_presence(amplitudes);
}

// ── Report sender task ──

static void csi_report_task(void *arg) {
    TickType_t interval = pdMS_TO_TICKS(_cfg->csi_report_interval_ms);

    while (1) {
        vTaskDelay(interval);

        csi_report_t report;
        xSemaphoreTake(_state_mutex, portMAX_DELAY);
        memcpy(&report, &_current_state, sizeof(report));
        xSemaphoreGive(_state_mutex);

        if (report.seq > 0) {
            udp_send_csi_report(&report);
        }
    }
}

// ── Public API ──

void csi_radar_init(const node_config_t *cfg) {
    _cfg = cfg;
    _state_mutex = xSemaphoreCreateMutex();
    memset(&_current_state, 0, sizeof(_current_state));
    memset(_amplitude_history, 0, sizeof(_amplitude_history));
    memset(_baseline, 0, sizeof(_baseline));

    // Enable CSI
    wifi_csi_config_t csi_cfg = {
        .lltf_en = true,           // L-LTF (Legacy Long Training Field)
        .htltf_en = true,          // HT-LTF
        .stbc_htltf2_en = true,
        .ltf_merge_en = true,
        .channel_filter_en = false,
        .manu_scale = false,
        .shift = false,
    };

    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi_cfg));
    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(csi_callback, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));

    ESP_LOGI(TAG, "CSI capture enabled — calibrating baseline (%d frames)...", BASELINE_SAMPLES_NEEDED);
}

void csi_radar_start(void) {
    xTaskCreatePinnedToCore(csi_report_task, "csi_report", 4096, NULL, 5, NULL, 1);
    ESP_LOGI(TAG, "CSI report task started (interval=%dms)", _cfg->csi_report_interval_ms);
}

void csi_radar_get_state(csi_report_t *out) {
    xSemaphoreTake(_state_mutex, portMAX_DELAY);
    memcpy(out, &_current_state, sizeof(csi_report_t));
    xSemaphoreGive(_state_mutex);
}
