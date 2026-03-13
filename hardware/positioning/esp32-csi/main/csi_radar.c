// csi_radar.c — WiFi CSI presence/motion detection (SOTA v2)
// Phase + amplitude, promiscuous mode, ML scoring, Hampel filter,
// subcarrier selection, EMA smoothing, hysteresis
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

// ── Subcarrier selection ──
// ESP32 802.11n HT20: 64 subcarriers, but only 52 carry data.
// DC subcarrier (index 0) and edge/guard subcarriers are noisy — skip them.
#define CSI_RAW_MAX        64
#define CSI_SKIP_DC         1    // skip DC (center) subcarrier
#define CSI_SKIP_EDGE       3    // skip 3 edge subcarriers on each side
#define CSI_SUBCARRIERS    46    // 52 - DC - 2*EDGE = 46 usable

// ── Processing parameters ──
#define CSI_HISTORY_LEN    30    // sliding window
#define BASELINE_SAMPLES   15    // calibration frames
#define EMA_ALPHA          0.15f // exponential moving average decay
#define HAMPEL_WINDOW       5    // Hampel filter half-window
#define HAMPEL_THRESHOLD   3.0f  // MAD multiplier for outlier detection

// ── Hysteresis ──
#define HYSTERESIS_FRAMES   4    // must see new state N times before switching
#define STALE_TIMEOUT_MS   10000 // 10s without CSI = mark stale

// ── Feature buffers ──

static float _amp_history[CSI_HISTORY_LEN][CSI_SUBCARRIERS];
static float _phase_history[CSI_HISTORY_LEN][CSI_SUBCARRIERS];
static int   _history_idx = 0;
static int   _history_count = 0;

// Baseline (empty room)
static float _amp_baseline[CSI_SUBCARRIERS];
static float _phase_baseline[CSI_SUBCARRIERS];
static bool  _baseline_set = false;
static int   _baseline_samples = 0;
static float _amp_baseline_accum[CSI_SUBCARRIERS];
static float _phase_baseline_accum[CSI_SUBCARRIERS];

// EMA smoothed features
static float _ema_amp_var = 0.0f;
static float _ema_phase_var = 0.0f;
static float _ema_deviation = 0.0f;
static bool  _ema_init = false;

// Temporal stability
static float _prev_amp_variance = 0.0f;
static float _prev_phase_variance = 0.0f;

// Hysteresis state
static uint8_t _pending_state = 0;
static int     _pending_count = 0;
static uint8_t _confirmed_state = 0;

static SemaphoreHandle_t _state_mutex;
static csi_report_t _current_state;
static uint32_t _seq = 0;

static const node_config_t *_cfg;
static uint32_t _csi_cb_count = 0;

// ── ML scoring weights (logistic regression) ──

typedef struct {
    float w_amp_var;
    float w_phase_var;
    float w_baseline_dev;
    float w_temporal;
    float w_cross;
    float bias;
} ml_weights_t;

// Motion: high variance + temporal jitter
static const ml_weights_t W_MOTION = {
    .w_amp_var      =  0.30f,
    .w_phase_var    =  0.25f,
    .w_baseline_dev =  0.10f,
    .w_temporal     =  0.20f,
    .w_cross        =  0.15f,
    .bias           = -0.35f,
};

// Presence: phase micro-changes + baseline shift
static const ml_weights_t W_PRESENCE = {
    .w_amp_var      =  0.10f,
    .w_phase_var    =  0.35f,
    .w_baseline_dev =  0.30f,
    .w_temporal     =  0.10f,
    .w_cross        =  0.15f,
    .bias           = -0.20f,
};

static inline float sigmoid(float x) {
    if (x > 10.0f) return 1.0f;
    if (x < -10.0f) return 0.0f;
    return 1.0f / (1.0f + expf(-x));
}

// ── Hampel filter — replace outliers with median ──

