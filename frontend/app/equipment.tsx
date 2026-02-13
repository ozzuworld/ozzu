import { useState, useCallback } from "react";
import { View, Text } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { StatusBadge } from "../components/StatusBadge";
import { CharacterSilhouette } from "../components/CharacterSilhouette";
import { EquipmentSlot } from "../components/EquipmentSlot";
import { ItemCardModal } from "../components/ItemCardModal";
import { TVPressable } from "../components/TVPressable";
import { useHA } from "../lib/ha-context";
import { rooms, type InventoryItem, RARITY_COLORS } from "../lib/rooms";

const TOP_BAR_HEIGHT = 48;
const INVENTORY_TOTAL_SLOTS = 20;
const INV_SLOT_SIZE = 100;
const INV_GAP = 10;

const allItems = rooms.flatMap((r) => r.items);

const ITEM_SLOT_MAP: Record<string, string> = {
  main_tv: "HELM",
  kazuma_iphone: "WEAPON",
  sous_vide: "CHEST",
  living_room_cam: "GLOVES",
  security_cam: "SHIELD",
  king_kazuma: "BOOTS",
  shopping_list: "RING",
  midea_washer: "AMULET",
};

const LEFT_SLOTS = ["HELM", "WEAPON", "CHEST", "GLOVES"] as const;
const RIGHT_SLOTS = ["SHIELD", "BOOTS", "RING", "AMULET"] as const;

type EquippedState = Record<string, InventoryItem | null>;

const iphone = allItems.find((i) => i.id === "kazuma_iphone") ?? null;

const INITIAL_EQUIPPED: EquippedState = {
  HELM: null,
  WEAPON: iphone,
  CHEST: null,
  GLOVES: null,
  SHIELD: null,
  BOOTS: null,
  RING: null,
  AMULET: null,
};

function EmptyInvSlot() {
  return (
    <View
      style={{
        width: INV_SLOT_SIZE,
        height: INV_SLOT_SIZE,
        borderWidth: 1,
        borderColor: "#222",
        borderRadius: 8,
        backgroundColor: "rgba(18,18,18,0.8)",
      }}
    />
  );
}

