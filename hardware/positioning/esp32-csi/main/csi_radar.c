// csi_radar.c — WiFi CSI presence/motion detection (SOTA)
// Phase + amplitude analysis, promiscuous mode, multi-feature ML scoring
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
#define CSI_HISTORY_LEN    30    // sliding window (larger = more stable)
#define BASELINE_SAMPLES   15    // frames to calibrate empty room

// ── Feature extraction buffers ──

static float _amp_history[CSI_HISTORY_LEN][CSI_SUBCARRIERS];
static float _phase_history[CSI_HISTORY_LEN][CSI_SUBCARRIERS];
static int   _history_idx = 0;
static int   _history_count = 0;

// Baseline (empty room calibration)
static float _amp_baseline[CSI_SUBCARRIERS];
static float _phase_baseline[CSI_SUBCARRIERS];
static bool  _baseline_set = false;
static int   _baseline_samples = 0;
static float _amp_baseline_accum[CSI_SUBCARRIERS];
static float _phase_baseline_accum[CSI_SUBCARRIERS];

// Temporal stability tracker
static float _prev_amp_variance = 0.0f;
static float _prev_phase_variance = 0.0f;

static SemaphoreHandle_t _state_mutex;
static csi_report_t _current_state;
static uint32_t _seq = 0;

static const node_config_t *_cfg;
static uint32_t _csi_cb_count = 0;

// ── ML scoring weights (logistic regression) ──
// Features: amp_variance, phase_variance, baseline_deviation, temporal_stability
// Tuned empirically — good separation on ESP32 CSI data

typedef struct {
    float w_amp_var;         // amplitude variance weight
    float w_phase_var;       // phase variance weight
    float w_baseline_dev;    // deviation from baseline weight
    float w_temporal;        // temporal stability (variance-of-variance) weight
    float w_cross;           // cross-feature (amp * phase interaction) weight
    float bias;              // bias term
} ml_weights_t;

// Motion detector — high variance = motion
static const ml_weights_t W_MOTION = {
    .w_amp_var     =  0.35f,
    .w_phase_var   =  0.30f,
    .w_baseline_dev =  0.10f,
    .w_temporal    =  0.15f,
    .w_cross       =  0.10f,
    .bias          = -0.40f,
};

// Presence detector — baseline deviation + phase micro-changes = someone still
static const ml_weights_t W_PRESENCE = {
    .w_amp_var     =  0.10f,
    .w_phase_var   =  0.35f,   // phase is key for static presence (breathing)
    .w_baseline_dev =  0.30f,
    .w_temporal    =  0.15f,
    .w_cross       =  0.10f,
    .bias          = -0.25f,
};

// Sigmoid activation
static inline float sigmoid(float x) {
    if (x > 10.0f) return 1.0f;
    if (x < -10.0f) return 0.0f;
    return 1.0f / (1.0f + expf(-x));
}

// ── CSI amplitude + phase extraction ──

static void extract_features(const int8_t *raw_csi, int len,
                              float *amplitudes, float *phases) {
    int pairs = len / 2;
    if (pairs > CSI_SUBCARRIERS) pairs = CSI_SUBCARRIERS;

    for (int i = 0; i < pairs; i++) {
        float imag = (float)raw_csi[i * 2];
        float real = (float)raw_csi[i * 2 + 1];
        amplitudes[i] = sqrtf(imag * imag + real * real);
        phases[i] = atan2f(imag, real);
    }
    for (int i = pairs; i < CSI_SUBCARRIERS; i++) {
        amplitudes[i] = 0.0f;
        phases[i] = 0.0f;
    }
}

// ── Phase unwrapping (handle -pi/+pi discontinuity) ──

static float phase_diff(float a, float b) {
    float d = a - b;
    while (d > M_PI) d -= 2.0f * M_PI;
    while (d < -M_PI) d += 2.0f * M_PI;
    return d;
}

// ── Presence/motion detection with ML scoring ──