static float median3(float a, float b, float c) {
    if (a > b) { float t = a; a = b; b = t; }
    if (b > c) { float t = b; b = c; c = t; }
    if (a > b) { b = a; }
    return b;
}

static void hampel_filter(float *data, int len) {
    float filtered[CSI_SUBCARRIERS];
    memcpy(filtered, data, sizeof(float) * len);

    for (int i = HAMPEL_WINDOW; i < len - HAMPEL_WINDOW; i++) {
        // Compute median in window
        float window[2 * HAMPEL_WINDOW + 1];
        for (int j = -HAMPEL_WINDOW; j <= HAMPEL_WINDOW; j++) {
            window[j + HAMPEL_WINDOW] = data[i + j];
        }
        // Simple median for small window: sort
        int wsize = 2 * HAMPEL_WINDOW + 1;
        for (int a = 0; a < wsize - 1; a++) {
            for (int b = a + 1; b < wsize; b++) {
                if (window[a] > window[b]) {
                    float t = window[a]; window[a] = window[b]; window[b] = t;
                }
            }
        }
        float med = window[wsize / 2];

        // Compute MAD (Median Absolute Deviation)
        float deviations[2 * HAMPEL_WINDOW + 1];
        for (int j = 0; j < wsize; j++) {
            deviations[j] = fabsf(data[i + j - HAMPEL_WINDOW] - med);
        }
        for (int a = 0; a < wsize - 1; a++) {
            for (int b = a + 1; b < wsize; b++) {
                if (deviations[a] > deviations[b]) {
                    float t = deviations[a]; deviations[a] = deviations[b]; deviations[b] = t;
                }
            }
        }
        float mad = deviations[wsize / 2] * 1.4826f; // scale to std dev

        if (mad > 0.001f && fabsf(data[i] - med) > HAMPEL_THRESHOLD * mad) {
            filtered[i] = med; // replace outlier
        }
    }

    memcpy(data, filtered, sizeof(float) * len);
}

// ── Feature extraction with subcarrier selection ──

static void extract_features(const int8_t *raw_csi, int len,
                              float *amplitudes, float *phases) {
    int pairs = len / 2;
    if (pairs > CSI_RAW_MAX) pairs = CSI_RAW_MAX;

    float raw_amp[CSI_RAW_MAX];
    float raw_phase[CSI_RAW_MAX];

    for (int i = 0; i < pairs; i++) {
        float imag = (float)raw_csi[i * 2];
        float real = (float)raw_csi[i * 2 + 1];
        raw_amp[i] = sqrtf(imag * imag + real * real);
        raw_phase[i] = atan2f(imag, real);
    }
    for (int i = pairs; i < CSI_RAW_MAX; i++) {
        raw_amp[i] = 0.0f;
        raw_phase[i] = 0.0f;
    }

    // Select usable subcarriers: skip DC and edges
    int out_idx = 0;
    for (int i = 0; i < pairs && out_idx < CSI_SUBCARRIERS; i++) {
        // Skip DC subcarrier (center)
        if (i == pairs / 2) continue;
        // Skip edge subcarriers
        if (i < CSI_SKIP_EDGE || i >= pairs - CSI_SKIP_EDGE) continue;

        amplitudes[out_idx] = raw_amp[i];
        phases[out_idx] = raw_phase[i];
        out_idx++;
    }
    for (int i = out_idx; i < CSI_SUBCARRIERS; i++) {
        amplitudes[i] = 0.0f;
        phases[i] = 0.0f;
    }

    // Hampel filter to remove outlier subcarriers
    hampel_filter(amplitudes, CSI_SUBCARRIERS);
}

// ── Phase unwrapping ──

static float phase_diff(float a, float b) {
    float d = a - b;
    while (d > M_PI) d -= 2.0f * M_PI;
    while (d < -M_PI) d += 2.0f * M_PI;
    return d;
}

// ── Presence/motion detection ──

