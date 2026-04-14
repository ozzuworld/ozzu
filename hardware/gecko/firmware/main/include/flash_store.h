#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

// W25Q128 — 16MB SPI NOR Flash
// Layout: ring buffer of JPEG frames + metadata
#define FLASH_TOTAL_SIZE     (16 * 1024 * 1024)  // 16MB
#define FLASH_SECTOR_SIZE    4096
#define FLASH_PAGE_SIZE      256
#define FLASH_MAX_FRAMES     1300   // ~12KB avg JPEG @ QVGA

// Frame metadata stored alongside JPEG
typedef struct {
    uint32_t timestamp_ms;
    uint16_t jpeg_size;
    uint8_t  mode;          // robot_mode_t when captured
    uint8_t  trigger;       // trigger_type_t if in alert mode
    int16_t  max_thermal;   // Hottest pixel (centi-degrees)
    uint8_t  battery_pct;
} frame_meta_t;

// Initialize W25Q128 on SPI bus
int flash_store_init(void);

// Store a JPEG frame with metadata. Returns frame index or -1 on error.
int flash_store_frame(const uint8_t *jpeg, size_t jpeg_len,
                      const frame_meta_t *meta);

// Read frame by index. Caller provides buffer.
int flash_read_frame(uint32_t index, uint8_t *jpeg_buf, size_t buf_size,
                     frame_meta_t *meta);

// Get number of stored frames
uint32_t flash_get_frame_count(void);

// Erase all stored frames (full chip erase)
void flash_erase_all(void);

// Get storage usage percentage
uint8_t flash_usage_pct(void);

// Check if storage is nearly full
bool flash_is_full(void);