static void detect_presence(float *amplitudes, float *phases) {
    // Store in history ring buffers
    memcpy(_amp_history[_history_idx], amplitudes, sizeof(float) * CSI_SUBCARRIERS);
    memcpy(_phase_history[_history_idx], phases, sizeof(float) * CSI_SUBCARRIERS);
    _history_idx = (_history_idx + 1) % CSI_HISTORY_LEN;
    if (_history_count < CSI_HISTORY_LEN) _history_count++;

    // Baseline calibration (empty room)
    if (!_baseline_set) {
        for (int s = 0; s < CSI_SUBCARRIERS; s++) {
            _amp_baseline_accum[s] += amplitudes[s];
            _phase_baseline_accum[s] += phases[s];
        }
        _baseline_samples++;
        if ((_baseline_samples % 5) == 0) {
            ESP_LOGI(TAG, "Calibrating: %d/%d samples", _baseline_samples, BASELINE_SAMPLES);
        }
        if (_baseline_samples >= BASELINE_SAMPLES) {
            for (int s = 0; s < CSI_SUBCARRIERS; s++) {
                _amp_baseline[s] = _amp_baseline_accum[s] / (float)_baseline_samples;
                _phase_baseline[s] = _phase_baseline_accum[s] / (float)_baseline_samples;
            }
            _baseline_set = true;
            ESP_LOGI(TAG, "Baseline calibrated (%d samples, amp+phase)", _baseline_samples);
        }
        return;
    }

    if (_history_count < 5) return;

    // ── Feature extraction across all subcarriers ──

    float total_amp_var = 0.0f;
    float total_phase_var = 0.0f;
    float total_amp_dev = 0.0f;
    float total_phase_dev = 0.0f;

    for (int s = 0; s < CSI_SUBCARRIERS; s++) {
        // Amplitude: mean + variance
        float amp_mean = 0.0f;
        for (int h = 0; h < _history_count; h++) {
            amp_mean += _amp_history[h][s];
        }
        amp_mean /= (float)_history_count;

        float amp_var = 0.0f;
        for (int h = 0; h < _history_count; h++) {
            float d = _amp_history[h][s] - amp_mean;
            amp_var += d * d;
        }
        amp_var /= (float)_history_count;
        total_amp_var += amp_var;

        // Phase: variance using circular unwrapping
        float phase_ref = _phase_history[0][s];
        float phase_sum = 0.0f;
        for (int h = 0; h < _history_count; h++) {
            phase_sum += phase_diff(_phase_history[h][s], phase_ref);
        }
        float phase_mean = phase_ref + phase_sum / (float)_history_count;

        float phase_var = 0.0f;
        for (int h = 0; h < _history_count; h++) {
            float d = phase_diff(_phase_history[h][s], phase_mean);
            phase_var += d * d;
        }
        phase_var /= (float)_history_count;
        total_phase_var += phase_var;

        // Deviation from baseline
        total_amp_dev += fabsf(amp_mean - _amp_baseline[s]);
        total_phase_dev += fabsf(phase_diff(phase_mean, _phase_baseline[s]));
    }

    // Normalize to per-subcarrier averages
    float amp_variance = total_amp_var / CSI_SUBCARRIERS;
    float phase_variance = total_phase_var / CSI_SUBCARRIERS;
    float amp_deviation = total_amp_dev / CSI_SUBCARRIERS;
    float phase_deviation = total_phase_dev / CSI_SUBCARRIERS;

    // Temporal stability: how much variance itself is changing
    float temporal = fabsf(amp_variance - _prev_amp_variance) +
                     fabsf(phase_variance - _prev_phase_variance);
    _prev_amp_variance = amp_variance;
    _prev_phase_variance = phase_variance;

    // Cross-feature interaction
    float cross = sqrtf(amp_variance * phase_variance);

    // ── Normalize features to ~[0,1] range for scoring ──

    float f_amp_var   = fminf(amp_variance / 20.0f, 1.0f);
    float f_phase_var = fminf(phase_variance / 1.5f, 1.0f);
    float f_dev       = fminf((amp_deviation + phase_deviation) / 15.0f, 1.0f);
    float f_temporal  = fminf(temporal / 10.0f, 1.0f);
    float f_cross     = fminf(cross / 5.0f, 1.0f);

    // ── ML scoring ──

    float motion_score = sigmoid(
        W_MOTION.w_amp_var * f_amp_var +
        W_MOTION.w_phase_var * f_phase_var +
        W_MOTION.w_baseline_dev * f_dev +
        W_MOTION.w_temporal * f_temporal +
        W_MOTION.w_cross * f_cross +
        W_MOTION.bias
    );

    float presence_score = sigmoid(
        W_PRESENCE.w_amp_var * f_amp_var +
        W_PRESENCE.w_phase_var * f_phase_var +
        W_PRESENCE.w_baseline_dev * f_dev +
        W_PRESENCE.w_temporal * f_temporal +
        W_PRESENCE.w_cross * f_cross +
        W_PRESENCE.bias
    );

    // ── Classify using ML scores ──

    uint8_t presence;
    uint8_t motion_level;
    uint8_t confidence;

    if (motion_score > 0.55f) {
        presence = PRESENCE_MOVING;
        motion_level = (uint8_t)(fminf(motion_score * 255.0f, 255.0f));
        confidence = (uint8_t)(fminf(motion_score * 100.0f, 100.0f));
    } else if (presence_score > 0.50f) {
        presence = PRESENCE_STATIC;
        motion_level = (uint8_t)(fminf(amp_variance, 255.0f));
        confidence = (uint8_t)(fminf(presence_score * 100.0f, 100.0f));
    } else {
        presence = PRESENCE_EMPTY;
        motion_level = 0;
        confidence = (uint8_t)(fminf((1.0f - presence_score) * 100.0f, 100.0f));
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
    if (!info) return;

    _csi_cb_count++;
    if (_csi_cb_count <= 3 || (_csi_cb_count % 200) == 0) {
        ESP_LOGI(TAG, "CSI frame #%lu len=%d rssi=%d",
                 (unsigned long)_csi_cb_count,
                 info->buf ? info->len : 0, info->rx_ctrl.rssi);
    }

    float amplitudes[CSI_SUBCARRIERS];
    float phases[CSI_SUBCARRIERS];

    if (info->buf && info->len >= 4) {
        extract_features((const int8_t *)info->buf, info->len, amplitudes, phases);
    } else {
        memset(amplitudes, 0, sizeof(amplitudes));
        memset(phases, 0, sizeof(phases));
    }

    // Update RSSI
    xSemaphoreTake(_state_mutex, portMAX_DELAY);
    _current_state.rssi = info->rx_ctrl.rssi;
    xSemaphoreGive(_state_mutex);

    detect_presence(amplitudes, phases);
}

// ── Promiscuous mode handler ──
// Required for promiscuous mode — CSI is still delivered via csi_callback,
// this just needs to exist for the mode to work.

static void promisc_rx_callback(void *buf, wifi_promiscuous_pkt_type_t type) {
    (void)buf;
    (void)type;
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

        // Always send — hub needs heartbeats even when calibrating
        udp_send_csi_report(&report);
    }
}

// ── Public API ──

void csi_radar_init(const node_config_t *cfg) {
    _cfg = cfg;
    _state_mutex = xSemaphoreCreateMutex();
    memset(&_current_state, 0, sizeof(_current_state));
    _current_state.magic = OZZU_MAGIC_CSI;
    _current_state.node_id = cfg->node_id;
    memset(_amp_history, 0, sizeof(_amp_history));
    memset(_phase_history, 0, sizeof(_phase_history));
    memset(_amp_baseline, 0, sizeof(_amp_baseline));
    memset(_phase_baseline, 0, sizeof(_phase_baseline));
    memset(_amp_baseline_accum, 0, sizeof(_amp_baseline_accum));
    memset(_phase_baseline_accum, 0, sizeof(_phase_baseline_accum));

    // Enable CSI collection
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

    // Enable promiscuous mode for passive CSI capture from ALL WiFi frames
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_rx_cb(promisc_rx_callback));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));

    wifi_promiscuous_filter_t filter = {
        .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA,
    };
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_filter(&filter));

    ESP_LOGI(TAG, "CSI capture enabled — promiscuous mode ON, phase+amplitude analysis");
    ESP_LOGI(TAG, "Calibrating baseline (%d frames)...", BASELINE_SAMPLES);
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
