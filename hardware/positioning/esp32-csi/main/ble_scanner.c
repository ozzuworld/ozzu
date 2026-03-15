// ble_scanner.c — BLE scanner + IRK enrollment for iOS device tracking
//
// Normal mode: passive scan, report device sightings to hub.
// Pair mode: advertise as "Ozzu-Node-X", accept bonding, extract IRK.
// IRK resolution: resolve randomized iOS MACs to real identity during scan.

#include "ble_scanner.h"
#include "udp_sender.h"
#include "protocol.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_gap.h"
#include "host/ble_store.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include <string.h>
#include <stdio.h>

static const char *TAG = "ble_scan";

static const node_config_t *_cfg;
static SemaphoreHandle_t _devices_mutex;

// Discovered devices buffer
static ble_device_t _devices[MAX_BLE_DEVICES_PER_REPORT];
static int _device_count = 0;
static uint32_t _ble_seq = 0;

// ── IRK storage ──

typedef struct {
    uint8_t irk[IRK_LEN];
    uint8_t addr[6];        // identity address
    uint8_t addr_type;
    char    label[16];
    bool    valid;
} stored_irk_t;

static stored_irk_t _irks[MAX_TRACKED_IRKS];
static int _irk_count = 0;
static SemaphoreHandle_t _irk_mutex;

// ── Pairing mode state ──

static uint8_t _own_addr_type = BLE_OWN_ADDR_PUBLIC;

static volatile bool _pair_mode = false;
static volatile bool _pair_success = false;
static uint16_t _pair_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t _pair_timeout_sec = 60;
static esp_timer_handle_t _pair_timer = NULL;
static ble_addr_t _peer_id_addr;
static bool _peer_addr_valid = false;

// ── NVS persistence for IRKs ──

#define NVS_IRK_NAMESPACE "ozzu_irk"

