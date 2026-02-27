import { useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import { useEntity } from "../../lib/useEntity";
import { useHA } from "../../lib/ha-context";

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
  const entity = useEntity(entityId);
  const battery = useEntity("sensor.dusk_vader_battery_level");
  const status = useEntity("sensor.dusk_vader_status");
  const progress = useEntity("sensor.dusk_vader_cleaning_progress");
  const area = useEntity("sensor.dusk_vader_cleaned_area");
  const currentRoom = useEntity("sensor.dusk_vader_current_room");
  const { callService } = useHA();

  const vacState = entity?.state ?? "unavailable";
  const batteryPct = battery?.state ? parseInt(battery.state, 10) : null;
  const statusText = status?.state ?? vacState;
  const progressPct = progress?.state ? parseInt(progress.state, 10) : 0;
  const areaM2 = area?.state ?? null;
  const roomName = currentRoom?.state ?? null;

  const isCleaning = vacState === "cleaning";
  const isDocked = vacState === "docked" || vacState === "idle";
  const isPaused = vacState === "paused";
  const isReturning = vacState === "returning";
  const stateColor = STATE_COLORS[vacState] ?? "#525252";
  const stateEmoji = STATE_EMOJI[vacState] ?? "🤖";

  const handleStart = useCallback(() => {
    callService("vacuum", "start", {}, { entity_id: entityId });
  }, [callService, entityId]);

  const handlePause = useCallback(() => {
    callService("vacuum", "pause", {}, { entity_id: entityId });
  }, [callService, entityId]);

  const handleDock = useCallback(() => {
    callService("vacuum", "return_to_base", {}, { entity_id: entityId });
  }, [callService, entityId]);

  if (!entity) return null;

  return (
    <View style={{ marginTop: 8 }}>
      {/* Header: name + battery + status */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Text style={{ fontSize: 16 }}>🤖</Text>
        <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 13, fontWeight: "bold" }}>
          Dusk Vader
        </Text>
        {batteryPct !== null && (
          <Text style={{ color: batteryPct < 20 ? "#EF4444" : "#A3A3A3", fontFamily: "monospace", fontSize: 11 }}>
            🔋 {batteryPct}%
          </Text>
        )}
        <Text style={{ color: stateColor, fontFamily: "monospace", fontSize: 11, marginLeft: "auto" }}>
          {stateEmoji} {statusText.toUpperCase()}
        </Text>
      </View>

      {/* Cleaning info (when active) */}
      {(isCleaning || isPaused) && (
        <View style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: "row", gap: 12, marginBottom: 6 }}>
            {roomName && roomName !== "unknown" && (
              <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 10 }}>
                🏠 {roomName}
              </Text>
            )}
            {areaM2 && (
              <Text style={{ color: "#A3A3A3", fontFamily: "monospace", fontSize: 10 }}>
                📐 {areaM2} m²
              </Text>
            )}
          </View>
          {progressPct > 0 && (
            <View style={{ height: 4, backgroundColor: "#333", borderRadius: 2 }}>
              <View
                style={{
                  width: `${Math.min(100, progressPct)}%`,
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
        {(isDocked || isPaused) && (
          <Pressable
            onPress={handleStart}
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
              {isPaused ? "▶ RESUME" : "▶ START"}
            </Text>
          </Pressable>
        )}

        {/* Pause */}
        {isCleaning && (
          <Pressable
            onPress={handlePause}
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
        {(isCleaning || isPaused) && (
          <Pressable
            onPress={handleDock}
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
        {isReturning && (
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
