#pragma once
#include <stdint.h>

// Robot operating modes
typedef enum {
    MODE_BOOT = 0,          // Startup, self-test, connect WiFi
    MODE_RECON,             // Active exploration — crawl walls, map house
    MODE_OVERWATCH,         // Parked — deep sleep, wake on event
    MODE_ALERT,             // Event detected — capture, analyze, report
    MODE_REPOSITION,        // Moving to new overwatch position
    MODE_RECHARGE,          // Returning to dock / docked charging
    MODE_MANUAL,            // Remote control via WiFi commands
    MODE_EMERGENCY          // Adhesion failure / low battery / stuck
} robot_mode_t;

// Overwatch trigger types
typedef enum {
    TRIGGER_NONE = 0,
    TRIGGER_SOUND,          // Mic detected above threshold
    TRIGGER_MOTION,         // ToF distance changed significantly
    TRIGGER_THERMAL,        // New heat source appeared
    TRIGGER_SCHEDULE,       // Time-based reposition (day/night)
    TRIGGER_COMMAND         // Remote command from bridge
} trigger_type_t;

// Battery thresholds
#define BATTERY_CRITICAL_PCT    10  // Emergency dock
#define BATTERY_LOW_PCT         25  // Start heading to dock
#define BATTERY_RECHARGE_PCT    95  // Done charging

// Initialize behavior controller
void behavior_init(void);

// Main behavior loop — call from app_main FreeRTOS task
void behavior_run(void);

// Force mode change (from remote command)
void behavior_set_mode(robot_mode_t mode);

// Get current mode
robot_mode_t behavior_get_mode(void);

// Get battery percentage (from ADC)
uint8_t behavior_get_battery_pct(void);