static void _save_irks_to_nvs(void) {
    nvs_handle_t h;
    if (nvs_open(NVS_IRK_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return;

    nvs_set_u8(h, "count", (uint8_t)_irk_count);
    for (int i = 0; i < _irk_count; i++) {
        char key[16];
        snprintf(key, sizeof(key), "irk_%d", i);
        nvs_set_blob(h, key, &_irks[i], sizeof(stored_irk_t));
    }
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "Saved %d IRKs to NVS", _irk_count);
}

static void _load_irks_from_nvs(void) {
    nvs_handle_t h;
    if (nvs_open(NVS_IRK_NAMESPACE, NVS_READONLY, &h) != ESP_OK) return;

    uint8_t count = 0;
    if (nvs_get_u8(h, "count", &count) != ESP_OK || count > MAX_TRACKED_IRKS) {
        nvs_close(h);
        return;
    }

    for (int i = 0; i < count; i++) {
        char key[16];
        snprintf(key, sizeof(key), "irk_%d", i);
        size_t len = sizeof(stored_irk_t);
        if (nvs_get_blob(h, key, &_irks[i], &len) == ESP_OK) {
            _irks[i].valid = true;
            _irk_count = i + 1;
        }
    }
    nvs_close(h);
    ESP_LOGI(TAG, "Loaded %d IRKs from NVS", _irk_count);
}

// ── IRK address resolution ──
// Resolve a random resolvable address (RPA) against stored IRKs.
// RPA format: top 2 bits of addr[5] == 01 (0x40-0x7F).
// Resolution: hash = AES-128(IRK, prand) — compare top 3 bytes.

#include "mbedtls/aes.h"

static bool _is_rpa(const uint8_t *addr, uint8_t addr_type) {
    // RPA: addr_type=random AND top 2 bits of MSB = 01
    if (addr_type != 1) return false;
    return (addr[5] & 0xC0) == 0x40;
}

static bool _resolve_rpa(const uint8_t *rpa, const uint8_t *irk) {
    // prand = last 3 bytes of address (MSB side): rpa[3], rpa[4], rpa[5]
    // hash  = first 3 bytes: rpa[0], rpa[1], rpa[2]
    // Expected: AES-128(IRK, prand_padded)[0..2] == hash

    uint8_t plaintext[16] = {0};
    // prand goes in last 3 bytes of the 16-byte block (big-endian per BLE spec)
    plaintext[13] = rpa[3];
    plaintext[14] = rpa[4];
    plaintext[15] = rpa[5];

    uint8_t cipher[16];
    mbedtls_aes_context ctx;
    mbedtls_aes_init(&ctx);
    mbedtls_aes_setkey_enc(&ctx, irk, 128);
    mbedtls_aes_crypt_ecb(&ctx, MBEDTLS_AES_ENCRYPT, plaintext, cipher);
    mbedtls_aes_free(&ctx);

    // Compare hash: cipher[13..15] == rpa[0..2]
    return cipher[13] == rpa[0] && cipher[14] == rpa[1] && cipher[15] == rpa[2];
}

// Try to resolve an RPA against all stored IRKs.
// If resolved, copies the identity address into resolved_addr and returns the label.
static const char *_try_resolve(const uint8_t *rpa, uint8_t addr_type,
                                uint8_t *resolved_addr, uint8_t *resolved_type) {
    if (!_is_rpa(rpa, addr_type)) return NULL;

    xSemaphoreTake(_irk_mutex, portMAX_DELAY);
    for (int i = 0; i < _irk_count; i++) {
        if (!_irks[i].valid) continue;
        if (_resolve_rpa(rpa, _irks[i].irk)) {
            memcpy(resolved_addr, _irks[i].addr, 6);
            *resolved_type = _irks[i].addr_type;
            const char *label = _irks[i].label;
            xSemaphoreGive(_irk_mutex);
            ESP_LOGD(TAG, "Resolved RPA → %s", label);
            return label;
        }
    }
    xSemaphoreGive(_irk_mutex);
    return NULL;
}

// ── BLE GAP event handler (scan mode) ──

static int ble_gap_event(struct ble_gap_event *event, void *arg) {
    if (event->type != BLE_GAP_EVENT_DISC) return 0;

    const struct ble_gap_disc_desc *desc = &event->disc;

    // Try IRK resolution for random addresses
    uint8_t report_addr[6];
    uint8_t report_addr_type = desc->addr.type;
    memcpy(report_addr, desc->addr.val, 6);

    uint8_t resolved_addr[6];
    uint8_t resolved_type;
    const char *label = _try_resolve(desc->addr.val, desc->addr.type,
                                     resolved_addr, &resolved_type);
    if (label != NULL) {
        // Use identity address instead of randomized one
        memcpy(report_addr, resolved_addr, 6);
        report_addr_type = resolved_type;
    }

    xSemaphoreTake(_devices_mutex, portMAX_DELAY);

    // Check if we already have this device (update RSSI)
    bool found = false;
    for (int i = 0; i < _device_count; i++) {
        if (memcmp(_devices[i].addr, report_addr, 6) == 0) {
            _devices[i].rssi = desc->rssi;
            found = true;
            break;
        }
    }

    // Add new device if space
    if (!found && _device_count < MAX_BLE_DEVICES_PER_REPORT) {
        ble_device_t *d = &_devices[_device_count];
        memcpy(d->addr, report_addr, 6);
        d->rssi = desc->rssi;
        d->addr_type = report_addr_type;
        d->_reserved = 0;
        _device_count++;
    }

    xSemaphoreGive(_devices_mutex);
    return 0;
}

// ── Pairing mode GAP event handler ──

static void _send_irk_to_hub(const uint8_t *irk, const uint8_t *addr,
                              uint8_t addr_type, const char *label) {
    irk_header_t header = {
        .magic = OZZU_MAGIC_IRK,
        .node_id = _cfg->node_id,
        .action = IRK_ACTION_REPORT,
        .irk_count = 1,
        ._reserved = 0,
    };
    irk_entry_t entry = {0};
    memcpy(entry.irk, irk, IRK_LEN);
    memcpy(entry.addr, addr, 6);
    entry.addr_type = addr_type;
    strncpy(entry.label, label ? label : "phone", sizeof(entry.label) - 1);

    udp_send_irk_report(&header, &entry);
    ESP_LOGI(TAG, "Sent IRK to hub for device '%s'", entry.label);
}

static void _extract_irk_from_bond(const ble_addr_t *peer_addr) {
    // Read peer security info from NimBLE bond store
    struct ble_store_value_sec val = {0};
    struct ble_store_key_sec key = {0};
    key.peer_addr = *peer_addr;

    int rc = ble_store_read_peer_sec(&key, &val);
    if (rc != 0) {
        ESP_LOGW(TAG, "Failed to read peer bond: rc=%d", rc);
        return;
    }

    if (!val.irk_present) {
        ESP_LOGW(TAG, "Bonded but no IRK received — device may not distribute IRK");
        return;
    }

    ESP_LOGI(TAG, "IRK extracted from bonded device!");

    // Store locally
    ble_scanner_add_irk(val.irk, peer_addr->val, peer_addr->type, "phone");

    // Send to hub
    _send_irk_to_hub(val.irk, peer_addr->val, peer_addr->type, "phone");

    _pair_success = true;
}

static int _pair_gap_event(struct ble_gap_event *event, void *arg) {
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                _pair_conn_handle = event->connect.conn_handle;
                ESP_LOGW(TAG, ">>> Peer CONNECTED (handle=%d) <<<", _pair_conn_handle);
                // Save peer address for disconnect fallback IRK read
                struct ble_gap_conn_desc cd;
                if (ble_gap_conn_find(_pair_conn_handle, &cd) == 0) {
                    _peer_id_addr = cd.peer_id_addr;
                    _peer_addr_valid = true;
                }
                // ACTIVELY initiate security — Derek Seaman's key fix
                // iOS won't start pairing on its own; we must request it
                ESP_LOGW(TAG, ">>> Initiating security in 100ms <<<");
                vTaskDelay(pdMS_TO_TICKS(100));  // Brief settle
                int rc = ble_gap_security_initiate(_pair_conn_handle);
                ESP_LOGW(TAG, ">>> security_initiate rc=%d <<<", rc);
            } else {
                ESP_LOGW(TAG, "Connection failed: %d", event->connect.status);
            }
            break;

        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGW(TAG, ">>> Peer DISCONNECTED — reason=%d <<<",
                     event->disconnect.reason);
            // Fallback IRK read on disconnect — Derek Seaman's approach
            if (!_pair_success && _peer_addr_valid) {
                ESP_LOGW(TAG, ">>> Trying IRK read on disconnect (fallback) <<<");
                _extract_irk_from_bond(&_peer_id_addr);
            }
            // Also try after 800ms delay (NVS flush delay)
            if (!_pair_success && _peer_addr_valid) {
                vTaskDelay(pdMS_TO_TICKS(800));
                ESP_LOGW(TAG, ">>> Trying IRK read after 800ms NVS flush <<<");
                _extract_irk_from_bond(&_peer_id_addr);
            }
            if (_pair_success) {
                ESP_LOGW(TAG, ">>> PAIRING COMPLETE — IRK extracted <<<");
            }
            _pair_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            _peer_addr_valid = false;
            // Cancel timeout timer and exit pair mode
            if (_pair_timer) {
                esp_timer_stop(_pair_timer);
                esp_timer_delete(_pair_timer);
                _pair_timer = NULL;
            }
            _pair_mode = false;
            ESP_LOGI(TAG, "Restarting WiFi after pairing...");
            esp_wifi_start();
            esp_wifi_connect();
            break;

        case BLE_GAP_EVENT_ENC_CHANGE:
            if (event->enc_change.status == 0) {
                ESP_LOGW(TAG, ">>> ENCRYPTION ESTABLISHED — extracting IRK <<<");

                // Get peer address
                struct ble_gap_conn_desc desc;
                if (ble_gap_conn_find(event->enc_change.conn_handle, &desc) == 0) {
                    _extract_irk_from_bond(&desc.peer_id_addr);
                }
            } else {
                ESP_LOGW(TAG, "Encryption failed: %d — clearing bonds", event->enc_change.status);
                struct ble_gap_conn_desc desc;
                if (ble_gap_conn_find(event->enc_change.conn_handle, &desc) == 0) {
                    ble_store_util_delete_peer(&desc.peer_id_addr);
                }
            }
            break;

        case BLE_GAP_EVENT_PASSKEY_ACTION:
            ESP_LOGW(TAG, ">>> PASSKEY ACTION: %d <<<",
                     event->passkey.params.action);
            if (event->passkey.params.action == BLE_SM_IOACT_NUMCMP) {
                // Numeric comparison — auto-confirm
                struct ble_sm_io pk = {0};
                pk.action = BLE_SM_IOACT_NUMCMP;
                pk.numcmp_accept = 1;
                ble_sm_inject_io(event->passkey.conn_handle, &pk);
            } else if (event->passkey.params.action == BLE_SM_IOACT_NONE) {
                // Just Works — nothing to do, NimBLE handles it
                ESP_LOGI(TAG, "Just Works pairing — no action needed");
            }
            break;

        case BLE_GAP_EVENT_REPEAT_PAIRING: {
            // Delete old bond, allow re-pairing
            ESP_LOGI(TAG, "Repeat pairing requested — clearing old bond");
            struct ble_gap_conn_desc desc;
            ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc);
            ble_store_util_delete_peer(&desc.peer_id_addr);
            return BLE_GAP_REPEAT_PAIRING_RETRY;
        }

        default:
            ESP_LOGD(TAG, "Pair GAP event: %d", event->type);
            break;
    }
    return 0;
}

