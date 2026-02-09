import "../global.css";
import { LogBox } from "react-native";
import { Stack } from "expo-router";
import { HAProvider } from "../lib/ha-context";

LogBox.ignoreAllLogs();

export default function RootLayout() {
  return (
    <HAProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: "#111111" },
        }}
      />
    </HAProvider>
  );
}
