import { requireNativeModule } from "expo-modules-core";

let ExpoMediaPipe: any = null;
try {
  ExpoMediaPipe = requireNativeModule("ExpoMediaPipe");
} catch {}

export const nativeAvailable = ExpoMediaPipe !== null;
export const isAvailable = () => ExpoMediaPipe !== null;

// ── Hand detection types ──

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

// ── Face detection types ──

export interface FaceBoundingBox {
  x: number; // normalized 0-1
  y: number;
  width: number;
  height: number;
}

export interface FaceResult {
  boundingBox: FaceBoundingBox;
  landmarkCount: number;
  blendshapes: Record<string, number>; // blendshape name → score 0-1
  confidence: number;
}

// ── Hand detection API ──

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

// ── Face detection API ──

export async function initializeFaces(): Promise<boolean> {
  if (!ExpoMediaPipe) return false;
  return ExpoMediaPipe.initializeFaces();
}

export async function detectFaces(base64Jpeg: string): Promise<FaceResult[]> {
  if (!ExpoMediaPipe) return [];
  return ExpoMediaPipe.detectFaces(base64Jpeg);
}

export async function disposeFaces(): Promise<void> {
  if (!ExpoMediaPipe) return;
  return ExpoMediaPipe.disposeFaces();
}
