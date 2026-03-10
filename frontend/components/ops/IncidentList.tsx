import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import type { OpsIncident } from "../../lib/ops-hooks";

const STATUS_COLORS: Record<string, string> = {
  healthy: "#22C55E",
  degraded: "#EAB308",
  down: "#EF4444",
  unknown: "#525252",
  idle: "#EAB308",
};

interface Props {
  incidents: OpsIncident[];
  loading: boolean;
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function IncidentList({ incidents, loading }: Props) {
  if (loading) {
    return (
      <View style={{ padding: 20, alignItems: "center" }}>
        <ActivityIndicator color="#525252" size="small" />
      </View>
    );
  }

  if (incidents.length === 0) {
    return (
      <View style={{ padding: 16, alignItems: "center" }}>
        <Text style={{ fontFamily: "monospace", fontSize: 11, color: "#525252" }}>
          No recent incidents
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text
        style={{
          fontFamily: "monospace",
          fontWeight: "700",
          fontSize: 10,
          color: "#525252",
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        RECENT INCIDENTS
      </Text>
      <ScrollView
        style={{ maxHeight: 220 }}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        {incidents.map((inc, i) => {
          const toColor = STATUS_COLORS[inc.toStatus] || "#525252";
          const isRecovery = inc.toStatus === "healthy";
          return (
            <View
              key={`${inc.service}-${inc.ts}-${i}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingVertical: 5,
                borderBottomWidth: i < incidents.length - 1 ? 1 : 0,
                borderBottomColor: "rgba(255,255,255,0.04)",
              }}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toColor }} />
              <Text
                style={{
                  fontFamily: "monospace",
                  fontWeight: "600",
                  fontSize: 10,
                  color: isRecovery ? "#22C55E" : "#E2E8F0",
                  width: 100,
                }}
                numberOfLines={1}
              >
                {inc.service.toUpperCase()}
              </Text>
              <Text style={{ fontFamily: "monospace", fontSize: 10, color: "#64748B", flex: 1 }}>
                {inc.fromStatus} → {inc.toStatus}
              </Text>
              <Text style={{ fontFamily: "monospace", fontSize: 9, color: "#525252" }}>
                {formatTs(inc.ts)}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