// ── GATT services for iOS enrollment (matching ESPresense exactly) ──
// Heart Rate Service (0x180D) with READ_ENC characteristics.
// When iOS reads an encrypted characteristic, NimBLE returns
// "insufficient encryption" → iOS triggers pairing dialog automatically.
// This is the proven ESPresense approach (PR #1655, iOS 17/18 fix).

static int _hrs_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg) {
    uint8_t hrm[] = {0x00, 60};  // flags=uint8, heart_rate=60 bpm
    os_mbuf_append(ctxt->om, hrm, sizeof(hrm));
    return 0;
}

static int _devinfo_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                               struct ble_gatt_access_ctxt *ctxt, void *arg) {
    const char *val = "Ozzu";
    os_mbuf_append(ctxt->om, val, strlen(val));
    return 0;
}

static const struct ble_gatt_svc_def _gatt_svcs[] = {
    {
        // Heart Rate Service (0x180D) — ESPresense uses this, not HID
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(0x180D),
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                // Heart Rate Measurement (0x2A37) — READ_ENC triggers iOS pairing
                .uuid = BLE_UUID16_DECLARE(0x2A37),
                .access_cb = _hrs_access_cb,
                .flags = BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_NOTIFY,
            },
            { 0 }
        },
    },
    {
        // Device Information Service (0x180A)
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = BLE_UUID16_DECLARE(0x180A),
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                // Manufacturer Name (0x2A29) — READ_ENC
                .uuid = BLE_UUID16_DECLARE(0x2A29),
                .access_cb = _devinfo_access_cb,
                .flags = BLE_GATT_CHR_F_READ_ENC,
            },
            { 0 }
        },
    },
    { 0 }  // end of services
};

