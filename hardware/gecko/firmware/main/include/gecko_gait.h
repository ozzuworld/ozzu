#pragma once
#include <stdbool.h>

// Locomotion direction
typedef enum {
    GAIT_FORWARD = 0,   // Up the wall / forward
    GAIT_BACKWARD = 1,  // Down the wall / backward
    GAIT_STOP = 2
} gait_direction_t;

// Gait state (one inchworm cycle)
typedef enum {
    GAIT_IDLE = 0,
    GAIT_RELEASE_REAR,      // Step 1: peel rear pad
    GAIT_CONTRACT_SPINE,    // Step 2: contract spine — pulls rear up
    GAIT_ATTACH_REAR,       // Step 3: rear pad re-sticks
    GAIT_RELEASE_FRONT,     // Step 4: peel front pad
    GAIT_EXTEND_SPINE,      // Step 5: spine extends — front slides up
    GAIT_ATTACH_FRONT,      // Step 6: front pad re-sticks
    GAIT_CYCLE_COMPLETE
} gait_state_t;

// Gait timing profile
typedef struct {
    uint32_t heat_ms;       // SMA heating time per activation
    uint32_t cool_ms;       // SMA cooling wait between steps
    uint32_t settle_ms;     // Pad settle time after re-attach
} gait_profile_t;

// Default profile for 0.050mm wire
#define GAIT_PROFILE_DEFAULT { .heat_ms = 150, .cool_ms = 240, .settle_ms = 50 }

// Initialize gait controller
void gait_init(void);

// Take N steps in direction. Blocking — returns when done.
void gait_walk(gait_direction_t dir, uint32_t steps);

// Take one step. Non-blocking — call gait_tick() to advance.
void gait_step_start(gait_direction_t dir);

// Advance gait state machine. Call from main loop.
// Returns true when step is complete.
bool gait_tick(void);

// Stop walking immediately (safe — re-attaches both pads)
void gait_stop(void);

// Get current gait state
gait_state_t gait_get_state(void);

// Set timing profile
void gait_set_profile(const gait_profile_t *profile);
