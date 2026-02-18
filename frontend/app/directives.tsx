import { useState, useCallback } from "react";
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
  ACTIVE_STATUSES,
  FAILED_STATUSES,
  NEEDS_ACTION_STATUSES,
} from "../lib/directive-constants";
import { DirectiveCard } from "../components/directives/DirectiveCard";
import { SummaryStatsBar } from "../components/directives/SummaryStatsBar";
import { PlanReviewModal } from "../components/directives/PlanReviewModal";
import { StatusChangeSheet } from "../components/directives/StatusChangeSheet";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const TOP_BAR_HEIGHT = 48;

const FILTER_CHIPS = [
  { key: "all", label: "ALL", emoji: "🌍" },
  { key: "needs_action", label: "NEEDS ACTION", emoji: "🔥" },
  { key: "active", label: "ACTIVE", emoji: "🚀" },
  { key: "completed", label: "COMPLETED", emoji: "✅" },
  { key: "failed", label: "FAILED", emoji: "⚠️" },
];

const SORT_OPTIONS = [
  { key: "status", label: "Status" },
  { key: "recent", label: "Recent" },
  { key: "priority", label: "Priority" },
  { key: "created", label: "Created" },
];

export default function DirectivesScreen() {
  const router = useRouter();
  const { insets, isPhone, screenWidth, screenHeight } = usePhoneLayout();
  const isTabletLandscape = !isPhone && screenWidth > screenHeight;

  const { directives, approvals, buildStatus, loading, error, refresh } = useDirectives();

  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("status");
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
          if (dir) {
            setPlanReviewDirective(dir);
            setPlanReviewApproval(approval || null);
          }
          return;
        }
        if (action === "deny") {
          Alert.alert("❌ Deny Plan", "Cancel this directive?", [
            { text: "No", style: "cancel" },
            {
              text: "Yes, Deny",
              style: "destructive",
              onPress: async () => {
                await cancelDirective(id);
                refresh();
              },
            },
          ]);
          return;
        }
        if (action === "cancel") {
          Alert.alert("🚫 Cancel Directive", "Are you sure?", [
            { text: "No", style: "cancel" },
            {
              text: "Cancel It",
              style: "destructive",
              onPress: async () => {
                await cancelDirective(id);
                refresh();
              },
            },
          ]);
          return;
        }
        if (action === "retry") {
          const result = await retryDirective(id);
          if (!result.ok) Alert.alert("Error", result.error || "Retry failed");
          refresh();
          return;
        }
        if (action === "retry_merge") {
          const result = await retryMergeDirective(id);
          if (result.ok) {
            Alert.alert("✅ Success", "Merge succeeded! Deploying now.");
          } else {
            Alert.alert("❌ Merge Failed", result.error || "Merge failed again");
          }
          refresh();
          return;
        }
        if (action === "unblock") {
          const result = await unblockDirective(id);
          if (!result.ok) Alert.alert("Error", result.error || "Unblock failed");
          refresh();
          return;
        }
      } catch (err: any) {
        Alert.alert("Error", err.message || "Action failed");
      }
    },
    [approvals, directives, refresh]
  );

  const handlePlanReview = useCallback(
    (directive: Directive) => {
      const approval = approvals.find((a) => a.directiveId === directive.id);
      setPlanReviewDirective(directive);
      setPlanReviewApproval(approval || null);
    },
    [approvals]
  );

  const handleStatusChange = useCallback((directive: Directive) => {
    setStatusChangeDirective(directive);
  }, []);

  // Status counts
  const needsActionCount = directives.filter((d) => NEEDS_ACTION_STATUSES.includes(d.status)).length;
  const activeCount = directives.filter((d) => ACTIVE_STATUSES.includes(d.status)).length;
  const failedCount = directives.filter((d) => FAILED_STATUSES.includes(d.status)).length;
  const completedCount = directives.filter((d) => d.status === "completed").length;

  // Filter
  const filtered =
    filter === "all"
      ? directives
      : filter === "needs_action"
        ? directives.filter((d) => NEEDS_ACTION_STATUSES.includes(d.status))
        : filter === "active"
          ? directives.filter((d) => ACTIVE_STATUSES.includes(d.status))
          : filter === "completed"
            ? directives.filter((d) => d.status === "completed")
            : filter === "failed"
              ? directives.filter((d) => FAILED_STATUSES.includes(d.status))
              : directives;

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "recent") return b.updatedAt - a.updatedAt;
    if (sortBy === "priority") return (a.priority ?? 3) - (b.priority ?? 3);
    if (sortBy === "created") return b.createdAt - a.createdAt;
    // Default: status order
    const orderA = STATUS_ORDER[a.status] ?? 99;
    const orderB = STATUS_ORDER[b.status] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return b.updatedAt - a.updatedAt;
  });

  const hPad = Math.max(16, insets.left, insets.right);

  const chipCounts: Record<string, number> = {
    all: directives.length,
    needs_action: needsActionCount,
    active: activeCount,
    completed: completedCount,
    failed: failedCount,
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#111111" }}>
      {/* Top Bar */}
      <View
        style={{
          paddingTop: insets.top,
          height: TOP_BAR_HEIGHT + insets.top,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: hPad,
        }}
      >
        <Text
          style={{
            color: "#F59E0B",
            fontSize: 24,
            fontWeight: "bold",
            fontFamily: "monospace",
            letterSpacing: 3,
          }}
        >
          ozzu
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <TVPressable
            onPress={() => router.back()}
            style={{ paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6 }}
          >
            <Text
              style={{
                color: "#A3A3A3",
                fontSize: 12,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              {"◀ BACK"}
            </Text>
          </TVPressable>
          <StatusBadge />
        </View>
      </View>

      {/* Summary Stats Bar */}
      <SummaryStatsBar
        directives={directives}
        onFilterSelect={setFilter}
        hPad={hPad}
      />

      {/* Filter Chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ maxHeight: 40, flexGrow: 0 }}
        contentContainerStyle={{
          paddingHorizontal: hPad,
          gap: 8,
          alignItems: "center",
          paddingVertical: 4,
        }}
      >
        {FILTER_CHIPS.map((chip) => {
          const isActive = filter === chip.key;
          const count = chipCounts[chip.key] || 0;
          const chipColor =
            chip.key === "needs_action"
              ? "#F59E0B"
              : chip.key === "all"
                ? "#06B6D4"
                : chip.key === "active"
                  ? "#3B82F6"
                  : chip.key === "completed"
                    ? "#22C55E"
                    : "#EF4444";

          return (
            <Pressable
              key={chip.key}
              onPress={() => setFilter(chip.key)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 6,
                borderWidth: isActive ? 1.5 : 1,
                borderColor: isActive ? chipColor : "#333",
                backgroundColor: isActive ? `${chipColor}15` : "#1A1A1A",
              }}
            >
              <Text style={{ fontSize: 10 }}>{chip.emoji}</Text>
              <Text
                style={{
                  color: isActive ? chipColor : "#737373",
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 0.5,
                }}
              >
                {count}
              </Text>
              <Text
                style={{
                  color: isActive ? chipColor : "#525252",
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 0.5,
                }}
              >
                {chip.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Sort Chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ maxHeight: 34, flexGrow: 0 }}
        contentContainerStyle={{
          paddingHorizontal: hPad,
          gap: 6,
          alignItems: "center",
          paddingVertical: 3,
        }}
      >
        {SORT_OPTIONS.map((opt) => {
          const isActive = sortBy === opt.key;
          return (
            <Pressable
              key={opt.key}
              onPress={() => setSortBy(opt.key)}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 4,
                backgroundColor: isActive ? "#06B6D420" : "transparent",
                borderWidth: 1,
                borderColor: isActive ? "#06B6D440" : "#222",
              }}
            >
              <Text
                style={{
                  color: isActive ? "#06B6D4" : "#525252",
                  fontSize: 9,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 0.5,
                }}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={{ height: 1, backgroundColor: "#222", marginHorizontal: hPad }} />

      {/* Directive List */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: hPad,
          paddingBottom: Math.max(24, insets.bottom),
          gap: 10,
          ...(isTabletLandscape ? { flexDirection: "row", flexWrap: "wrap" } : {}),
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#06B6D4"
            colors={["#06B6D4"]}
          />
        }
      >
        {/* Pending Approvals Banner */}
        {approvals.length > 0 ? (
          <View
            style={{
              backgroundColor: "#0D2847",
              borderWidth: 1,
              borderColor: "#3B82F6",
              borderRadius: 10,
              padding: 14,
              marginBottom: 4,
              width: "100%",
            }}
          >
            <Text
              style={{
                color: "#60A5FA",
                fontSize: 11,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 1,
                marginBottom: 10,
              }}
            >
              📋 PENDING APPROVALS ({approvals.length})
            </Text>
            {approvals.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => {
                  const dir = directives.find((d) => d.id === a.directiveId);
                  if (dir) handlePlanReview(dir);
                }}
                style={{
                  backgroundColor: "#111",
                  borderWidth: 1,
                  borderColor: "#2A2A2A",
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 6,
                }}
              >
                <Text
                  style={{ color: "#E5E5E5", fontSize: 13, fontFamily: "monospace", fontWeight: "600" }}
                  numberOfLines={1}
                >
                  {a.directiveTitle || a.directiveId || a.id}
                </Text>
                {a.directivePlan ? (
                  <Text
                    style={{ color: "#666", fontSize: 11, fontFamily: "monospace", marginTop: 4 }}
                    numberOfLines={2}
                  >
                    {a.directivePlan.slice(0, 150)}
                  </Text>
                ) : null}
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <Pressable
                    onPress={() => handleAction("approve", a.directiveId || "")}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: 5,
                      borderWidth: 1,
                      borderColor: "#22C55E",
                      backgroundColor: "rgba(34,197,94,0.1)",
                    }}
                  >
                    <Text style={{ color: "#22C55E", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                      ✅ APPROVE
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleAction("deny", a.directiveId || "")}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: 5,
                      borderWidth: 1,
                      borderColor: "#EF4444",
                      backgroundColor: "rgba(239,68,68,0.1)",
                    }}
                  >
                    <Text style={{ color: "#EF4444", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                      ❌ DENY
                    </Text>
                  </Pressable>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}

        {error ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: "#EF4444", fontSize: 12, fontFamily: "monospace", textAlign: "center" }}>
              {error}
            </Text>
            <Pressable onPress={refresh} style={{ marginTop: 12 }}>
              <Text style={{ color: "#06B6D4", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                TAP TO RETRY
              </Text>
            </Pressable>
          </View>
        ) : loading && sorted.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: "#06B6D4", fontSize: 13, fontFamily: "monospace", opacity: 0.6 }}>
              Loading directives...
            </Text>
          </View>
        ) : sorted.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ fontSize: 24, marginBottom: 8 }}>
              {filter === "needs_action" ? "🔥" : filter === "active" ? "🚀" : filter === "completed" ? "✅" : filter === "failed" ? "⚠️" : "🌍"}
            </Text>
            <Text style={{ color: "#06B6D4", fontSize: 13, fontFamily: "monospace", opacity: 0.6 }}>
              {filter === "needs_action" ? "No directives need action" : filter === "active" ? "No active directives" : filter === "completed" ? "No completed directives" : filter === "failed" ? "No failed directives" : "No directives found"}
            </Text>
            {filter !== "all" ? (
              <Pressable onPress={() => setFilter("all")} style={{ marginTop: 12 }}>
                <Text style={{ color: "#06B6D4", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                  Show All
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : isTabletLandscape ? (
          sorted.map((d) => (
            <View key={d.id} style={{ width: "48%", marginBottom: 2 }}>
              <DirectiveCard
                directive={d}
                isTabletLandscape={false}
                onAction={handleAction}
                buildStatus={buildStatus}
                onPlanReview={handlePlanReview}
                onStatusChange={handleStatusChange}
              />
            </View>
          ))
        ) : (
          sorted.map((d) => (
            <DirectiveCard
              key={d.id}
              directive={d}
              isTabletLandscape={false}
              onAction={handleAction}
              buildStatus={buildStatus}
              onPlanReview={handlePlanReview}
              onStatusChange={handleStatusChange}
            />
          ))
        )}
      </ScrollView>

      {/* Plan Review Modal */}
      <PlanReviewModal
        visible={planReviewDirective !== null}
        directive={planReviewDirective}
        approval={planReviewApproval}
        onDismiss={() => {
          setPlanReviewDirective(null);
          setPlanReviewApproval(null);
        }}
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
