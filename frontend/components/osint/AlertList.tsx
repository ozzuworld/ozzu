import { useState } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { markOsintAlertRead, markAllOsintAlertsRead, type OsintAlert } from "../../lib/bridge-api";
import { SEVERITY_EMOJI, SEVERITY_COLORS, ALERT_TYPE_EMOJI, ALERT_TYPE_LABELS } from "../../lib/osint-constants";

interface Props {
  alerts: OsintAlert[];
  onRefresh: () => void;
  onClose: () => void;
}

export function AlertList({ alerts, onRefresh, onClose }: Props) {
  const [markingAll, setMarkingAll] = useState(false);

  const handleMarkAll = async () => {
    setMarkingAll(true);
    try {
      await markAllOsintAlertsRead();
      onRefresh();
    } catch (_) {}
    setMarkingAll(false);
  };

  const handleMarkRead = async (id: number) => {
    try {
      await markOsintAlertRead(id);
      onRefresh();
    } catch (_) {}
  };

  const unread = alerts.filter((a) => !a.is_read);

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#333",
        marginBottom: 8,
      }}>
        <Text style={{ color: "#FFF", fontFamily: "monospace", fontSize: 14, fontWeight: "700" }}>
          ALERTS ({unread.length} unread)
        </Text>
        <View style={{ flexDirection: "row", gap: 12 }}>
          {unread.length > 0 && (
            <Pressable onPress={handleMarkAll} disabled={markingAll}>
              <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 11 }}>
                {markingAll ? "..." : "MARK ALL READ"}
              </Text>
            </Pressable>
          )}
          <Pressable onPress={onClose}>
            <Text style={{ color: "#666", fontFamily: "monospace", fontSize: 11 }}>CLOSE</Text>
          </Pressable>
        </View>
      </View>

      {/* Alert items */}
      <ScrollView style={{ flex: 1 }}>
        {alerts.length === 0 ? (
          <Text style={{ color: "#666", fontFamily: "monospace", fontSize: 12, textAlign: "center", marginTop: 20 }}>
            No alerts yet
          </Text>
        ) : (
          alerts.map((alert) => {
            const emoji = ALERT_TYPE_EMOJI[alert.alert_type] || SEVERITY_EMOJI[alert.severity] || "🔔";
            const label = ALERT_TYPE_LABELS[alert.alert_type] || alert.alert_type.toUpperCase();
            const borderColor = alert.is_read ? "#222" : (SEVERITY_COLORS[alert.severity] || "#333");
            const timeAgo = getTimeAgo(alert.created_at);

            return (
              <Pressable
                key={alert.id}
                onPress={() => !alert.is_read && handleMarkRead(alert.id)}
              >
                <View style={{
                  backgroundColor: alert.is_read ? "#111" : "#1A1A1A",
                  borderWidth: 1,
                  borderColor,
                  borderRadius: 6,
                  padding: 8,
                  marginBottom: 6,
                  opacity: alert.is_read ? 0.6 : 1,
                }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={{ fontSize: 14 }}>{emoji}</Text>
                    <Text style={{
                      color: SEVERITY_COLORS[alert.severity] || "#AAA",
                      fontFamily: "monospace",
                      fontSize: 10,
                      fontWeight: "700",
                    }}>
                      {label}
                    </Text>
                    <Text style={{ color: "#555", fontFamily: "monospace", fontSize: 10, marginLeft: "auto" }}>
                      {timeAgo}
                    </Text>
                  </View>
                  <Text style={{
                    color: "#DDD",
                    fontFamily: "monospace",
                    fontSize: 11,
                    marginTop: 4,
                  }} numberOfLines={2}>
                    {alert.title}
                  </Text>
                  {alert.profile_label && (
                    <Text style={{ color: "#555", fontFamily: "monospace", fontSize: 10, marginTop: 2 }}>
                      {alert.profile_label}
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
