#include "camera.h"
#include "gecko_pins.h"
#include "esp_log.h"

static const char *TAG = "camera";

// TODO: Implement with esp32-camera component when OV2640 arrives
// For now, stubs that log calls

int camera_init(cam_resolution_t res) {
    ESP_LOGI(TAG, "Camera init (res=%d) — stub", res);
    // Real implementation:
    // camera_config_t config = {
    //     .pin_d0 = PIN_CAM_D0, ... .pin_d7 = PIN_CAM_D7,
    //     .pin_xclk = PIN_CAM_XCLK, .pin_pclk = PIN_CAM_PCLK,
    //     .pin_vsync = PIN_CAM_VSYNC, .pin_href = PIN_CAM_HREF,
    //     .pin_sccb_sda = PIN_CAM_SIOD, .pin_sccb_scl = PIN_CAM_SIOC,
    //     .xclk_freq_hz = 20000000,
    //     .pixel_format = PIXFORMAT_JPEG,
    //     .frame_size = FRAMESIZE_QVGA,
    //     .jpeg_quality = 12,
    //     .fb_count = 1,
    //     .grab_mode = CAMERA_GRAB_LATEST,
    // };
    // return esp_camera_init(&config) == ESP_OK ? 0 : -1;
    return 0;
}

int camera_capture(uint8_t **jpeg_buf, size_t *jpeg_len) {
    ESP_LOGD(TAG, "Capture — stub");
    *jpeg_buf = NULL;
    *jpeg_len = 0;
    return 0;
}

void camera_release_frame(void) {}
void camera_set_resolution(cam_resolution_t res) { (void)res; }
void camera_sleep(void) { ESP_LOGD(TAG, "Sleep"); }
void camera_wake(void) { ESP_LOGD(TAG, "Wake"); }
