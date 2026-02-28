import type { HandLandmark } from "../modules/expo-mediapipe";

export type GestureType = "pinch" | "point" | "grab" | "open_palm" | "none";

export interface GestureResult {
  gesture: GestureType;
  confidence: number; // 0-1
  activeFingers: number[]; // landmark indices involved
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

export function detectGesture(landmarks: HandLandmark[]): GestureResult {
  if (!landmarks || landmarks.length < 21) {
    return { gesture: "none", confidence: 0, activeFingers: [] };
  }

  // Priority order: pinch > point > grab > open_palm
  const pinch = detectPinch(landmarks);
  if (pinch) return pinch;

  const point = detectPoint(landmarks);
  if (point) return point;

  const grab = detectGrab(landmarks);
  if (grab) return grab;

  const palm = detectOpenPalm(landmarks);
  if (palm) return palm;

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
    default:
      return "";
  }
}
