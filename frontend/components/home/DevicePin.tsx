import { useEffect, useRef } from "react";
import { Pressable, Text, View, Animated } from "react-native";
import { useEntity } from "../../lib/useEntity";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import type { MapPin } from "../../lib/map-config";

function getStateColor(state: string | undefined, type: string): string {
  if (!state || state === "unavailable") return "#525252";
  switch (state) {
    case "on":
    case "cleaning":
    case "playing":
      return "#22C55E";
    case "cool":
      return "#3B82F6";
    case "heat":
      return "#EF4444";
    case "paused":
      return "#F97316";
    case "error":
      return "#EF4444";
    case "off":
    case "idle":
    case "docked":
      return "#525252";
    default:
      // AC entity reports hvac_mode as state
      if (type === "ac" && state !== "off") return "#3B82F6";
      return "#525252";
  }
}

function isActive(state: string | undefined): boolean {
  if (!state) return false;
  return ["on", "cleaning", "playing", "cool", "heat", "auto", "dry", "fan_only", "paused", "returning"].includes(state);
}

interface DevicePinProps {
  pin: MapPin;
  onPress: (pin: MapPin) => void;
}

export function DevicePin({ pin, onPress }: DevicePinProps) {
  const entity = useEntity(pin.primaryEntityId);
  const { isPhone } = usePhoneLayout();
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const state = entity?.state;
  const color = getStateColor(state, pin.type);
  const active = isActive(state);
  const size = isPhone ? 32 : 40;

  useEffect(() => {
    if (active) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.6, duration: 1200, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [active]);

  return (
    <Pressable
      onPress={() => onPress(pin)}
      style={({ pressed }) => ({
        alignItems: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Animated.View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: "#1A1A1A",
          borderWidth: 2,
          borderColor: color,
          alignItems: "center",
          justifyContent: "center",
          opacity: active ? pulseAnim : 1,
        }}
      >
        <Text style={{ fontSize: isPhone ? 14 : 18 }}>{pin.icon}</Text>
      </Animated.View>
      {!isPhone && (
        <Text
          style={{
            color: "#A3A3A3",
            fontFamily: "monospace",
            fontSize: 10,
            marginTop: 2,
            textAlign: "center",
          }}
          numberOfLines={1}
        >
          {pin.label}
        </Text>
      )}
    </Pressable>
  );
}
