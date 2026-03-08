// Home Dashboard — Premium glassmorphic smart home control
// Room cards, quick actions, live device status, scheduling

import { useState, useCallback, useMemo, useEffect } from "react";
import { View, Text, ScrollView, Pressable, Dimensions, Modal, Switch } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBadge } from "../../components/StatusBadge";
import { HamburgerMenu } from "../../components/HamburgerMenu";
import { useHA } from "../../lib/ha-context";
import { useEntity } from "../../lib/useEntity";
import { useMediaPlayer } from "../../lib/useMediaPlayer";
import { useVacuum } from "../../lib/useVacuum";
import { rooms, type InventoryItem, type Room } from "../../lib/rooms";
import { ACWidget } from "../../components/devices/ACWidget";
import { VacuumWidget } from "../../components/devices/VacuumWidget";
import { FloorPlanMap } from "../../components/home/FloorPlanMap";
import { DeviceSheet } from "../../components/home/DeviceSheet";
import type { MapPin } from "../../lib/map-config";
import { fetchSchedules, updateSchedule, type DeviceSchedule } from "../../lib/bridge-api";
import { useGlasses, type FocusedDevice } from "../../lib/glasses-context";

const ACCENT = "#06B6D4";
const DIM = "#525252";
const GLASS = "rgba(30,30,30,0.7)";
const GLASS_BORDER = "rgba(255,255,255,0.08)";
const { width: SCREEN_W } = Dimensions.get("window");

// ── Quick Action Button ──
function QuickAction({
  icon,
  label,
  entityId,
  isActive,
  onPress,
}: {
  icon: string;
  label: string;
  entityId: string;
  isActive: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        width: 76,
        height: 76,
        backgroundColor: isActive ? "rgba(6,182,212,0.18)" : "rgba(50,50,50,0.6)",
        borderWidth: 1.5,
        borderColor: isActive ? "rgba(6,182,212,0.5)" : GLASS_BORDER,
        borderRadius: 18,
        justifyContent: "center",
        alignItems: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 24 }}>{icon}</Text>
      <Text
        numberOfLines={1}
        style={{
          color: isActive ? ACCENT : "#999",
          fontSize: 9,
          fontFamily: "monospace",
          fontWeight: "600",
          marginTop: 4,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── Device Mini Card (inside room cards) ──
function DeviceMini({ item }: { item: InventoryItem }) {
  const entity = useEntity(item.primaryEntityId);
  const { callService } = useHA();
  const { setFocusedDevice } = useGlasses();
  const state = entity?.state ?? "unavailable";
  const isOn = state === "on" || state === "playing" || state === "home" || state === "cleaning";
  const isUnavailable = state === "unavailable";

  // Battery for vacuum/phone
  const batteryId = item.entities.find((e) => e.label === "Battery")?.entityId;
  const batteryEntity = useEntity(batteryId ?? "");
  const battery = batteryEntity ? parseInt(batteryEntity.state, 10) : null;

  // Temperature for AC
  const isClimate = item.primaryEntityId.startsWith("climate.");
  const temp = isClimate && entity?.attributes
    ? `${Math.round(entity.attributes.current_temperature || 0)}\u00B0`
    : null;

  const handlePress = useCallback(() => {
    if (isUnavailable) return;
    const domain = item.primaryEntityId.split(".")[0];
    // Set as focused device for glasses gesture control
    setFocusedDevice({ entityId: item.primaryEntityId, domain, name: item.name });
    if (domain === "switch") {
      callService("switch", "toggle", {}, { entity_id: item.primaryEntityId });
    } else if (domain === "media_player") {
      callService("media_player", "toggle", {}, { entity_id: item.primaryEntityId });
    }
  }, [item.primaryEntityId, item.name, callService, isUnavailable, setFocusedDevice]);

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => ({
        width: "47%",
        backgroundColor: "rgba(20,20,20,0.8)",
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: isOn ? "rgba(6,182,212,0.25)" : GLASS_BORDER,
        opacity: pressed ? 0.7 : isUnavailable ? 0.4 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 5 }}>
        <Text style={{ fontSize: 18 }}>{item.icon}</Text>
        <View
          style={{
            marginLeft: 5,
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: isOn ? ACCENT : "#444",
          }}
        />
      </View>
      <Text numberOfLines={1} style={{ color: "#ccc", fontSize: 11, fontWeight: "500" }}>
        {item.name}
      </Text>
      {/* Status line */}
      {temp ? (
        <Text style={{ color: ACCENT, fontSize: 13, fontWeight: "700", marginTop: 2 }}>
          {temp}
        </Text>
      ) : battery != null && !isNaN(battery) ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
          <View style={{ width: 28, height: 10, borderRadius: 3, backgroundColor: "rgba(6,182,212,0.15)", borderWidth: 1, borderColor: "rgba(6,182,212,0.3)", overflow: "hidden", padding: 1 }}>
            <View style={{ height: "100%", width: `${Math.min(100, battery)}%`, backgroundColor: battery < 20 ? "#EF4444" : ACCENT, borderRadius: 2 }} />
          </View>
          <Text style={{ color: battery < 20 ? "#EF4444" : ACCENT, fontSize: 10, fontWeight: "600" }}>
            {battery}%
          </Text>
        </View>
      ) : (
        <Text style={{ color: isOn ? ACCENT : "#555", fontSize: 10, marginTop: 2, fontWeight: "500" }}>
          {isUnavailable ? "N/A" : state}
        </Text>
      )}
    </Pressable>
  );
}

