import { View, Text } from "react-native";
import { useHA } from "../lib/ha-context";
import { RARITY_COLORS } from "../lib/rooms";

const KEY_ENTITIES = [
  { entityId: "media_player.main_tv", label: "TV", icon: "📺", rarity: "legendary" as const },
  { entityId: "switch.living_room_cam_power", label: "Cam", icon: "📹", rarity: "epic" as const },
  { entityId: "device_tracker.kazuma_iphone", label: "Phone", icon: "📱", rarity: "epic" as const },
  { entityId: "person.king_kazuma", label: "Kazuma", icon: "👤", rarity: "common" as const },
];

export function EntityStatusCards() {
  const { entities } = useHA();

  return (
    <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
      {KEY_ENTITIES.map((item) => {
        const entity = entities[item.entityId];
        const state = entity?.state ?? "unknown";
        const isOn = state === "on" || state === "home" || state === "playing";
        const colors = RARITY_COLORS[item.rarity];

        return (
          <View
            key={item.entityId}
            style={{
              width: 90,
              paddingVertical: 10,
              paddingHorizontal: 8,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: isOn ? colors.border : "#2A2A2A",
              backgroundColor: isOn ? colors.dim : "rgba(18,18,18,0.6)",
              alignItems: "center",
              gap: 4,
            }}
          >
            <Text style={{ fontSize: 22 }}>{item.icon}</Text>
            <Text
              style={{
                color: isOn ? colors.text : "#525252",
                fontSize: 10,
                fontWeight: "bold",
                letterSpacing: 0.5,
              }}
            >
              {item.label}
            </Text>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: isOn ? "#22C55E" : "#525252",
                }}
              />
              <Text
                style={{
                  color: isOn ? "#A3A3A3" : "#444",
                  fontSize: 8,
                  fontWeight: "bold",
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                }}
              >
                {state}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
