#pragma once
#include <stdint.h>
#include <stdbool.h>

// Audio capture config
#define MIC_SAMPLE_RATE     16000   // 16kHz — enough for voice detection
#define MIC_BIT_DEPTH       16
#define MIC_BUFFER_SAMPLES  512     // ~32ms per buffer

// Initialize INMP441 on I2S bus
int mic_init(void);

// Read audio samples into buffer. Returns number of samples read.
int mic_read(int16_t *samples, size_t max_samples);

// Get current RMS amplitude (for threshold detection)
uint16_t mic_get_rms(void);

// Configure ULP coprocessor for sound-wake in deep sleep.
// When amplitude exceeds threshold, ULP wakes main CPU.
void mic_configure_wake(uint16_t rms_threshold);

// Start/stop continuous monitoring (for overwatch mode)
void mic_start_monitor(void);
void mic_stop_monitor(void);

// Check if sound event triggered wake from deep sleep
bool mic_was_wake_source(void);

void mic_sleep(void);
void mic_wake(void);
