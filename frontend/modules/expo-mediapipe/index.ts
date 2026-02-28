import { requireNativeModule } from "expo-modules-core";

let ExpoMediaPipe: any = null;
try {
  ExpoMediaPipe = requireNativeModule("ExpoMediaPipe");
} catch {}

export const nativeAvailable = ExpoMediaPipe !== null;
export const isAvailable = () => ExpoMediaPipe !== null;

export interface HandLandmark {
  x: number;
  y: number;
  z: number; // normalized 0-1
}

export interface HandResult {
  landmarks: HandLandmark[]; // 21 points
  handedness: "Left" | "Right" | "unknown";
  confidence: number;
}

export async function initialize(): Promise<boolean> {
  if (!ExpoMediaPipe) return false;
  return ExpoMediaPipe.initialize();
}

export async function detectHands(base64Jpeg: string): Promise<HandResult[]> {
  if (!ExpoMediaPipe) return [];
  return ExpoMediaPipe.detectHands(base64Jpeg);
}

export async function dispose(): Promise<void> {
  if (!ExpoMediaPipe) return;
  return ExpoMediaPipe.dispose();
}