export default function EquipmentScreen() {
  const router = useRouter();
  const { callService } = useHA();

  const [equipped, setEquipped] = useState<EquippedState>(INITIAL_EQUIPPED);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

  const equippedIds = new Set(
    Object.values(equipped)
      .filter((i): i is InventoryItem => i !== null)
      .map((i) => i.id)
  );

  const inventoryItems = allItems.filter((i) => !equippedIds.has(i.id));
  const emptySlotCount = Math.max(
    0,
    INVENTORY_TOTAL_SLOTS - inventoryItems.length
  );

  const handleEquip = useCallback((item: InventoryItem) => {
    const slot = ITEM_SLOT_MAP[item.id];
    if (slot) {
      setEquipped((prev) => ({ ...prev, [slot]: item }));
    }
  }, []);

  const handleUnequip = useCallback((item: InventoryItem) => {
    const slot = ITEM_SLOT_MAP[item.id];
    if (slot) {
      setEquipped((prev) => ({ ...prev, [slot]: null }));
      setModalVisible(false);
    }
  }, []);

  const handleSlotPress = useCallback(
    (slotLabel: string) => {
      const item = equipped[slotLabel];
      if (item) {
        setSelectedItem(item);
        setModalVisible(true);
      }
    },
    [equipped]
  );

  const handleModalClose = useCallback(() => {
    setModalVisible(false);
  }, []);

  const handleUse = useCallback(
    (item: InventoryItem) => {
      const domain = item.primaryEntityId.split(".")[0];
      switch (domain) {
        case "media_player":
          callService("media_player", "media_play_pause", undefined, {
            entity_id: item.primaryEntityId,
          });
          break;
        case "switch":
        case "siren":
          callService(domain, "toggle", undefined, {
            entity_id: item.primaryEntityId,
          });
          break;
        default:
          break;
      }
    },
    [callService]
  );

  return (
    <View style={{ flex: 1, backgroundColor: "#111111" }}>
      {/* Top Bar */}
      <View
        style={{
          height: TOP_BAR_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
        }}
      >
        <Text style={{ color: "#F59E0B", fontSize: 24, fontWeight: "bold" }}>
          ozzu
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <TVPressable
            onPress={() => router.back()}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 6,
            }}
          >
            <Text
              style={{
                color: "#A3A3A3",
                fontSize: 12,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              {"◀ BACK"}
            </Text>
          </TVPressable>
          <StatusBadge />
        </View>
      </View>

      {/* Main: Character Panel | Inventory Panel */}
      <View style={{ flex: 1, flexDirection: "row" }}>
        {/* Character Panel */}
        <View
          style={{
            width: "25%",
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 8,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
            }}
          >
            {/* Left Slots */}
            <View style={{ gap: 6, alignItems: "center" }}>
              {LEFT_SLOTS.map((slot) => (
                <EquipmentSlot
                  key={slot}
                  item={equipped[slot]}
                  slotLabel={slot}
                  onPress={() => handleSlotPress(slot)}
                />
              ))}
            </View>

            {/* Character Silhouette */}
            <CharacterSilhouette />

            {/* Right Slots */}
            <View style={{ gap: 6, alignItems: "center" }}>
              {RIGHT_SLOTS.map((slot) => (
                <EquipmentSlot
                  key={slot}
                  item={equipped[slot]}
                  slotLabel={slot}
                  onPress={() => handleSlotPress(slot)}
                />
              ))}
            </View>
          </View>
        </View>

        {/* Divider */}
        <View
          style={{
            width: 1,
            backgroundColor: "#2A2A2A",
            marginVertical: 20,
          }}
        />

        {/* Inventory Panel */}
        <View style={{ flex: 1, padding: 20 }}>
          {/* Inventory Header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderWidth: 1,
                borderColor: "#444",
                borderRadius: 6,
                backgroundColor: "#1A1A1A",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <Text style={{ fontSize: 16 }}>📦</Text>
            </View>
            <Text
              style={{
                color: "#737373",
                fontSize: 14,
                fontWeight: "bold",
                letterSpacing: 2,
              }}
            >
              INVENTORY
            </Text>
            <Text
              style={{
                color: "#444",
                fontSize: 12,
              }}
            >
              {inventoryItems.length}/{INVENTORY_TOTAL_SLOTS}
            </Text>
          </View>

          {/* Inventory Grid */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: INV_GAP,
            }}
          >
            {/* Filled slots */}
            {inventoryItems.map((item) => {
              const colors = RARITY_COLORS[item.rarity];
              const slot = ITEM_SLOT_MAP[item.id];
              return (
                <TVPressable
                  key={item.id}
                  rarity={item.rarity}
                  onPress={() => handleEquip(item)}
                  style={{
                    width: INV_SLOT_SIZE,
                    height: INV_SLOT_SIZE,
                    padding: 6,
                    justifyContent: "center",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  <Text style={{ fontSize: 28 }}>{item.icon}</Text>
                  <Text
                    style={{
                      color: "#FFF",
                      fontSize: 10,
                      fontWeight: "bold",
                      textAlign: "center",
                    }}
                    numberOfLines={1}
                  >
                    {item.name}
                  </Text>
                  <Text
                    style={{
                      color: colors.text,
                      fontSize: 7,
                      fontWeight: "bold",
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                    }}
                  >
                    {item.rarity}
                  </Text>
                  <Text
                    style={{ color: "#444", fontSize: 7, letterSpacing: 0.5 }}
                  >
                    {slot}
                  </Text>
                </TVPressable>
              );
            })}

            {/* Empty slots */}
            {Array.from({ length: emptySlotCount }, (_, i) => (
              <EmptyInvSlot key={`empty-${i}`} />
            ))}
          </View>
        </View>
      </View>

      {/* Item Card Modal */}
      <ItemCardModal
        item={selectedItem}
        visible={modalVisible}
        onClose={handleModalClose}
        onUse={handleUse}
        onUnequip={handleUnequip}
      />

      <StatusBar style="light" />
    </View>
  );
}