static void detect_presence(float *amplitudes, float *phases) {
    memcpy(_amp_history[_history_idx], amplitudes, sizeof(float) * CSI_SUBCARRIERS);
    memcpy(_phase_history[_history_idx], phases, sizeof(float) * CSI_SUBCARRIERS);
    _history_idx = (_history_idx + 1) % CSI_HISTORY_LEN;
    if (_history_count < CSI_HISTORY_LEN) _history_count++;

    // Baseline calibration
    if (!_baseline_set) {
        for (int s = 0; s < CSI_SUBCARRIERS; s++) {
            _amp_baseline_accum[s] += amplitudes[s];
            _phase_baseline_accum[s] += phases[s];
        }
        _baseline_samples++;
        if ((_baseline_samples % 5) == 0) {
            ESP_LOGI(TAG, "Calibrating: %d/%d", _baseline_samples, BASELINE_SAMPLES);
        }
        if (_baseline_samples >= BASELINE_SAMPLES) {
            for (int s = 0; s < CSI_SUBCARRIERS; s++) {
                _amp_baseline[s] = _amp_baseline_accum[s] / (float)_baseline_samples;
                _phase_baseline[s] = _phase_baseline_accum[s] / (float)_baseline_samples;
            }
            _baseline_set = true;
            ESP_LOGI(TAG, "Baseline calibrated (%d samples)", _baseline_samples);
        }
        return;
    }

    if (_history_count < 5) return;

    // ── Feature extraction ──

    float total_amp_var = 0.0f;
    float total_phase_var = 0.0f;
    float total_amp_dev = 0.0f;
    float total_phase_dev = 0.0f;

    for (int s = 0; s < CSI_SUBCARRIERS; s++) {
        float amp_mean = 0.0f;
        for (int h = 0; h < _history_count; h++)
            amp_mean += _amp_history[h][s];
        amp_mean /= (float)_history_count;

        float amp_var = 0.0f;
        for (int h = 0; h < _history_count; h++) {
            float d = _amp_history[h][s] - amp_mean;
            amp_var += d * d;
        }
        amp_var /= (float)_history_count;
        total_amp_var += amp_var;

        // Phase variance with circular unwrapping
        float phase_ref = _phase_history[0][s];
        float phase_sum = 0.0f;
        for (int h = 0; h < _history_count; h++)
            phase_sum += phase_diff(_phase_history[h][s], phase_ref);
        float phase_mean = phase_ref + phase_sum / (float)_history_count;

        float phase_var = 0.0f;
        for (int h = 0; h < _history_count; h++) {
            float d = phase_diff(_phase_history[h][s], phase_mean);
            phase_var += d * d;
        }
        phase_var /= (float)_history_count;
        total_phase_var += phase_var;

        total_amp_dev += fabsf(amp_mean - _amp_baseline[s]);
        total_phase_dev += fabsf(phase_diff(phase_mean, _phase_baseline[s]));
    }

    float amp_variance = total_amp_var / CSI_SUBCARRIERS;
    float phase_variance = total_phase_var / CSI_SUBCARRIERS;
    float deviation = (total_amp_dev + total_phase_dev) / CSI_SUBCARRIERS;

    // ── EMA smoothing (reduces noise-induced state flipping) ──

    if (!_ema_init) {
        _ema_amp_var = amp_variance;
        _ema_phase_var = phase_variance;
        _ema_deviation = deviation;
        _ema_init = true;
    } else {
        _ema_amp_var = EMA_ALPHA * amp_variance + (1.0f - EMA_ALPHA) * _ema_amp_var;
        _ema_phase_var = EMA_ALPHA * phase_variance + (1.0f - EMA_ALPHA) * _ema_phase_var;
        _ema_deviation = EMA_ALPHA * deviation + (1.0f - EMA_ALPHA) * _ema_deviation;
    }

    // Temporal stability
    float temporal = fabsf(_ema_amp_var - _prev_amp_variance) +
                     fabsf(_ema_phase_var - _prev_phase_variance);
    _prev_amp_variance = _ema_amp_var;
    _prev_phase_variance = _ema_phase_var;

    float cross = sqrtf(_ema_amp_var * _ema_phase_var);

    // ── Normalize features ──

    float f_amp_var   = fminf(_ema_amp_var / 20.0f, 1.0f);
    float f_phase_var = fminf(_ema_phase_var / 1.5f, 1.0f);
    float f_dev       = fminf(_ema_deviation / 15.0f, 1.0f);
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

    // ── Classify ──

    uint8_t raw_state;
    uint8_t motion_level;
    uint8_t confidence;

    if (motion_score > 0.55f) {
        raw_state = PRESENCE_MOVING;
        motion_level = (uint8_t)(fminf(motion_score * 255.0f, 255.0f));
        confidence = (uint8_t)(fminf(motion_score * 100.0f, 100.0f));
    } else if (presence_score > 0.50f) {
        raw_state = PRESENCE_STATIC;
        motion_level = (uint8_t)(fminf(_ema_amp_var, 255.0f));
        confidence = (uint8_t)(fminf(presence_score * 100.0f, 100.0f));
    } else {
        raw_state = PRESENCE_EMPTY;
        motion_level = 0;
        confidence = (uint8_t)(fminf((1.0f - presence_score) * 100.0f, 100.0f));
    }

    // ── Hysteresis — require N consistent frames before switching state ──

    if (raw_state == _pending_state) {
        _pending_count++;
    } else {
        _pending_state = raw_state;
        _pending_count = 1;
    }

    if (_pending_count >= HYSTERESIS_FRAMES) {
        _confirmed_state = _pending_state;
    }

    // Use confirmed state but raw confidence/motion for responsiveness
    uint8_t final_presence = _confirmed_state;

    // Boost confidence when state is stable
    if (_pending_count >= HYSTERESIS_FRAMES * 2) {
        confidence = (uint8_t)fminf(confidence + 10, 100);
    }

    // Update state (thread-safe)
    xSemaphoreTake(_state_mutex, portMAX_DELAY);
    _current_state.magic = OZZU_MAGIC_CSI;
    _current_state.node_id = _cfg->node_id;
    _current_state.presence = final_presence;
    _current_state.motion_level = motion_level;
    _current_state.confidence = confidence;
    _current_state.uptime_sec = (uint32_t)((esp_timer_get_time() / 1000000ULL));
    _current_state.seq = ++_seq;
    xSemaphoreGive(_state_mutex);
}

