import { useEffect, useRef } from "react";
import {
  View,
  Text,
  Modal,
  Animated,
  Pressable,
  Platform,
  type ViewStyle,
} from "react-native";
import { TVPressable } from "./TVPressable";
import { useEntity } from "../lib/useEntity";
import {
  type InventoryItem,
  type ItemEntity,
  type Rarity,
  RARITY_COLORS,
} from "../lib/rooms";

interface ItemCardModalProps {
  item: InventoryItem | null;
  visible: boolean;
  onClose: () => void;
  onUse: (item: InventoryItem) => void;
  onUnequip: (item: InventoryItem) => void;
}

const SHIMMER_PERIODS: Record<Rarity, number> = {
  legendary: 1500,
  epic: 2000,
  rare: 2500,
  common: 0,
};

function useShimmer(rarity: Rarity, visible: boolean) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const period = SHIMMER_PERIODS[rarity];
    if (!visible || period === 0) {
      anim.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: period / 2,
          useNativeDriver: false,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: period / 2,
          useNativeDriver: false,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [rarity, visible, anim]);

  return anim;
}

function getShimmerStyle(
  rarity: Rarity,
  anim: Animated.Value
): Animated.WithAnimatedObject<ViewStyle> {
  const colors = RARITY_COLORS[rarity];
  if (rarity === "common") return {};

  const glowRadius = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 24],
  });

  const glowOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.9],
  });

  if (Platform.OS === "web") {
    return {};
  }

  return {
    shadowColor: colors.glow,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: glowOpacity as unknown as number,
    shadowRadius: glowRadius as unknown as number,
    elevation: 20,
  };
}

function getWebStaticGlow(rarity: Rarity): ViewStyle {
  if (Platform.OS !== "web" || rarity === "common") return {};
  const colors = RARITY_COLORS[rarity];
  return {
    // @ts-ignore – web-only boxShadow
    boxShadow: `0 0 20px ${colors.glow}`,
  };
}

function StatRow({ itemEntity }: { itemEntity: ItemEntity }) {
  const entity = useEntity(itemEntity.entityId);
  const state = entity?.state ?? "—";
  const unit = entity?.attributes.unit_of_measurement ?? "";
  const domain = itemEntity.entityId.split(".")[0];

  let valueDisplay: string;
  let valueColor: string;

  switch (domain) {
    case "switch":
    case "siren": {
      const isOn = state === "on";
      valueDisplay = isOn ? "ON" : "OFF";
      valueColor = isOn ? "#22C55E" : "#737373";
      break;
    }
    case "media_player":
      valueDisplay = state;
      valueColor = state === "playing" ? "#22C55E" : "#A3A3A3";
      break;
    default:
      valueDisplay = unit ? `${state} ${unit}` : state;
      valueColor = "#FFFFFF";
      break;
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 8,
        paddingHorizontal: 4,
        borderBottomWidth: 1,
        borderBottomColor: "#2A2A2A",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 16 }}>{itemEntity.icon}</Text>
        <Text style={{ color: "#A3A3A3", fontSize: 13 }}>
          {itemEntity.label}
        </Text>
      </View>
      <Text style={{ color: valueColor, fontSize: 13, fontWeight: "bold" }}>
        {valueDisplay}
      </Text>
    </View>
  );
}

function getUseButtonLabel(primaryEntityId: string): string {
  const domain = primaryEntityId.split(".")[0];
  switch (domain) {
    case "media_player":
      return "▶  Play / Pause";
    case "switch":
    case "siren":
      return "⚡  Toggle";
    default:
      return "👁  View";
  }
}

export function ItemCardModal({
  item,
  visible,
  onClose,
  onUse,
  onUnequip,
}: ItemCardModalProps) {
  const shimmerAnim = useShimmer(item?.rarity ?? "common", visible);

  if (!item) return null;

  const colors = RARITY_COLORS[item.rarity];
  const shimmerStyle = getShimmerStyle(item.rarity, shimmerAnim);
  const webGlow = getWebStaticGlow(item.rarity);

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      {/* Backdrop */}
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.75)",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {/* Card */}
        <Animated.View
          style={[
            {
              width: "40%",
              maxHeight: "85%",
              borderWidth: 2,
              borderColor: colors.border,
              borderRadius: 16,
              backgroundColor: "#1A1A1A",
              padding: 24,
            },
            shimmerStyle,
            webGlow,
          ]}
        >
          <Pressable>
            {/* Header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 16,
              }}
            >
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
              >
                <Text style={{ fontSize: 36 }}>{item.icon}</Text>
                <Text
                  style={{
                    color: "#FFFFFF",
                    fontSize: 22,
                    fontWeight: "bold",
                  }}
                >
                  {item.name}
                </Text>
              </View>
              <View
                style={{
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 4,
                  paddingHorizontal: 10,
                  paddingVertical: 3,
                  backgroundColor: colors.bg,
                }}
              >
                <Text
                  style={{
                    color: colors.text,
                    fontSize: 10,
                    fontWeight: "bold",
                    letterSpacing: 1,
                    textTransform: "uppercase",
                  }}
                >
                  {item.rarity}
                </Text>
              </View>
            </View>

            {/* Lore */}
            <Text
              style={{
                color: "#737373",
                fontSize: 13,
                fontStyle: "italic",
                lineHeight: 20,
                marginBottom: 16,
              }}
            >
              "{item.lore}"
            </Text>

            {/* Divider */}
            <View
              style={{
                height: 1,
                backgroundColor: colors.border,
                opacity: 0.3,
                marginBottom: 8,
              }}
            />

            {/* Stats */}
            {item.entities.map((e) => (
              <StatRow key={e.entityId} itemEntity={e} />
            ))}

            {/* Action Buttons */}
            <View style={{ marginTop: 20, gap: 10 }}>
              <TVPressable
                rarity={item.rarity}
                onPress={() => onUse(item)}
                style={{
                  paddingVertical: 14,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    color: colors.text,
                    fontSize: 15,
                    fontWeight: "bold",
                    letterSpacing: 1,
                  }}
                >
                  {getUseButtonLabel(item.primaryEntityId)}
                </Text>
              </TVPressable>

              <TVPressable
                rarity="common"
                onPress={() => onUnequip(item)}
                style={{
                  paddingVertical: 10,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    color: "#737373",
                    fontSize: 12,
                    letterSpacing: 1,
                  }}
                >
                  Unequip
                </Text>
              </TVPressable>
            </View>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}
