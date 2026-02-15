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

// ── Native module ──

const ExpoGlasses = requireNativeModule("ExpoGlasses");
const emitter = new EventEmitter<GlassesEvents>(ExpoGlasses);

// ── Functions ──

export function isAvailable(): boolean {
  return ExpoGlasses.isAvailable();
}

export async function initialize(): Promise<boolean> {
  return ExpoGlasses.initialize();
}

export async function registerDevice(): Promise<void> {
  return ExpoGlasses.registerDevice();
}

export async function unregisterDevice(): Promise<void> {
  return ExpoGlasses.unregisterDevice();
}

export function getConnectionState(): ConnectionState {
  return ExpoGlasses.getConnectionState();
}

export async function startVideoStream(
  options?: VideoStreamOptions
): Promise<void> {
  return ExpoGlasses.startVideoStream(options ?? {});
}

export async function stopVideoStream(): Promise<void> {
  return ExpoGlasses.stopVideoStream();
}

export async function capturePhoto(): Promise<string | null> {
  return ExpoGlasses.capturePhoto();
}

// ── Event subscriptions ──

export function onConnectionChanged(
  callback: (event: ConnectionChangedEvent) => void
): EventSubscription {
  return emitter.addListener("onConnectionChanged", callback);
}

export function onVideoFrame(
  callback: (event: VideoFrameEvent) => void
): EventSubscription {
  return emitter.addListener("onVideoFrame", callback);
}

export function onPhotoCaptured(
  callback: (event: PhotoCapturedEvent) => void
): EventSubscription {
  return emitter.addListener("onPhotoCaptured", callback);
}

export function onStreamStateChanged(
  callback: (event: StreamStateChangedEvent) => void
): EventSubscription {
  return emitter.addListener("onStreamStateChanged", callback);
}

export function onError(
  callback: (event: GlassesErrorEvent) => void
): EventSubscription {
  return emitter.addListener("onError", callback);
}
