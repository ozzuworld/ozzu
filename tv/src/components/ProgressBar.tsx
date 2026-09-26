import React from "react";
import { View, StyleSheet, type ViewStyle } from "react-native";
import { colors, radius, withAlpha } from "../lib/theme";

export function ProgressBar({
  fraction,
  height = 4,
  style,
}: {
  fraction: number;
  height?: number;
  style?: ViewStyle;
}) {
  const f = Math.max(0, Math.min(1, fraction || 0));
  return (
    <View style={[styles.track, { height }, style]}>
      <View style={[styles.fill, { width: `${f * 100}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    backgroundColor: withAlpha(colors.text.primary, 0.25),
    borderRadius: radius.sm,
    overflow: "hidden",
    width: "100%",
  },
  fill: {
    height: "100%",
    backgroundColor: colors.accent,
  },
});
