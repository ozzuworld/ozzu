// Home Dashboard — Premium smart home control
// Apple Home + Google Home inspired: true black, category colors, icon glows

import { useState, useCallback, useMemo, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Dimensions,
  Modal,
  Switch,
  Platform,
} from "react-native";
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
import { fetchSchedules, updateSchedule, type DeviceSchedule, getBridgeUrl } from "../../lib/bridge-api";
import { useGlasses, type FocusedDevice } from "../../lib/glasses-context";
import { BLEPairingModal } from "../../components/home/BLEPairingModal";

const { width: SW } = Dimensions.get("window");

// ── Design System ──
const C = {
  bg: "#000000",
  card: "rgba(255,255,255,0.06)",
  cardActive: "rgba(255,255,255,0.12)",
  border: "rgba(255,255,255,0.08)",
  borderActive: "rgba(255,255,255,0.18)",
  text: "#FFFFFF",
  textSec: "rgba(255,255,255,0.55)",
  textDim: "rgba(255,255,255,0.3)",
  // Category colors
  climate: "#4FC3F7",
  media: "#CE93D8",
  security: "#66BB6A",
  power: "#FFB830",
  vacuum: "#10B981",
  generic: "#90A4AE",
};

function deviceColor(domain: string, entityId: string): string {
  if (domain === "climate") return C.climate;
  if (domain === "vacuum") return C.vacuum;
  if (domain === "media_player") return C.media;
  if (entityId.includes("cam") || entityId.includes("siren")) return C.security;
  if (domain === "switch") return C.power;
  return C.generic;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ── Favorite Device Card (2-column grid) ──
function DeviceCard({
  item,
  onFocus,
}: {
  item: InventoryItem;
  onFocus: (d: FocusedDevice) => void;
}) {
  const entity = useEntity(item.primaryEntityId);
  const { callService } = useHA();
  const state = entity?.state ?? "unavailable";
  const isOn = state === "on" || state === "playing" || state === "home" || state === "cleaning"
    || state === "cool" || state === "heat" || state === "auto" || state === "returning";
  const isUnavailable = state === "unavailable";
  const domain = item.primaryEntityId.split(".")[0];
  const color = deviceColor(domain, item.primaryEntityId);

  // Battery for vacuum/phone
  const batteryId = item.entities.find((e) => e.label === "Battery")?.entityId;
  const batteryEntity = useEntity(batteryId ?? "");
  const battery = batteryEntity ? parseInt(batteryEntity.state, 10) : null;

  // Temperature for AC
  const isClimate = domain === "climate";
  const temp = isClimate && entity?.attributes?.current_temperature
    ? Math.round(entity.attributes.current_temperature)
    : null;

  const handlePress = useCallback(() => {
    if (isUnavailable) return;
    onFocus({ entityId: item.primaryEntityId, domain, name: item.name });
    if (domain === "switch") {
      callService("switch", "toggle", {}, { entity_id: item.primaryEntityId });
    } else if (domain === "media_player") {
      callService("media_player", "toggle", {}, { entity_id: item.primaryEntityId });
    }
  }, [item.primaryEntityId, item.name, domain, callService, isUnavailable, onFocus]);

  const cardW = (SW - 52) / 2;

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => ({
        width: cardW,
        backgroundColor: isOn ? `${color}18` : C.card,
        borderWidth: 1,
        borderColor: isOn ? `${color}40` : C.border,
        borderRadius: 22,
        padding: 16,
        opacity: pressed ? 0.8 : isUnavailable ? 0.35 : 1,
      })}
    >
      {/* Icon + status dot */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: isOn ? `${color}25` : "rgba(255,255,255,0.06)",
            justifyContent: "center",
            alignItems: "center",
            ...(isOn && Platform.OS === "ios" ? {
              shadowColor: color,
              shadowOffset: { width: 0, height: 0 },
              shadowRadius: 12,
              shadowOpacity: 0.4,
            } : {}),
          }}
        >
          <Text style={{ fontSize: 20 }}>{item.icon}</Text>
        </View>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: isOn ? color : "rgba(255,255,255,0.15)",
            marginTop: 4,
          }}
        />
      </View>

      {/* Name */}
      <Text
        numberOfLines={1}
        style={{
          color: isOn ? C.text : "rgba(255,255,255,0.7)",
          fontSize: 14,
          fontWeight: "500",
          marginTop: 14,
        }}
      >
        {item.name}
      </Text>

      {/* Status / big number */}
      {temp != null ? (
        <Text
          style={{
            color: isOn ? color : C.textDim,
            fontSize: 28,
            fontWeight: "300",
            fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
            marginTop: 2,
          }}
        >
          {temp}{"\u00B0"}
        </Text>
      ) : battery != null && !isNaN(battery) ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
          <View
            style={{
              width: 32,
              height: 12,
              borderRadius: 4,
              backgroundColor: "rgba(255,255,255,0.06)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.1)",
              overflow: "hidden",
              padding: 1.5,
            }}
          >
            <View
              style={{
                height: "100%",
                width: `${Math.min(100, battery)}%`,
                backgroundColor: battery < 20 ? "#EF4444" : color,
                borderRadius: 2,
              }}
            />
          </View>
          <Text style={{ color: battery < 20 ? "#EF4444" : C.textSec, fontSize: 12, fontWeight: "500" }}>
            {battery}%
          </Text>
        </View>
      ) : (
        <Text
          style={{
            color: isOn ? `${color}CC` : C.textDim,
            fontSize: 12,
            fontWeight: "400",
            marginTop: 4,
          }}
        >
          {isUnavailable ? "Offline" : state}
        </Text>
      )}
    </Pressable>
  );
}

