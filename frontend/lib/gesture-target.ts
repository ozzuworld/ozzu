// Gesture Targeting Engine — checks if index fingertip is inside a detected object's bounding box
// Locks onto a device when pointed at for 500ms, unlocks after 2s away

import type { HandLandmark, ObjectDetection } from "../modules/expo-mediapipe";
import { findDeviceForObject, type DeviceTarget } from "./device-map";

const LOCK_TIME_MS = 500; // hold pointing at object for 500ms to lock
const UNLOCK_TIME_MS = 2000; // move away for 2s to auto-unlock
const PROXIMITY_MARGIN = 0.05; // 5% bbox expansion for easier targeting

const INDEX_TIP = 8; // MediaPipe hand landmark index for index fingertip

export interface TargetLock {
  target: DeviceTarget;
  object: ObjectDetection; // the detected object being targeted
  lockedAt: number; // timestamp when lock was established
}

export interface TargetCandidate {
  target: DeviceTarget;
  object: ObjectDetection;
  startTime: number; // when we started pointing at it
}

export class GestureTargetEngine {
  private locked: TargetLock | null = null;
  private candidate: TargetCandidate | null = null;
  private lastPointedAt: number = 0; // last time finger was inside any target

  /** Get current locked target */
  getLockedTarget(): TargetLock | null {
    return this.locked;
  }

  /** Get current candidate (pointing but not yet locked) */
  getCandidate(): TargetCandidate | null {
    return this.candidate;
  }

  /** Force unlock */
  unlock(): void {
    this.locked = null;
    this.candidate = null;
  }

  /** Reset all state */
  reset(): void {
    this.locked = null;
    this.candidate = null;
    this.lastPointedAt = 0;
  }

  /**
   * Update targeting state based on current hand landmarks and detected objects.
   * Call every frame when targetMode is active.
   *
   * @param landmarks - hand landmarks from MediaPipe (21 points, normalized 0-1)
   * @param objects - detected objects from MediaPipe ObjectDetector
   * @returns current lock state (TargetLock or null)
   */
  update(
    landmarks: HandLandmark[] | null,
    objects: ObjectDetection[]
  ): TargetLock | null {
    const now = Date.now();

    // No hand detected — check for auto-unlock
    if (!landmarks || landmarks.length < 21) {
      if (this.locked && now - this.lastPointedAt > UNLOCK_TIME_MS) {
        this.locked = null;
      }
      this.candidate = null;
      return this.locked;
    }

    const fingertip = landmarks[INDEX_TIP];

    // Find which object (if any) the fingertip is pointing at
    let hitObject: ObjectDetection | null = null;
    let hitTarget: DeviceTarget | null = null;

    for (const obj of objects) {
      // Expand bbox by proximity margin for easier targeting
      const x1 = obj.x - PROXIMITY_MARGIN;
      const y1 = obj.y - PROXIMITY_MARGIN;
      const x2 = obj.x + obj.width + PROXIMITY_MARGIN;
      const y2 = obj.y + obj.height + PROXIMITY_MARGIN;

      if (
        fingertip.x >= x1 &&
        fingertip.x <= x2 &&
        fingertip.y >= y1 &&
        fingertip.y <= y2
      ) {
        const device = findDeviceForObject(obj.label);
        if (device) {
          hitObject = obj;
          hitTarget = device;
          break; // first match wins
        }
      }
    }

    // Not pointing at any known device
    if (!hitObject || !hitTarget) {
      // If locked, check auto-unlock timer
      if (this.locked && now - this.lastPointedAt > UNLOCK_TIME_MS) {
        this.locked = null;
      }
      this.candidate = null;
      return this.locked;
    }

    // Pointing at a known device
    this.lastPointedAt = now;

    // Already locked on this device — keep lock
    if (this.locked && this.locked.target.entityId === hitTarget.entityId) {
      // Update the object position (it may move between frames)
      this.locked.object = hitObject;
      return this.locked;
    }

    // Different device than current lock — start new candidate
    if (
      !this.candidate ||
      this.candidate.target.entityId !== hitTarget.entityId
    ) {
      this.candidate = {
        target: hitTarget,
        object: hitObject,
        startTime: now,
      };
      return this.locked; // keep old lock until new one establishes
    }

    // Same candidate — update object position and check if held long enough
    this.candidate.object = hitObject;

    if (now - this.candidate.startTime >= LOCK_TIME_MS) {
      // Lock established!
      this.locked = {
        target: hitTarget,
        object: hitObject,
        lockedAt: now,
      };
      this.candidate = null;
    }

    return this.locked;
  }
}
