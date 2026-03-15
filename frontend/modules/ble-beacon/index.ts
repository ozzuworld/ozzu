import {
  requireNativeModule,
  EventEmitter,
  type EventSubscription,
} from "expo-modules-core";

export type StateChangeEvent = {
  state: "advertising" | "poweredOff" | "unauthorized" | "unsupported";
};

export type ErrorEvent = {
  error: string;
};

type BleBeaconEvents = Record<string, (...args: any[]) => void> & {
  onStateChange: (event: StateChangeEvent) => void;
  onError: (event: ErrorEvent) => void;
};

let BleBeacon: any = null;
let emitter: EventEmitter<BleBeaconEvents> | null = null;

try {
  BleBeacon = requireNativeModule("BleBeacon");
  emitter = new EventEmitter<BleBeaconEvents>(BleBeacon);
} catch {
  // Native module not available (Android/TV builds)
}

export const nativeAvailable = BleBeacon !== null;

/** Start BLE peripheral advertising with a device name */
export async function startAdvertising(
  name: string = "ozzu-phone"
): Promise<boolean> {
  if (!BleBeacon) return false;
  return BleBeacon.startAdvertising(name);
}

/** Stop BLE advertising */
export function stopAdvertising(): void {
  if (!BleBeacon) return;
  BleBeacon.stopAdvertising();
}

/** Check if currently advertising */
export function isAdvertising(): boolean {
  if (!BleBeacon) return false;
  return BleBeacon.isAdvertising();
}

/** Check if BLE peripheral mode is available */
export function isAvailable(): boolean {
  if (!BleBeacon) return false;
  return BleBeacon.isAvailable();
}

/** Subscribe to state changes */
export function onStateChange(
  callback: (event: StateChangeEvent) => void
): EventSubscription {
  if (!emitter) return { remove: () => {} };
  return emitter.addListener("onStateChange", callback);
}

/** Subscribe to errors */
export function onError(
  callback: (event: ErrorEvent) => void
): EventSubscription {
  if (!emitter) return { remove: () => {} };
  return emitter.addListener("onError", callback);
}