// ── Pairing mode advertising ──

static void _start_advertising(void) {
    struct ble_gap_adv_params adv_params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,   // undirected connectable
        .disc_mode = BLE_GAP_DISC_MODE_GEN,   // general discoverable
        .itvl_min = 0x0020,  // 20ms
        .itvl_max = 0x0040,  // 40ms
    };

    // Set device name
    char name[20];
    snprintf(name, sizeof(name), "Ozzu-Node-%d", _cfg->node_id);
    ble_svc_gap_device_name_set(name);

    // Build advertising data with HID service UUID so iOS shows it in Settings
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (uint8_t *)name;
    fields.name_len = strlen(name);
    fields.name_is_complete = 1;

    // Advertise Heart Rate service (0x180D) — matching ESPresense
    // iOS discovers this, tries to read encrypted chars, triggers pairing
    static const ble_uuid16_t svc_uuids[] = {
        BLE_UUID16_INIT(0x180D),  // Heart Rate
    };
    fields.uuids16 = svc_uuids;
    fields.num_uuids16 = 1;
    fields.uuids16_is_complete = 1;

    // Set appearance to Heart Rate Sensor
    fields.appearance = 0x0340;  // Generic Heart Rate Sensor
    fields.appearance_is_present = 1;

    ble_gap_adv_set_fields(&fields);

    // Add scan response with preferred connection parameters (helps iPhone connections)
    struct ble_hs_adv_fields rsp_fields = {0};
    rsp_fields.tx_pwr_lvl = BLE_HS_ADV_TX_PWR_LVL_AUTO;
    rsp_fields.tx_pwr_lvl_is_present = 1;
    ble_gap_adv_rsp_set_fields(&rsp_fields);

    int rc = -1;
    for (int attempt = 0; attempt < 5; attempt++) {
        rc = ble_gap_adv_start(_own_addr_type, NULL, BLE_HS_FOREVER,
                                    &adv_params, _pair_gap_event, NULL);
        if (rc == 0) break;
        ESP_LOGW(TAG, "Advertising start attempt %d failed: %d, retrying...", attempt + 1, rc);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
    if (rc != 0) {
        ESP_LOGE(TAG, "Advertising failed after 5 attempts — restarting WiFi");
        _pair_mode = false;
        esp_wifi_start();
        esp_wifi_connect();
        return;
    }

    ESP_LOGI(TAG, "=== PAIRING MODE: Advertising as '%s' ===", name);
    ESP_LOGI(TAG, "Open iPhone Settings → Bluetooth → tap '%s' to pair", name);
}

