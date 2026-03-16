import type { HandLandmark } from "../modules/expo-mediapipe";

export type GestureType =
  | "pinch"
  | "point"
  | "grab"
  | "open_palm"
  | "thumbs_up"
  | "peace"
  | "ok_sign"
  | "finger_count"
  | "swipe_left"
  | "swipe_right"
  | "swipe_down"
  | "none";

export interface GestureResult {
  gesture: GestureType;
  confidence: number; // 0-1
  activeFingers: number[]; // landmark indices involved
  fingerCount?: number; // for finger_count gesture (1-5)
}

// MediaPipe hand landmark indices
const WRIST = 0;
const THUMB_CMC = 1;
const THUMB_MCP = 2;
const THUMB_IP = 3;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_DIP = 7;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_DIP = 11;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_PIP = 14;
const RING_DIP = 15;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_DIP = 19;
const PINKY_TIP = 20;

function dist(a: HandLandmark, b: HandLandmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Check if a finger is extended (tip above MCP in normalized coords)
// Note: y increases downward in image space, so extended = tip.y < mcp.y
function isFingerExtended(
  landmarks: HandLandmark[],
  tip: number,
  pip: number,
  mcp: number
): boolean {
  return landmarks[tip].y < landmarks[mcp].y;
}

// Check if a finger is curled (tip below PIP)
function isFingerCurled(
  landmarks: HandLandmark[],
  tip: number,
  pip: number
): boolean {
  return landmarks[tip].y > landmarks[pip].y;
}

// Check if thumb is extended sideways (for thumbs up, the thumb tip is above thumb IP)
function isThumbUp(landmarks: HandLandmark[]): boolean {
  // Thumb tip is significantly above thumb IP and MCP (vertical extension)
  return (
    landmarks[THUMB_TIP].y < landmarks[THUMB_IP].y &&
    landmarks[THUMB_TIP].y < landmarks[THUMB_MCP].y &&
    // Thumb tip is above wrist level
    landmarks[THUMB_TIP].y < landmarks[WRIST].y
  );
}

function detectPinch(landmarks: HandLandmark[]): GestureResult | null {
  const d = dist(landmarks[THUMB_TIP], landmarks[INDEX_TIP]);
  if (d < 0.05) {
    return {
      gesture: "pinch",
      confidence: Math.max(0, 1 - d / 0.05),
      activeFingers: [THUMB_TIP, INDEX_TIP],
    };
  }
  return null;
}

// OK sign: thumb + index form a circle (tips close), other fingers extended
function detectOkSign(landmarks: HandLandmark[]): GestureResult | null {
  const thumbIndexDist = dist(landmarks[THUMB_TIP], landmarks[INDEX_TIP]);
  if (thumbIndexDist > 0.06) return null;

  // Other 3 fingers should be extended
  const middleUp = isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP);
  const ringUp = isFingerExtended(landmarks, RING_TIP, RING_PIP, RING_MCP);
  const pinkyUp = isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP, PINKY_MCP);

  if (middleUp && ringUp && pinkyUp) {
    return {
      gesture: "ok_sign",
      confidence: 0.85,
      activeFingers: [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP],
    };
  }
  return null;
}

// Thumbs up: thumb extended vertically, all other fingers curled
function detectThumbsUp(landmarks: HandLandmark[]): GestureResult | null {
  if (!isThumbUp(landmarks)) return null;

  const indexCurled = isFingerCurled(landmarks, INDEX_TIP, INDEX_PIP);
  const middleCurled = isFingerCurled(landmarks, MIDDLE_TIP, MIDDLE_PIP);
  const ringCurled = isFingerCurled(landmarks, RING_TIP, RING_PIP);
  const pinkyCurled = isFingerCurled(landmarks, PINKY_TIP, PINKY_PIP);

  if (indexCurled && middleCurled && ringCurled && pinkyCurled) {
    return {
      gesture: "thumbs_up",
      confidence: 0.9,
      activeFingers: [THUMB_CMC, THUMB_MCP, THUMB_IP, THUMB_TIP],
    };
  }
  return null;
}

