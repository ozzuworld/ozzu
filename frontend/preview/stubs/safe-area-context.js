// Preview stub of react-native-safe-area-context — fixed iPhone 14/15 logical
// insets (59 top Dynamic Island, 34 bottom home indicator).
import React from "react";
const INSETS = { top: 59, bottom: 34, left: 0, right: 0 };
export function useSafeAreaInsets() { return INSETS; }
export function useSafeAreaFrame() { return { x: 0, y: 0, width: 393, height: 852 }; }
export function SafeAreaProvider({ children }) { return children ?? null; }
export function SafeAreaView({ children, style }) {
  return React.createElement("div", { style }, children);
}
