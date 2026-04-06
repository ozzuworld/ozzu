import { useEffect } from "react";
import { View } from "react-native";
import { router } from "expo-router";

// / maps here. Redirect to directives tab (sibling tab — safe after tab mount).
// Do NOT use <Redirect> — Expo Router tab navigator crashes reading displayName on it.
export default function Index() {
  useEffect(() => {
    router.replace("/directives");
  }, []);
  return <View style={{ flex: 1, backgroundColor: "#0a0a0f" }} />;
}
