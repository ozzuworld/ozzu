import "../global.css";
import React, { useEffect } from "react";
import { AppState, LogBox, View, Text, Platform, Dimensions } from "react-native";
import { Stack, useRouter } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HAProvider } from "../lib/ha-context";
import { GlassesProvider } from "../lib/glasses-context";
import { setImmersiveCallback } from "../lib/immersive-events";
import { probeBridgeUrl, resetBridgeUrl } from "../lib/bridge-api";
import { GlobalApprovalGate } from "../components/GlobalApprovalGate";
import * as BleBeacon from "../modules/ble-beacon";
import { registerForPushNotifications } from "../lib/push-notifications";

import { colors } from "../lib/design-tokens";
if (!__DEV__) {
  LogBox.ignoreAllLogs();
}

// ── Crash Reporter ──
// Sends crash reports to bridge via HTTP (works even when WS is down)
const BRIDGE_URL = process.env.EXPO_PUBLIC_BRIDGE_URL || "https://home.ozzu.world/bridge";

function reportCrash(error: string, stack?: string | null, componentStack?: string | null, context?: string | null) {
  fetch(`${BRIDGE_URL}/api/crash-reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: "unknown", // filled by bridge-session when available
      deviceType: "unknown",
      platform: Platform.OS,
      error,
      stack: stack || null,
      componentStack: componentStack || null,
      context: context || null,
    }),
  }).catch(() => {}); // fire-and-forget
}

// Global unhandled JS exception handler
const originalHandler = (globalThis as any).ErrorUtils?.getGlobalHandler?.();
(globalThis as any).ErrorUtils?.setGlobalHandler?.((error: Error, isFatal?: boolean) => {
  reportCrash(
    `${isFatal ? "[FATAL] " : ""}${error.message}`,
    error.stack,
    null,
    "globalHandler"
  );
  // Call original handler so RN still shows red box in dev
  if (originalHandler) originalHandler(error, isFatal);
});

// Global unhandled promise rejection handler
if (typeof globalThis !== "undefined") {
  const onRejection = (event: any) => {
    const reason = event?.reason;
    const message = reason instanceof Error ? reason.message : String(reason || "Unknown rejection");
    const stack = reason instanceof Error ? reason.stack : null;
    reportCrash(message, stack, null, "unhandledRejection");
  };
  // @ts-ignore — addEventListener exists on globalThis in Hermes
  globalThis.addEventListener?.("unhandledrejection", onRejection);
}

// Simple error boundary for kiosk resilience — auto-reloads after crash
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  state = { hasError: false, error: "" };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error);
    // Report to bridge
    reportCrash(error.message, error.stack, errorInfo?.componentStack, "ErrorBoundary");
    // Auto-recover after 5 seconds
    setTimeout(() => this.setState({ hasError: false, error: "" }), 5000);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, backgroundColor: colors.gray[850], alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.error, fontSize: 16, fontFamily: "monospace", marginBottom: 8 }}>
            Something went wrong
          </Text>
          <Text style={{ color: "#6B7280", fontSize: 12, fontFamily: "monospace", textAlign: "center", paddingHorizontal: 32 }}>
            {this.state.error}
          </Text>
          <Text style={{ color: colors.gray[400], fontSize: 11, fontFamily: "monospace", marginTop: 16 }}>
            Recovering in 5s...
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

/** Phone-only, iOS-only: listens for immersive mode activation from bridge and navigates to glasses screen */
function ImmersiveListener() {
  const router = useRouter();

  useEffect(() => {
    // Only on iPhone (iOS + screen width < 500)
    if (Platform.OS !== "ios") return;
    const { width } = Dimensions.get("screen");
    if (width >= 500) return;

    setImmersiveCallback((enable) => {
      if (enable) {
        router.push("/glasses?immersive=true");
      }
      // Disable is handled inside glasses.tsx itself
    });

    return () => setImmersiveCallback(null);
  }, [router]);

  return null;
}

// ── Console redirect to bridge (for remote debugging) ──
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
function remoteLog(level: string, ...args: any[]) {
  const msg = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  fetch(`${BRIDGE_URL}/api/device-logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device: `${Platform.OS}`, level, msg }),
  }).catch(() => {});
}
console.log = (...a) => { _origLog(...a); remoteLog("log", ...a); };
console.warn = (...a) => { _origWarn(...a); remoteLog("warn", ...a); };
console.error = (...a) => { _origError(...a); remoteLog("error", ...a); };

export default function RootLayout() {
  useEffect(() => {
    remoteLog("boot", `[boot] RootLayout mounted — platform=${Platform.OS}`);
    probeBridgeUrl();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") { resetBridgeUrl(); probeBridgeUrl(); }
    });

    // Start BLE beacon on iPhone for indoor positioning
    if (Platform.OS === "ios" && BleBeacon.nativeAvailable && BleBeacon.isAvailable()) {
      BleBeacon.startAdvertising("kazuma-iphone");
    }

    // Register for push notifications (requires expo-notifications native build)
    if (Platform.OS === "ios") {
      registerForPushNotifications("kazuma-iphone").catch(() => {});
    }

    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <HAProvider>
          <GlassesProvider>
            <ImmersiveListener />
            <GlobalApprovalGate />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.gray[850] },
              }}
            />
          </GlassesProvider>
        </HAProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