// ── Scan cycle task ──

static void ble_scan_task(void *arg) {
    struct ble_gap_disc_params scan_params = {
        .itvl = 0x50,             // 50ms interval
        .window = 0x30,           // 30ms window
        .filter_policy = BLE_HCI_SCAN_FILT_NO_WL,
        .limited = 0,
        .passive = 1,             // passive scan — don't send scan requests
        .filter_duplicates = 0,   // we handle dedup ourselves
    };

    while (1) {
        // If in pairing mode, wait for it to finish
        if (_pair_mode) {
            vTaskDelay(pdMS_TO_TICKS(500));
            continue;
        }

        // Clear device buffer
        xSemaphoreTake(_devices_mutex, portMAX_DELAY);
        _device_count = 0;
        xSemaphoreGive(_devices_mutex);

        // Start scan
        int rc = ble_gap_disc(_own_addr_type, _cfg->ble_scan_interval_ms,
                              &scan_params, ble_gap_event, NULL);
        if (rc != 0 && rc != BLE_HS_EALREADY) {
            ESP_LOGW(TAG, "Scan start failed: %d", rc);
        }

        // Wait for scan duration
        vTaskDelay(pdMS_TO_TICKS(_cfg->ble_scan_interval_ms));

        // Stop scan
        ble_gap_disc_cancel();

        // Send report
        xSemaphoreTake(_devices_mutex, portMAX_DELAY);
        if (_device_count > 0) {
            ble_report_header_t header = {
                .magic = OZZU_MAGIC_BLE,
                .node_id = _cfg->node_id,
                .device_count = (uint8_t)_device_count,
                .scan_duration_ms = _cfg->ble_scan_interval_ms,
                .seq = ++_ble_seq,
            };
            udp_send_ble_report(&header, _devices);
            ESP_LOGD(TAG, "Sent %d BLE devices", _device_count);
        }
        xSemaphoreGive(_devices_mutex);

        // Brief pause between scan cycles
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

// ── NimBLE host task ──

static void _on_sync(void) {
    // NimBLE host synced — configure address and privacy
    ESP_LOGI(TAG, "NimBLE host synced — configuring address");

    // Ensure we have a valid address
    int rc = ble_hs_util_ensure_addr(0);
    if (rc != 0) {
        ESP_LOGW(TAG, "ble_hs_util_ensure_addr failed: %d", rc);
    }

    // Infer address type (public or random)
    rc = ble_hs_id_infer_auto(0, &_own_addr_type);
    if (rc != 0) {
        ESP_LOGW(TAG, "ble_hs_id_infer_auto failed: %d, defaulting to public", rc);
        _own_addr_type = BLE_OWN_ADDR_PUBLIC;
    }
    ESP_LOGI(TAG, "BLE address type: %d", _own_addr_type);
}

static void _on_reset(int reason) {
    ESP_LOGW(TAG, "NimBLE reset: reason=%d", reason);
}

static void nimble_host_task(void *param) {
    nimble_port_run();
    nimble_port_freertos_deinit();
}

// ── Public API ──

void ble_scanner_init(const node_config_t *cfg) {
    _cfg = cfg;
    _devices_mutex = xSemaphoreCreateMutex();
    _irk_mutex = xSemaphoreCreateMutex();
    _device_count = 0;

    // NimBLE init
    esp_err_t ret = nimble_port_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "NimBLE init failed: %s", esp_err_to_name(ret));
        return;
    }

    // Configure security for bonding + IRK exchange
    ble_hs_cfg.sync_cb = _on_sync;
    ble_hs_cfg.reset_cb = _on_reset;
    // Bond store callbacks — CRITICAL: without this, bonds are never persisted
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;  // round-robin eviction
    // Security config matching ESPresense PR #1655 (iOS 17/18 fix)
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;      // Just Works (no PIN)
    ble_hs_cfg.sm_bonding = 1;                          // enable bonding (persist keys)
    ble_hs_cfg.sm_sc = 1;                               // Secure Connections (required for iOS IRK)
    ble_hs_cfg.sm_mitm = 0;                             // NO MITM — mitm=1 + NO_IO contradicts, iOS skips key exchange
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;

    // Initialize standard GATT services + our encrypted characteristic
    ble_svc_gap_init();
    ble_svc_gatt_init();

    // Register our custom service with encrypted read (triggers iOS pairing)
    int rc = ble_gatts_count_cfg(_gatt_svcs);
    if (rc == 0) {
        rc = ble_gatts_add_svcs(_gatt_svcs);
    }
    if (rc != 0) {
        ESP_LOGW(TAG, "Custom GATT service registration failed: %d", rc);
    }

    // Load stored IRKs from NVS
    _load_irks_from_nvs();

    // Start NimBLE host task
    nimble_port_freertos_init(nimble_host_task);
    ESP_LOGI(TAG, "BLE scanner initialized (interval=%dms, %d IRKs loaded)",
             cfg->ble_scan_interval_ms, _irk_count);
}

