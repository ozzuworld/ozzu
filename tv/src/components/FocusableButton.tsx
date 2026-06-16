import React, { useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { colors, radius, spacing, fontSize, fontWeight, focus, withAlpha } from "../lib/theme";

/**
 * A 10-foot button with D-pad focus affordance (scale + ring). `primary` is the
 * Netflix-style white Play CTA; otherwise a translucent secondary button.
 */
export function FocusableButton({
  label,
  icon,
  onPress,
  primary = false,
  hasTVPreferredFocus = false,
  style,
}: {
  label: string;
  icon?: string;
  onPress?: () => void;
  primary?: boolean;
  hasTVPreferredFocus?: boolean;
  style?: ViewStyle;
}) {
  const [focused, setFocused] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;

  const animate = (to: number) =>
    Animated.timing(scale, { toValue: to, duration: focus.tween, useNativeDriver: true }).start();

  const textColor = primary ? colors.text.onLight : colors.text.primary;

  return (
    <Pressable
      focusable
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => {
        setFocused(true);
        animate(1.06);
      }}
      onBlur={() => {
        setFocused(false);
        animate(1);
      }}
      onPress={onPress}
      style={style}
    >
      <Animated.View
        style={[
          styles.btn,
          primary ? styles.primary : styles.secondary,
          focused && styles.focused,
          { transform: [{ scale }] },
        ]}
      >
        {icon ? <Text style={[styles.icon, { color: textColor }]}>{icon}</Text> : null}
        <Text style={[styles.label, { color: textColor }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    borderWidth: focus.ringWidth,
    borderColor: "transparent", // reserve space so focus doesn't shift layout
  },
  primary: { backgroundColor: colors.text.primary },
  secondary: { backgroundColor: withAlpha(colors.text.primary, 0.16) },
  focused: { borderColor: colors.focusRing },
  icon: { fontSize: fontSize.body, fontWeight: fontWeight.bold },
  label: { fontSize: fontSize.cardTitle, fontWeight: fontWeight.semibold, letterSpacing: 0.3 },
});