// ── Room Card (glassmorphic) ──
function RoomCard({ room, onExpand }: { room: Room; onExpand: () => void }) {
  const activeCount = useRoomActiveCount(room);

  return (
    <Pressable
      onPress={onExpand}
      style={({ pressed }) => ({
        width: (SCREEN_W - 48) / 2,
        backgroundColor: GLASS,
        borderWidth: 1,
        borderColor: activeCount > 0 ? "rgba(6,182,212,0.2)" : GLASS_BORDER,
        borderRadius: 20,
        padding: 14,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {/* Header */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <Text style={{ fontSize: 22 }}>{room.icon}</Text>
        {activeCount > 0 && (
          <View style={{ backgroundColor: "rgba(6,182,212,0.15)", paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 }}>
            <Text style={{ color: ACCENT, fontSize: 10, fontWeight: "700" }}>{activeCount}</Text>
          </View>
        )}
      </View>
      <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600", marginBottom: 2 }}>
        {room.name}
      </Text>
      <Text style={{ color: "#666", fontSize: 10 }}>
        {room.items.length} device{room.items.length !== 1 ? "s" : ""}
      </Text>

      {/* Mini device list (first 2) */}
      <View style={{ marginTop: 10, gap: 4 }}>
        {room.items.slice(0, 2).map((item) => (
          <RoomCardDeviceRow key={item.id} item={item} />
        ))}
        {room.items.length > 2 && (
          <Text style={{ color: "#444", fontSize: 9, fontFamily: "monospace", marginTop: 2 }}>
            +{room.items.length - 2} more
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function RoomCardDeviceRow({ item }: { item: InventoryItem }) {
  const entity = useEntity(item.primaryEntityId);
  const state = entity?.state ?? "unavailable";
  const isOn = state === "on" || state === "playing" || state === "cleaning" || state === "home";

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: isOn ? ACCENT : "#333" }} />
      <Text numberOfLines={1} style={{ color: isOn ? "#bbb" : "#555", fontSize: 10, flex: 1 }}>
        {item.name}
      </Text>
      <Text style={{ color: isOn ? ACCENT : "#444", fontSize: 9, fontWeight: "500" }}>
        {state === "unavailable" ? "" : state}
      </Text>
    </View>
  );
}

function useRoomActiveCount(room: Room): number {
  // Can't call hooks in a loop, so we just count at render time
  // This works because the parent re-renders when entities change
  const { entities } = useHA();
  let count = 0;
  for (const item of room.items) {
    const e = entities[item.primaryEntityId];
    if (e && (e.state === "on" || e.state === "playing" || e.state === "cleaning" || e.state === "home")) {
      count++;
    }
  }
  return count;
}

// ── Washer Status Banner ──
function WasherBanner() {
  const status = useEntity("sensor.151732606804847_status");
  const progress = useEntity("sensor.151732606804847_progress");
  const remaining = useEntity("sensor.151732606804847_time_remaining");

  if (!status || status.state === "unavailable" || status.state === "idle" || status.state === "off") {
    return null;
  }

  const pct = progress ? parseInt(progress.state, 10) : 0;

  return (
    <View style={{
      marginHorizontal: 16,
      marginBottom: 12,
      padding: 12,
      backgroundColor: "rgba(59,130,246,0.1)",
      borderRadius: 14,
      borderWidth: 1,
      borderColor: "rgba(59,130,246,0.25)",
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 18 }}>{"\uD83E\uDEE7"}</Text>
          <Text style={{ color: "#93C5FD", fontSize: 12, fontFamily: "monospace", fontWeight: "600" }}>
            Washer: {status.state}
          </Text>
        </View>
        {remaining?.state && (
          <Text style={{ color: "#6B7280", fontSize: 11, fontFamily: "monospace" }}>
            {remaining.state}
          </Text>
        )}
      </View>
      {pct > 0 && (
        <View style={{ marginTop: 8, height: 4, backgroundColor: "rgba(59,130,246,0.15)", borderRadius: 2 }}>
          <View style={{ width: `${Math.min(100, pct)}%`, height: 4, backgroundColor: "#3B82F6", borderRadius: 2 }} />
        </View>
      )}
    </View>
  );
}

// ── Spotify Now Playing Banner ──
function SpotifyBanner() {
  const { state } = useMediaPlayer();
  const router = useRouter();

  if (!state.available || !state.isPlaying) return null;

  return (
    <Pressable
      onPress={() => router.push("/(tabs)/music")}
      style={({ pressed }) => ({
        marginHorizontal: 16,
        marginBottom: 12,
        padding: 12,
        backgroundColor: "rgba(29,185,84,0.1)",
        borderRadius: 14,
        borderWidth: 1,
        borderColor: "rgba(29,185,84,0.25)",
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 18 }}>{"\uD83C\uDFB5"}</Text>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: "#1DB954", fontSize: 12, fontFamily: "monospace", fontWeight: "600" }}>
          {state.trackName}
        </Text>
        <Text numberOfLines={1} style={{ color: "#6B7280", fontSize: 10, fontFamily: "monospace" }}>
          {state.artist}
        </Text>
      </View>
      <Text style={{ color: "#1DB954", fontSize: 10 }}>{"\u25B6"}</Text>
    </Pressable>
  );
}

// ── Vacuum Quick Status ──
function VacuumBanner() {
  const { state: vac } = useVacuum();

  if (!vac.state || vac.state === "unavailable" || vac.isDocked) return null;

  const color = vac.isCleaning ? "#10B981" : vac.isReturning ? "#F59E0B" : vac.isPaused ? "#F97316" : "#666";

  return (
    <View style={{
      marginHorizontal: 16,
      marginBottom: 12,
      padding: 12,
      backgroundColor: `${color}15`,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: `${color}40`,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 18 }}>{"\uD83E\uDD16"}</Text>
        <View>
          <Text style={{ color, fontSize: 12, fontFamily: "monospace", fontWeight: "600" }}>
            Dusk Vader — {vac.status}
          </Text>
          {vac.currentRoom && (
            <Text style={{ color: "#6B7280", fontSize: 10, fontFamily: "monospace" }}>
              {vac.currentRoom}
            </Text>
          )}
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text style={{ fontSize: 10 }}>{"\uD83D\uDD0B"}</Text>
        <Text style={{ color: vac.battery < 20 ? "#EF4444" : ACCENT, fontSize: 11, fontWeight: "600" }}>
          {vac.battery}%
        </Text>
      </View>
    </View>
  );
}

// ── Room Detail Modal ──
function RoomDetailModal({
  room,
  visible,
  onClose,
}: {
  room: Room | null;
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  if (!room) return null;

  const isLivingRoom = room.name === "Living Room";
  const isCleaning = room.name === "Cleaning";

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.85)", paddingTop: insets.top }}>
        {/* Header */}
        <View style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 20,
          paddingVertical: 16,
          borderBottomWidth: 1,
          borderColor: GLASS_BORDER,
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ fontSize: 24 }}>{room.icon}</Text>
            <Text style={{ color: "#fff", fontSize: 18, fontWeight: "600" }}>{room.name}</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={20} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.1)", justifyContent: "center", alignItems: "center" }}>
            <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600" }}>X</Text>
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}>
          {/* Device grid */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            {room.items.map((item) => (
              <DeviceMini key={item.id} item={item} />
            ))}
          </View>

          {/* AC widget */}
          {isLivingRoom && (
            <View style={{ marginTop: 16 }}>
              <ACWidget entityId="climate.living_room_ac" />
            </View>
          )}

          {/* Vacuum widget */}
          {isCleaning && (
            <View style={{ marginTop: 16 }}>
              <VacuumWidget entityId="vacuum.dusk_vader" />
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Schedule Row ──
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function ScheduleRow({
  schedule,
  onToggle,
}: {
  schedule: DeviceSchedule;
  onToggle: (id: number, enabled: boolean) => void;
}) {
  const timeStr = `${String(schedule.cron_hour).padStart(2, "0")}:${String(schedule.cron_minute).padStart(2, "0")}`;
  const daysStr = schedule.cron_days.length === 7
    ? "Every day"
    : schedule.cron_days.map((d) => DAY_LABELS[d]).join(" ");

  const nextRun = schedule.next_run_at ? new Date(schedule.next_run_at) : null;
  const now = new Date();
  let nextLabel = "";
  if (nextRun) {
    const diff = nextRun.getTime() - now.getTime();
    if (diff < 3600000) nextLabel = `in ${Math.max(1, Math.round(diff / 60000))}m`;
    else if (diff < 86400000) nextLabel = `in ${Math.round(diff / 3600000)}h`;
    else nextLabel = nextRun.toLocaleDateString([], { weekday: "short" });
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: GLASS,
        borderRadius: 14,
        padding: 12,
        borderWidth: 1,
        borderColor: schedule.enabled ? "rgba(6,182,212,0.15)" : GLASS_BORDER,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: schedule.enabled ? "#ddd" : "#555", fontSize: 13, fontWeight: "600" }}>
          {schedule.name}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 }}>
          <Text style={{ color: schedule.enabled ? ACCENT : "#444", fontSize: 16, fontWeight: "700", fontFamily: "monospace" }}>
            {timeStr}
          </Text>
          <Text style={{ color: "#555", fontSize: 10, fontFamily: "monospace" }}>{daysStr}</Text>
        </View>
        {nextLabel && schedule.enabled && (
          <Text style={{ color: "#444", fontSize: 9, fontFamily: "monospace", marginTop: 2 }}>
            Next: {nextLabel}
          </Text>
        )}
      </View>
      <Switch
        value={schedule.enabled}
        onValueChange={(val) => onToggle(schedule.id, val)}
        trackColor={{ false: "#333", true: "rgba(6,182,212,0.35)" }}
        thumbColor={schedule.enabled ? ACCENT : "#666"}
      />
    </View>
  );
}

