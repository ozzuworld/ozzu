import { View, Text, ActivityIndicator } from "react-native";
import type { TimelineEvent } from "../../lib/bridge-api";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#DC2626",
  high: "#F97316",
  medium: "#EAB308",
  low: "#22C55E",
  info: "#6B7280",
};

const EVENT_TYPE_CONFIG: Record<string, { emoji: string; color: string }> = {
  scan: { emoji: "🔄", color: "#06B6D4" },
  finding: { emoji: "🔍", color: "#F59E0B" },
  alert: { emoji: "🔔", color: "#EF4444" },
};

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

interface Props {
  events: TimelineEvent[];
  loading: boolean;
}

export function Timeline({ events, loading }: Props) {
  if (loading) {
    return (
      <View style={{ padding: 40, alignItems: "center" }}>
        <ActivityIndicator color="#06B6D4" />
        <Text style={{ color: "#737373", fontSize: 11, fontFamily: "monospace", marginTop: 8 }}>Loading timeline...</Text>
      </View>
    );
  }

  if (events.length === 0) {
    return (
      <View style={{ padding: 40, alignItems: "center" }}>
        <Text style={{ fontSize: 32, marginBottom: 8 }}>⏱</Text>
        <Text style={{ color: "#737373", fontSize: 12, fontFamily: "monospace", textAlign: "center" }}>
          No activity yet. Run a scan to see events here.
        </Text>
      </View>
    );
  }

  // Group events by date
  const grouped: { date: string; events: TimelineEvent[] }[] = [];
  let currentDate = "";
  for (const event of events) {
    const date = formatDate(event.timestamp);
    if (date !== currentDate) {
      currentDate = date;
      grouped.push({ date, events: [] });
    }
    grouped[grouped.length - 1].events.push(event);
  }

  return (
    <View style={{ gap: 12 }}>
      {grouped.map((group, gi) => (
        <View key={gi} style={{ gap: 4 }}>
          {/* Date header */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: "#222" }} />
            <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
              {group.date}
            </Text>
            <View style={{ flex: 1, height: 1, backgroundColor: "#222" }} />
          </View>

          {/* Events */}
          {group.events.map((event, ei) => {
            const typeConfig = EVENT_TYPE_CONFIG[event.type] || { emoji: "•", color: "#6B7280" };
            const severityColor = SEVERITY_COLORS[event.severity] || "#6B7280";

            return (
              <View key={ei} style={{ flexDirection: "row", gap: 10, paddingVertical: 6 }}>
                {/* Timeline line */}
                <View style={{ width: 24, alignItems: "center" }}>
                  <Text style={{ fontSize: 12 }}>{typeConfig.emoji}</Text>
                  {ei < group.events.length - 1 && (
                    <View style={{ width: 1, flex: 1, backgroundColor: "#222", marginTop: 2 }} />
                  )}
                </View>

                {/* Content */}
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <View style={{ backgroundColor: `${severityColor}20`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                      <Text style={{ color: severityColor, fontSize: 8, fontFamily: "monospace", fontWeight: "bold" }}>
                        {event.severity.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>
                      {formatTimestamp(event.timestamp)}
                    </Text>
                  </View>
                  <Text style={{ color: "#D4D4D4", fontSize: 11, fontFamily: "monospace" }} numberOfLines={2}>
                    {event.title}
                  </Text>
                  {event.data?.module && (
                    <Text style={{ color: "#404040", fontSize: 9, fontFamily: "monospace" }}>
                      {event.data.module}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
