import { useState, useMemo } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { markOsintAlertRead, markAllOsintAlertsRead, type OsintAlert } from "../../lib/bridge-api";
import { SEVERITY_EMOJI, SEVERITY_COLORS, ALERT_TYPE_EMOJI, ALERT_TYPE_LABELS } from "../../lib/osint-constants";

interface Props {
  alerts: OsintAlert[];
  onRefresh: () => void;
  onClose: () => void;
}

interface GroupedAlert {
  key: string;
  representative: OsintAlert;
  count: number;
  allIds: number[];
  hasUnread: boolean;
}

export function AlertList({ alerts, onRefresh, onClose }: Props) {
  const [markingAll, setMarkingAll] = useState(false);
  const [showOlder, setShowOlder] = useState(false);

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
  const readAlerts = alerts.filter((a) => a.is_read);

  // Group alerts by finding_id (same finding = 1 row with count badge)
  const groupedUnread = useMemo(() => {
    const groups = new Map<string, GroupedAlert>();
    // Sort unread: severity order first
    const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const sorted = [...unread].sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));

    for (const alert of sorted) {
      const key = alert.finding_id ? `finding_${alert.finding_id}` : `alert_${alert.id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        existing.allIds.push(alert.id);
      } else {
        groups.set(key, {
          key,
          representative: alert,
          count: 1,
          allIds: [alert.id],
          hasUnread: true,
        });
      }
    }
    return Array.from(groups.values());
  }, [unread]);

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
          <>
            {/* Unread — grouped by finding_id */}
            {groupedUnread.map((group) => {
              const alert = group.representative;
              const emoji = ALERT_TYPE_EMOJI[alert.alert_type] || SEVERITY_EMOJI[alert.severity] || "\uD83D\uDD14";
              const label = ALERT_TYPE_LABELS[alert.alert_type] || alert.alert_type.toUpperCase();
              const borderColor = SEVERITY_COLORS[alert.severity] || "#333";
              const timeAgo = getTimeAgo(alert.created_at);

              return (
                <Pressable
                  key={group.key}
                  onPress={() => handleMarkRead(alert.id)}
                >
                  <View style={{
                    backgroundColor: "#1A1A1A",
                    borderWidth: 1,
                    borderColor,
                    borderRadius: 6,
                    padding: 8,
                    marginBottom: 6,
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
                      {group.count > 1 && (
                        <View style={{
                          backgroundColor: SEVERITY_COLORS[alert.severity] || "#444",
                          borderRadius: 8,
                          paddingHorizontal: 5,
                          paddingVertical: 1,
                        }}>
                          <Text style={{ color: "#FFF", fontFamily: "monospace", fontSize: 9, fontWeight: "bold" }}>
                            {"\u00D7"}{group.count}
                          </Text>
                        </View>
                      )}
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
            })}

            {/* Read alerts — collapsed section */}
            {readAlerts.length > 0 && (
              <>
                <Pressable onPress={() => setShowOlder(!showOlder)}>
                  <View style={{
                    backgroundColor: "#111",
                    borderWidth: 1,
                    borderColor: "#222",
                    borderRadius: 6,
                    padding: 8,
                    marginTop: 4,
                    marginBottom: 6,
                    alignItems: "center",
                  }}>
                    <Text style={{ color: "#555", fontFamily: "monospace", fontSize: 11 }}>
                      {showOlder ? "\u25B2 HIDE" : "\u25BC"} {readAlerts.length} older alert{readAlerts.length !== 1 ? "s" : ""}
                    </Text>
                  </View>
                </Pressable>
                {showOlder && readAlerts.map((alert) => {
                  const emoji = ALERT_TYPE_EMOJI[alert.alert_type] || SEVERITY_EMOJI[alert.severity] || "\uD83D\uDD14";
                  const label = ALERT_TYPE_LABELS[alert.alert_type] || alert.alert_type.toUpperCase();
                  const timeAgo = getTimeAgo(alert.created_at);
                  return (
                    <View key={alert.id} style={{
                      backgroundColor: "#111",
                      borderWidth: 1,
                      borderColor: "#222",
                      borderRadius: 6,
                      padding: 8,
                      marginBottom: 4,
                      opacity: 0.6,
                    }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={{ fontSize: 12 }}>{emoji}</Text>
                        <Text style={{ color: "#555", fontFamily: "monospace", fontSize: 10, fontWeight: "700" }}>
                          {label}
                        </Text>
                        <Text style={{ color: "#444", fontFamily: "monospace", fontSize: 10, marginLeft: "auto" }}>
                          {timeAgo}
                        </Text>
                      </View>
                      <Text style={{ color: "#777", fontFamily: "monospace", fontSize: 11, marginTop: 3 }} numberOfLines={1}>
                        {alert.title}
                      </Text>
                    </View>
                  );
                })}
              </>
            )}
          </>
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
