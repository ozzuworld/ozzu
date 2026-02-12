import { useEffect, useRef } from "react";
import { View, Animated, type ViewStyle } from "react-native";

type OrbMode = "idle" | "ambient" | "active";

interface SciFiOrbProps {
  active: boolean;
  /** Ambient mode: slow gentle pulse when mic is open but no speech detected */
  ambient?: boolean;
}

const CYAN = "#06B6D4";

const RINGS = [
  { size: 120, borderWidth: 2 },
  { size: 90, borderWidth: 1.5 },
  { size: 60, borderWidth: 1 },
];

export function SciFiOrb({ active, ambient }: SciFiOrbProps) {
  const opacity = useRef(new Animated.Value(0.2)).current;
  const scale = useRef(new Animated.Value(1)).current;

  const mode: OrbMode = active ? "active" : ambient ? "ambient" : "idle";

  useEffect(() => {
    opacity.stopAnimation();
    scale.stopAnimation();

    if (mode === "active") {
      // Fast pulse — speech being processed/streamed
      const pulseOpacity = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0.4,
            duration: 400,
            useNativeDriver: true,
          }),
        ])
      );
      const pulseScale = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 1.1,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 1,
            duration: 400,
            useNativeDriver: true,
          }),
        ])
      );
      pulseOpacity.start();
      pulseScale.start();
      return () => {
        pulseOpacity.stop();
        pulseScale.stop();
      };
    } else if (mode === "ambient") {
      // Slow gentle pulse — mic open, listening quietly
      const pulseOpacity = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0.6,
            duration: 2500,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0.25,
            duration: 2500,
            useNativeDriver: true,
          }),
        ])
      );
      const pulseScale = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 1.03,
            duration: 2500,
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 1,
            duration: 2500,
            useNativeDriver: true,
          }),
        ])
      );
      pulseOpacity.start();
      pulseScale.start();
      return () => {
        pulseOpacity.stop();
        pulseScale.stop();
      };
    } else {
      // Idle — very subtle breathing
      const pulseOpacity = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 0.4,
            duration: 1500,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0.2,
            duration: 1500,
            useNativeDriver: true,
          }),
        ])
      );
      scale.setValue(1);
      pulseOpacity.start();
      return () => {
        pulseOpacity.stop();
      };
    }
  }, [mode, opacity, scale]);

  const containerStyle: ViewStyle = {
    width: RINGS[0].size,
    height: RINGS[0].size,
    justifyContent: "center",
    alignItems: "center",
  };

  return (
    <Animated.View
      style={[
        containerStyle,
        { opacity, transform: [{ scale }] },
      ]}
    >
      {RINGS.map((ring, i) => (
        <View
          key={i}
          style={{
            position: i === 0 ? "relative" : "absolute",
            width: ring.size,
            height: ring.size,
            borderRadius: ring.size / 2,
            borderWidth: ring.borderWidth,
            borderColor: CYAN,
          }}
        />
      ))}
    </Animated.View>
  );
}
