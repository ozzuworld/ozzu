import {
  requireNativeModule,
  EventEmitter,
  type EventSubscription,
} from "expo-modules-core";

// ── Types ──

export type ConnectionState =
  | "connected"
  | "disconnected"
  | "connecting"
  | "unavailable";

export type VideoStreamOptions = {
  quality?: "low" | "medium" | "high";
  frameRate?: number;
};

export type ConnectionChangedEvent = {
  state: ConnectionState;
  error?: string;
};

export type VideoFrameEvent = {
  data: string; // base64 JPEG
  width: number;
  height: number;
  timestamp: number;
};

export type PhotoCapturedEvent = {
  data: string; // base64 JPEG
  format: string;
};

export type StreamStateChangedEvent = {
  state: string;
};

export type GlassesErrorEvent = {
  code: string;
  message: string;
};

type GlassesEvents = Record<string, (...args: any[]) => void> & {
  onConnectionChanged: (event: ConnectionChangedEvent) => void;
  onVideoFrame: (event: VideoFrameEvent) => void;
  onPhotoCaptured: (event: PhotoCapturedEvent) => void;
  onStreamStateChanged: (event: StreamStateChangedEvent) => void;
  onError: (event: GlassesErrorEvent) => void;
};

// ── Native module (graceful fallback if not in current binary) ──

let ExpoGlasses: any = null;
let emitter: EventEmitter<GlassesEvents> | null = null;

try {
  ExpoGlasses = requireNativeModule("ExpoGlasses");
  emitter = new EventEmitter<GlassesEvents>(ExpoGlasses);
} catch {
  // Native module not available in this binary — all functions return safe defaults
}

/** Whether the native module is loaded in the current binary */
export const nativeAvailable = ExpoGlasses !== null;

// ── Functions ──

export function isAvailable(): boolean {
  if (!ExpoGlasses) return false;
  return ExpoGlasses.isAvailable();
}

export async function initialize(): Promise<boolean> {
  if (!ExpoGlasses) return false;
  return ExpoGlasses.initialize();
}

export async function registerDevice(): Promise<void> {
  if (!ExpoGlasses) throw new Error("Native module not available — rebuild required");
  return ExpoGlasses.registerDevice();
}

export async function unregisterDevice(): Promise<void> {
  if (!ExpoGlasses) throw new Error("Native module not available — rebuild required");
  return ExpoGlasses.unregisterDevice();
}

export function getConnectionState(): ConnectionState {
  if (!ExpoGlasses) return "unavailable";
  return ExpoGlasses.getConnectionState();
}

export async function startVideoStream(
  options?: VideoStreamOptions
): Promise<void> {
  if (!ExpoGlasses) throw new Error("Native module not available — rebuild required");
  return ExpoGlasses.startVideoStream(options ?? {});
}

export async function stopVideoStream(): Promise<void> {
  if (!ExpoGlasses) throw new Error("Native module not available — rebuild required");
  return ExpoGlasses.stopVideoStream();
}

export async function capturePhoto(): Promise<string | null> {
  if (!ExpoGlasses) throw new Error("Native module not available — rebuild required");
  return ExpoGlasses.capturePhoto();
}

// ── Event subscriptions (no-op if native module missing) ──

const noopSubscription: EventSubscription = { remove: () => {} };

export function onConnectionChanged(
  callback: (event: ConnectionChangedEvent) => void
): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onConnectionChanged", callback);
}

export function onVideoFrame(
  callback: (event: VideoFrameEvent) => void
): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onVideoFrame", callback);
}

export function onPhotoCaptured(
  callback: (event: PhotoCapturedEvent) => void
): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onPhotoCaptured", callback);
}

export function onStreamStateChanged(
  callback: (event: StreamStateChangedEvent) => void
): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onStreamStateChanged", callback);
}

export function onError(
  callback: (event: GlassesErrorEvent) => void
): EventSubscription {
  if (!emitter) return noopSubscription;
  return emitter.addListener("onError", callback);
}
