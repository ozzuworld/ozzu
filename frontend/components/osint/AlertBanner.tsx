import { View, Text, Pressable } from "react-native";
import { SEVERITY_EMOJI, ALERT_TYPE_EMOJI, SEVERITY_COLORS } from "../../lib/osint-constants";
import type { OsintAlert } from "../../lib/bridge-api";

interface Props {
  alerts: OsintAlert[];
  unreadCount: number;
  onPress: () => void;
}

export function AlertBanner({ alerts, unreadCount, onPress }: Props) {
  if (unreadCount === 0) return null;

  // Find highest severity unread alert + count by severity
  const unread = alerts.filter((a) => !a.is_read);
  const severityOrder = ["critical", "high", "medium", "low", "info"];
  let highestSeverity = "info";
  const sevCounts: Record<string, number> = {};
  for (const a of unread) {
    sevCounts[a.severity] = (sevCounts[a.severity] || 0) + 1;
    if (severityOrder.indexOf(a.severity) < severityOrder.indexOf(highestSeverity)) {
      highestSeverity = a.severity;
    }
  }
  const sevEmojis: Record<string, string> = { critical: "\uD83D\uDD34", high: "\uD83D\uDFE0", medium: "\uD83D\uDFE1", low: "\uD83D\uDD35", info: "\u26AA" };
  const breakdownParts = severityOrder
    .filter((s) => sevCounts[s])
    .map((s) => `${sevEmojis[s] || ""} ${sevCounts[s]} ${s}`);

  const bgColor = highestSeverity === "critical" ? "#7F1D1D" :
    highestSeverity === "high" ? "#7C2D12" :
    highestSeverity === "medium" ? "#713F12" : "#1E1E1E";
  const borderColor = SEVERITY_COLORS[highestSeverity] || "#333";
  const emoji = SEVERITY_EMOJI[highestSeverity] || "🔔";

  // Latest alert title
  const latest = unread[0];
  const alertEmoji = latest ? (ALERT_TYPE_EMOJI[latest.alert_type] || emoji) : emoji;

  return (
    <Pressable onPress={onPress}>
      <View style={{
        backgroundColor: bgColor,
        borderWidth: 1,
        borderColor,
        borderRadius: 8,
        padding: 10,
        marginBottom: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}>
        <Text style={{ fontSize: 18 }}>{alertEmoji}</Text>
        <View style={{ flex: 1 }}>
          <Text style={{
            color: "#FFF",
            fontFamily: "monospace",
            fontSize: 12,
            fontWeight: "700",
          }}>
            {unreadCount} ALERT{unreadCount > 1 ? "S" : ""}{breakdownParts.length > 0 ? ` | ${breakdownParts.join("  ")}` : ""}
          </Text>
          {latest && (
            <Text style={{
              color: "#AAA",
              fontFamily: "monospace",
              fontSize: 11,
              marginTop: 2,
            }} numberOfLines={1}>
              {latest.title}
            </Text>
          )}
        </View>
        <Text style={{ color: "#666", fontFamily: "monospace", fontSize: 11 }}>TAP</Text>
      </View>
    </Pressable>
  );
}
