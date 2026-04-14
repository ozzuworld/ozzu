#pragma once
#include <stdint.h>
#include <stdbool.h>

// MLX90640 32x24 pixel thermal array
#define THERMAL_COLS  32
#define THERMAL_ROWS  24
#define THERMAL_PIXELS (THERMAL_COLS * THERMAL_ROWS)

// Thermal frame — temperatures in °C * 100 (fixed point)
typedef struct {
    int16_t pixels[THERMAL_PIXELS];  // Temp in centi-degrees (2500 = 25.00°C)
    int16_t ambient;                  // Ambient temp (centi-degrees)
    uint32_t timestamp_ms;
} thermal_frame_t;

// Initialize MLX90640 on I2C bus
int thermal_init(void);

// Capture one thermal frame (takes ~64ms at 8Hz refresh)
int thermal_capture(thermal_frame_t *frame);

// Check if a heat source (person/pet) is present in frame
// Returns number of hot spots detected, fills max_temp
bool thermal_detect_presence(const thermal_frame_t *frame, int16_t *max_temp);

// Get average temperature in a region (for room fingerprinting)
int16_t thermal_region_avg(const thermal_frame_t *frame,
                           uint8_t x, uint8_t y, uint8_t w, uint8_t h);

// Power down sensor
void thermal_sleep(void);
void thermal_wake(void);
