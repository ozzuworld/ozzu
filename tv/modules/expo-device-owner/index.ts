import { requireNativeModule } from "expo-modules-core";

const DeviceOwnerModule = requireNativeModule("DeviceOwner");

/** Returns true if this app is the device owner (can silently install APKs) */
export function isDeviceOwner(): boolean {
  return DeviceOwnerModule.isDeviceOwner();
}

/** Returns the current app versionCode from PackageInfo */
export function getVersionCode(): number {
  return DeviceOwnerModule.getVersionCode();
}

/**
 * Download an APK from the given URL and install it silently.
 * Only works when the app is device owner (provisioned via `adb shell dpm set-device-owner`).
 * Returns a promise that resolves when the install completes.
 */
export async function downloadAndInstall(url: string): Promise<string> {
  return DeviceOwnerModule.downloadAndInstall(url);
}
