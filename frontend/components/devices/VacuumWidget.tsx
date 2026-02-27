import { View, Text, Pressable } from "react-native";
import { useVacuum } from "../../lib/useVacuum";

interface VacuumWidgetProps {
  entityId: string;
}

const ACCENT = "#06B6D4";

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

export function VacuumWidget({ entityId }: VacuumWidgetProps) {
  const { state, controls } = useVacuum();

  const stateColor = STATE_COLORS[state.state] ?? "#525252";
  const stateEmoji = STATE_EMOJI[state.state] ?? "🤖";

  if (state.state === "unavailable") return null;

  return (
    <View style={{ marginTop: 8 }}>
      {/* Header: name + battery + status */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Text style={{ fontSize: 16 }}>🤖</Text>
        <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 13, fontWeight: "bold" }}>
          Dusk Vader
        </Text>
        {state.battery !== null && (
          <Text style={{ color: state.battery < 20 ? "#EF4444" : "#A3A3A3", fontFamily: "monospace", fontSize: 11 }}>
            🔋 {state.battery}%
          </Text>
        )}
        <Text style={{ color: stateColor, fontFamily: "monospace", fontSize: 11, marginLeft: "auto" }}>
          {stateEmoji} {state.status.toUpperCase()}
        </Text>
      </View>

      {/* Cleaning info (when active) */}
      {(state.isCleaning || state.isPaused) && (
        <View style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: "row", gap: 12, marginBottom: 6 }}>
            {state.currentRoom && state.currentRoom !== "unknown" && (
              <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 10 }}>
                🏠 {state.currentRoom}
              </Text>
            )}
            {state.area && (
              <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 10 }}>
                📐 {state.area} m²
              </Text>
            )}
          </View>
          {state.progress > 0 && (
            <View style={{ height: 4, backgroundColor: "#333", borderRadius: 2 }}>
              <View
                style={{
                  width: `${Math.min(100, state.progress)}%`,
                  height: 4,
                  backgroundColor: "#22C55E",
                  borderRadius: 2,
                }}
              />
            </View>
          )}
        </View>
      )}

      {/* Control buttons */}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {/* Start / Resume */}
        {(state.isDocked || state.isPaused) && (
          <Pressable
            onPress={controls.start}
            style={({ pressed }) => ({
              flex: 1,
              paddingVertical: 8,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: "#22C55E",
              backgroundColor: pressed ? "rgba(34,197,94,0.2)" : "rgba(34,197,94,0.1)",
              alignItems: "center",
            })}
          >
            <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
              {state.isPaused ? "▶ RESUME" : "▶ START"}
            </Text>
          </Pressable>
        )}

        {/* Pause */}
        {state.isCleaning && (
          <Pressable
            onPress={controls.pause}
            style={({ pressed }) => ({
              flex: 1,
              paddingVertical: 8,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: "#F97316",
              backgroundColor: pressed ? "rgba(249,115,22,0.2)" : "rgba(249,115,22,0.1)",
              alignItems: "center",
            })}
          >
            <Text style={{ color: "#F97316", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
              ⏸ PAUSE
            </Text>
          </Pressable>
        )}

        {/* Dock / Return */}
        {(state.isCleaning || state.isPaused) && (
          <Pressable
            onPress={controls.dock}
            style={({ pressed }) => ({
              flex: 1,
              paddingVertical: 8,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: ACCENT,
              backgroundColor: pressed ? "rgba(6,182,212,0.2)" : "rgba(6,182,212,0.1)",
              alignItems: "center",
            })}
          >
            <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
              🏠 DOCK
            </Text>
          </Pressable>
        )}

        {/* Docked/returning state info */}
        {state.isReturning && (
          <View style={{ flex: 1, paddingVertical: 8, alignItems: "center" }}>
            <Text style={{ color: "#EAB308", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
              Returning to dock...
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
