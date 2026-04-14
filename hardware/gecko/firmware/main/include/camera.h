#pragma once
#include <stdint.h>
#include <stddef.h>

// JPEG capture resolution
typedef enum {
    CAM_RES_QQVGA = 0,   // 160x120 — lowest power, fast burst
    CAM_RES_QVGA,        // 320x240 — default recon mode
    CAM_RES_VGA,         // 640x480 — detail capture on alert
} cam_resolution_t;

// Initialize OV2640 on DVP bus
int camera_init(cam_resolution_t res);

// Capture one JPEG frame. Returns pointer to JPEG buffer and size.
// Buffer is valid until next capture or camera_release_frame().
int camera_capture(uint8_t **jpeg_buf, size_t *jpeg_len);

// Release frame buffer back to driver
void camera_release_frame(void);

// Change resolution on the fly
void camera_set_resolution(cam_resolution_t res);

// Power down camera (deep sleep)
void camera_sleep(void);

// Wake camera from sleep
void camera_wake(void);
