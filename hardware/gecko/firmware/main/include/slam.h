#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "tof.h"

// Simple 2D occupancy grid SLAM
// Robot builds a map of walls/obstacles from ToF data as it crawls

#define SLAM_GRID_SIZE     200     // 200x200 cells
#define SLAM_CELL_SIZE_MM   50     // 50mm per cell = 10m x 10m map
#define SLAM_OCCUPIED       255
#define SLAM_FREE            0
#define SLAM_UNKNOWN        128

// Robot pose (position + heading on the wall plane)
typedef struct {
    int16_t x_mm;      // Position along wall
    int16_t y_mm;      // Height on wall
    int16_t heading;    // Degrees (0 = up, 90 = right)
} pose_t;

// Initialize SLAM with robot at center of grid
void slam_init(void);

// Update map with new ToF frame at current pose
void slam_update(const tof_frame_t *tof, const pose_t *pose);

// Update pose after a gait step (dead reckoning)
// step_mm = distance moved per step (~3mm for SMA)
void slam_step(int16_t step_mm);

// Set heading (from IMU or gait direction)
void slam_set_heading(int16_t degrees);

// Get occupancy at grid cell
uint8_t slam_get_cell(uint8_t gx, uint8_t gy);

// Get current pose
pose_t slam_get_pose(void);

// Find best overwatch position (highest room coverage, concealed)
// Returns grid coordinates of optimal position
bool slam_find_overwatch(uint8_t *best_x, uint8_t *best_y);

// Serialize map to buffer for WiFi burst transmission
// Returns bytes written
size_t slam_serialize(uint8_t *buf, size_t buf_size);

// Get exploration coverage percentage
uint8_t slam_coverage_pct(void);