// ── Quick Action Chip ──
function QuickChip({
  icon,
  label,
  entityId,
  domain,
  isActive,
  onPress,
}: {
  icon: string;
  label: string;
  entityId: string;
  domain: string;
  isActive: boolean;
  onPress: () => void;
}) {
  const color = deviceColor(domain, entityId);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        height: 40,
        paddingHorizontal: 16,
        gap: 8,
        backgroundColor: isActive ? `${color}20` : "rgba(255,255,255,0.06)",
        borderWidth: 1,
        borderColor: isActive ? `${color}40` : C.border,
        borderRadius: 20,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 16 }}>{icon}</Text>
      <Text
        style={{
          color: isActive ? color : C.textSec,
          fontSize: 13,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── Room Section Header ──
function RoomHeader({ room, activeCount }: { room: Room; activeCount: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12, marginTop: 24 }}>
      <Text style={{ fontSize: 18 }}>{room.icon}</Text>
      <Text style={{ color: C.text, fontSize: 17, fontWeight: "600" }}>{room.name}</Text>
      {activeCount > 0 && (
        <View
          style={{
            backgroundColor: "rgba(255,255,255,0.08)",
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 8,
          }}
        >
          <Text style={{ color: C.textSec, fontSize: 11, fontWeight: "600" }}>{activeCount}</Text>
        </View>
      )}
    </View>
  );
}

