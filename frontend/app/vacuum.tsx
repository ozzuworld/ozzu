import { useState } from "react";
import { View, Text, ScrollView, Image, Pressable } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { useVacuum } from "../lib/useVacuum";

const ACCENT = "#06B6D4";
const TOP_BAR_HEIGHT = 48;

const STATE_COLORS: Record<string, string> = {
  cleaning: "#22C55E",
  returning: "#EAB308",
  docked: "#525252",
  idle: "#525252",
  paused: "#F97316",
  error: "#EF4444",
};

const STATE_EMOJI: Record<string, string> = {
  cleaning: "🧹",
  returning: "🏠",
  docked: "🔌",
  idle: "💤",
  paused: "⏸",
  error: "⚠️",
};

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <View style={{ flex: 1, height: 6, backgroundColor: "#333", borderRadius: 3 }}>
      <View
        style={{
          width: `${Math.min(100, Math.max(0, value))}%`,
          height: 6,
          backgroundColor: color,
          borderRadius: 3,
        }}
      />
    </View>
  );
}

function MaintenanceBar({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const color = value > 50 ? "#22C55E" : value > 20 ? "#EAB308" : "#EF4444";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 10, width: 80 }}>
        {label}
      </Text>
      <ProgressBar value={value} color={color} />
      <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, width: 32, textAlign: "right" }}>
        {value}%
      </Text>
    </View>
  );
}

