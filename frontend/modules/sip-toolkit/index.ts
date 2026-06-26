import { NativeModule, requireNativeModule } from "expo-modules-core";

export interface SipDevice {
  ip: string;
  port: number;
  userAgent: string;
  server: string;
  allow: string[];
  statusCode: number;
  fingerprint: string;
}

export interface SipExtension {
  extension: string;
  status: "exists" | "auth_required" | "forbidden" | "not_found" | "error";
  statusCode: number;
  realm?: string;
  userAgent?: string;
}

export interface AuthResult {
  extension: string;
  username: string;
  success: boolean;
  statusCode: number;
  message: string;
}

export interface ScanProgress {
  phase: string;
  current: number;
  total: number;
  found: number;
}

interface SipToolkitEvents {
  onDeviceFound: (event: SipDevice) => void;
  onExtensionFound: (event: SipExtension) => void;
  onAuthResult: (event: AuthResult) => void;
  onProgress: (event: ScanProgress) => void;
  onRawResponse: (event: { from: string; statusCode: number; body: string }) => void;
  onError: (event: { message: string }) => void;
}

const SipToolkit: NativeModule<SipToolkitEvents> =
  requireNativeModule("SipToolkit");

export async function scanRange(
  startIp: string,
  endIp: string,
  port: number = 5060,
  transport: "udp" | "tcp" = "udp",
  timeoutMs: number = 2000
): Promise<SipDevice[]> {
  return SipToolkit.scanRange(startIp, endIp, port, transport, timeoutMs);
}

export async function enumerateExtensions(
  target: string,
  port: number = 5060,
  startExt: number = 100,
  endExt: number = 999,
  method: "REGISTER" | "INVITE" | "OPTIONS" = "REGISTER",
  transport: "udp" | "tcp" = "udp",
  timeoutMs: number = 1500
): Promise<SipExtension[]> {
  return SipToolkit.enumerateExtensions(
    target, port, startExt, endExt, method, transport, timeoutMs
  );
}

export async function testCredentials(
  target: string,
  port: number,
  extension: string,
  username: string,
  password: string,
  transport: "udp" | "tcp" = "udp"
): Promise<AuthResult> {
  return SipToolkit.testCredentials(target, port, extension, username, password, transport);
}

export async function sendRaw(
  target: string,
  port: number,
  message: string,
  transport: "udp" | "tcp" = "udp",
  timeoutMs: number = 3000
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return SipToolkit.sendRaw(target, port, message, transport, timeoutMs);
}

export function cancelScan(): void {
  SipToolkit.cancelScan();
}

export function addListener(
  eventName: keyof SipToolkitEvents,
  listener: SipToolkitEvents[typeof eventName]
) {
  return SipToolkit.addListener(eventName, listener);
}
