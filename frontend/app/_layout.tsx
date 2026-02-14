import "../global.css";
import React from "react";
import { LogBox, View, Text } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HAProvider } from "../lib/ha-context";

if (!__DEV__) {
  LogBox.ignoreAllLogs();
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

  componentDidCatch(error: Error) {
    console.error("[ErrorBoundary]", error);
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
