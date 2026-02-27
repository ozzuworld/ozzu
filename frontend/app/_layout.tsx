import "../global.css";
import React from "react";
import { LogBox, View, Text, Platform } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HAProvider } from "../lib/ha-context";

if (!__DEV__) {
  LogBox.ignoreAllLogs();
}

// ── Crash Reporter ──
// Sends crash reports to bridge via HTTP (works even when WS is down)
const BRIDGE_URL = process.env.EXPO_PUBLIC_BRIDGE_URL || "http://10.8.0.1:3333";

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
        <View style={{ flex: 1, backgroundColor: "#111", alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#EF4444", fontSize: 16, fontFamily: "monospace", marginBottom: 8 }}>
            Something went wrong
          </Text>
          <Text style={{ color: "#6B7280", fontSize: 12, fontFamily: "monospace", textAlign: "center", paddingHorizontal: 32 }}>
            {this.state.error}
          </Text>
          <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace", marginTop: 16 }}>
            Recovering in 5s...
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <HAProvider>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: "#111111" },
            }}
          />
        </HAProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
