import { useState, useCallback } from "react";
import { Pressable, Platform, type PressableProps, type ViewStyle } from "react-native";
import { type Rarity, RARITY_COLORS } from "../lib/rooms";

interface TVPressableProps extends PressableProps {
  rarity?: Rarity;
  style?: ViewStyle;
}

function getGlowStyle(rarity: Rarity, focused: boolean): ViewStyle {
  const colors = RARITY_COLORS[rarity];
  if (rarity === "common") return {};

  const glowRadius = rarity === "legendary" ? 16 : rarity === "epic" ? 10 : 6;
  const focusMultiplier = focused ? 1.5 : 1;
  const radius = glowRadius * focusMultiplier;

  if (Platform.OS === "web") {
    return {
      // @ts-ignore – web-only boxShadow
      boxShadow: `0 0 ${radius}px ${colors.glow}`,
    };
  }

  return {
    elevation: radius,
    shadowColor: colors.glow,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: focused ? 0.8 : 0.5,
    shadowRadius: radius,
  };
}

export function TVPressable({
  rarity = "common",
  style,
  children,
  ...props
}: TVPressableProps) {
  const [focused, setFocused] = useState(false);
  const colors = RARITY_COLORS[rarity];

  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);

  const baseStyle: ViewStyle = {
    borderWidth: focused ? 3 : 2,
    borderColor: focused ? colors.border : colors.border,
    borderRadius: 12,
    backgroundColor: focused ? colors.bg : colors.dim,
    transform: [{ scale: focused ? 1.08 : 1 }],
  };

  return (
    <Pressable
      onFocus={handleFocus}
      onBlur={handleBlur}
      style={[baseStyle, getGlowStyle(rarity, focused), style]}
      {...props}
    >
      {children}
    </Pressable>
  );
}
