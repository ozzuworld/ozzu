// SOC tab — list of pentest engagements.
// dir_1780764341980: redesigned card via EngagementCard + status filter pills.
// Lives at /soc inside the Work group.

import { useState, useCallback, useEffect, useMemo } from "react";
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
import { GroupNav } from "../../components/GroupNav";
import { TopBar } from "../../components/TopBar";
import { getBridgeUrl } from "../../lib/bridge-api";
import { useBridgeStream } from "../../lib/useBridgeStream";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../lib/design-tokens";
import { EngagementCard, type EngagementSummary } from "../../components/soc/EngagementCard";

type FilterKey = "active" | "scoping" | "done" | "all";

const FILTERS: Array<{ key: FilterKey; label: string; match: (e: EngagementSummary) => boolean }> = [
  { key: "active", label: "Active", match: (e) => e.status === "in_progress" || e.status === "approved" },
  { key: "scoping", label: "Scoping", match: (e) => e.status === "scoping" || e.status === "planning" },
  { key: "done", label: "Done", match: (e) => e.status === "completed" || e.status === "billed" || e.status === "reporting" },
  { key: "all", label: "All", match: () => true },
];

export default function SOCScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [engagements, setEngagements] = useState<EngagementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("active");

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

  // Live refresh — any SOC-side mutation refetches the list so counters stay
  // accurate without the screen needing its own poll. WS push already shipped.
  useBridgeStream("socQueueChanged", () => { fetchEngagements(); });
  useBridgeStream("socStepDone", () => { fetchEngagements(); });
  useBridgeStream("socFindingAdded", () => { fetchEngagements(); });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchEngagements();
    setRefreshing(false);
  }, [fetchEngagements]);

  const filtered = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) || FILTERS[3];
    return engagements.filter(f.match);
  }, [engagements, filter]);

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { active: 0, scoping: 0, done: 0, all: engagements.length };
    for (const e of engagements) {
      for (const f of FILTERS) {
        if (f.key !== "all" && f.match(e)) c[f.key]++;
      }
    }
    return c;
  }, [engagements]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />

      <TopBar title="🔐 SOC" background={colors.bg.elevated} borderBottom />
      <GroupNav group="work" />

      {/* Filter pills (scrollable) + Create button (always pinned/visible) */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexShrink: 1 }}
          contentContainerStyle={{ gap: spacing.xs, alignItems: "center" }}
        >
          {FILTERS.map((f) => {
            const selected = filter === f.key;
            const c = counts[f.key];
            return (
              <Pressable
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={({ pressed }) => [
                  styles.filterPill,
                  selected && styles.filterPillSelected,
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text style={{
                  color: selected ? colors.bg.base : colors.text.secondary,
                  fontSize: fs.sm,
                  fontWeight: selected ? fw.semibold : fw.medium,
                }}>
                  {f.label}
                </Text>
                <Text style={{
                  color: selected ? colors.bg.base : colors.text.tertiary,
                  fontSize: fs.xs,
                  fontFamily: "monospace",
                  marginLeft: 4,
                }}>
                  {c}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Unmissable full-width create button — its own full-width row, so it can't be
          clipped or pushed off-screen like the old inline filter-row button was. Opens
          the standalone /newsoc page (zero shared layout chrome). */}
      <Pressable
        onPress={() => router.push("/newsoc")}
        style={({ pressed }) => [styles.createWide, pressed && { opacity: 0.9 }]}
      >
        <Text style={{ color: colors.bg.base, fontSize: 16, fontWeight: "800" }}>+ New Engagement</Text>
      </Pressable>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.disabled} />
        }
      >
        {loading ? (
          <Text style={{ color: colors.text.disabled, textAlign: "center", marginTop: spacing.xl }}>
            Loading engagements...
          </Text>
        ) : filtered.length === 0 ? (
          <View style={{ alignItems: "center", marginTop: spacing.xxxl }}>
            <Text style={{ fontSize: 48, marginBottom: spacing.md }}>🔐</Text>
            <Text style={{ color: colors.text.tertiary, fontSize: fs.md, textAlign: "center" }}>
              {engagements.length === 0 ? "No engagements yet" : `No ${filter} engagements`}
            </Text>
            <Pressable
              onPress={() => router.push("/soc/new")}
              style={({ pressed }) => [styles.createBtnLg, pressed && { opacity: 0.85 }]}
            >
              <Text style={{ color: colors.bg.base, fontSize: fs.lg, fontWeight: fw.semibold }}>+ New Engagement</Text>
            </Pressable>
          </View>
        ) : (
          filtered.map((eng) => (
            <EngagementCard
              key={eng.id}
              engagement={eng}
              onPress={() => router.push(`/soc/${eng.id}`)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  filterPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    backgroundColor: withAlpha(colors.text.secondary, 0.08),
  },
  filterPillSelected: {
    backgroundColor: colors.accent,
  },
  createWide: {
    marginHorizontal: spacing.md,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    paddingVertical: 14,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: "center",
  },
  createBtnLg: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
});
