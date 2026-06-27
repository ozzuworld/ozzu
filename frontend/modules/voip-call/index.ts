import { NativeModule, requireNativeModule } from "expo-modules-core";

interface VoipCallEvents {
  onIncomingCall: (event: {
    uuid: string;
    caller: string;
    name: string;
  }) => void;
  onCallAnswered: (event: { uuid: string }) => void;
  onCallEnded: (event: { uuid: string; reason: string }) => void;
  onCallFailed: (event: { uuid: string; error: string }) => void;
  onRegistered: (event: { server: string }) => void;
  onRegistrationFailed: (event: { error: string }) => void;
  onPushToken: (event: { token: string }) => void;
}

const VoipCall: NativeModule<VoipCallEvents> =
  requireNativeModule("VoipCall");

export interface VoipConfig {
  server: string;
  port?: number;
  wsPort?: number;
  username: string;
  password: string;
}

export async function configure(config: VoipConfig): Promise<void> {
  return VoipCall.configure(config);
}

export async function register(): Promise<{ status: string; server: string }> {
  return VoipCall.register();
}

export async function reportIncomingCall(
  callerNumber: string,
  callerName?: string
): Promise<string> {
  return VoipCall.reportIncomingCall(callerNumber, callerName || "");
}

export async function endCall(uuid: string): Promise<void> {
  return VoipCall.endCall(uuid);
}

export async function getActiveCalls(): Promise<
  Array<{ uuid: string; caller: string; name: string; answered: boolean }>
> {
  return VoipCall.getActiveCalls();
}

export function isRegistered(): boolean {
  return VoipCall.isRegistered();
}

export function addListener<K extends keyof VoipCallEvents>(
  eventName: K,
  listener: VoipCallEvents[K]
) {
  return VoipCall.addListener(eventName, listener);
}