// ── WiFi CSI callback ──

static void csi_callback(void *ctx, wifi_csi_info_t *info) {
    if (!info) return;

    _csi_cb_count++;
    if (_csi_cb_count <= 3 || (_csi_cb_count % 500) == 0) {
        ESP_LOGI(TAG, "CSI #%lu len=%d rssi=%d",
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

    xSemaphoreTake(_state_mutex, portMAX_DELAY);
    _current_state.rssi = info->rx_ctrl.rssi;
    xSemaphoreGive(_state_mutex);

    detect_presence(amplitudes, phases);
}

// ── Promiscuous mode handler ──

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

    wifi_csi_config_t csi_cfg = {
        .lltf_en = true,
        .htltf_en = true,
        .stbc_htltf2_en = true,
        .ltf_merge_en = true,
        .channel_filter_en = false,
        .manu_scale = false,
        .shift = false,
    };

    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi_cfg));
    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(csi_callback, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));

    // Promiscuous mode — capture CSI from all WiFi traffic
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_rx_cb(promisc_rx_callback));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));
    wifi_promiscuous_filter_t filter = {
        .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA,
    };
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_filter(&filter));

    ESP_LOGI(TAG, "CSI SOTA v2 — promiscuous, phase+amp, Hampel, EMA, hysteresis");
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
