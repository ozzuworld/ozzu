import { View, Text } from "react-native";
import { TVPressable } from "./TVPressable";
import { useEntity } from "../lib/useEntity";
import { type InventoryItem, RARITY_COLORS } from "../lib/rooms";

interface EquipmentSlotProps {
  item: InventoryItem | null;
  slotLabel: string;
  onPress: () => void;
}

export function EquipmentSlot({ item, slotLabel, onPress }: EquipmentSlotProps) {
  const primaryEntity = useEntity(item?.primaryEntityId ?? "");
  const colors = item ? RARITY_COLORS[item.rarity] : null;

  const state = primaryEntity?.state ?? "unavailable";
  const isOff = state === "off" || state === "unavailable" || state === "standby";

  if (!item) {
    return (
      <View
        style={{
          width: 56,
          height: 62,
          borderWidth: 1,
          borderColor: "#2A2A2A",
          borderRadius: 6,
          borderStyle: "dashed",
          backgroundColor: "rgba(20,20,20,0.6)",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text
          style={{
            color: "#333",
            fontSize: 7,
            fontWeight: "bold",
            letterSpacing: 0.5,
          }}
        >
          {slotLabel}
        </Text>
      </View>
    );
  }

  return (
    <TVPressable
      rarity={item.rarity}
      onPress={onPress}
      style={{
        width: 56,
        height: 62,
        padding: 4,
        opacity: isOff ? 0.5 : 1,
        justifyContent: "center",
        alignItems: "center",
        gap: 1,
      }}
    >
      <Text style={{ fontSize: 18 }}>{item.icon}</Text>
      <Text
        style={{
          color: "#FFF",
          fontSize: 7,
          textAlign: "center",
          fontWeight: "bold",
        }}
        numberOfLines={1}
      >
        {item.name}
      </Text>
      <Text
        style={{
          color: colors!.text,
          fontSize: 6,
          fontWeight: "bold",
          letterSpacing: 0.5,
          opacity: 0.6,
        }}
      >
        {slotLabel}
      </Text>
    </TVPressable>
  );
}
