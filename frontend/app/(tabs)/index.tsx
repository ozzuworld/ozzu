import { useCallback } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { StatusBadge } from "../../components/StatusBadge";
import { HamburgerMenu } from "../../components/HamburgerMenu";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { useHA } from "../../lib/ha-context";
import { useEntity } from "../../lib/useEntity";
import { useMediaPlayer } from "../../lib/useMediaPlayer";
import { rooms, RARITY_COLORS, type InventoryItem } from "../../lib/rooms";
import { ACWidget } from "../../components/devices/ACWidget";

const TOP_BAR_HEIGHT = 48;
const ACCENT = "#06B6D4";
const AC_ENTITY_ID = "climate.living_room_ac";

// ── Device Card ──
function DeviceCard({ item }: { item: InventoryItem }) {
  const entity = useEntity(item.primaryEntityId);
  const { callService } = useHA();
  const colors = RARITY_COLORS[item.rarity];

  const state = entity?.state ?? "unavailable";
  const isOn = state === "on" || state === "playing" || state === "home";
  const isUnavailable = state === "unavailable";
  const displayState = isUnavailable ? "N/A" : state;

  const handlePress = useCallback(() => {
    if (!entity || isUnavailable) return;
    const domain = item.primaryEntityId.split(".")[0];
    if (domain === "switch") {
      callService("switch", "toggle", {}, { entity_id: item.primaryEntityId });
    } else if (domain === "media_player") {
      callService("media_player", "toggle", {}, { entity_id: item.primaryEntityId });
    }
  }, [entity, item.primaryEntityId, callService, isUnavailable]);

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => ({
        backgroundColor: "#1A1A1A",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: isOn ? colors.border : "#2A2A2A",
        padding: 10,
        minWidth: 80,
        alignItems: "center",
        opacity: pressed ? 0.7 : isUnavailable ? 0.4 : 1,
      })}
    >
      <Text style={{ fontSize: 20, marginBottom: 4 }}>{item.icon}</Text>
      <Text
        style={{
          color: "#D4D4D4",
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: "bold",
          textAlign: "center",
        }}
        numberOfLines={1}
      >
        {item.name}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 }}>
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
            color: isOn ? "#A3A3A3" : "#525252",
            fontFamily: "monospace",
            fontSize: 9,
          }}
        >
          {displayState}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Washer Status ──
function WasherStatus() {
  const status = useEntity("sensor.151732606804847_status");
  const progress = useEntity("sensor.151732606804847_progress");
  const remaining = useEntity("sensor.151732606804847_time_remaining");

  if (!status || status.state === "unavailable" || status.state === "idle" || status.state === "off") {
    return null;
  }

  const pct = progress ? parseInt(progress.state, 10) : 0;
  const timeLeft = remaining?.state ?? "";

  return (
    <View style={{ marginTop: 8, padding: 10, backgroundColor: "#1A1A1A", borderRadius: 8, borderWidth: 1, borderColor: "#2A2A2A" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ fontSize: 14 }}>🫧</Text>
        <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
          Washer: {status.state}
        </Text>
        {timeLeft ? (
          <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginLeft: "auto" }}>
            {timeLeft} left
          </Text>
        ) : null}
      </View>
      {pct > 0 && (
        <View style={{ marginTop: 6, height: 4, backgroundColor: "#333", borderRadius: 2 }}>
          <View
            style={{
              width: `${Math.min(100, pct)}%`,
              height: 4,
              backgroundColor: "#3B82F6",
              borderRadius: 2,
            }}
          />
        </View>
      )}
    </View>
  );
}

// ── Spotify Mini Widget ──
function SpotifyMini() {
  const { state } = useMediaPlayer();
  const router = useRouter();

  if (!state.available || !state.isPlaying) return null;

  return (
    <Pressable
      onPress={() => router.push("/(tabs)/music")}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        padding: 10,
        marginHorizontal: 16,
        marginBottom: 12,
        backgroundColor: "rgba(29,185,84,0.12)",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "rgba(29,185,84,0.3)",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 16 }}>🎵</Text>
      <Text
        style={{ color: "#1DB954", fontFamily: "monospace", fontSize: 11, fontWeight: "bold", flex: 1 }}
        numberOfLines={1}
      >
        {state.trackName}
      </Text>
      <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10 }} numberOfLines={1}>
        {state.artist}
      </Text>
    </Pressable>
  );
}

