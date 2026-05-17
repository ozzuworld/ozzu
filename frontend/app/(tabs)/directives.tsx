import { useState, useCallback, useMemo, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  UIManager,
  Platform,
  Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { StatusBadge } from "../../components/StatusBadge";
import { TVPressable } from "../../components/TVPressable";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { useDirectives } from "../../lib/directive-hooks";
import {
  cancelDirective,
  retryDirective,
  retryMergeDirective,
  unblockDirective,
  type Directive,
} from "../../lib/bridge-api";
import {
  STATUS_ORDER,
  ACTIVE_STATUSES,
  HUMAN_STATUS,
  relativeTime,
} from "../../lib/directive-constants";
import { DirectiveListItem } from "../../components/directives/DirectiveListItem";
import { PlanReviewModal } from "../../components/directives/PlanReviewModal";
import { StatusChangeSheet } from "../../components/directives/StatusChangeSheet";
import HamburgerMenu from "../../components/HamburgerMenu";
import { GroupNav } from "../../components/GroupNav";
import { TopBar } from "../../components/TopBar";
import { colors, spacing, radius, fontSize as fs, fontWeight as fw, withAlpha, statusPillStyle, layout } from "../../lib/design-tokens";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}


type ViewMode = "overview" | "board" | "timeline" | "list";