// ── Active Banners ──
function SpotifyBanner() {
  const { state } = useMediaPlayer();
  const router = useRouter();
  if (!state.available || !state.isPlaying) return null;

  return (
    <Pressable
      onPress={() => router.push("/(tabs)/music")}
      style={({ pressed }) => ({
        marginBottom: 12,
        padding: 14,
        backgroundColor: "rgba(29,185,84,0.08)",
        borderRadius: 16,
        borderWidth: 1,
        borderColor: "rgba(29,185,84,0.2)",
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          backgroundColor: "rgba(29,185,84,0.15)",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text style={{ fontSize: 18 }}>{"\uD83C\uDFB5"}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: "#1DB954", fontSize: 13, fontWeight: "600" }}>
          {state.trackName}
        </Text>
        <Text numberOfLines={1} style={{ color: C.textDim, fontSize: 11 }}>
          {state.artist}
        </Text>
      </View>
      <Text style={{ color: "#1DB954", fontSize: 12 }}>{"\u25B6"}</Text>
    </Pressable>
  );
}

function WasherBanner() {
  const status = useEntity("sensor.151732606804847_status");
  const progress = useEntity("sensor.151732606804847_progress");
  const remaining = useEntity("sensor.151732606804847_time_remaining");
  if (!status || status.state === "unavailable" || status.state === "idle" || status.state === "off") return null;

  const pct = progress ? parseInt(progress.state, 10) : 0;

  return (
    <View
      style={{
        marginBottom: 12,
        padding: 14,
        backgroundColor: "rgba(59,130,246,0.08)",
        borderRadius: 16,
        borderWidth: 1,
        borderColor: "rgba(59,130,246,0.2)",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ fontSize: 18 }}>{"\uD83E\uDEE7"}</Text>
          <Text style={{ color: "#93C5FD", fontSize: 13, fontWeight: "600" }}>
            Washer \u00B7 {status.state}
          </Text>
        </View>
        {remaining?.state && (
          <Text style={{ color: C.textDim, fontSize: 11 }}>{remaining.state}</Text>
        )}
      </View>
      {pct > 0 && (
        <View style={{ marginTop: 10, height: 3, backgroundColor: "rgba(59,130,246,0.12)", borderRadius: 2 }}>
          <View style={{ width: `${Math.min(100, pct)}%`, height: 3, backgroundColor: "#3B82F6", borderRadius: 2 }} />
        </View>
      )}
    </View>
  );
}

function VacuumBanner() {
  const { state: vac } = useVacuum();
  if (!vac.state || vac.state === "unavailable" || vac.isDocked) return null;

  const color = vac.isCleaning ? C.vacuum : vac.isReturning ? "#F59E0B" : vac.isPaused ? "#F97316" : C.generic;

  return (
    <View
      style={{
        marginBottom: 12,
        padding: 14,
        backgroundColor: `${color}10`,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: `${color}30`,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ fontSize: 18 }}>{"\uD83E\uDD16"}</Text>
        <View>
          <Text style={{ color, fontSize: 13, fontWeight: "600" }}>
            Dusk Vader \u00B7 {vac.status}
          </Text>
          {vac.currentRoom && (
            <Text style={{ color: C.textDim, fontSize: 11 }}>{vac.currentRoom}</Text>
          )}
        </View>
      </View>
      <Text style={{ color: vac.battery < 20 ? "#EF4444" : C.textSec, fontSize: 12, fontWeight: "600" }}>
        {"\uD83D\uDD0B"} {vac.battery}%
      </Text>
    </View>
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

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: C.card,
        borderRadius: 16,
        padding: 14,
        borderWidth: 1,
        borderColor: schedule.enabled ? C.borderActive : C.border,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: schedule.enabled ? C.text : C.textDim, fontSize: 14, fontWeight: "500" }}>
          {schedule.name}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 }}>
          <Text
            style={{
              color: schedule.enabled ? C.text : C.textDim,
              fontSize: 22,
              fontWeight: "300",
              fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
            }}
          >
            {timeStr}
          </Text>
          <Text style={{ color: C.textDim, fontSize: 11 }}>{daysStr}</Text>
        </View>
      </View>
      <Switch
        value={schedule.enabled}
        onValueChange={(val) => onToggle(schedule.id, val)}
        trackColor={{ false: "rgba(255,255,255,0.08)", true: "rgba(6,182,212,0.3)" }}
        thumbColor={schedule.enabled ? C.climate : "rgba(255,255,255,0.3)"}
      />
    </View>
  );
}

