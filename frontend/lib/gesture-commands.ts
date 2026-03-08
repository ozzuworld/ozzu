// Gesture Command System — debounce, cooldown, compound gesture detection
// Turns raw per-frame gestures into discrete triggered commands

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

const HOLD_MS = 150; // hold gesture for 150ms to trigger (fast palm response)
const COOLDOWN_MS = 1000; // 1s cooldown after trigger before same gesture can re-trigger
const COMPOUND_WINDOW_MS = 600; // two gestures within 600ms = compound

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

    // Same gesture held — check if hold duration met
    if (!this.state.triggered && now - this.state.startTime >= HOLD_MS) {
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
    this.callback?.(command);
  }

  reset(): void {
    this.state = { currentGesture: "none", startTime: 0, triggered: false };
    this.cooldowns.clear();
    this.lastTriggered = null;
  }
}