export default function DirectivesScreen() {
  useEffect(() => { console.log("[boot] DirectivesScreen mounted"); }, []);
  const router = useRouter();
  const { insets, isPhone, screenWidth, screenHeight } = usePhoneLayout();
  const isTabletLandscape = !isPhone && screenWidth > screenHeight;

  const { directives, buildStatus, summary, loading, error, refresh } = useDirectives();

  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [refreshing, setRefreshing] = useState(false);

  // Plan review modal
  const [planReviewDirective, setPlanReviewDirective] = useState<Directive | null>(null);

  // Status change sheet
  const [statusChangeDirective, setStatusChangeDirective] = useState<Directive | null>(null);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  // Action handler
  const handleAction = useCallback(
    async (action: string, id: string) => {
      try {
        if (action === "approve") {
          const dir = directives.find((d) => d.id === id);
          if (dir) setPlanReviewDirective(dir);
          return;
        }
        if (action === "cancel") {
          Alert.alert("Cancel Directive", "Are you sure?", [
            { text: "No", style: "cancel" },
            { text: "Cancel It", style: "destructive", onPress: async () => { await cancelDirective(id); refresh(); } },
          ]);
          return;
        }
        if (action === "retry") { const r = await retryDirective(id); if (!r.ok) Alert.alert("Error", r.error || "Retry failed"); refresh(); return; }
        if (action === "retry_merge") { const r = await retryMergeDirective(id); if (r.ok) Alert.alert("Success", "Merge succeeded! Deploying now."); else Alert.alert("Merge Failed", r.error || "Merge failed again"); refresh(); return; }
        if (action === "unblock") { const r = await unblockDirective(id); if (!r.ok) Alert.alert("Error", r.error || "Unblock failed"); refresh(); return; }
      } catch (err: any) { Alert.alert("Error", err.message || "Action failed"); }
    },
    [directives, refresh]
  );

  const handlePlanReview = useCallback((directive: Directive) => {
    setPlanReviewDirective(directive);
  }, []);

  const handleStatusChange = useCallback((directive: Directive) => {
    setStatusChangeDirective(directive);
  }, []);

  // All directives — no category filter
  const filtered = directives;

  // Timeline groups
  const timelineGroups = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0, 0, 0, 0);

    const getTime = (d: Directive) => d.completedAt || d.updatedAt || d.createdAt || 0;
    const sorted = [...filtered].sort((a, b) => getTime(b) - getTime(a));

    return {
      today: sorted.filter((d) => getTime(d) >= todayStart.getTime()),
      yesterday: sorted.filter((d) => getTime(d) >= yesterdayStart.getTime() && getTime(d) < todayStart.getTime()),
      thisWeek: sorted.filter((d) => getTime(d) >= weekStart.getTime() && getTime(d) < yesterdayStart.getTime()),
      older: sorted.filter((d) => getTime(d) < weekStart.getTime()),
    };
  }, [filtered]);

  // Overview: needs attention + active only (no completed)
  const overviewGroups = useMemo(() => {
    const needsAttention = filtered.filter((d) => ["blocked", "deploy_failed", "failed", "stale"].includes(d.status));
    const active = filtered.filter((d) => ACTIVE_STATUSES.includes(d.status) && !["blocked"].includes(d.status));
    return { needsAttention, active };
  }, [filtered]);

  // Board columns (Jira-style kanban)
  const boardColumns = useMemo(() => {
    const columns: Array<{ key: string; label: string; color: string; items: Directive[] }> = [
      { key: "needs_action", label: "Needs Action", color: colors.error, items: [] },
      { key: "todo", label: "To Do", color: colors.gray[300], items: [] },
      { key: "in_progress", label: "In Progress", color: colors.brand.blue, items: [] },
      { key: "done", label: "Done", color: colors.success, items: [] },
    ];
    for (const d of filtered) {
      if (["blocked", "deploy_failed", "failed", "stale"].includes(d.status)) {
        columns[0].items.push(d);
      } else if (["pending", "planning", "planned", "approved"].includes(d.status)) {
        columns[1].items.push(d);
      } else if (d.status === "in_progress") {
        columns[2].items.push(d);
      } else if (["completed", "cancelled"].includes(d.status)) {
        columns[3].items.push(d);
      }
    }
    // Only show Done column's last 5
    columns[3].items = columns[3].items
      .sort((a, b) => (b.completedAt || b.updatedAt) - (a.completedAt || a.updatedAt))
      .slice(0, 5);
    return columns;
  }, [filtered]);

  // Enrich epics with phases
  const enrichDirective = (d: Directive): Directive => {
    if (d.type === "epic" && !d.phases) {
      const phases = directives.filter((p) => p.epicId === d.id).sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0));
      if (phases.length > 0) return { ...d, phases };
    }
    return d;
  };

  const hPad = Math.max(16, insets.left, insets.right);

  const navigateToDirective = useCallback((d: Directive) => {
    router.push(`/directive/${d.id}`);
  }, [router]);

  const renderCard = (d: Directive) => (
    <DirectiveListItem
      key={d.id}
      directive={enrichDirective(d)}
      onPress={navigateToDirective}
    />
  );

  const renderSection = (title: string, items: Directive[], count?: number) => {
    if (items.length === 0) return null;
    return (
      <View key={title} style={{ marginBottom: 20 }}>
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8, paddingVertical: 6 }}>
          <Text style={{ color: colors.text.disabled, fontSize: 12, fontWeight: fw.semibold, letterSpacing: 0.3, textTransform: "uppercase" }}>
            {title}
          </Text>
          <Text style={{ color: colors.text.disabled, fontSize: 11, marginLeft: 6, opacity: 0.6 }}>
            {items.length}
          </Text>
        </View>
        {items.map((d) => (
          <DirectiveListItem
            key={d.id}
            directive={enrichDirective(d)}
            onPress={navigateToDirective}
          />
        ))}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <TopBar
        left={<Text style={{ color: colors.text.primary, fontSize: 18, fontWeight: fw.semibold }}>Cipher</Text>}
        right={<><StatusBadge /><HamburgerMenu /></>}
      />

      <GroupNav group="cipher" />

      {/* Stats row — minimal, no box */}
      {summary ? (
        <View style={{ paddingHorizontal: hPad, paddingBottom: 8, flexDirection: "row", gap: 16, alignItems: "baseline" }}>
          <Text style={{ color: colors.text.secondary, fontSize: 13 }}>
            <Text style={{ color: colors.success, fontWeight: fw.bold }}>{summary.completedToday}</Text> done today
          </Text>
          <Text style={{ color: colors.text.secondary, fontSize: 13 }}>
            <Text style={{ color: colors.accent, fontWeight: fw.bold }}>{summary.activeCount}</Text> active
          </Text>
          {summary.needsAttentionCount > 0 ? (
            <Text style={{ color: colors.text.secondary, fontSize: 13 }}>
              <Text style={{ color: colors.error, fontWeight: fw.bold }}>{summary.needsAttentionCount}</Text> needs action
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* View Mode Tabs — underline style */}
      <View style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: hPad,
        borderBottomWidth: 0.5,
        borderBottomColor: withAlpha("#ffffff", 0.06),
      }}>
        {(["timeline", "board", "overview"] as ViewMode[]).map((mode) => {
          const isActive = viewMode === mode;
          const labels: Record<ViewMode, string> = { timeline: "Timeline", board: "Board", overview: "Pending", list: "All" };
          return (
            <Pressable
              key={mode}
              onPress={() => setViewMode(mode)}
              style={({ pressed }) => ({
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderBottomWidth: 2,
                borderBottomColor: isActive ? colors.accent : "transparent",
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{
                color: isActive ? colors.text.primary : colors.text.disabled,
                fontSize: 13,
                fontWeight: isActive ? fw.semibold : fw.normal,
              }}>
                {labels[mode]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: hPad, paddingBottom: Math.max(24, insets.bottom) }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
        }
      >
        {error ? (
          <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: colors.error, fontSize: fs.md, textAlign: "center" }}>{error}</Text>
            <Pressable
              onPress={refresh}
              style={({ pressed }) => ({ marginTop: 12, opacity: pressed ? 0.6 : 1 })}
            >
              <Text style={{ color: colors.accent, fontSize: fs.md, fontWeight: fw.bold }}>TAP TO RETRY</Text>
            </Pressable>
          </View>
        ) : loading && directives.length === 0 ? (
          <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: colors.accent, fontSize: fs.base, opacity: 0.6 }}>Loading...</Text>
          </View>
        ) : filtered.length === 0 ? (
          <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: colors.text.disabled, fontSize: fs.base }}>
              No directives
            </Text>
          </View>
        ) : viewMode === "overview" ? (
          <>
            {renderSection("Needs Attention", overviewGroups.needsAttention)}
            {renderSection("Active", overviewGroups.active)}
          </>
        ) : viewMode === "board" ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 12, paddingRight: 16 }}
          >
            {boardColumns.map((col) => (
              <View
                key={col.key}
                style={{
                  width: Math.min(280, screenWidth * 0.72),
                  backgroundColor: colors.bg.elevated,
                  borderRadius: radius.lg,
                  borderTopWidth: 3,
                  borderTopColor: col.color,
                  padding: spacing.md,
                }}
              >
                {/* Column header */}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md }}>
                  <Text style={{ color: colors.text.secondary, fontSize: fs.md, fontWeight: fw.bold, letterSpacing: 0.5 }}>
                    {col.label.toUpperCase()}
                  </Text>
                  <View style={{
                    backgroundColor: withAlpha(col.color, 0.12),
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: 10,
                  }}>
                    <Text style={{ color: col.color, fontSize: fs.sm, fontWeight: fw.bold }}>
                      {col.items.length}
                    </Text>
                  </View>
                </View>

                {/* Column cards */}
                {col.items.length === 0 ? (
                  <View style={{ paddingVertical: 20, alignItems: "center" }}>
                    <Text style={{ color: colors.text.disabled, fontSize: fs.md }}>Empty</Text>
                  </View>
                ) : (
                  <View style={{ gap: spacing.sm }}>
                    {col.items.map((d) => {
                      const pill = statusPillStyle(d.status);
                      return (
                        <Pressable
                          key={d.id}
                          onPress={() => navigateToDirective(d)}
                          style={({ pressed }) => ({
                            backgroundColor: pressed ? colors.bg.overlay : colors.bg.surface,
                            borderRadius: radius.md,
                            padding: spacing.md,
                            transform: [{ scale: pressed ? 0.98 : 1 }],
                          })}
                        >
                          {/* Card: emoji + title */}
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <Text style={{ fontSize: 14 }}>{d.emoji || ""}</Text>
                            <Text
                              style={{ color: colors.text.primary, fontSize: fs.base, fontWeight: fw.semibold, flex: 1 }}
                              numberOfLines={2}
                            >
                              {d.title}
                            </Text>
                          </View>

                          {/* Card: status pill + time */}
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: pill.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full }}>
                              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: pill.dot }} />
                              <Text style={{ color: pill.text, fontSize: 9, fontWeight: fw.bold }}>
                                {HUMAN_STATUS[d.status] || d.status}
                              </Text>
                            </View>
                            <Text style={{ color: colors.text.disabled, fontSize: fs.xs }}>
                              {relativeTime(d.updatedAt)}
                            </Text>
                          </View>

                          {/* Card: work summary preview */}
                          {d.work_summary ? (
                            <Text
                              style={{ color: colors.text.tertiary, fontSize: fs.xs, marginTop: 4, lineHeight: 14 }}
                              numberOfLines={2}
                            >
                              {d.work_summary}
                            </Text>
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </View>
            ))}
          </ScrollView>
        ) : viewMode === "timeline" ? (
          <>
            {renderSection("Today", timelineGroups.today)}
            {renderSection("Yesterday", timelineGroups.yesterday)}
            {renderSection("This Week", timelineGroups.thisWeek)}
            {renderSection("Older", timelineGroups.older)}
          </>
        ) : null}
      </ScrollView>

      {/* Plan Review Modal */}
      <PlanReviewModal
        visible={planReviewDirective !== null}
        directive={planReviewDirective}
        onDismiss={() => setPlanReviewDirective(null)}
        onResolved={refresh}
      />

      {/* Status Change Sheet */}
      <StatusChangeSheet
        visible={statusChangeDirective !== null}
        directive={statusChangeDirective}
        onDismiss={() => setStatusChangeDirective(null)}
        onStatusChanged={refresh}
      />

      <StatusBar style="light" />
    </View>
  );
}
