#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "flash_store.h"

// WiFi burst protocol:
// 1. Radio sleeps 95% of the time
// 2. On trigger (timer or alert), wake radio
// 3. Connect to AP, dump frames to bridge server
// 4. Receive any pending commands
// 5. Disconnect, radio back to sleep

// Burst config
#define WIFI_BURST_INTERVAL_MS   (5 * 60 * 1000)  // 5 min default
#define WIFI_BURST_TIMEOUT_MS    10000              // Max 10s per burst
#define WIFI_BRIDGE_PORT         3333

// Alert payload sent to bridge
typedef struct {
    uint8_t  trigger;       // trigger_type_t
    uint8_t  battery_pct;
    int16_t  max_thermal;
    uint16_t tof_min_mm;    // Closest object distance
    uint16_t mic_rms;       // Sound level at trigger
    uint32_t timestamp_ms;
} alert_payload_t;

// Command from bridge (received during burst)
typedef enum {
    CMD_NONE = 0,
    CMD_SET_MODE,           // Change robot mode
    CMD_REPOSITION,         // Move to coordinates
    CMD_CAPTURE_NOW,        // Immediate full sensor capture
    CMD_COME_HOME,          // Return to dock
    CMD_SET_BURST_INTERVAL, // Change burst frequency
} remote_cmd_t;

// Initialize WiFi (stays off until burst)
int wifi_burst_init(const char *ssid, const char *password,
                    const char *bridge_host);

// Perform a burst: wake radio, dump frames, get commands, sleep radio.
// Returns received command (CMD_NONE if no commands pending).
remote_cmd_t wifi_burst_sync(void);

// Send an immediate alert (wakes radio out of schedule)
int wifi_burst_alert(const alert_payload_t *alert,
                     const uint8_t *jpeg, size_t jpeg_len);

// Set burst interval
void wifi_burst_set_interval(uint32_t interval_ms);

// Force radio off
void wifi_radio_off(void);
