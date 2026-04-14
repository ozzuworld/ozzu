#pragma once

// ============================================================
// Gecko Recon Robot — ESP32-S3 SuperMini Pin Assignments
// ============================================================
// Board: ESP32-S3FH4R2 SuperMini (23.5x18mm)
// SMA wires driven via N-channel MOSFET (IRLML6244 or similar)
// All I2C devices share one bus. SPI bus for flash + camera.
// ============================================================

// --- SMA Wire Actuators (PWM via MOSFET gate) ---
#define PIN_SMA_SPINE       1   // Spine wire — contracts body
#define PIN_SMA_FRONT_PAD   2   // Front gecko pad release
#define PIN_SMA_REAR_PAD   42   // Rear gecko pad release

// --- OV2640 Camera (DVP 8-bit) ---
#define PIN_CAM_SIOD        3   // SCCB data (I2C-like)
#define PIN_CAM_SIOC        4   // SCCB clock
#define PIN_CAM_VSYNC       5   // Frame sync
#define PIN_CAM_HREF        6   // Line sync
#define PIN_CAM_PCLK        7   // Pixel clock
#define PIN_CAM_XCLK        8   // Master clock out (20MHz)
#define PIN_CAM_D0          9
#define PIN_CAM_D1         10
#define PIN_CAM_D2         11
#define PIN_CAM_D3         12
#define PIN_CAM_D4         13
#define PIN_CAM_D5         14
#define PIN_CAM_D6         21
#define PIN_CAM_D7         47

// --- I2C Bus (shared: MLX90640 + VL53L8CX) ---
#define PIN_I2C_SDA        15
#define PIN_I2C_SCL        16
#define I2C_PORT           I2C_NUM_0
#define I2C_FREQ_HZ        400000

// --- MLX90640 Thermal (on I2C bus) ---
#define MLX90640_I2C_ADDR  0x33

// --- VL53L8CX ToF (on I2C bus) ---
#define VL53L8CX_I2C_ADDR 0x29

// --- INMP441 Microphone (I2S) ---
#define PIN_MIC_SCK        17   // I2S bit clock
#define PIN_MIC_WS         18   // I2S word select
#define PIN_MIC_SD         48   // I2S data in

// --- W25Q128 Flash (SPI) ---
#define PIN_FLASH_CS       38
#define PIN_FLASH_CLK      39
#define PIN_FLASH_MOSI     40
#define PIN_FLASH_MISO     41
#define FLASH_SPI_HOST     SPI3_HOST

// --- Battery ADC ---
#define PIN_BATTERY_ADC    46   // Via voltage divider (2:1)
#define BATTERY_FULL_MV    4200
#define BATTERY_EMPTY_MV   3300