// ── Room Detail Modal ──
function RoomDetailModal({
  room,
  visible,
  onClose,
  onFocusDevice,
}: {
  room: Room | null;
  visible: boolean;
  onClose: () => void;
  onFocusDevice: (d: FocusedDevice) => void;
}) {
  const insets = useSafeAreaInsets();
  if (!room) return null;

  const isLivingRoom = room.name === "Living Room";
  const isCleaning = room.name === "Cleaning";

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top }}>
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 20,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderColor: C.border,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ fontSize: 24 }}>{room.icon}</Text>
            <Text style={{ color: C.text, fontSize: 20, fontWeight: "600" }}>{room.name}</Text>
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={20}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: "rgba(255,255,255,0.08)",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Text style={{ color: C.text, fontSize: 16, fontWeight: "600" }}>X</Text>
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}>
          {/* Device grid */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {room.items.map((item) => (
              <DeviceCard key={item.id} item={item} onFocus={onFocusDevice} />
            ))}
          </View>

          {/* AC widget */}
          {isLivingRoom && (
            <View style={{ marginTop: 20 }}>
              <ACWidget entityId="climate.living_room_ac" />
            </View>
          )}

          {/* Vacuum widget */}
          {isCleaning && (
            <View style={{ marginTop: 20 }}>
              <VacuumWidget entityId="vacuum.dusk_vader" />
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Home Screen ──
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { entities, callService } = useHA();
  const { setFocusedDevice, lastGestureAction } = useGlasses();
  const acEntity = useEntity("climate.living_room_ac");
  const [viewMode, setViewMode] = useState<"cards" | "map">("cards");
  const [expandedRoom, setExpandedRoom] = useState<Room | null>(null);
  const [activePin, setActivePin] = useState<MapPin | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [schedules, setSchedules] = useState<DeviceSchedule[]>([]);
  const [pairingVisible, setPairingVisible] = useState(false);

  useEffect(() => {
    fetchSchedules().then((r) => setSchedules(r.schedules)).catch(() => {});
  }, []);

  const handleScheduleToggle = useCallback(async (id: number, enabled: boolean) => {
    setSchedules((prev) => prev.map((s) => s.id === id ? { ...s, enabled } : s));
    try { await updateSchedule(id, { enabled }); }
    catch { setSchedules((prev) => prev.map((s) => s.id === id ? { ...s, enabled: !enabled } : s)); }
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
    ? Math.round(acEntity.attributes.current_temperature)
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

  // Room active counts
  const roomActiveCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const room of rooms) {
      let c = 0;
      for (const item of room.items) {
        const e = entities[item.primaryEntityId];
        if (e && (e.state === "on" || e.state === "playing" || e.state === "cleaning" || e.state === "home")) c++;
      }
      counts[room.name] = c;
    }
    return counts;
  }, [entities]);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* ── Header ── */}
      <View style={{ paddingTop: insets.top + 12, paddingBottom: 16, paddingHorizontal: 20 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <HamburgerMenu />
            <View>
              <Text style={{ color: C.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.5 }}>
                {getGreeting()}
              </Text>
              <Text style={{ color: C.textSec, fontSize: 13, marginTop: 2 }}>
                {activeDeviceCount} device{activeDeviceCount !== 1 ? "s" : ""} active
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {currentTemp != null && (
              <View
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  backgroundColor: `${C.climate}15`,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: `${C.climate}30`,
                }}
              >
                <Text
                  style={{
                    color: C.climate,
                    fontSize: 18,
                    fontWeight: "300",
                    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                  }}
                >
                  {currentTemp}{"\u00B0"}
                </Text>
              </View>
            )}
            <Pressable onPress={() => setPairingVisible(true)} hitSlop={12} style={{ padding: 4 }}>
              <Text style={{ color: C.textSec, fontSize: 18 }}>BLE</Text>
            </Pressable>
            <Pressable onPress={toggleView} hitSlop={12} style={{ padding: 4 }}>
              <Text style={{ color: C.textSec, fontSize: 20 }}>
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
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 30 + insets.bottom }}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Quick Actions ── */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingRight: 20 }}
          >
            {quickActions.map((action) => {
              const e = entities[action.entityId];
              const isActive = e ? (e.state === "on" || e.state === "playing" || e.state === "cleaning"
                || e.state === "cool" || e.state === "heat" || e.state === "auto") : false;
              return (
                <QuickChip
                  key={action.entityId}
                  icon={action.icon}
                  label={action.label}
                  entityId={action.entityId}
                  domain={action.domain}
                  isActive={isActive}
                  onPress={() => handleQuickAction(action)}
                />
              );
            })}
          </ScrollView>

          {/* ── Active Banners ── */}
          <View style={{ marginTop: 20 }}>
            <SpotifyBanner />
            <WasherBanner />
            <VacuumBanner />
          </View>

          {/* ── Rooms with Device Cards ── */}
          {rooms.map((room) => (
            <View key={room.name}>
              <Pressable onPress={() => setExpandedRoom(room)}>
                <RoomHeader room={room} activeCount={roomActiveCounts[room.name] || 0} />
              </Pressable>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
                {room.items.slice(0, 4).map((item) => (
                  <DeviceCard key={item.id} item={item} onFocus={setFocusedDevice} />
                ))}
              </View>
              {room.items.length > 4 && (
                <Pressable onPress={() => setExpandedRoom(room)} style={{ marginTop: 8 }}>
                  <Text style={{ color: C.textSec, fontSize: 12, fontWeight: "500" }}>
                    +{room.items.length - 4} more devices \u203A
                  </Text>
                </Pressable>
              )}
            </View>
          ))}

          {/* ── Schedules ── */}
          {schedules.length > 0 && (
            <View style={{ marginTop: 28 }}>
              <Text
                style={{
                  color: C.textSec,
                  fontSize: 11,
                  fontWeight: "600",
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  marginBottom: 12,
                }}
              >
                Automations
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
        onFocusDevice={setFocusedDevice}
      />

      {/* Map Pin Detail Sheet */}
      <DeviceSheet visible={sheetVisible} pin={activePin} onDismiss={closeSheet} />

      {/* Gesture action feedback */}
      {lastGestureAction && (
        <View
          style={{
            position: "absolute",
            top: insets.top + 72,
            alignSelf: "center",
            backgroundColor: "rgba(0,0,0,0.85)",
            borderWidth: 1,
            borderColor: C.borderActive,
            borderRadius: 14,
            paddingVertical: 10,
            paddingHorizontal: 20,
            zIndex: 100,
          }}
        >
          <Text style={{ color: C.text, fontSize: 14, fontWeight: "600" }}>
            {"\uD83E\uDD0C"} {lastGestureAction}
          </Text>
        </View>
      )}

      {/* BLE Pairing Modal */}
      <BLEPairingModal
        visible={pairingVisible}
        onClose={() => setPairingVisible(false)}
        bridgeUrl={getBridgeUrl()}
      />

      <StatusBar style="light" />
    </View>
  );
}