// ── Home Screen ──
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { entities, callService } = useHA();
  const { setFocusedDevice, lastGestureAction, isConnected: glassesConnected } = useGlasses();
  const acEntity = useEntity("climate.living_room_ac");
  const [viewMode, setViewMode] = useState<"cards" | "map">("cards");
  const [expandedRoom, setExpandedRoom] = useState<Room | null>(null);
  const [activePin, setActivePin] = useState<MapPin | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [schedules, setSchedules] = useState<DeviceSchedule[]>([]);

  useEffect(() => {
    fetchSchedules().then((r) => setSchedules(r.schedules)).catch(() => {});
  }, []);

  const handleScheduleToggle = useCallback(async (id: number, enabled: boolean) => {
    setSchedules((prev) => prev.map((s) => s.id === id ? { ...s, enabled } : s));
    try {
      await updateSchedule(id, { enabled });
    } catch {
      setSchedules((prev) => prev.map((s) => s.id === id ? { ...s, enabled: !enabled } : s));
    }
  }, []);

  // Count active devices
  const activeDeviceCount = useMemo(() => {
    let count = 0;
    for (const room of rooms) {
      for (const item of room.items) {
        const e = entities[item.primaryEntityId];
        if (e && (e.state === "on" || e.state === "playing" || e.state === "cleaning")) count++;
      }
    }
    return count;
  }, [entities]);

  const currentTemp = acEntity?.attributes?.current_temperature
    ? `${Math.round(acEntity.attributes.current_temperature)}\u00B0`
    : null;

  // Quick actions
  const quickActions = useMemo(() => [
    { icon: "\u2744\uFE0F", label: "AC", entityId: "climate.living_room_ac", domain: "climate" },
    { icon: "\uD83D\uDCFA", label: "TV", entityId: "media_player.main_tv", domain: "media_player" },
    { icon: "\uD83E\uDD16", label: "Vacuum", entityId: "vacuum.dusk_vader", domain: "vacuum" },
    { icon: "\uD83D\uDCF9", label: "LR Cam", entityId: "switch.living_room_cam_power", domain: "switch" },
    { icon: "\uD83D\uDCF9", label: "Sec Cam", entityId: "switch.cam1_power", domain: "switch" },
    { icon: "\uD83E\uDEE7", label: "Washer", entityId: "switch.151732606804847_power", domain: "switch" },
  ], []);

  const handleQuickAction = useCallback((action: typeof quickActions[0]) => {
    const e = entities[action.entityId];
    if (!e) return;
    // Set as focused device for glasses gesture control
    setFocusedDevice({ entityId: action.entityId, domain: action.domain, name: action.label });
    if (action.domain === "switch") {
      callService("switch", "toggle", {}, { entity_id: action.entityId });
    } else if (action.domain === "media_player") {
      callService("media_player", "toggle", {}, { entity_id: action.entityId });
    } else if (action.domain === "vacuum") {
      const isActive = e.state === "cleaning" || e.state === "returning";
      callService("vacuum", isActive ? "return_to_base" : "start", {}, { entity_id: action.entityId });
    }
  }, [entities, callService, setFocusedDevice]);

  const toggleView = useCallback(() => setViewMode((v) => v === "cards" ? "map" : "cards"), []);
  const handlePinPress = useCallback((pin: MapPin) => { setActivePin(pin); setSheetVisible(true); }, []);
  const handleMapLoadError = useCallback(() => setViewMode("cards"), []);
  const closeSheet = useCallback(() => { setSheetVisible(false); setActivePin(null); }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#0D0D0D" }}>
      {/* ── Header ── */}
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingBottom: 12,
          paddingHorizontal: 20,
          backgroundColor: "#0D0D0D",
          borderBottomWidth: 1,
          borderBottomColor: GLASS_BORDER,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <HamburgerMenu />
              <Text style={{ color: "#fff", fontSize: 20, fontWeight: "700" }}>My Home</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4, marginLeft: 36 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: activeDeviceCount > 0 ? ACCENT : "#444" }} />
              <Text style={{ color: "#777", fontSize: 11, fontFamily: "monospace" }}>
                {activeDeviceCount} active{currentTemp ? ` \u00B7 ${currentTemp}` : ""}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {currentTemp && (
              <View style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                backgroundColor: "rgba(6,182,212,0.1)",
                borderRadius: 8,
                borderWidth: 1,
                borderColor: "rgba(6,182,212,0.25)",
              }}>
                <Text style={{ color: ACCENT, fontSize: 13, fontWeight: "700" }}>{currentTemp}</Text>
              </View>
            )}
            <Pressable onPress={toggleView} hitSlop={12} style={{ padding: 4 }}>
              <Text style={{ color: ACCENT, fontSize: 18 }}>
                {viewMode === "cards" ? "\uD83D\uDDFA" : "\u2630"}
              </Text>
            </Pressable>
            <StatusBadge />
          </View>
        </View>
      </View>

      {viewMode === "map" ? (
        <View style={{ flex: 1 }}>
          <FloorPlanMap onPinPress={handlePinPress} onMapLoadError={handleMapLoadError} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Quick Actions ── */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: 16 }}
            contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
          >
            {quickActions.map((action) => {
              const e = entities[action.entityId];
              const isActive = e ? (e.state === "on" || e.state === "playing" || e.state === "cleaning" || e.state === "cool" || e.state === "heat" || e.state === "auto") : false;
              return (
                <QuickAction
                  key={action.entityId}
                  icon={action.icon}
                  label={action.label}
                  entityId={action.entityId}
                  isActive={isActive}
                  onPress={() => handleQuickAction(action)}
                />
              );
            })}
          </ScrollView>

          {/* ── Active Banners ── */}
          <View style={{ marginTop: 16 }}>
            <SpotifyBanner />
            <WasherBanner />
            <VacuumBanner />
          </View>

          {/* ── Room Cards Grid ── */}
          <View style={{ paddingHorizontal: 16, marginTop: 4 }}>
            <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace", fontWeight: "700", letterSpacing: 2, marginBottom: 12 }}>
              ROOMS
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              {rooms.map((room) => (
                <RoomCard
                  key={room.name}
                  room={room}
                  onExpand={() => setExpandedRoom(room)}
                />
              ))}
            </View>
          </View>

          {/* ── Schedules ── */}
          {schedules.length > 0 && (
            <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
              <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace", fontWeight: "700", letterSpacing: 2, marginBottom: 12 }}>
                AUTOMATIONS
              </Text>
              <View style={{ gap: 8 }}>
                {schedules.map((sched) => (
                  <ScheduleRow key={sched.id} schedule={sched} onToggle={handleScheduleToggle} />
                ))}
              </View>
            </View>
          )}
        </ScrollView>
      )}

      {/* Room Detail Modal */}
      <RoomDetailModal
        room={expandedRoom}
        visible={!!expandedRoom}
        onClose={() => setExpandedRoom(null)}
      />

      {/* Map Pin Detail Sheet */}
      <DeviceSheet visible={sheetVisible} pin={activePin} onDismiss={closeSheet} />

      {/* Gesture action feedback banner */}
      {lastGestureAction && (
        <View
          style={{
            position: "absolute",
            top: insets.top + 56,
            left: 40,
            right: 40,
            backgroundColor: "rgba(6,182,212,0.2)",
            borderWidth: 1,
            borderColor: "rgba(6,182,212,0.4)",
            borderRadius: 12,
            paddingVertical: 8,
            paddingHorizontal: 16,
            alignItems: "center",
            zIndex: 100,
          }}
        >
          <Text style={{ color: ACCENT, fontSize: 13, fontFamily: "monospace", fontWeight: "700" }}>
            {"\uD83E\uDD0C"} {lastGestureAction}
          </Text>
        </View>
      )}

      <StatusBar style="light" />
    </View>
  );
}
