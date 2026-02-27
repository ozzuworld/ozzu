import { useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import { useEntity } from "../../../lib/useEntity";
import { useHA } from "../../../lib/ha-context";
import type { MapPin } from "../../../lib/map-config";

interface MediaSheetProps {
  pin: MapPin;
}

export function MediaSheet({ pin }: MediaSheetProps) {
  const entity = useEntity(pin.primaryEntityId);
  const { callService } = useHA();

  const domain = pin.primaryEntityId.split(".")[0];
  const state = entity?.state ?? "unavailable";
  const isOn = state === "on" || state === "playing" || state === "idle" || state === "paused";
  const isUnavailable = state === "unavailable";

  const attrs = entity?.attributes ?? {};
  const source = (attrs.source as string) ?? null;
  const appName = (attrs.app_name as string) ?? null;

  const handleToggle = useCallback(() => {
    if (domain === "media_player") {
      callService("media_player", "toggle", {}, { entity_id: pin.primaryEntityId });
    } else {
      callService(domain, "toggle", {}, { entity_id: pin.primaryEntityId });
    }
  }, [callService, domain, pin.primaryEntityId]);

  return (
    <View style={{ gap: 12 }}>
      {/* State + source info */}
      <View style={{ gap: 4 }}>
        <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 14 }}>
          {state.toUpperCase()}
        </Text>
        {(source || appName) && (
          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 11 }}>
            {appName ?? source}
          </Text>
        )}
      </View>

      {/* Power toggle */}
      <Pressable
        onPress={handleToggle}
        disabled={isUnavailable}
        style={({ pressed }) => ({
          paddingVertical: 12,
          borderRadius: 8,
          backgroundColor: isOn
            ? pressed ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.15)"
            : pressed ? "rgba(34,197,94,0.3)" : "rgba(34,197,94,0.15)",
          borderWidth: 1,
          borderColor: isOn ? "#EF4444" : "#22C55E",
          alignItems: "center",
          opacity: isUnavailable ? 0.4 : 1,
        })}
      >
        <Text
          style={{
            color: isOn ? "#EF4444" : "#22C55E",
            fontFamily: "monospace",
            fontSize: 13,
            fontWeight: "bold",
          }}
        >
          {isOn ? "TURN OFF" : "TURN ON"}
        </Text>
      </Pressable>
    </View>
  );
}
