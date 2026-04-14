#pragma once
#include <stdint.h>
#include <stdbool.h>

// SMA wire channels
typedef enum {
    SMA_SPINE = 0,       // Contracts body (locomotion)
    SMA_FRONT_PAD = 1,   // Releases front gecko pad
    SMA_REAR_PAD = 2,    // Releases rear gecko pad
    SMA_CHANNEL_COUNT = 3
} sma_channel_t;

// SMA wire parameters (0.050mm Nitinol)
#define SMA_CURRENT_MA        50      // Activation current
#define SMA_HEAT_TIME_MS      150     // Time to heat to Af (~60°C)
#define SMA_COOL_TIME_MS      240     // Time to cool and extend
#define SMA_MAX_DUTY_CYCLE    180     // PWM duty (0-255) for 50mA @ 3.3V
#define SMA_HOLD_DUTY_CYCLE   100     // Lower PWM to hold contracted (saves power)

// Initialize SMA PWM channels on configured pins
void sma_init(void);

// Activate a wire — heats to contract, holds for duration_ms, then releases
void sma_activate(sma_channel_t channel, uint32_t duration_ms);

// Activate with hold — contracts and keeps contracted until sma_release()
void sma_contract(sma_channel_t channel);

// Release a wire — stops current, wire cools and extends
void sma_release(sma_channel_t channel);

// Check if wire has cooled (ready for next cycle)
bool sma_is_ready(sma_channel_t channel);

// Wait for a specific wire to cool
void sma_wait_cool(sma_channel_t channel);

// Emergency stop — release all wires immediately
void sma_emergency_stop(void);
