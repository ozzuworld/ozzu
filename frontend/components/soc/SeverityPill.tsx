// SeverityPill — compact "🔴 3" style chip for severity counts on cards,
// or solo pill for a single finding's severity badge.

import { Pressable, Text, View } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing, withAlpha } from "../../lib/design-tokens";
import { severityColor, severityIcon } from "./phaseColors";

interface SeverityPillProps {
  severity: string;
  count?: number;
  selected?: boolean;
  onPress?: () => void;
  size?: "sm" | "md";
}

export function SeverityPill({ severity, count, selected, onPress, size = "sm" }: SeverityPillProps) {
  const color = severityColor(severity);
  const fs = size === "sm" ? fontSize.xs : fontSize.sm;
  const padV = size === "sm" ? 2 : 4;
  const padH = size === "sm" ? spacing.xs + 2 : spacing.sm;
  const bg = selected ? withAlpha(color, 0.28) : withAlpha(color, 0.14);

  const content = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: bg,
        borderRadius: radius.sm,
        paddingHorizontal: padH,
        paddingVertical: padV,
        borderWidth: selected ? 1 : 0,
        borderColor: selected ? color : "transparent",
      }}
    >
      <Text style={{ fontSize: fs }}>{severityIcon(severity)}</Text>
      {count !== undefined ? (
        <Text style={{ color, fontSize: fs, fontWeight: fontWeight.bold }}>{count}</Text>
      ) : null}
      <Text style={{ color, fontSize: fs, fontWeight: fontWeight.medium, textTransform: "uppercase" }}>
        {severity}
      </Text>
    </View>
  );

  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {content}
    </Pressable>
  );
}
