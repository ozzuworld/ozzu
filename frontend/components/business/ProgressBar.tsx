import { View } from "react-native";

import { colors } from "../../lib/design-tokens";
interface ProgressBarProps {
  done: number;
  total: number;
  color?: string;
  height?: number;
  glow?: boolean;
}

export function ProgressBar({ done, total, color = colors.accent, height = 4, glow }: ProgressBarProps) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <View style={{ height, backgroundColor: "#222", borderRadius: height / 2, overflow: "hidden" }}>
      <View
        style={{
          width: `${pct}%`,
          height: "100%",
          backgroundColor: color,
          borderRadius: height / 2,
          ...(glow ? { shadowColor: color, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 4 } : {}),
        }}
      />
    </View>
  );
}
