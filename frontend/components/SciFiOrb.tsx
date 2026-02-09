import { useEffect, useRef } from "react";
import { View, Animated, type ViewStyle } from "react-native";

interface SciFiOrbProps {
  active: boolean;
}

const CYAN = "#06B6D4";

const RINGS = [
  { size: 120, borderWidth: 2 },
  { size: 90, borderWidth: 1.5 },
  { size: 60, borderWidth: 1 },
];

export function SciFiOrb({ active }: SciFiOrbProps) {
  const opacity = useRef(new Animated.Value(0.2)).current;
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    opacity.stopAnimation();
    scale.stopAnimation();

    if (active) {
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
    } else {
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
  }, [active, opacity, scale]);

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
