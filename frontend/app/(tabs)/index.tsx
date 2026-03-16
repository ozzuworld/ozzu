// Home Dashboard — Fullscreen 3D apartment map with interactive device markers
// Devices placed at real positions, tappable for controls

import { useState, useCallback, useMemo, useEffect } from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBadge } from "../../components/StatusBadge";
import { HamburgerMenu } from "../../components/HamburgerMenu";
import { useHA } from "../../lib/ha-context";
import { useEntity } from "../../lib/useEntity";
import { useMediaPlayer } from "../../lib/useMediaPlayer";
import HomeMap3D, { DEVICE_MARKERS } from "../../components/home/HomeMap3D";
import { getBridgeUrl } from "../../lib/bridge-api";
import { useGlasses } from "../../lib/glasses-context";
import { BLEPairingModal } from "../../components/home/BLEPairingModal";

// ── Design System ──
const C = {
  bg: "#000000",
  text: "#FFFFFF",
  textSec: "rgba(255,255,255,0.55)",
  textDim: "rgba(255,255,255,0.3)",
  climate: "#4FC3F7",
};

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ── Now Playing Mini Bar ──
function NowPlayingBar() {
  const { state } = useMediaPlayer();
  if (!state.available || !state.isPlaying) return null;

  return (
    <View
      style={{
        position: "absolute",
        bottom: 52,
        left: 12,
        right: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: "rgba(29,185,84,0.15)",
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "rgba(29,185,84,0.25)",
      }}
    >
      <Text style={{ fontSize: 12 }}>{"\uD83C\uDFB5"}</Text>
      <Text numberOfLines={1} style={{ flex: 1, color: "#1DB954", fontSize: 11, fontWeight: "600" }}>
        {state.trackName}
      </Text>
      <Text numberOfLines={1} style={{ color: "rgba(255,255,255,0.3)", fontSize: 10 }}>
        {state.artist}
      </Text>
    </View>
  );
}

// ── Home Screen ──
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { entities, callService } = useHA();
  const { lastGestureAction } = useGlasses();
  const acEntity = useEntity("climate.living_room_ac");
  const [pairingVisible, setPairingVisible] = useState(false);

  // Count active devices
  const activeDeviceCount = useMemo(() => {
    let count = 0;
    for (const marker of DEVICE_MARKERS) {
      const e = entities[marker.entityId];
      if (e && ["on", "playing", "cleaning", "cool", "heat", "auto"].includes(e.state)) count++;
    }
    return count;
  }, [entities]);

  const currentTemp = acEntity?.attributes?.current_temperature
    ? Math.round(acEntity.attributes.current_temperature)
    : null;

  // Build device states map for the 3D scene
  const deviceStates = useMemo(() => {
    const states: Record<string, { state: string; attributes?: any }> = {};
    for (const marker of DEVICE_MARKERS) {
      const e = entities[marker.entityId];
      if (e) states[marker.entityId] = { state: e.state, attributes: e.attributes };
    }
    return states;
  }, [entities]);

  // Handle device toggle from popup
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

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Fullscreen 3D Map */}
      <HomeMap3D
        deviceStates={deviceStates}
        onDeviceToggle={handleDeviceToggle}
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
          // Gradient-like fade from top
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
            <StatusBadge />
          </View>
        </View>
      </View>

      {/* Now Playing mini bar */}
      <NowPlayingBar />

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
