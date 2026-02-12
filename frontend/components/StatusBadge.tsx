import { useState, useEffect } from "react";
import { View, Text } from "react-native";
import { useHA } from "../lib/ha-context";

const statusConfig: Record<string, { dot: string }> = {
  connected: { dot: "#22C55E" },
  connecting: { dot: "#EAB308" },
  disconnected: { dot: "#737373" },
  error: { dot: "#EF4444" },
};

function getTimeString() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function StatusBadge() {
  const { status } = useHA();
  const cfg = statusConfig[status] ?? statusConfig.disconnected;
  const [time, setTime] = useState(getTimeString);

  useEffect(() => {
    const interval = setInterval(() => setTime(getTimeString()), 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
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
      <Text
        style={{
          color: "#525252",
          fontSize: 11,
          fontWeight: "bold",
          fontFamily: "monospace",
        }}
      >
        {time}
      </Text>
    </View>
  );
}
