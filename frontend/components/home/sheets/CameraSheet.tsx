import { useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import { useEntity } from "../../../lib/useEntity";
import { useHA } from "../../../lib/ha-context";
import type { MapPin } from "../../../lib/map-config";

interface ToggleRowProps {
  label: string;
  entityId: string;
}

function ToggleRow({ label, entityId }: ToggleRowProps) {
  const entity = useEntity(entityId);
  const { callService } = useHA();
  const isOn = entity?.state === "on";

  const handleToggle = useCallback(() => {
    callService("switch", "toggle", {}, { entity_id: entityId });
  }, [callService, entityId]);

  if (!entity) return null;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 }}>
      <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 13 }}>{label}</Text>
      <Pressable
        onPress={handleToggle}
        style={{
          paddingHorizontal: 14,
          paddingVertical: 6,
          borderRadius: 8,
          backgroundColor: isOn ? "rgba(34,197,94,0.2)" : "rgba(82,82,82,0.2)",
          borderWidth: 1,
          borderColor: isOn ? "#22C55E" : "#525252",
        }}
      >
        <Text style={{ color: isOn ? "#22C55E" : "#525252", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
          {isOn ? "ON" : "OFF"}
        </Text>
      </Pressable>
    </View>
  );
}

interface CameraSheetProps {
  pin: MapPin;
}

export function CameraSheet({ pin }: CameraSheetProps) {
  const { callService } = useHA();
  const related = pin.relatedEntityIds ?? [];

  const motionId = related.find((e) => e.includes("motion_detection"));
  const notifId = related.find((e) => e.includes("notifications"));
  const sirenId = related.find((e) => e.includes("siren"));

  const handleSiren = useCallback(() => {
    if (!sirenId) return;
    callService("siren", "turn_on", {}, { entity_id: sirenId });
  }, [callService, sirenId]);

  return (
    <View style={{ gap: 4 }}>
      <ToggleRow label="Power" entityId={pin.primaryEntityId} />

      {motionId && (
        <>
          <View style={{ height: 1, backgroundColor: "#2A2A2A" }} />
          <ToggleRow label="Motion Detection" entityId={motionId} />
        </>
      )}

      {notifId && (
        <>
          <View style={{ height: 1, backgroundColor: "#2A2A2A" }} />
          <ToggleRow label="Notifications" entityId={notifId} />
        </>
      )}

      {sirenId && (
        <>
          <View style={{ height: 1, backgroundColor: "#2A2A2A", marginTop: 4 }} />
          <Pressable
            onPress={handleSiren}
            style={({ pressed }) => ({
              marginTop: 8,
              paddingVertical: 10,
              borderRadius: 8,
              backgroundColor: pressed ? "rgba(239,68,68,0.3)" : "rgba(239,68,68,0.15)",
              borderWidth: 1,
              borderColor: "#EF4444",
              alignItems: "center",
            })}
          >
            <Text style={{ color: "#EF4444", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
              {"\uD83D\uDEA8"} TRIGGER SIREN
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
