import { View } from "react-native";

interface ProgressBarProps {
  done: number;
  total: number;
  color?: string;
  height?: number;
}

export function ProgressBar({ done, total, color = "#06B6D4", height = 4 }: ProgressBarProps) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <View style={{ height, backgroundColor: "#2A2A2A", borderRadius: height / 2, overflow: "hidden" }}>
      <View style={{ width: `${pct}%`, height: "100%", backgroundColor: color, borderRadius: height / 2 }} />
    </View>
  );
}
