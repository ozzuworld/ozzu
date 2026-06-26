import { NativeModule, requireNativeModule } from "expo-modules-core";

interface SocksRelayEvents {
  onStateChange: (event: { running: boolean; clientCount: number; port: number }) => void;
  onClientConnect: (event: { remoteAddr: string; targetAddr: string; targetPort: number }) => void;
  onError: (event: { message: string }) => void;
}

const SocksRelay: NativeModule<SocksRelayEvents> =
  requireNativeModule("SocksRelay");

export async function startRelay(port: number = 1080): Promise<boolean> {
  return SocksRelay.startRelay(port);
}

export function stopRelay(): void {
  SocksRelay.stopRelay();
}

export function isRunning(): boolean {
  return SocksRelay.isRunning();
}

export function getStats(): { clientCount: number; totalConnections: number; port: number } {
  return SocksRelay.getStats();
}

export function addListener(
  eventName: keyof SocksRelayEvents,
  listener: SocksRelayEvents[typeof eventName]
) {
  return SocksRelay.addListener(eventName, listener);
}
