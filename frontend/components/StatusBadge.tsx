import { View, Text } from "react-native";
import { useHA } from "../lib/ha-context";

const statusConfig: Record<string, { dot: string; label: string }> = {
  connected: { dot: "#22C55E", label: "ONLINE" },
  connecting: { dot: "#EAB308", label: "CONNECTING" },
  disconnected: { dot: "#737373", label: "OFFLINE" },
  error: { dot: "#EF4444", label: "ERROR" },
};

export function StatusBadge() {
  const { status } = useHA();
  const cfg = statusConfig[status] ?? statusConfig.disconnected;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        borderWidth: 1,
        borderColor: "#333333",
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 4,
        backgroundColor: "#1A1A1A",
        gap: 6,
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: cfg.dot,
        }}
      />
      <Text style={{ color: cfg.dot, fontSize: 11, fontWeight: "bold", letterSpacing: 1 }}>
        {cfg.label}
      </Text>
    </View>
  );
}
