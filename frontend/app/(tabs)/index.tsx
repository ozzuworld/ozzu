// Home — Fullscreen 3D apartment map
// Cipher bubble (top right), Ops icon below it
// Long-press to place items in edit mode

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { StatusBadge } from "../../components/StatusBadge";
import { HamburgerMenu } from "../../components/HamburgerMenu";
import { useHA } from "../../lib/ha-context";
import { useEntity } from "../../lib/useEntity";
import HomeMap3D, { ALL_DEVICES, ItemPicker, DeviceMarker } from "../../components/home/HomeMap3D";
import { getBridgeUrl } from "../../lib/bridge-api";
import { useGlasses } from "../../lib/glasses-context";
import { usePosition } from "../../lib/usePosition";
import { BLEPairingModal } from "../../components/home/BLEPairingModal";
import * as FileSystem from "expo-file-system/legacy";

const STORAGE_FILE = FileSystem.documentDirectory + "device_placements.json";

const C = {
  bg: "#000000",
  text: "#FFFFFF",
  textSec: "rgba(255,255,255,0.55)",
  textDim: "rgba(255,255,255,0.3)",
  climate: "#4FC3F7",
  cyan: "#06B6D4",
};

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Default placements (what was previously hardcoded)
const DEFAULT_PLACEMENTS: DeviceMarker[] = [
  { ...ALL_DEVICES.find((d) => d.id === "main_tv")!, position: [2.20, -4.80] },
  { ...ALL_DEVICES.find((d) => d.id === "spotify")!, position: [1.15, -3.33] },
  { ...ALL_DEVICES.find((d) => d.id === "ac")!, position: [0.30, -5.10] },
  { ...ALL_DEVICES.find((d) => d.id === "midea_washer")!, position: [-3.97, -0.74] },
];

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { entities, callService } = useHA();
  const { lastGestureAction } = useGlasses();
  const { position } = usePosition();
  const acEntity = useEntity("climate.living_room_ac");
  const [pairingVisible, setPairingVisible] = useState(false);

  // Edit mode
  const [editMode, setEditMode] = useState(false);
  const [itemPickerVisible, setItemPickerVisible] = useState(false);
  const [pendingPlacePos, setPendingPlacePos] = useState<[number, number] | null>(null);

  // Device placements — loaded from AsyncStorage
  const [placedDevices, setPlacedDevices] = useState<DeviceMarker[]>(DEFAULT_PLACEMENTS);
  const loadedRef = useRef(false);

  // Load saved placements
  useEffect(() => {
    async function load() {
      try {
        const info = await FileSystem.getInfoAsync(STORAGE_FILE);
        if (info.exists) {
          const saved = await FileSystem.readAsStringAsync(STORAGE_FILE);
          const parsed: Array<{ id: string; position: [number, number] }> = JSON.parse(saved);
          const devices: DeviceMarker[] = [];
          for (const p of parsed) {
            const template = ALL_DEVICES.find((d) => d.id === p.id);
            if (template) {
              devices.push({ ...template, position: p.position });
            }
          }
          if (devices.length > 0) {
            setPlacedDevices(devices);
          }
        }
      } catch {}
      loadedRef.current = true;
    }
    load();
  }, []);

  // Save placements when they change
  const savePlacements = useCallback(async (devices: DeviceMarker[]) => {
    try {
      const minimal = devices.map((d) => ({ id: d.id, position: d.position }));
      await FileSystem.writeAsStringAsync(STORAGE_FILE, JSON.stringify(minimal));
    } catch {}
  }, []);

  // Count active devices
  const activeDeviceCount = useMemo(() => {
    let count = 0;
    for (const marker of placedDevices) {
      const e = entities[marker.entityId];
      if (e && ["on", "playing", "cleaning", "cool", "heat", "auto"].includes(e.state)) count++;
    }
    return count;
  }, [entities, placedDevices]);

  const currentTemp = acEntity?.attributes?.current_temperature
    ? Math.round(acEntity.attributes.current_temperature)
    : null;

  // Build device states map
  const deviceStates = useMemo(() => {
    const states: Record<string, { state: string; attributes?: any }> = {};
    for (const marker of placedDevices) {
      const e = entities[marker.entityId];
      if (e) states[marker.entityId] = { state: e.state, attributes: e.attributes };
    }
    return states;
  }, [entities, placedDevices]);

  // Device toggle
  const handleDeviceToggle = useCallback((entityId: string, domain: string) => {
    if (domain === "switch") {
      callService("switch", "toggle", {}, { entity_id: entityId });
    } else if (domain === "media_player") {
      callService("media_player", "toggle", {}, { entity_id: entityId });
    } else if (domain === "climate") {
      const e = entities[entityId];
      const isOn = e && ["cool", "heat", "auto"].includes(e.state);
      callService("climate", isOn ? "turn_off" : "turn_on", {}, { entity_id: entityId });
    } else if (domain === "vacuum") {
      const e = entities[entityId];
      const isActive = e && (e.state === "cleaning" || e.state === "returning");
      callService("vacuum", isActive ? "return_to_base" : "start", {}, { entity_id: entityId });
    }
  }, [entities, callService]);

  // Place device at position
  const handlePlaceDevice = useCallback((device: Omit<DeviceMarker, "position">) => {
    if (!pendingPlacePos) return;
    const newDevice: DeviceMarker = { ...device, position: pendingPlacePos } as DeviceMarker;
    const updated = [...placedDevices, newDevice];
    setPlacedDevices(updated);
    savePlacements(updated);
    setItemPickerVisible(false);
    setPendingPlacePos(null);
  }, [pendingPlacePos, placedDevices, savePlacements]);

  // Remove device
  const handleRemoveDevice = useCallback((deviceId: string) => {
    const updated = placedDevices.filter((d) => d.id !== deviceId);
    setPlacedDevices(updated);
    savePlacements(updated);
  }, [placedDevices, savePlacements]);

  // Handle tap on 3D map in edit mode → open item picker
  const handleRequestPlaceAt = useCallback((worldX: number, worldZ: number) => {
    setPendingPlacePos([Math.round(worldX * 100) / 100, Math.round(worldZ * 100) / 100]);
    setItemPickerVisible(true);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Fullscreen 3D Map */}
      <HomeMap3D
        position={position}
        deviceStates={deviceStates}
        onDeviceToggle={handleDeviceToggle}
        editMode={editMode}
        placedDevices={placedDevices}
        onRemoveDevice={handleRemoveDevice}
        onRequestPlaceAt={handleRequestPlaceAt}
      />

      {/* Floating Header Overlay */}
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          paddingTop: insets.top + 4,
          paddingBottom: 8,
          paddingHorizontal: 16,
          backgroundColor: "rgba(0,0,0,0.5)",
        }}
        pointerEvents="box-none"
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }} pointerEvents="auto">
            <HamburgerMenu />
            <View>
              <Text style={{ color: C.text, fontSize: 20, fontWeight: "700", letterSpacing: -0.5 }}>
                {getGreeting()}
              </Text>
              <Text style={{ color: C.textSec, fontSize: 10 }}>
                {activeDeviceCount} device{activeDeviceCount !== 1 ? "s" : ""} active
                {position ? ` \u00B7 ${position.room}` : ""}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }} pointerEvents="auto">
            {currentTemp != null && (
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  backgroundColor: "rgba(0,0,0,0.4)",
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: `${C.climate}25`,
                }}
              >
                <Text
                  style={{
                    color: C.climate,
                    fontSize: 14,
                    fontWeight: "300",
                    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                  }}
                >
                  {currentTemp}{"\u00B0"}
                </Text>
              </View>
            )}
            {/* Edit mode toggle */}
            <Pressable
              onPress={() => setEditMode(!editMode)}
              style={({ pressed }) => ({
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 8,
                backgroundColor: editMode ? "rgba(6,182,212,0.2)" : "rgba(0,0,0,0.4)",
                borderWidth: 1,
                borderColor: editMode ? "rgba(6,182,212,0.5)" : "rgba(255,255,255,0.1)",
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ color: editMode ? C.cyan : "rgba(255,255,255,0.5)", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                {editMode ? "DONE" : "EDIT"}
              </Text>
            </Pressable>
            <StatusBadge />
          </View>
        </View>
      </View>

      {/* Right side floating icons — Cipher + Ops */}
      <View
        style={{
          position: "absolute",
          right: 12,
          top: insets.top + 60,
          gap: 10,
          alignItems: "center",
        }}
        pointerEvents="box-none"
      >
        {/* Cipher bubble */}
        <Pressable
          onPress={() => router.push("/cipher")}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: "rgba(6,182,212,0.15)",
            borderWidth: 1,
            borderColor: "rgba(6,182,212,0.35)",
            justifyContent: "center",
            alignItems: "center",
            opacity: pressed ? 0.7 : 1,
            ...(Platform.OS === "ios" ? {
              shadowColor: C.cyan,
              shadowRadius: 8,
              shadowOpacity: 0.3,
              shadowOffset: { width: 0, height: 0 },
            } : { elevation: 4 }),
          })}
        >
          <Text style={{ fontSize: 20 }}>{"🤖"}</Text>
        </Pressable>

        {/* Ops icon */}
        <Pressable
          onPress={() => router.push("/ops")}
          style={({ pressed }) => ({
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: "rgba(0,0,0,0.6)",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.12)",
            justifyContent: "center",
            alignItems: "center",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ fontSize: 16 }}>{"📡"}</Text>
        </Pressable>
      </View>

      {/* Gesture feedback */}
      {lastGestureAction && (
        <View
          style={{
            position: "absolute",
            top: insets.top + 60,
            alignSelf: "center",
            backgroundColor: "rgba(0,0,0,0.85)",
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.18)",
            borderRadius: 12,
            paddingVertical: 8,
            paddingHorizontal: 16,
            zIndex: 100,
          }}
        >
          <Text style={{ color: C.text, fontSize: 13, fontWeight: "600" }}>
            {"\uD83E\uDD0C"} {lastGestureAction}
          </Text>
        </View>
      )}

      {/* Item Picker for edit mode */}
      <ItemPicker
        visible={itemPickerVisible}
        placedDeviceIds={placedDevices.map((d) => d.id)}
        onSelect={handlePlaceDevice}
        onClose={() => { setItemPickerVisible(false); setPendingPlacePos(null); }}
      />

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