// Peace sign: index + middle extended, ring + pinky curled
function detectPeace(landmarks: HandLandmark[]): GestureResult | null {
  const indexUp = isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP, INDEX_MCP);
  const middleUp = isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP);
  const ringCurled = isFingerCurled(landmarks, RING_TIP, RING_PIP);
  const pinkyCurled = isFingerCurled(landmarks, PINKY_TIP, PINKY_PIP);

  if (indexUp && middleUp && ringCurled && pinkyCurled) {
    // Make sure fingers are spread (distinguishes from point with middle slightly up)
    const spread = dist(landmarks[INDEX_TIP], landmarks[MIDDLE_TIP]);
    if (spread > 0.04) {
      return {
        gesture: "peace",
        confidence: 0.85,
        activeFingers: [INDEX_MCP, INDEX_PIP, INDEX_DIP, INDEX_TIP, MIDDLE_MCP, MIDDLE_PIP, MIDDLE_DIP, MIDDLE_TIP],
      };
    }
  }
  return null;
}

function detectPoint(landmarks: HandLandmark[]): GestureResult | null {
  const indexExtended = isFingerExtended(
    landmarks,
    INDEX_TIP,
    INDEX_PIP,
    INDEX_MCP
  );
  const middleCurled = isFingerCurled(landmarks, MIDDLE_TIP, MIDDLE_PIP);
  const ringCurled = isFingerCurled(landmarks, RING_TIP, RING_PIP);
  const pinkyCurled = isFingerCurled(landmarks, PINKY_TIP, PINKY_PIP);

  if (indexExtended && middleCurled && ringCurled && pinkyCurled) {
    return {
      gesture: "point",
      confidence: 0.85,
      activeFingers: [INDEX_MCP, INDEX_PIP, INDEX_DIP, INDEX_TIP],
    };
  }
  return null;
}

function detectGrab(landmarks: HandLandmark[]): GestureResult | null {
  const allCurled =
    isFingerCurled(landmarks, THUMB_TIP, THUMB_IP) &&
    isFingerCurled(landmarks, INDEX_TIP, INDEX_PIP) &&
    isFingerCurled(landmarks, MIDDLE_TIP, MIDDLE_PIP) &&
    isFingerCurled(landmarks, RING_TIP, RING_PIP) &&
    isFingerCurled(landmarks, PINKY_TIP, PINKY_PIP);

  if (allCurled) {
    return {
      gesture: "grab",
      confidence: 0.9,
      activeFingers: [
        THUMB_TIP,
        INDEX_TIP,
        MIDDLE_TIP,
        RING_TIP,
        PINKY_TIP,
      ],
    };
  }
  return null;
}

function detectOpenPalm(landmarks: HandLandmark[]): GestureResult | null {
  const allExtended =
    isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP, INDEX_MCP) &&
    isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP) &&
    isFingerExtended(landmarks, RING_TIP, RING_PIP, RING_MCP) &&
    isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP, PINKY_MCP);

  // Check fingers are spread (distance between index and pinky tips)
  const spread = dist(landmarks[INDEX_TIP], landmarks[PINKY_TIP]);

  if (allExtended && spread > 0.1) {
    return {
      gesture: "open_palm",
      confidence: 0.85,
      activeFingers: [
        THUMB_TIP,
        INDEX_TIP,
        MIDDLE_TIP,
        RING_TIP,
        PINKY_TIP,
      ],
    };
  }
  return null;
}

// Count extended fingers (1-5) — used as a generic "number" gesture
function detectFingerCount(landmarks: HandLandmark[]): GestureResult | null {
  let count = 0;
  const active: number[] = [];

  // Thumb: check if tip is to the side of MCP (extended outward)
  if (isThumbUp(landmarks) || dist(landmarks[THUMB_TIP], landmarks[INDEX_MCP]) > 0.08) {
    count++;
    active.push(THUMB_TIP);
  }
  if (isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP, INDEX_MCP)) {
    count++;
    active.push(INDEX_TIP);
  }
  if (isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP)) {
    count++;
    active.push(MIDDLE_TIP);
  }
  if (isFingerExtended(landmarks, RING_TIP, RING_PIP, RING_MCP)) {
    count++;
    active.push(RING_TIP);
  }
  if (isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP, PINKY_MCP)) {
    count++;
    active.push(PINKY_TIP);
  }

  // Only return finger count for 1-5 (and only if it doesn't match a more specific gesture)
  if (count >= 1 && count <= 5) {
    return {
      gesture: "finger_count",
      confidence: 0.7,
      activeFingers: active,
      fingerCount: count,
    };
  }
  return null;
}

// ── Swipe detection (requires tracking wrist position across frames) ──

let prevWristX: number | null = null;
let prevWristY: number | null = null;
let prevWristTime = 0;