void ble_scanner_start(void) {
    xTaskCreatePinnedToCore(ble_scan_task, "ble_scan", 4096, NULL, 4, NULL, 0);
    ESP_LOGI(TAG, "BLE scan task started");
}

static void _pair_timeout_cb(void *arg) {
    if (_pair_mode && !_pair_success) {
        ESP_LOGW(TAG, "Pairing timeout — no device paired, restarting WiFi");
        ble_gap_adv_stop();
        if (_pair_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
            ble_gap_terminate(_pair_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
        }
        _pair_mode = false;
        esp_wifi_start();
        esp_wifi_connect();
    }
}

void ble_scanner_enter_pair_mode(uint16_t timeout_sec) {
    if (_pair_mode) {
        ESP_LOGW(TAG, "Already in pairing mode");
        return;
    }

    ESP_LOGI(TAG, "Entering pairing mode (timeout=%ds) — stopping WiFi for BLE advertising", timeout_sec);

    _pair_mode = true;
    _pair_success = false;
    _pair_timeout_sec = timeout_sec;

    // Stop scanning first
    ble_gap_disc_cancel();
    vTaskDelay(pdMS_TO_TICKS(200));

    // Stop WiFi to free antenna for BLE advertising (ESP32-WROOM-32 shared antenna)
    esp_wifi_disconnect();
    esp_wifi_stop();

    // Wait for radio to settle before starting BLE advertising
    vTaskDelay(pdMS_TO_TICKS(2000));

    // Start advertising
    _start_advertising();

    // Cancel any old timer before creating a new one
    if (_pair_timer) {
        esp_timer_stop(_pair_timer);
        esp_timer_delete(_pair_timer);
        _pair_timer = NULL;
    }
    const esp_timer_create_args_t timer_args = {
        .callback = _pair_timeout_cb,
        .name = "pair_timeout",
    };
    esp_timer_create(&timer_args, &_pair_timer);
    esp_timer_start_once(_pair_timer, (uint64_t)timeout_sec * 1000000ULL);
}

bool ble_scanner_add_irk(const uint8_t irk[16], const uint8_t addr[6],
                         uint8_t addr_type, const char *label) {
    xSemaphoreTake(_irk_mutex, portMAX_DELAY);

    // Check if this IRK already exists (by identity address)
    for (int i = 0; i < _irk_count; i++) {
        if (_irks[i].valid && memcmp(_irks[i].addr, addr, 6) == 0) {
            // Update existing
            memcpy(_irks[i].irk, irk, IRK_LEN);
            _irks[i].addr_type = addr_type;
            if (label) strncpy(_irks[i].label, label, sizeof(_irks[i].label) - 1);
            xSemaphoreGive(_irk_mutex);
            _save_irks_to_nvs();
            ESP_LOGI(TAG, "Updated IRK for '%s'", label ? label : "device");
            return true;
        }
    }

    // Add new
    if (_irk_count >= MAX_TRACKED_IRKS) {
        xSemaphoreGive(_irk_mutex);
        ESP_LOGW(TAG, "IRK storage full (%d/%d)", _irk_count, MAX_TRACKED_IRKS);
        return false;
    }

    stored_irk_t *slot = &_irks[_irk_count];
    memcpy(slot->irk, irk, IRK_LEN);
    memcpy(slot->addr, addr, 6);
    slot->addr_type = addr_type;
    if (label) strncpy(slot->label, label, sizeof(slot->label) - 1);
    slot->valid = true;
    _irk_count++;

    xSemaphoreGive(_irk_mutex);
    _save_irks_to_nvs();
    ESP_LOGI(TAG, "Added IRK for '%s' (%d/%d)", label ? label : "device",
             _irk_count, MAX_TRACKED_IRKS);
    return true;
}

bool ble_scanner_is_pairing(void) {
    return _pair_mode;
}

int ble_scanner_irk_count(void) {
    return _irk_count;
}
