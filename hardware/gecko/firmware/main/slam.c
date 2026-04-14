#include "slam.h"
#include "esp_log.h"
#include <string.h>
#include <math.h>

static const char *TAG = "slam";

static uint8_t grid[SLAM_GRID_SIZE][SLAM_GRID_SIZE];
static pose_t robot_pose;

void slam_init(void) {
    memset(grid, SLAM_UNKNOWN, sizeof(grid));
    robot_pose.x_mm = (SLAM_GRID_SIZE / 2) * SLAM_CELL_SIZE_MM;
    robot_pose.y_mm = (SLAM_GRID_SIZE / 2) * SLAM_CELL_SIZE_MM;
    robot_pose.heading = 0;
    ESP_LOGI(TAG, "SLAM init — %dx%d grid, %dmm/cell",
             SLAM_GRID_SIZE, SLAM_GRID_SIZE, SLAM_CELL_SIZE_MM);
}

void slam_update(const tof_frame_t *tof, const pose_t *pose) {
    // Project each ToF zone ray into grid space and mark cells
    // The VL53L8CX has 8x8 zones with ~45° total FOV
    float heading_rad = pose->heading * M_PI / 180.0f;
    float fov_per_zone = (45.0f / 8.0f) * M_PI / 180.0f;

    for (int row = 0; row < TOF_ROWS; row++) {
        for (int col = 0; col < TOF_COLS; col++) {
            uint16_t dist = tof->distance_mm[row * TOF_COLS + col];
            if (dist == 0 || dist > 4000) continue;

            // Angle of this zone relative to heading
            float angle = heading_rad + (col - 3.5f) * fov_per_zone;

            // Endpoint in mm
            float ex = pose->x_mm + dist * sinf(angle);
            float ey = pose->y_mm + dist * cosf(angle);

            // Grid coords
            int gx = (int)(ex / SLAM_CELL_SIZE_MM);
            int gy = (int)(ey / SLAM_CELL_SIZE_MM);

            // Mark endpoint as occupied
            if (gx >= 0 && gx < SLAM_GRID_SIZE &&
                gy >= 0 && gy < SLAM_GRID_SIZE) {
                grid[gy][gx] = SLAM_OCCUPIED;
            }

            // Ray-trace free space between robot and endpoint
            int rx = (int)(pose->x_mm / SLAM_CELL_SIZE_MM);
            int ry = (int)(pose->y_mm / SLAM_CELL_SIZE_MM);
            // Simple Bresenham line — mark intermediate cells as free
            int dx = abs(gx - rx), dy = abs(gy - ry);
            int sx = rx < gx ? 1 : -1, sy = ry < gy ? 1 : -1;
            int err = dx - dy;
            int cx = rx, cy = ry;
            while (cx != gx || cy != gy) {
                if (cx >= 0 && cx < SLAM_GRID_SIZE &&
                    cy >= 0 && cy < SLAM_GRID_SIZE &&
                    grid[cy][cx] != SLAM_OCCUPIED) {
                    grid[cy][cx] = SLAM_FREE;
                }
                int e2 = 2 * err;
                if (e2 > -dy) { err -= dy; cx += sx; }
                if (e2 < dx)  { err += dx; cy += sy; }
            }
        }
    }
}

void slam_step(int16_t step_mm) {
    float heading_rad = robot_pose.heading * M_PI / 180.0f;
    robot_pose.x_mm += (int16_t)(step_mm * sinf(heading_rad));
    robot_pose.y_mm += (int16_t)(step_mm * cosf(heading_rad));
}

void slam_set_heading(int16_t degrees) {
    robot_pose.heading = degrees;
}

uint8_t slam_get_cell(uint8_t gx, uint8_t gy) {
    if (gx >= SLAM_GRID_SIZE || gy >= SLAM_GRID_SIZE) return SLAM_UNKNOWN;
    return grid[gy][gx];
}

pose_t slam_get_pose(void) {
    return robot_pose;
}

bool slam_find_overwatch(uint8_t *best_x, uint8_t *best_y) {
    // Score each free cell by: number of free cells visible (coverage)
    // Higher is better — want max line-of-sight to open areas
    int best_score = 0;
    bool found = false;

    // Subsample to avoid O(n^4) — check every 5th cell
    for (uint8_t y = 0; y < SLAM_GRID_SIZE; y += 5) {
        for (uint8_t x = 0; x < SLAM_GRID_SIZE; x += 5) {
            if (grid[y][x] != SLAM_FREE) continue;

            // Count free neighbors in 20-cell radius
            int score = 0;
            for (int dy = -20; dy <= 20; dy += 2) {
                for (int dx = -20; dx <= 20; dx += 2) {
                    int ny = y + dy, nx = x + dx;
                    if (ny >= 0 && ny < SLAM_GRID_SIZE &&
                        nx >= 0 && nx < SLAM_GRID_SIZE &&
                        grid[ny][nx] == SLAM_FREE) {
                        score++;
                    }
                }
            }

            if (score > best_score) {
                best_score = score;
                *best_x = x;
                *best_y = y;
                found = true;
            }
        }
    }
    return found;
}

size_t slam_serialize(uint8_t *buf, size_t buf_size) {
    // RLE encode the grid for transmission
    size_t pos = 0;
    uint8_t current = grid[0][0];
    uint8_t count = 1;

    for (int i = 1; i < SLAM_GRID_SIZE * SLAM_GRID_SIZE; i++) {
        uint8_t cell = grid[i / SLAM_GRID_SIZE][i % SLAM_GRID_SIZE];
        if (cell == current && count < 255) {
            count++;
        } else {
            if (pos + 2 > buf_size) break;
            buf[pos++] = count;
            buf[pos++] = current;
            current = cell;
            count = 1;
        }
    }
    if (pos + 2 <= buf_size) {
        buf[pos++] = count;
        buf[pos++] = current;
    }
    return pos;
}

uint8_t slam_coverage_pct(void) {
    int known = 0;
    int total = SLAM_GRID_SIZE * SLAM_GRID_SIZE;
    for (int y = 0; y < SLAM_GRID_SIZE; y++) {
        for (int x = 0; x < SLAM_GRID_SIZE; x++) {
            if (grid[y][x] != SLAM_UNKNOWN) known++;
        }
    }
    return (uint8_t)(known * 100 / total);
}
