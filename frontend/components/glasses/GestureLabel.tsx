import React, { useEffect, useRef } from "react";
import { Animated, Text, View } from "react-native";
import type { GestureResult } from "../../lib/gestures";
import { gestureEmoji } from "../../lib/gestures";

interface GestureLabelProps {
  gesture: GestureResult | null;
}

export default function GestureLabel({ gesture }: GestureLabelProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const prevGesture = useRef<string | null>(null);

  useEffect(() => {
    const current = gesture?.gesture ?? null;
    if (current && current !== "none" && current !== prevGesture.current) {
      Animated.timing(opacity, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
    } else if (!current || current === "none") {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
    prevGesture.current = current;
  }, [gesture?.gesture]);

  if (!gesture || gesture.gesture === "none") return null;

  const label = gesture.gesture.toUpperCase().replace("_", " ");
  const emoji = gestureEmoji(gesture.gesture);

  return (
    <Animated.View
      style={{
        position: "absolute",
        bottom: 12,
        alignSelf: "center",
        opacity,
        backgroundColor: "rgba(0,0,0,0.6)",
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
      }}
    >
      <Text style={{ fontSize: 16 }}>{emoji}</Text>
      <Text
        style={{
          color: "#06B6D4",
          fontSize: 11,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 2,
        }}
      >
        {label}
      </Text>
    </Animated.View>
  );
}