// ── Camera Card ──
function CameraCard({ item }: { item: InventoryItem }) {
  const powerEntity = useEntity(item.primaryEntityId);
  const { callService } = useHA();
  const isOn = powerEntity?.state === "on";

  // Find sub-entities for motion + notifications
  const motionId = item.entities.find((e) => e.label === "Motion Detection")?.entityId;
  const notifId = item.entities.find((e) => e.label === "Notifications")?.entityId;
  const motionEntity = useEntity(motionId ?? "");
  const notifEntity = useEntity(notifId ?? "");

  const handleToggle = useCallback(() => {
    callService("switch", "toggle", {}, { entity_id: item.primaryEntityId });
  }, [callService, item.primaryEntityId]);

  return (
    <View
      style={{
        backgroundColor: "#1A1A1A",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: isOn ? "#A855F7" : "#2A2A2A",
        padding: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontSize: 16 }}>{item.icon}</Text>
          <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
            {item.name}
          </Text>
        </View>
        <Pressable
          onPress={handleToggle}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: isOn ? "rgba(34,197,94,0.2)" : "rgba(82,82,82,0.2)",
            borderWidth: 1,
            borderColor: isOn ? "#22C55E" : "#525252",
          }}
        >
          <Text style={{ color: isOn ? "#22C55E" : "#525252", fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
            {isOn ? "ON" : "OFF"}
          </Text>
        </Pressable>
      </View>
      {/* Sub-status indicators */}
      <View style={{ flexDirection: "row", gap: 12, marginTop: 6 }}>
        {motionEntity && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 9 }}>Motion</Text>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: motionEntity.state === "on" ? "#22C55E" : "#525252",
              }}
            />
          </View>
        )}
        {notifEntity && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 9 }}>Notif</Text>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: notifEntity.state === "on" ? "#22C55E" : "#525252",
              }}
            />
          </View>
        )}
      </View>
    </View>
  );
}

// ── iPhone/Person Status ──
function StatusCard({ item }: { item: InventoryItem }) {
  const entity = useEntity(item.primaryEntityId);
  const state = entity?.state ?? "unavailable";

  // Try to get battery for iPhone
  const batteryEntity = useEntity(
    item.entities.find((e) => e.label === "Battery")?.entityId ?? ""
  );
  const chargingEntity = useEntity(
    item.entities.find((e) => e.label === "Charging")?.entityId ?? ""
  );

  const batteryPct = batteryEntity ? `${batteryEntity.state}%` : null;
  const isCharging = chargingEntity?.state === "Charging";

  return (
    <View
      style={{
        backgroundColor: "#1A1A1A",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#2A2A2A",
        padding: 10,
        minWidth: 80,
        alignItems: "center",
      }}
    >
      <Text style={{ fontSize: 20, marginBottom: 4 }}>{item.icon}</Text>
      <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }} numberOfLines={1}>
        {item.name.replace("Kazuma ", "KK ").replace("King ", "")}
      </Text>
      <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>
        {batteryPct ? `${batteryPct}${isCharging ? " ⚡" : ""}` : state}
      </Text>
    </View>
  );
}

// ── Room Section ──
function RoomSection({ name, icon, items }: { name: string; icon: string; items: InventoryItem[] }) {
  const isLivingRoom = name === "Living Room";
  const isSecurity = name === "Security";
  const isKitchen = name === "Kitchen";
  const isGeneral = name === "General";

  // Separate cameras from regular devices
  const cameras = items.filter((i) => i.id.includes("cam"));
  const regularDevices = items.filter((i) => !i.id.includes("cam"));

  return (
    <View style={{ marginBottom: 16, paddingHorizontal: 16 }}>
      {/* Room header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Text style={{ fontSize: 14 }}>{icon}</Text>
        <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12, fontWeight: "bold", letterSpacing: 2 }}>
          {name.toUpperCase()}
        </Text>
      </View>

      {/* Device cards grid */}
      {regularDevices.length > 0 && !isGeneral && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {regularDevices.map((item) => (
            <DeviceCard key={item.id} item={item} />
          ))}
        </View>
      )}

      {/* General/Status section uses StatusCard */}
      {isGeneral && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {items.map((item) => (
            <StatusCard key={item.id} item={item} />
          ))}
        </View>
      )}

      {/* Camera cards */}
      {cameras.length > 0 && (
        <View style={{ gap: 8, marginTop: regularDevices.length > 0 ? 8 : 0 }}>
          {cameras.map((item) => (
            <CameraCard key={item.id} item={item} />
          ))}
        </View>
      )}

      {/* AC Widget for Living Room */}
      {isLivingRoom && <ACWidget entityId={AC_ENTITY_ID} />}

      {/* Washer status for Kitchen */}
      {isKitchen && <WasherStatus />}
    </View>
  );
}

// ── Home Screen ──
export default function HomeScreen() {
  const { insets } = usePhoneLayout();

  return (
    <View style={{ flex: 1, backgroundColor: "#111111" }}>
      {/* Top Bar */}
      <View
        style={{
          paddingTop: insets.top,
          height: TOP_BAR_HEIGHT + insets.top,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: Math.max(16, insets.left, insets.right),
          backgroundColor: "#111111",
          borderBottomWidth: 1,
          borderBottomColor: "#222",
          zIndex: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <HamburgerMenu />
          <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 2 }}>
            HOME
          </Text>
        </View>
        <StatusBadge />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 24 + insets.bottom }}
        showsVerticalScrollIndicator={false}
      >
        {/* Spotify Mini Widget */}
        <SpotifyMini />

        {/* Room sections */}
        {rooms.map((room) => (
          <RoomSection key={room.name} name={room.name} icon={room.icon} items={room.items} />
        ))}
      </ScrollView>

      <StatusBar style="light" />
    </View>
  );
}
