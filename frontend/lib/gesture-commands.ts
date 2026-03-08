// Gesture Command System — debounce, cooldown, compound gesture detection
// Turns raw per-frame gestures into discrete triggered commands
// v2: consecutive-frame confirmation for reliability (GECO-inspired)

import type { GestureResult, GestureType } from "./gestures";

export interface GestureCommand {
  gesture: GestureType;
  fingerCount?: number;
  timestamp: number;
  compound?: string; // e.g. "point+pinch"
}

export type GestureCommandCallback = (command: GestureCommand) => void;

interface GestureState {
  currentGesture: GestureType;
  startTime: number;
  triggered: boolean;
  fingerCount?: number;
}

const HOLD_MS = 200; // hold gesture for 200ms to trigger
const COOLDOWN_MS = 1200; // 1.2s cooldown after trigger
const COMPOUND_WINDOW_MS = 600; // two gestures within 600ms = compound
const CONFIRM_WINDOW = 7; // sliding window size
const CONFIRM_THRESHOLD = 5; // need 5 of 7 frames matching

export class GestureCommandManager {
  private state: GestureState = {
    currentGesture: "none",
    startTime: 0,
    triggered: false,
  };
  private cooldowns = new Map<string, number>(); // gesture → last trigger time
  private lastTriggered: GestureCommand | null = null;
  private callback: GestureCommandCallback | null = null;
  private enabled = true;

  // Consecutive-frame confirmation buffer
  private frameBuffer: GestureType[] = [];

  setCallback(cb: GestureCommandCallback): void {
    this.callback = cb;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  getLastTriggered(): GestureCommand | null {
    return this.lastTriggered;
  }

  /** Call this every frame with the detected gesture */
  update(result: GestureResult): void {
    if (!this.enabled || !this.callback) return;

    const now = Date.now();
    const gesture = result.gesture;

    // Push to frame buffer for consecutive-frame confirmation
    this.frameBuffer.push(gesture);
    if (this.frameBuffer.length > CONFIRM_WINDOW) {
      this.frameBuffer.shift();
    }

    // Swipes trigger immediately (motion-based, no hold needed)
    if (gesture === "swipe_left" || gesture === "swipe_right") {
      if (!this.isOnCooldown(gesture, now)) {
        this.trigger({ gesture, timestamp: now });
      }
      return;
    }

    // No gesture — reset state
    if (gesture === "none") {
      this.state = { currentGesture: "none", startTime: 0, triggered: false };
      return;
    }

    // Gesture changed — start new hold timer
    if (gesture !== this.state.currentGesture) {
      this.state = {
        currentGesture: gesture,
        startTime: now,
        triggered: false,
        fingerCount: result.fingerCount,
      };
      return;
    }

    // Same gesture held — check if hold duration met AND frame confirmation passes
    if (!this.state.triggered && now - this.state.startTime >= HOLD_MS) {
      // Consecutive-frame confirmation: need CONFIRM_THRESHOLD of CONFIRM_WINDOW frames
      const matchCount = this.frameBuffer.filter((g) => g === gesture).length;
      if (matchCount < CONFIRM_THRESHOLD) return; // not enough confidence

      if (!this.isOnCooldown(gesture, now)) {
        // Check for compound gesture (e.g. point then pinch in quick succession)
        const compound = this.detectCompound(gesture, now);

        this.trigger({
          gesture,
          fingerCount: result.fingerCount,
          timestamp: now,
          compound: compound || undefined,
        });
      }
      this.state.triggered = true;
    }
  }

  private isOnCooldown(gesture: GestureType, now: number): boolean {
    const lastTrigger = this.cooldowns.get(gesture);
    if (lastTrigger && now - lastTrigger < COOLDOWN_MS) return true;
    return false;
  }

  private detectCompound(gesture: GestureType, now: number): string | null {
    if (!this.lastTriggered) return null;
    if (now - this.lastTriggered.timestamp > COMPOUND_WINDOW_MS) return null;
    if (this.lastTriggered.gesture === gesture) return null;

    return `${this.lastTriggered.gesture}+${gesture}`;
  }

  private trigger(command: GestureCommand): void {
    this.cooldowns.set(command.gesture, command.timestamp);
    this.lastTriggered = command;
    this.frameBuffer = []; // clear buffer after trigger to avoid re-trigger
    this.callback?.(command);
  }

  reset(): void {
    this.state = { currentGesture: "none", startTime: 0, triggered: false };
    this.cooldowns.clear();
    this.lastTriggered = null;
    this.frameBuffer = [];
  }
}
