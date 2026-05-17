import { View, Text, Pressable } from "react-native";
import { useState } from "react";
import type { ServiceStatus } from "../../lib/ops-hooks";
import { formatRelativeTime } from "../../lib/format";

import { colors } from "../../lib/design-tokens";
const STATUS_COLORS: Record<string, string> = {
  healthy: colors.success,
  degraded: colors.brand.amberDeep,
  down: colors.error,
  unknown: colors.gray[400],
};

const SERVICE_EMOJI: Record<string, string> = {
  postgres: "🐘",
  redis: "🔴",
  nginx: "🌐",
  openvpn: "🔒",
  qdrant: "🧠",
  homeassistant: "🏠",
  "face-recognition": "👤",
  "osint-tools": "🕵️",
  browser: "🌍",
  "vast-gpu": "⚡",
};

interface Props {
  name: string;
  status: ServiceStatus;
}

function formatLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}


export default function ServiceCard({ name, status }: Props) {
  const [expanded, setExpanded] = useState(false);
  const dotColor = STATUS_COLORS[status.status] || colors.gray[400];
  const emoji = SERVICE_EMOJI[name] || "📦";

  return (
    <Pressable
      onPress={() => setExpanded(!expanded)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)",
        borderWidth: 1,
        borderColor: status.status === "down" ? "rgba(239,68,68,0.3)" : "rgba(255,255,255,0.08)",
        borderRadius: 8,
        padding: 10,
        flex: 1,
        minWidth: 140,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <Text style={{ fontSize: 14 }}>{emoji}</Text>
        <Text
          style={{
            fontFamily: "monospace",
            fontWeight: "700",
            fontSize: 11,
            color: "#E2E8F0",
            letterSpacing: 0.5,
            flex: 1,
          }}
          numberOfLines={1}
        >
          {name.toUpperCase()}
        </Text>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontFamily: "monospace", fontSize: 10, color: colors.gray[400] }}>
          {formatLatency(status.latencyMs)}
        </Text>
        <Text style={{ fontFamily: "monospace", fontSize: 10, color: colors.gray[400] }}>
          {formatRelativeTime(status.lastCheck)}
        </Text>
      </View>
      {expanded && Object.keys(status.details).length > 0 && (
        <View style={{ marginTop: 6, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 6 }}>
          {Object.entries(status.details).map(([k, v]) => (
            <Text key={k} style={{ fontFamily: "monospace", fontSize: 9, color: "#64748B" }}>
              {k}: {String(v)}
            </Text>
          ))}
        </View>
      )}
    </Pressable>
  );
}
