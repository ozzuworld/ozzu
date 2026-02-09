import "../global.css";
import { Stack } from "expo-router";
import { HAProvider } from "../lib/ha-context";

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