export function resetSwipeTracking(): void {
  prevWristX = null;
  prevWristY = null;
  prevWristTime = 0;
}

function detectSwipe(landmarks: HandLandmark[]): GestureResult | null {
  const now = Date.now();
  const wristX = landmarks[WRIST].x;
  const wristY = landmarks[WRIST].y;

  if (prevWristX !== null && prevWristY !== null && now - prevWristTime < 500) {
    const dx = wristX - prevWristX;
    const dy = wristY - prevWristY;
    const dt = now - prevWristTime;

    if (dt > 50) {
      // Check vertical swipe first (swipe down = cycle device target)
      // y increases downward in image space, so dy > 0 = swipe down
      if (dy > 0.10 && Math.abs(dy) > Math.abs(dx) * 1.3) {
        // Swipe down — just need 2+ fingers visible (any open hand swipe)
        const indexUp = isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP, INDEX_MCP);
        const middleUp = isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP);
        const ringUp = isFingerExtended(landmarks, RING_TIP, RING_PIP, RING_MCP);
        const pinkyUp = isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP, PINKY_MCP);
        const extendedCount = [indexUp, middleUp, ringUp, pinkyUp].filter(Boolean).length;

        if (extendedCount >= 2) {
          prevWristX = wristX;
          prevWristY = wristY;
          prevWristTime = now;
          return {
            gesture: "swipe_down",
            confidence: Math.min(1, dy / 0.18),
            activeFingers: [INDEX_TIP, MIDDLE_TIP],
            fingerCount: 2,
          };
        }
      }

      // Horizontal swipes
      if (Math.abs(dx) > 0.15) {
        prevWristX = wristX;
        prevWristY = wristY;
        prevWristTime = now;

        if (dx < 0) {
          return {
            gesture: "swipe_left",
            confidence: Math.min(1, Math.abs(dx) / 0.2),
            activeFingers: [WRIST],
          };
        } else {
          return {
            gesture: "swipe_right",
            confidence: Math.min(1, dx / 0.2),
            activeFingers: [WRIST],
          };
        }
      }
    }
  }

  prevWristX = wristX;
  prevWristY = wristY;
  prevWristTime = now;
  return null;
}

export function detectGesture(landmarks: HandLandmark[]): GestureResult {
  if (!landmarks || landmarks.length < 21) {
    return { gesture: "none", confidence: 0, activeFingers: [] };
  }

  // Check swipe first (motion-based, highest priority)
  const swipe = detectSwipe(landmarks);
  if (swipe) return swipe;

  // Priority order: ok_sign > pinch > thumbs_up > peace > point > grab > open_palm > finger_count
  // ok_sign before pinch because both have thumb+index close, but ok has other fingers extended
  const ok = detectOkSign(landmarks);
  if (ok) return ok;

  const pinch = detectPinch(landmarks);
  if (pinch) return pinch;

  const thumbsUp = detectThumbsUp(landmarks);
  if (thumbsUp) return thumbsUp;

  const peace = detectPeace(landmarks);
  if (peace) return peace;

  const point = detectPoint(landmarks);
  if (point) return point;

  const grab = detectGrab(landmarks);
  if (grab) return grab;

  const palm = detectOpenPalm(landmarks);
  if (palm) return palm;

  // Finger count as lowest priority fallback (catches partial gestures)
  const count = detectFingerCount(landmarks);
  if (count) return count;

  return { gesture: "none", confidence: 0, activeFingers: [] };
}

export function gestureEmoji(gesture: GestureType): string {
  switch (gesture) {
    case "pinch":
      return "\u{1F90F}";
    case "point":
      return "\u{261D}\u{FE0F}";
    case "grab":
      return "\u{270A}";
    case "open_palm":
      return "\u{1F590}\u{FE0F}";
    case "thumbs_up":
      return "\u{1F44D}";
    case "peace":
      return "\u{270C}\u{FE0F}";
    case "ok_sign":
      return "\u{1F44C}";
    case "finger_count":
      return "\u{1F91A}";
    case "swipe_left":
      return "\u{1F448}";
    case "swipe_right":
      return "\u{1F449}";
    case "swipe_down":
      return "\u{1F447}";
    default:
      return "";
  }
}

export function gestureLabel(result: GestureResult): string {
  if (result.gesture === "finger_count" && result.fingerCount) {
    return `${result.fingerCount}`;
  }
  return result.gesture.toUpperCase().replace(/_/g, " ");
}
