// PhasePill — colored pill showing the engagement_phase value.
// Tap to open a phase picker (parent supplies onPress).

import { Pressable, Text, View } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing, withAlpha } from "../../lib/design-tokens";
import { phaseColor, phaseLabel } from "./phaseColors";

interface PhasePillProps {
  phase?: string | null;
  onPress?: () => void;
  size?: "sm" | "md";
}

export function PhasePill({ phase, onPress, size = "md" }: PhasePillProps) {
  const color = phaseColor(phase);
  const label = phaseLabel(phase);
  const fs = size === "sm" ? fontSize.xs : fontSize.sm;
  const padV = size === "sm" ? 2 : 4;
  const padH = size === "sm" ? spacing.xs : spacing.sm;

  const content = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: withAlpha(color, 0.14),
        borderRadius: radius.sm,
        paddingHorizontal: padH,
        paddingVertical: padV,
        alignSelf: "flex-start",
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, marginRight: spacing.xs }} />
      <Text style={{ color, fontSize: fs, fontWeight: fontWeight.semibold, textTransform: "lowercase" }}>
        {label}
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