export default function VacuumScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();
  const { state, controls } = useVacuum();
  const [selectedRooms, setSelectedRooms] = useState<number[]>([]);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  const stateColor = STATE_COLORS[state.state] ?? "#525252";
  const stateEmoji = STATE_EMOJI[state.state] ?? "🤖";
  const roomEntries = Object.entries(state.rooms);

  const toggleRoom = (id: number) => {
    setSelectedRooms((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]
    );
  };

  const handleCleanSelected = () => {
    if (selectedRooms.length > 0) {
      controls.cleanRooms(selectedRooms);
      setSelectedRooms([]);
    }
  };

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
          borderBottomWidth: 1,
          borderBottomColor: "#222",
        }}
      >
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
            {"◀ BACK"}
          </Text>
        </Pressable>
        <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 2 }}>
          DUSK VADER
        </Text>
        {state.battery !== null && (
          <Text
            style={{
              color: state.battery < 20 ? "#EF4444" : "#A3A3A3",
              fontFamily: "monospace",
              fontSize: 12,
              fontWeight: "bold",
            }}
          >
            🔋 {state.battery}%
          </Text>
        )}
        {state.battery === null && <View style={{ width: 60 }} />}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
        showsVerticalScrollIndicator={false}
      >
        {/* Live Map */}
        {state.mapUrl && (
          <View style={{ backgroundColor: "#0A0A0A", marginHorizontal: 16, marginTop: 12, borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: "#2A2A2A" }}>
            <Image
              source={{ uri: state.mapUrl }}
              style={{ width: "100%", height: 300 }}
              resizeMode="contain"
            />
          </View>
        )}

        {/* Status Row */}
        <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Text style={{ color: stateColor, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
              {stateEmoji} {state.status.toUpperCase()}
            </Text>
            {state.currentRoom && state.currentRoom !== "unknown" && (
              <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 10 }}>
                · 🏠 {state.currentRoom}
              </Text>
            )}
          </View>
          {(state.isCleaning || state.isPaused) && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <ProgressBar value={state.progress} color="#22C55E" />
              <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10 }}>
                {state.progress}%
              </Text>
              {state.area && (
                <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10 }}>
                  {state.area} m²
                </Text>
              )}
              {state.cleaningTime && (
                <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10 }}>
                  {state.cleaningTime}
                </Text>
              )}
            </View>
          )}
        </View>

        {/* Room Pills */}
        {roomEntries.length > 0 && (
          <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
            <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 11, fontWeight: "bold", letterSpacing: 2, marginBottom: 8 }}>
              ROOMS
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {roomEntries.map(([id, room]) => {
                const numId = parseInt(id, 10);
                const isSelected = selectedRooms.includes(numId);
                return (
                  <Pressable
                    key={id}
                    onPress={() => toggleRoom(numId)}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 16,
                      borderWidth: 1,
                      borderColor: isSelected ? ACCENT : "#333",
                      backgroundColor: isSelected ? "rgba(6,182,212,0.15)" : "#1A1A1A",
                    }}
                  >
                    <Text
                      style={{
                        color: isSelected ? ACCENT : "#A3A3A3",
                        fontFamily: "monospace",
                        fontSize: 11,
                        fontWeight: isSelected ? "bold" : "normal",
                      }}
                    >
                      {room.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {selectedRooms.length > 0 && (
              <Pressable
                onPress={handleCleanSelected}
                style={({ pressed }) => ({
                  marginTop: 10,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: pressed ? "rgba(6,182,212,0.3)" : "rgba(6,182,212,0.15)",
                  borderWidth: 1,
                  borderColor: ACCENT,
                  alignItems: "center",
                })}
              >
                <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                  🧹 CLEAN {selectedRooms.length} ROOM{selectedRooms.length > 1 ? "S" : ""}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Control Buttons */}
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, marginTop: 16 }}>
          {(state.isDocked || state.isPaused) && (
            <Pressable
              onPress={controls.start}
              style={({ pressed }) => ({
                flex: 1,
                paddingVertical: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: "#22C55E",
                backgroundColor: pressed ? "rgba(34,197,94,0.2)" : "rgba(34,197,94,0.1)",
                alignItems: "center",
              })}
            >
              <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                {state.isPaused ? "▶ RESUME" : "▶ START"}
              </Text>
            </Pressable>
          )}
          {state.isCleaning && (
            <Pressable
              onPress={controls.pause}
              style={({ pressed }) => ({
                flex: 1,
                paddingVertical: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: "#F97316",
                backgroundColor: pressed ? "rgba(249,115,22,0.2)" : "rgba(249,115,22,0.1)",
                alignItems: "center",
              })}
            >
              <Text style={{ color: "#F97316", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                ⏸ PAUSE
              </Text>
            </Pressable>
          )}
          {(state.isCleaning || state.isPaused) && (
            <Pressable
              onPress={controls.dock}
              style={({ pressed }) => ({
                flex: 1,
                paddingVertical: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: ACCENT,
                backgroundColor: pressed ? "rgba(6,182,212,0.2)" : "rgba(6,182,212,0.1)",
                alignItems: "center",
              })}
            >
              <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                🏠 DOCK
              </Text>
            </Pressable>
          )}
          {state.isReturning && (
            <View style={{ flex: 1, paddingVertical: 10, alignItems: "center" }}>
              <Text style={{ color: "#EAB308", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                Returning to dock...
              </Text>
            </View>
          )}
        </View>

        {/* Suction & Mode */}
        {(state.suctionOptions.length > 0 || state.modeOptions.length > 0) && (
          <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
            {state.suctionOptions.length > 0 && (
              <View style={{ marginBottom: 12 }}>
                <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 11, fontWeight: "bold", letterSpacing: 2, marginBottom: 8 }}>
                  SUCTION
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {state.suctionOptions.map((opt) => {
                    const isActive = opt === state.suctionLevel;
                    return (
                      <Pressable
                        key={opt}
                        onPress={() => controls.setSuction(opt)}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 6,
                          borderRadius: 16,
                          borderWidth: 1,
                          borderColor: isActive ? ACCENT : "#333",
                          backgroundColor: isActive ? "rgba(6,182,212,0.15)" : "#1A1A1A",
                        }}
                      >
                        <Text
                          style={{
                            color: isActive ? ACCENT : "#A3A3A3",
                            fontFamily: "monospace",
                            fontSize: 11,
                            fontWeight: isActive ? "bold" : "normal",
                          }}
                        >
                          {opt}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            {state.modeOptions.length > 0 && (
              <View>
                <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 11, fontWeight: "bold", letterSpacing: 2, marginBottom: 8 }}>
                  MODE
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {state.modeOptions.map((opt) => {
                    const isActive = opt === state.cleaningMode;
                    return (
                      <Pressable
                        key={opt}
                        onPress={() => controls.setMode(opt)}
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 6,
                          borderRadius: 16,
                          borderWidth: 1,
                          borderColor: isActive ? ACCENT : "#333",
                          backgroundColor: isActive ? "rgba(6,182,212,0.15)" : "#1A1A1A",
                        }}
                      >
                        <Text
                          style={{
                            color: isActive ? ACCENT : "#A3A3A3",
                            fontFamily: "monospace",
                            fontSize: 11,
                            fontWeight: isActive ? "bold" : "normal",
                          }}
                        >
                          {opt}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}
          </View>
        )}

        {/* Maintenance */}
        <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
          <Pressable
            onPress={() => setMaintenanceOpen((o) => !o)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: maintenanceOpen ? 10 : 0 }}
          >
            <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 11, fontWeight: "bold", letterSpacing: 2 }}>
              {maintenanceOpen ? "▼" : "▶"} MAINTENANCE
            </Text>
          </Pressable>
          {maintenanceOpen && (
            <View>
              <MaintenanceBar label="Main Brush" value={state.mainBrushLeft} />
              <MaintenanceBar label="Side Brush" value={state.sideBrushLeft} />
              <MaintenanceBar label="Filter" value={state.filterLeft} />
              <MaintenanceBar label="Sensor" value={state.sensorDirtyLeft} />
            </View>
          )}
        </View>
      </ScrollView>

      <StatusBar style="light" />
    </View>
  );
}
