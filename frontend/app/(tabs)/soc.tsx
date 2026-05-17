import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  StyleSheet,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import HamburgerMenu from "../../components/HamburgerMenu";
import { GroupNav } from "../../components/GroupNav";
import { getBridgeUrl } from "../../lib/bridge-api";
import { colors, spacing, radius, fontSize as fs, fontWeight as fw, withAlpha, layout } from "../../lib/design-tokens";

type Engagement = {
  id: string;
  client_name: string;
  engagement_type: string;
  status: string;
  findings_count: number;
  critical_count: number;
  high_count: number;
  created_at: string;
};

export default function SOCScreen() {
  const router = useRouter();
  const { insets, isPhone } = usePhoneLayout();

  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchEngagements = useCallback(async () => {
    try {
      const response = await fetch(`${getBridgeUrl()}/soc/engagements`);
      const data = await response.json();
      setEngagements(data.engagements || []);
    } catch (error) {
      console.error("Error fetching engagements:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEngagements();
  }, [fetchEngagements]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchEngagements();
    setRefreshing(false);
  }, [fetchEngagements]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "scoping": return colors.status.pending;
      case "approved": return colors.status.approved;
      case "in_progress": return colors.status.working;
      case "reporting": return colors.accent.blue;
      case "completed": return colors.status.success;
      default: return colors.text.disabled;
    }
  };

  const statusEmoji: Record<string, string> = {
    scoping: "📋",
    approved: "✅",
    in_progress: "🔍",
    reporting: "📝",
    completed: "✓",
    billed: "💰",
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.primary, paddingTop: insets.top }}>
      <StatusBar style="light" />

      {/* Top Bar */}
      <View
        style={{
          height: layout.topBarHeight,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: spacing.md,
          backgroundColor: colors.bg.secondary,
          borderBottomWidth: 1,
          borderBottomColor: colors.border.subtle,
        }}
      >
        <HamburgerMenu />
        <Text
          style={{
            fontSize: fs.lg,
            fontWeight: fw.semibold,
            color: colors.text.primary,
            marginLeft: spacing.md,
          }}
        >
          🔐 SOC Engagements
        </Text>
      </View>

      <GroupNav group="work" />

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.md }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.disabled} />
        }
      >
        {loading ? (
          <Text style={{ color: colors.text.disabled, textAlign: "center", marginTop: spacing.xl }}>
            Loading engagements...
          </Text>
        ) : engagements.length === 0 ? (
          <View style={{ alignItems: "center", marginTop: spacing.xl * 2 }}>
            <Text style={{ fontSize: 48, marginBottom: spacing.md }}>🔐</Text>
            <Text style={{ color: colors.text.tertiary, fontSize: fs.md, textAlign: "center" }}>
              No engagements yet
            </Text>
            <Text style={{ color: colors.text.disabled, fontSize: fs.sm, textAlign: "center", marginTop: spacing.xs }}>
              Create one via Cipher MCP tools
            </Text>
          </View>
        ) : (
          <View style={{ gap: spacing.md }}>
            {engagements.map((eng) => (
              <Pressable
                key={eng.id}
                onPress={() => router.push(`/soc/${eng.id}`)}
                style={({ pressed }) => [
                  styles.engagementCard,
                  pressed && { opacity: 0.9, transform: [{ scale: 0.99 }] },
                ]}
              >
                {/* Status accent bar */}
                <View
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 4,
                    backgroundColor: getStatusColor(eng.status),
                    borderTopLeftRadius: radius.md,
                    borderBottomLeftRadius: radius.md,
                  }}
                />

                {/* Content */}
                <View style={{ paddingLeft: spacing.md }}>
                  {/* Header */}
                  <View style={{ flexDirection: "row", alignItems: "center", marginBottom: spacing.xs }}>
                    <Text style={{ fontSize: 18, marginRight: spacing.xs }}>
                      {statusEmoji[eng.status] || "🔒"}
                    </Text>
                    <Text style={{ fontSize: fs.md, fontWeight: fw.semibold, color: colors.text.primary, flex: 1 }}>
                      {eng.id}
                    </Text>
                  </View>

                  {/* Client */}
                  <Text style={{ fontSize: fs.sm, color: colors.text.secondary, marginBottom: spacing.sm }}>
                    {eng.client_name} • {eng.engagement_type}
                  </Text>

                  {/* Findings summary */}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <View
                      style={{
                        paddingHorizontal: spacing.sm,
                        paddingVertical: 4,
                        backgroundColor: withAlpha(getStatusColor(eng.status), 0.15),
                        borderRadius: radius.sm,
                      }}
                    >
                      <Text style={{ fontSize: fs.xs, color: getStatusColor(eng.status), fontWeight: fw.medium }}>
                        {eng.status.toUpperCase().replace("_", " ")}
                      </Text>
                    </View>

                    {eng.findings_count > 0 && (
                      <View style={{ flexDirection: "row", gap: spacing.xs }}>
                        {eng.critical_count > 0 && (
                          <View style={[styles.findingBadge, { backgroundColor: withAlpha(colors.status.error, 0.15) }]}>
                            <Text style={[styles.findingBadgeText, { color: colors.status.error }]}>
                              {eng.critical_count} CRITICAL
                            </Text>
                          </View>
                        )}
                        {eng.high_count > 0 && (
                          <View style={[styles.findingBadge, { backgroundColor: withAlpha(colors.accent.orange, 0.15) }]}>
                            <Text style={[styles.findingBadgeText, { color: colors.accent.orange }]}>
                              {eng.high_count} HIGH
                            </Text>
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  engagementCard: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    position: "relative",
  },
  findingBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
  },
  findingBadgeText: {
    fontSize: fs.xs,
    fontWeight: fw.medium,
  },
});
