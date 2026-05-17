import { View, Text, Pressable } from "react-native";
import { useVacuum } from "../../../lib/useVacuum";

const ACCENT = "#06B6D4";

function stateEmoji(state: string): string {
  switch (state) {
    case "cleaning": return "\uD83E\uDDF9";
    case "returning": return "\uD83C\uDFE0";
    case "docked":
    case "idle": return "\uD83D\uDD0C";
    case "paused": return "\u23F8\uFE0F";
    case "error": return "\u26A0\uFE0F";
    default: return "\uD83E\uDD16";
  }
}

function stateColor(state: string): string {
  switch (state) {
    case "cleaning": return "#22C55E";
    case "returning": return "#EAB308";
    case "paused": return "#F97316";
    case "error": return "#EF4444";
    default: return "#525252";
  }
}

interface VacuumSheetProps {
  onDismiss?: () => void;
}

export function VacuumSheet({ onDismiss }: VacuumSheetProps) {
  const { state, controls } = useVacuum();

  return (
    <View style={{ gap: 12 }}>
      {/* Status row */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ fontSize: 24 }}>{stateEmoji(state.state)}</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ color: stateColor(state.state), fontFamily: "monospace", fontSize: 14, fontWeight: "bold" }}>
            {state.status.toUpperCase()}
          </Text>
          {state.currentRoom && (
            <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 11, marginTop: 2 }}>
              {state.currentRoom}
            </Text>
          )}
        </View>
        {state.battery !== null && (
          <Text style={{ color: state.battery < 20 ? "#EF4444" : "#A3A3A3", fontFamily: "monospace", fontSize: 12 }}>
            {"\uD83D\uDD0B"} {state.battery}%
          </Text>
        )}
      </View>

      {/* Progress bar (when cleaning) */}
      {state.isCleaning && state.progress > 0 && (
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

      {/* Quick controls */}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(state.isDocked || state.isPaused) && (
          <Pressable
            onPress={controls.start}
            style={({ pressed }) => ({
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              backgroundColor: pressed ? "rgba(34,197,94,0.3)" : "rgba(34,197,94,0.15)",
              borderWidth: 1,
              borderColor: "#22C55E",
              alignItems: "center",
            })}
          >
            <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
              {state.isPaused ? "\u25B6 RESUME" : "\u25B6 START"}
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
              backgroundColor: pressed ? "rgba(249,115,22,0.3)" : "rgba(249,115,22,0.15)",
              borderWidth: 1,
              borderColor: "#F97316",
              alignItems: "center",
            })}
          >
            <Text style={{ color: "#F97316", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
              {"\u23F8"} PAUSE
            </Text>
          </Pressable>
        )}
        {!state.isDocked && (
          <Pressable
            onPress={controls.dock}
            style={({ pressed }) => ({
              flex: 1,
              paddingVertical: 10,
              borderRadius: 8,
              backgroundColor: pressed ? "rgba(82,82,82,0.3)" : "rgba(82,82,82,0.15)",
              borderWidth: 1,
              borderColor: "#525252",
              alignItems: "center",
            })}
          >
            <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
              {"\uD83C\uDFE0"} DOCK
            </Text>
          </Pressable>
        )}
      </View>

    </View>
  );
}
