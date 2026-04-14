#include "flash_store.h"
#include "gecko_pins.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "flash";
static uint32_t frame_count = 0;
static uint32_t write_offset = 0;

int flash_store_init(void) {
    ESP_LOGI(TAG, "W25Q128 init (SPI host=%d, CS=GPIO%d) — stub",
             FLASH_SPI_HOST, PIN_FLASH_CS);
    // Real: init SPI bus, read JEDEC ID, verify W25Q128
    frame_count = 0;
    write_offset = 0;
    return 0;
}

int flash_store_frame(const uint8_t *jpeg, size_t jpeg_len,
                      const frame_meta_t *meta) {
    if (!jpeg || jpeg_len == 0) return -1;

    // Real: write meta header + jpeg to flash at write_offset
    // Advance write_offset, wrap around if full (ring buffer)
    ESP_LOGD(TAG, "Store frame #%lu (%u bytes)", (unsigned long)frame_count,
             (unsigned)jpeg_len);
    frame_count++;
    write_offset += sizeof(frame_meta_t) + jpeg_len;
    if (write_offset >= FLASH_TOTAL_SIZE) {
        write_offset = 0;  // Ring buffer wrap
    }
    return (int)(frame_count - 1);
}

int flash_read_frame(uint32_t index, uint8_t *jpeg_buf, size_t buf_size,
                     frame_meta_t *meta) {
    (void)index; (void)jpeg_buf; (void)buf_size; (void)meta;
    return -1;  // Stub
}

uint32_t flash_get_frame_count(void) { return frame_count; }
void flash_erase_all(void) { frame_count = 0; write_offset = 0; }
uint8_t flash_usage_pct(void) {
    return (uint8_t)(write_offset * 100 / FLASH_TOTAL_SIZE);
}
bool flash_is_full(void) { return flash_usage_pct() > 90; }
