// Expression detection from MediaPipe FaceLandmarker blendshapes
// Detects: smile, surprise, wink, frown, mouth_open, eyebrow_raise

export type ExpressionType =
  | "smile"
  | "surprise"
  | "wink_left"
  | "wink_right"
  | "frown"
  | "mouth_open"
  | "eyebrow_raise"
  | "neutral";

export interface ExpressionResult {
  expression: ExpressionType;
  confidence: number;
  emoji: string;
}

// Blendshape thresholds for expression detection
// Names from MediaPipe FaceLandmarker blendshape output
const SMILE_SHAPES = ["mouthSmileLeft", "mouthSmileRight"];
const SURPRISE_SHAPES = ["browOuterUpLeft", "browOuterUpRight", "jawOpen"];
const FROWN_SHAPES = ["mouthFrownLeft", "mouthFrownRight"];
const BLINK_LEFT = "eyeBlinkLeft";
const BLINK_RIGHT = "eyeBlinkRight";
const JAW_OPEN = "jawOpen";
const BROW_UP = ["browOuterUpLeft", "browOuterUpRight"];

function avg(blendshapes: Record<string, number>, keys: string[]): number {
  let sum = 0;
  let count = 0;
  for (const k of keys) {
    if (k in blendshapes) {
      sum += blendshapes[k];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

export function detectExpression(blendshapes: Record<string, number>): ExpressionResult {
  if (!blendshapes || Object.keys(blendshapes).length === 0) {
    return { expression: "neutral", confidence: 0, emoji: "" };
  }

  const smile = avg(blendshapes, SMILE_SHAPES);
  const frown = avg(blendshapes, FROWN_SHAPES);
  const jawOpen = blendshapes[JAW_OPEN] || 0;
  const browUp = avg(blendshapes, BROW_UP);
  const blinkL = blendshapes[BLINK_LEFT] || 0;
  const blinkR = blendshapes[BLINK_RIGHT] || 0;

  // Priority: surprise > wink > smile > frown > mouth_open > eyebrow_raise

  // Surprise: brows up + jaw open
  if (browUp > 0.4 && jawOpen > 0.3) {
    return { expression: "surprise", confidence: Math.min(1, (browUp + jawOpen) / 2), emoji: "\u{1F632}" };
  }

  // Wink: one eye blink while other open
  if (blinkL > 0.5 && blinkR < 0.3) {
    return { expression: "wink_left", confidence: blinkL, emoji: "\u{1F609}" };
  }
  if (blinkR > 0.5 && blinkL < 0.3) {
    return { expression: "wink_right", confidence: blinkR, emoji: "\u{1F609}" };
  }

  // Smile
  if (smile > 0.4) {
    return { expression: "smile", confidence: smile, emoji: "\u{1F604}" };
  }

  // Frown
  if (frown > 0.3) {
    return { expression: "frown", confidence: frown, emoji: "\u{1F641}" };
  }

  // Mouth open (talking/yawning)
  if (jawOpen > 0.4) {
    return { expression: "mouth_open", confidence: jawOpen, emoji: "\u{1F62E}" };
  }

  // Eyebrow raise
  if (browUp > 0.35) {
    return { expression: "eyebrow_raise", confidence: browUp, emoji: "\u{1F928}" };
  }

  return { expression: "neutral", confidence: 1 - Math.max(smile, frown, jawOpen, browUp), emoji: "" };
}

export function expressionLabel(expr: ExpressionResult): string {
  if (expr.expression === "neutral") return "";
  return expr.expression.toUpperCase().replace(/_/g, " ");
}
