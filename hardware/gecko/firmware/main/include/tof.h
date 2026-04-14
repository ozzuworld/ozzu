#pragma once
#include <stdint.h>

// VL53L8CX 8x8 multizone ToF
#define TOF_ZONES    64   // 8x8 grid
#define TOF_COLS      8
#define TOF_ROWS      8

// Single ToF measurement frame
typedef struct {
    uint16_t distance_mm[TOF_ZONES];   // Distance per zone (0 = no target)
    uint8_t  status[TOF_ZONES];        // Measurement status per zone
    uint32_t timestamp_ms;
} tof_frame_t;

// Initialize VL53L8CX on I2C bus
int tof_init(void);

// Capture one depth frame
int tof_capture(tof_frame_t *frame);

// Set ranging frequency (1-15 Hz, lower = more accurate)
void tof_set_frequency(uint8_t hz);

// Set ranging mode
typedef enum {
    TOF_MODE_SHORT = 0,    // Up to 1.3m, higher accuracy
    TOF_MODE_LONG = 1      // Up to 4m, lower accuracy
} tof_mode_t;
void tof_set_mode(tof_mode_t mode);

// Check if any zone distance changed significantly (motion detect)
// Returns true if delta > threshold_mm in any zone vs previous frame
bool tof_detect_motion(const tof_frame_t *current,
                       const tof_frame_t *previous,
                       uint16_t threshold_mm);

void tof_sleep(void);
void tof_wake(void);
