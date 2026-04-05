import { useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  UIManager,
  Platform,
  Alert,
  TextInput,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { useDirectives } from "../lib/directive-hooks";
import {
  cancelDirective,
  retryDirective,
  retryMergeDirective,
  unblockDirective,
  type Directive,
} from "../lib/bridge-api";
import {
  STATUS_ORDER,
  STATUS_COLORS,
  STATUS_EMOJI,
  ACTIVE_STATUSES,
  FAILED_STATUSES,
  NEEDS_ACTION_STATUSES,
  CATEGORY_INFO,
  HUMAN_STATUS,
  relativeTime,
} from "../lib/directive-constants";
import { DirectiveCard } from "../components/directives/DirectiveCard";
import { PlanReviewModal } from "../components/directives/PlanReviewModal";
import { StatusChangeSheet } from "../components/directives/StatusChangeSheet";
import HamburgerMenu from "../components/HamburgerMenu";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const TOP_BAR_HEIGHT = 48;

type ViewMode = "overview" | "board" | "timeline" | "list";

export default function DirectivesScreen() {
  const router = useRouter();
  const { insets, isPhone, screenWidth, screenHeight } = usePhoneLayout();
  const isTabletLandscape = !isPhone && screenWidth > screenHeight;

  const { directives, approvals, buildStatus, summary, loading, error, refresh } = useDirectives();

  const [category, setCategory] = useState("all");
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const [searchQuery, setSearchQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  // Plan review modal
  const [planReviewDirective, setPlanReviewDirective] = useState<Directive | null>(null);
  const [planReviewApproval, setPlanReviewApproval] = useState<any>(null);
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
          const approval = approvals.find((a) => a.directiveId === id);
          if (dir) { setPlanReviewDirective(dir); setPlanReviewApproval(approval || null); }
          return;
        }
        if (action === "deny") {
          Alert.alert("Deny Plan", "Cancel this directive?", [
            { text: "No", style: "cancel" },
            { text: "Yes, Deny", style: "destructive", onPress: async () => { await cancelDirective(id); refresh(); } },
          ]);
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
    [approvals, directives, refresh]
  );

  const handlePlanReview = useCallback((directive: Directive) => {
    const approval = approvals.find((a) => a.directiveId === directive.id);
    setPlanReviewDirective(directive); setPlanReviewApproval(approval || null);
  }, [approvals]);

  const handleStatusChange = useCallback((directive: Directive) => {
    setStatusChangeDirective(directive);
  }, []);

  // Filter by category + search
  const filtered = useMemo(() => {
    let result = directives;
    if (category !== "all") {
      result = result.filter((d) => (d.category || "dev") === category);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((d) =>
        (d.title || "").toLowerCase().includes(q) ||
        (d.description || "").toLowerCase().includes(q) ||
        (d.work_summary || "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [directives, category, searchQuery]);

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

  // Overview: split into active + needs attention + recent completed
  const overviewGroups = useMemo(() => {
    const needsAttention = filtered.filter((d) => ["blocked", "deploy_failed", "failed", "stale"].includes(d.status));
    const active = filtered.filter((d) => ACTIVE_STATUSES.includes(d.status) && !["blocked"].includes(d.status));
    const completed = filtered.filter((d) => d.status === "completed").sort((a, b) => (b.completedAt || b.updatedAt) - (a.completedAt || a.updatedAt)).slice(0, 10);
    return { needsAttention, active, completed };
  }, [filtered]);

  // Board columns (Jira-style kanban)
  const boardColumns = useMemo(() => {
    const columns: Array<{ key: string; label: string; color: string; items: Directive[] }> = [
      { key: "needs_action", label: "Needs Action", color: "#EF4444", items: [] },
      { key: "todo", label: "To Do", color: "#737373", items: [] },
      { key: "in_progress", label: "In Progress", color: "#3B82F6", items: [] },
      { key: "done", label: "Done", color: "#22C55E", items: [] },
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

  // Status-sorted list view
  const listSorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const oa = STATUS_ORDER[a.status] ?? 99;
      const ob = STATUS_ORDER[b.status] ?? 99;
      if (oa !== ob) return oa - ob;
      return b.updatedAt - a.updatedAt;
    });
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
  const catKeys = Object.keys(CATEGORY_INFO);

  const renderCard = (d: Directive) => (
    <DirectiveCard
      key={d.id}
      directive={enrichDirective(d)}
      isTabletLandscape={false}
      onAction={handleAction}
      buildStatus={buildStatus}
      onPlanReview={handlePlanReview}
      onStatusChange={handleStatusChange}
    />
  );

  const renderSection = (title: string, items: Directive[], color: string, collapsed?: boolean) => {
    if (items.length === 0) return null;
    return (
      <View key={title} style={{ marginBottom: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <View style={{ width: 3, height: 16, backgroundColor: color, borderRadius: 2 }} />
          <Text style={{ color: "#A3A3A3", fontSize: 13, fontWeight: "700", letterSpacing: 0.5 }}>
            {title}
          </Text>
          <View style={{ backgroundColor: `${color}25`, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 10 }}>
            <Text style={{ color, fontSize: 11, fontWeight: "bold" }}>{items.length}</Text>
          </View>
        </View>
        <View style={{ gap: 8, ...(isTabletLandscape ? { flexDirection: "row", flexWrap: "wrap" } : {}) }}>
          {items.map((d) => (
            isTabletLandscape
              ? <View key={d.id} style={{ width: "48%", marginBottom: 2 }}>{renderCard(d)}</View>
              : renderCard(d)
          ))}
        </View>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      <HamburgerMenu />
      {/* Top Bar */}
      <View style={{
        paddingTop: insets.top,
        height: TOP_BAR_HEIGHT + insets.top,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: hPad,
      }}>
        <Text style={{ color: "#F59E0B", fontSize: 22, fontWeight: "bold", letterSpacing: 2 }}>
          OZZU
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <StatusBadge />
        </View>
      </View>

      {/* Headline Banner */}
      {summary ? (
        <View style={{
          marginHorizontal: hPad,
          marginBottom: 10,
          paddingVertical: 10,
          paddingHorizontal: 14,
          backgroundColor: summary.needsAttentionCount > 0 ? "#2D1B0E" : "#0D1B2A",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: summary.needsAttentionCount > 0 ? "#F59E0B30" : "#3B82F620",
        }}>
          <Text style={{ color: "#E5E5E5", fontSize: 16, fontWeight: "700" }}>
            {summary.headline}
          </Text>
          <View style={{ flexDirection: "row", gap: 16, marginTop: 6 }}>
            <Text style={{ color: "#737373", fontSize: 12 }}>
              <Text style={{ color: "#22C55E", fontWeight: "bold" }}>{summary.completedToday}</Text> done today
            </Text>
            <Text style={{ color: "#737373", fontSize: 12 }}>
              <Text style={{ color: "#3B82F6", fontWeight: "bold" }}>{summary.activeCount}</Text> active
            </Text>
            <Text style={{ color: "#737373", fontSize: 12 }}>
              <Text style={{ color: "#06B6D4", fontWeight: "bold" }}>{summary.completedThisWeek}</Text> this week
            </Text>
          </View>
        </View>
      ) : null}

      {/* Category Tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, maxHeight: 38 }}
        contentContainerStyle={{ paddingHorizontal: hPad, gap: 6, alignItems: "center", paddingVertical: 3 }}
      >
        {catKeys.map((key) => {
          const cat = CATEGORY_INFO[key];
          const isActive = category === key;
          const count = key === "all"
            ? directives.length
            : directives.filter((d) => (d.category || "dev") === key).length;
          if (count === 0 && key !== "all") return null;
          return (
            <Pressable
              key={key}
              onPress={() => setCategory(key)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: isActive ? `${cat.color}18` : "transparent",
                borderWidth: 1,
                borderColor: isActive ? `${cat.color}50` : "#1A1A1A",
              }}
            >
              <Text style={{ fontSize: 11 }}>{cat.emoji}</Text>
              <Text style={{
                color: isActive ? cat.color : "#525252",
                fontSize: 11,
                fontWeight: "bold",
                letterSpacing: 0.3,
              }}>
                {cat.label}
              </Text>
              <Text style={{
                color: isActive ? cat.color : "#3A3A3A",
                fontSize: 10,
                fontWeight: "bold",
              }}>
                {count}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* View Mode + Search */}
      <View style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: hPad,
        paddingVertical: 6,
        gap: 8,
      }}>
        {/* View mode toggles */}
        {(["overview", "board", "timeline", "list"] as ViewMode[]).map((mode) => {
          const isActive = viewMode === mode;
          const labels: Record<ViewMode, string> = { overview: "Overview", board: "Board", timeline: "Timeline", list: "All" };
          return (
            <Pressable
              key={mode}
              onPress={() => setViewMode(mode)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: isActive ? "#06B6D415" : "transparent",
                borderWidth: 1,
                borderColor: isActive ? "#06B6D440" : "#1A1A1A",
              }}
            >
              <Text style={{
                color: isActive ? "#06B6D4" : "#3A3A3A",
                fontSize: 11,
                fontWeight: "bold",
              }}>
                {labels[mode]}
              </Text>
            </Pressable>
          );
        })}

        {/* Search */}
        <View style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: "#141414",
          borderRadius: 6,
          borderWidth: 1,
          borderColor: searchQuery ? "#06B6D440" : "#1A1A1A",
          paddingHorizontal: 8,
          height: 28,
        }}>
          <Text style={{ color: "#3A3A3A", fontSize: 12, marginRight: 4 }}>Search</Text>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder=""
            placeholderTextColor="#2A2A2A"
            style={{
              flex: 1,
              color: "#E5E5E5",
              fontSize: 12,
              padding: 0,
              height: 28,
            }}
          />
          {searchQuery ? (
            <Pressable onPress={() => setSearchQuery("")}>
              <Text style={{ color: "#525252", fontSize: 11 }}>x</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={{ height: 1, backgroundColor: "#1A1A1A", marginHorizontal: hPad }} />

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: hPad, paddingBottom: Math.max(24, insets.bottom) }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#06B6D4" colors={["#06B6D4"]} />
        }
      >
        {/* Pending Approvals */}
        {approvals.length > 0 ? (
          <View style={{
            backgroundColor: "#111111",
            borderRadius: 14,
            padding: 16,
            marginBottom: 12,
          }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#3B82F6" }} />
              <Text style={{ color: "#E5E5E5", fontSize: 15, fontWeight: "700" }}>
                {approvals.length === 1 ? "1 item needs your approval" : `${approvals.length} items need your approval`}
              </Text>
            </View>
            {approvals.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => {
                  const dir = directives.find((d) => d.id === a.directiveId);
                  if (dir) handlePlanReview(dir);
                }}
                style={{
                  backgroundColor: "#1A1A1A",
                  borderRadius: 12,
                  padding: 14,
                  marginBottom: 8,
                }}
              >
                <Text style={{ color: "#F5F5F5", fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
                  {a.directiveTitle || a.directiveId || a.id}
                </Text>
                {a.directivePlan ? (
                  <Text style={{ color: "#525252", fontSize: 12, marginTop: 4, lineHeight: 18 }} numberOfLines={2}>{a.directivePlan.slice(0, 150)}</Text>
                ) : null}
                <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
                  <Pressable
                    onPress={() => handleAction("approve", a.directiveId || "")}
                    style={{
                      flex: 2,
                      paddingVertical: 10,
                      borderRadius: 10,
                      backgroundColor: "#22C55E",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>Approve</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleAction("deny", a.directiveId || "")}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 10,
                      backgroundColor: "#1A1A1A",
                      borderWidth: 1,
                      borderColor: "#333333",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: "#EF4444", fontSize: 13, fontWeight: "600" }}>Deny</Text>
                  </Pressable>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}

        {error ? (
          <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: "#EF4444", fontSize: 12, textAlign: "center" }}>{error}</Text>
            <Pressable onPress={refresh} style={{ marginTop: 12 }}>
              <Text style={{ color: "#06B6D4", fontSize: 12, fontWeight: "bold" }}>TAP TO RETRY</Text>
            </Pressable>
          </View>
        ) : loading && directives.length === 0 ? (
          <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: "#06B6D4", fontSize: 13, opacity: 0.6 }}>Loading...</Text>
          </View>
        ) : filtered.length === 0 ? (
          <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: "#525252", fontSize: 13 }}>
              {searchQuery ? "No results" : "No directives"}
            </Text>
          </View>
        ) : viewMode === "overview" ? (
          <>
            {renderSection("Needs Attention", overviewGroups.needsAttention, "#EF4444")}
            {renderSection("Active", overviewGroups.active, "#3B82F6")}
            {renderSection("Recently Completed", overviewGroups.completed, "#22C55E")}
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
                  backgroundColor: "#111111",
                  borderRadius: 12,
                  borderTopWidth: 3,
                  borderTopColor: col.color,
                  padding: 10,
                }}
              >
                {/* Column header */}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <Text style={{ color: "#A3A3A3", fontSize: 12, fontWeight: "700", letterSpacing: 0.5 }}>
                    {col.label.toUpperCase()}
                  </Text>
                  <View style={{
                    backgroundColor: `${col.color}20`,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: 10,
                  }}>
                    <Text style={{ color: col.color, fontSize: 11, fontWeight: "bold" }}>
                      {col.items.length}
                    </Text>
                  </View>
                </View>

                {/* Column cards */}
                {col.items.length === 0 ? (
                  <View style={{ paddingVertical: 20, alignItems: "center" }}>
                    <Text style={{ color: "#2A2A2A", fontSize: 12 }}>Empty</Text>
                  </View>
                ) : (
                  <View style={{ gap: 8 }}>
                    {col.items.map((d) => {
                      const sColor = STATUS_COLORS[d.status] || "#737373";
                      return (
                        <Pressable
                          key={d.id}
                          onPress={() => {
                            // Switch to overview and the card will be there
                          }}
                          style={{
                            backgroundColor: "#1A1A1A",
                            borderRadius: 10,
                            padding: 10,
                            borderLeftWidth: 3,
                            borderLeftColor: sColor,
                          }}
                        >
                          {/* Card: emoji + title */}
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <Text style={{ fontSize: 14 }}>{d.emoji || STATUS_EMOJI[d.status] || ""}</Text>
                            <Text
                              style={{ color: "#E5E5E5", fontSize: 13, fontWeight: "600", flex: 1 }}
                              numberOfLines={2}
                            >
                              {d.title}
                            </Text>
                          </View>

                          {/* Card: status lozenge + type + time */}
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
                            <View style={{
                              paddingHorizontal: 6,
                              paddingVertical: 2,
                              borderRadius: 4,
                              backgroundColor: `${sColor}20`,
                            }}>
                              <Text style={{ color: sColor, fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>
                                {HUMAN_STATUS[d.status] || d.status}
                              </Text>
                            </View>
                            <Text style={{ color: "#3A3A3A", fontSize: 10 }}>
                              {relativeTime(d.updatedAt)}
                            </Text>
                          </View>

                          {/* Card: work summary preview */}
                          {d.work_summary ? (
                            <Text
                              style={{ color: "#525252", fontSize: 10, marginTop: 4, lineHeight: 14 }}
                              numberOfLines={2}
                            >
                              {d.work_summary}
                            </Text>
                          ) : null}

                          {/* Card: assignee/creator */}
                          {d.createdBy ? (
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
                              <View style={{
                                width: 14, height: 14, borderRadius: 7,
                                backgroundColor: d.createdBy === "Cipher" ? "#6EE7B720" : "#A78BFA20",
                                alignItems: "center", justifyContent: "center",
                              }}>
                                <Text style={{ fontSize: 7, color: d.createdBy === "Cipher" ? "#6EE7B7" : "#A78BFA" }}>
                                  {d.createdBy[0]}
                                </Text>
                              </View>
                              <Text style={{ color: "#3A3A3A", fontSize: 9 }}>{d.createdBy}</Text>
                            </View>
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
            {renderSection("Today", timelineGroups.today, "#06B6D4")}
            {renderSection("Yesterday", timelineGroups.yesterday, "#3B82F6")}
            {renderSection("This Week", timelineGroups.thisWeek, "#A855F7")}
            {renderSection("Older", timelineGroups.older, "#525252")}
          </>
        ) : (
          <View style={{ gap: 8, ...(isTabletLandscape ? { flexDirection: "row", flexWrap: "wrap" } : {}) }}>
            {listSorted.map((d) =>
              isTabletLandscape
                ? <View key={d.id} style={{ width: "48%", marginBottom: 2 }}>{renderCard(d)}</View>
                : renderCard(d)
            )}
          </View>
        )}
      </ScrollView>

      {/* Plan Review Modal */}
      <PlanReviewModal
        visible={planReviewDirective !== null}
        directive={planReviewDirective}
        approval={planReviewApproval}
        onDismiss={() => { setPlanReviewDirective(null); setPlanReviewApproval(null); }}
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
