import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  LayoutAnimation,
  UIManager,
  Platform,
  TextInput,
  Modal,
  Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import {
  fetchDirectives,
  fetchApprovalDetails,
  resolveApproval,
  cancelDirective,
  retryDirective,
  retryMergeDirective,
  unblockDirective,
  type Directive,
  type EnrichedApproval,
} from "../lib/bridge-api";
import { BRIDGE_PIN } from "../lib/biometric-auth";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const TOP_BAR_HEIGHT = 48;

const STATUS_COLORS: Record<string, string> = {
  pending: "#737373",
  planning: "#A855F7",
  planned: "#8B5CF6",
  approved: "#FBBF24",
  in_progress: "#3B82F6",
  completed: "#22C55E",
  failed: "#EF4444",
  cancelled: "#F97316",
  stale: "#6B7280",
  blocked: "#F59E0B",
  deploy_failed: "#DC2626",
};

const STATUS_ORDER: Record<string, number> = {
  deploy_failed: 0,
  blocked: 1,
  planned: 2,
  in_progress: 3,
  planning: 4,
  pending: 5,
  approved: 6,
  completed: 7,
  failed: 8,
  cancelled: 9,
  stale: 10,
};

const ACTOR_COLORS: Record<string, string> = {
  "King Kazuma": "#A78BFA",
  "June": "#67E8F9",
  "Cipher": "#6EE7B7",
  "system": "#9CA3AF",
};

const FILTER_CHIPS = [
  { key: "all", label: "ALL" },
  { key: "needs_action", label: "NEEDS ACTION" },
  { key: "active", label: "ACTIVE" },
  { key: "completed", label: "COMPLETED" },
  { key: "failed", label: "FAILED" },
];

const ACTIVE_STATUSES = ["pending", "planning", "planned", "approved", "in_progress", "blocked"];
const FAILED_STATUSES = ["failed", "stale", "deploy_failed"];
const NEEDS_ACTION_STATUSES = ["planned", "blocked", "deploy_failed"];

function relativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function humanDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function priorityLabel(p: number): string {
  if (p <= 1) return "P1";
  if (p <= 2) return "P2";
  if (p <= 3) return "P3";
  return "P4";
}

function ActorBadge({ actor }: { actor?: string }) {
  if (!actor) return null;
  const color = ACTOR_COLORS[actor] || "#9CA3AF";
  return (
    <Text
      style={{
        color,
        fontSize: 9,
        fontFamily: "monospace",
        fontWeight: "bold",
        backgroundColor: `${color}18`,
        borderWidth: 1,
        borderColor: `${color}33`,
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      {actor}
    </Text>
  );
}

function ActionButton({
  label,
  color,
  onPress,
}: {
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: `${color}18`,
      }}
    >
      <Text
        style={{
          color,
          fontSize: 11,
          fontFamily: "monospace",
          fontWeight: "bold",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function DirectiveCard({
  directive,
  isTabletLandscape,
  onAction,
}: {
  directive: Directive;
  isTabletLandscape: boolean;
  onAction: (action: string, id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = STATUS_COLORS[directive.status] || "#737373";
  const isActive = !["completed", "cancelled"].includes(directive.status);
  const actLog = directive.activity_log || [];

  const toggle = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => !prev);
  }, []);

  return (
    <Pressable
      onPress={toggle}
      style={{
        backgroundColor: "#1A1A1A",
        borderRadius: 8,
        borderLeftWidth: 3,
        borderLeftColor: statusColor,
        borderWidth: 1,
        borderColor: "#2A2A2A",
        padding: 12,
        flex: isTabletLandscape ? 1 : undefined,
      }}
    >
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: statusColor,
          }}
        />
        <Text
          style={{
            flex: 1,
            color: "#E5E5E5",
            fontSize: 14,
            fontWeight: "600",
            fontFamily: "monospace",
          }}
          numberOfLines={expanded ? undefined : 1}
        >
          {directive.title}
        </Text>
        {directive.createdBy ? <ActorBadge actor={directive.createdBy} /> : null}
        <Text style={{ color: "#525252", fontSize: 12, fontFamily: "monospace" }}>
          {expanded ? "▲" : "▼"}
        </Text>
      </View>

      {/* Meta row */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 6,
          marginLeft: 16,
        }}
      >
        <Text
          style={{
            color: "#06B6D4",
            fontSize: 10,
            fontFamily: "monospace",
            fontWeight: "bold",
            letterSpacing: 1,
            backgroundColor: "rgba(6,182,212,0.1)",
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          {directive.type?.toUpperCase() || "QUICK"}
        </Text>
        <Text
          style={{
            color:
              directive.priority <= 1
                ? "#EF4444"
                : directive.priority <= 2
                  ? "#F59E0B"
                  : "#737373",
            fontSize: 10,
            fontFamily: "monospace",
            fontWeight: "bold",
          }}
        >
          {priorityLabel(directive.priority ?? 3)}
        </Text>
        <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
          {relativeTime(directive.updatedAt)}
        </Text>
        {directive.duration ? (
          <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
            {humanDuration(directive.duration)}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        <Text
          style={{
            color: statusColor,
            fontSize: 10,
            fontFamily: "monospace",
            fontWeight: "bold",
            letterSpacing: 0.5,
          }}
        >
          {directive.status?.toUpperCase().replace(/_/g, " ")}
        </Text>
      </View>

      {/* Failure reason — always visible */}
      {directive.failureReason ? (
        <View
          style={{
            backgroundColor: "rgba(239,68,68,0.1)",
            borderWidth: 1,
            borderColor: "rgba(239,68,68,0.3)",
            borderRadius: 6,
            padding: 8,
            marginTop: 8,
          }}
        >
          <Text style={{ color: "#FCA5A5", fontSize: 11, fontFamily: "monospace", lineHeight: 16 }}>
            {directive.failureReason}
          </Text>
        </View>
      ) : null}

      {/* Latest activity — always visible for active */}
      {isActive && actLog.length > 0 ? (
        <Text
          style={{
            color: "#737373",
            fontSize: 11,
            fontFamily: "monospace",
            marginTop: 6,
            marginLeft: 16,
          }}
          numberOfLines={1}
        >
          {actLog[actLog.length - 1].message}
        </Text>
      ) : null}

      {/* Action buttons — always visible */}
      <View style={{ flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {directive.status === "planned" ? (
          <>
            <ActionButton label="APPROVE" color="#22C55E" onPress={() => onAction("approve", directive.id)} />
            <ActionButton label="DENY" color="#EF4444" onPress={() => onAction("deny", directive.id)} />
          </>
        ) : null}
        {directive.status === "deploy_failed" ? (
          <>
            <ActionButton label="RETRY MERGE" color="#F59E0B" onPress={() => onAction("retry_merge", directive.id)} />
            <ActionButton label="RETRY FULL" color="#3B82F6" onPress={() => onAction("retry", directive.id)} />
          </>
        ) : null}
        {directive.status === "blocked" ? (
          <>
            <ActionButton label="UNBLOCK" color="#A855F7" onPress={() => onAction("unblock", directive.id)} />
            <ActionButton label="CANCEL" color="#EF4444" onPress={() => onAction("cancel", directive.id)} />
          </>
        ) : null}
        {["failed", "stale", "cancelled"].includes(directive.status) ? (
          <ActionButton label="RETRY" color="#3B82F6" onPress={() => onAction("retry", directive.id)} />
        ) : null}
        {!["completed", "failed", "cancelled", "stale", "planned", "blocked", "deploy_failed"].includes(directive.status) ? (
          <ActionButton label="CANCEL" color="#EF4444" onPress={() => onAction("cancel", directive.id)} />
        ) : null}
      </View>

      {/* Inline audit trail for active (last 3 entries) */}
      {isActive && actLog.length > 1 ? (
        <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: "#252525", paddingTop: 6 }}>
          {actLog.slice(-3).reverse().map((entry, i) => (
            <View
              key={i}
              style={{
                flexDirection: "row",
                gap: 6,
                alignItems: "baseline",
                marginBottom: 2,
              }}
            >
              <Text style={{ color: "#3A3A3A", fontSize: 9, fontFamily: "monospace", minWidth: 45 }}>
                {relativeTime(entry.timestamp)}
              </Text>
              {entry.actor ? <ActorBadge actor={entry.actor} /> : null}
              <Text
                style={{ color: "#666", fontSize: 9, fontFamily: "monospace", flex: 1 }}
                numberOfLines={1}
              >
                {entry.message}
              </Text>
            </View>
          ))}
          {actLog.length > 3 ? (
            <Text style={{ color: "#3B82F6", fontSize: 9, fontFamily: "monospace", marginTop: 2 }}>
              +{actLog.length - 3} more entries ▼
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Expanded content */}
      {expanded && (
        <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: "#252525", paddingTop: 10 }}>
          {/* Description */}
          {directive.description ? (
            <Text
              style={{
                color: "#A3A3A3",
                fontSize: 12,
                fontFamily: "monospace",
                lineHeight: 18,
                marginBottom: 10,
              }}
            >
              {directive.description}
            </Text>
          ) : null}

          {/* Plan section */}
          {directive.plan ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: "#333",
                borderRadius: 6,
                padding: 10,
                marginBottom: 10,
                backgroundColor: "#141414",
                maxHeight: 200,
              }}
            >
              <Text
                style={{
                  color: "#06B6D4",
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 1,
                  marginBottom: 6,
                }}
              >
                PLAN
              </Text>
              <ScrollView nestedScrollEnabled>
                <Text
                  style={{
                    color: "#A3A3A3",
                    fontSize: 11,
                    fontFamily: "monospace",
                    lineHeight: 16,
                  }}
                >
                  {directive.plan}
                </Text>
              </ScrollView>
            </View>
          ) : null}

          {/* Metadata grid */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 4,
              marginBottom: 10,
            }}
          >
            <MetaItem label="Created" value={formatTimestamp(directive.createdAt)} />
            <MetaItem label="Updated" value={formatTimestamp(directive.updatedAt)} />
            {directive.startedAt ? (
              <MetaItem label="Started" value={formatTimestamp(directive.startedAt)} />
            ) : null}
            {directive.completedAt ? (
              <MetaItem label="Completed" value={formatTimestamp(directive.completedAt)} />
            ) : null}
            {directive.duration ? (
              <MetaItem label="Duration" value={humanDuration(directive.duration)} />
            ) : null}
            {(directive.retryCount ?? 0) > 0 ? (
              <MetaItem label="Retries" value={String(directive.retryCount)} />
            ) : null}
            {directive.createdBy ? (
              <MetaItem label="Created By" value={directive.createdBy} />
            ) : null}
          </View>

          {/* Dependencies */}
          {directive.dependsOn && directive.dependsOn.length > 0 ? (
            <View style={{ marginBottom: 10 }}>
              <Text
                style={{
                  color: "#525252",
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 1,
                  marginBottom: 4,
                }}
              >
                DEPENDS ON
              </Text>
              {directive.dependsOn.map((depId) => (
                <Text
                  key={depId}
                  style={{
                    color: "#A3A3A3",
                    fontSize: 11,
                    fontFamily: "monospace",
                    marginLeft: 8,
                  }}
                >
                  • {depId}
                </Text>
              ))}
            </View>
          ) : null}

          {/* Full activity log */}
          {actLog.length > 0 ? (
            <View>
              <Text
                style={{
                  color: "#525252",
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 1,
                  marginBottom: 4,
                }}
              >
                AUDIT TRAIL
              </Text>
              {actLog.map((entry, i) => (
                <View
                  key={i}
                  style={{
                    flexDirection: "row",
                    gap: 6,
                    marginLeft: 8,
                    marginBottom: 3,
                    alignItems: "baseline",
                  }}
                >
                  <Text style={{ color: "#3A3A3A", fontSize: 10, fontFamily: "monospace", minWidth: 55 }}>
                    {relativeTime(entry.timestamp)}
                  </Text>
                  {entry.actor ? <ActorBadge actor={entry.actor} /> : null}
                  <Text
                    style={{
                      color: "#A3A3A3",
                      fontSize: 10,
                      fontFamily: "monospace",
                      flex: 1,
                    }}
                  >
                    {entry.message}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: "48%", marginBottom: 2 }}>
      <Text
        style={{
          color: "#525252",
          fontSize: 9,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
      <Text style={{ color: "#A3A3A3", fontSize: 11, fontFamily: "monospace" }}>
        {value}
      </Text>
    </View>
  );
}

export default function DirectivesScreen() {
  const router = useRouter();
  const { insets, isPhone, screenWidth, screenHeight } = usePhoneLayout();
  const isTabletLandscape = !isPhone && screenWidth > screenHeight;

  const [directives, setDirectives] = useState<Directive[]>([]);
  const [approvals, setApprovals] = useState<EnrichedApproval[]>([]);
  const [filter, setFilter] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Approval modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [modalDirectiveId, setModalDirectiveId] = useState<string | null>(null);
  const [modalTitle, setModalTitle] = useState("");
  const [modalPlan, setModalPlan] = useState("");
  const [modalPin, setModalPin] = useState("");
  const [modalError, setModalError] = useState("");
  const [modalLoading, setModalLoading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [directiveData, approvalData] = await Promise.all([
        fetchDirectives(),
        fetchApprovalDetails().catch(() => [] as EnrichedApproval[]),
      ]);
      setDirectives(directiveData);
      setApprovals(approvalData);
    } catch (e: any) {
      setError(e.message || "Failed to load directives");
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  useFocusEffect(
    useCallback(() => {
      loadData();
      // Auto-refresh every 15s
      const interval = setInterval(loadData, 15000);
      return () => clearInterval(interval);
    }, [loadData])
  );

  // Action handler
  const handleAction = useCallback(
    async (action: string, id: string) => {
      try {
        if (action === "approve") {
          // Open modal
          const approval = approvals.find((a) => a.directiveId === id);
          setModalDirectiveId(id);
          setModalTitle(approval?.directiveTitle || id);
          setModalPlan(approval?.directivePlan || approval?.directiveDescription || "No plan details available.");
          setModalPin("");
          setModalError("");
          setModalVisible(true);
          return;
        }
        if (action === "deny") {
          Alert.alert("Deny Plan", "Cancel this directive?", [
            { text: "No", style: "cancel" },
            {
              text: "Yes, Deny",
              style: "destructive",
              onPress: async () => {
                await cancelDirective(id);
                loadData();
              },
            },
          ]);
          return;
        }
        if (action === "cancel") {
          Alert.alert("Cancel Directive", "Are you sure?", [
            { text: "No", style: "cancel" },
            {
              text: "Cancel It",
              style: "destructive",
              onPress: async () => {
                await cancelDirective(id);
                loadData();
              },
            },
          ]);
          return;
        }
        if (action === "retry") {
          const result = await retryDirective(id);
          if (!result.ok) Alert.alert("Error", result.error || "Retry failed");
          loadData();
          return;
        }
        if (action === "retry_merge") {
          const result = await retryMergeDirective(id);
          if (result.ok) {
            Alert.alert("Success", "Merge succeeded! Deploying now.");
          } else {
            Alert.alert("Merge Failed", result.error || "Merge failed again");
          }
          loadData();
          return;
        }
        if (action === "unblock") {
          const result = await unblockDirective(id);
          if (!result.ok) Alert.alert("Error", result.error || "Unblock failed");
          loadData();
          return;
        }
      } catch (err: any) {
        Alert.alert("Error", err.message || "Action failed");
      }
    },
    [approvals, loadData]
  );

  const submitApproval = useCallback(async () => {
    if (!modalPin) {
      setModalError("PIN is required");
      return;
    }
    setModalLoading(true);
    setModalError("");
    try {
      const approval = approvals.find((a) => a.directiveId === modalDirectiveId);
      if (!approval) {
        setModalError("Approval not found — may already be resolved");
        return;
      }
      const result = await resolveApproval(approval.id, true, modalPin);
      if (result.ok) {
        setModalVisible(false);
        loadData();
      } else {
        setModalError(result.error || "Approval failed");
      }
    } catch (err: any) {
      setModalError(err.message || "Network error");
    } finally {
      setModalLoading(false);
    }
  }, [modalPin, modalDirectiveId, approvals, loadData]);

  // Status counts
  const statusCounts: Record<string, number> = {};
  for (const d of directives) {
    statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
  }
  const needsActionCount = directives.filter((d) => NEEDS_ACTION_STATUSES.includes(d.status)).length;
  const activeCount = directives.filter((d) => ACTIVE_STATUSES.includes(d.status)).length;
  const failedCount = directives.filter((d) => FAILED_STATUSES.includes(d.status)).length;
  const completedCount = statusCounts["completed"] || 0;

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

  // Sort: needs-action first, then active, then terminal
  const sorted = [...filtered].sort((a, b) => {
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

      {/* Filter Chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ maxHeight: 44, flexGrow: 0 }}
        contentContainerStyle={{
          paddingHorizontal: hPad,
          gap: 8,
          alignItems: "center",
          paddingVertical: 6,
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
              PENDING APPROVALS ({approvals.length})
            </Text>
            {approvals.map((a) => (
              <View
                key={a.id}
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
                  <ActionButton
                    label="APPROVE"
                    color="#22C55E"
                    onPress={() => handleAction("approve", a.directiveId || "")}
                  />
                  <ActionButton
                    label="DENY"
                    color="#EF4444"
                    onPress={() => handleAction("deny", a.directiveId || "")}
                  />
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {error ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: "#EF4444", fontSize: 12, fontFamily: "monospace", textAlign: "center" }}>
              {error}
            </Text>
            <Pressable onPress={loadData} style={{ marginTop: 12 }}>
              <Text style={{ color: "#06B6D4", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
                TAP TO RETRY
              </Text>
            </Pressable>
          </View>
        ) : sorted.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 }}>
            <Text style={{ color: "#06B6D4", fontSize: 13, fontFamily: "monospace", opacity: 0.6 }}>
              No directives found
            </Text>
          </View>
        ) : isTabletLandscape ? (
          sorted.map((d) => (
            <View key={d.id} style={{ width: "48%", marginBottom: 2 }}>
              <DirectiveCard directive={d} isTabletLandscape={false} onAction={handleAction} />
            </View>
          ))
        ) : (
          sorted.map((d) => (
            <DirectiveCard key={d.id} directive={d} isTabletLandscape={false} onAction={handleAction} />
          ))
        )}
      </ScrollView>

      {/* Approval Modal */}
      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.8)",
            justifyContent: "center",
            alignItems: "center",
            padding: 24,
          }}
          onPress={() => setModalVisible(false)}
        >
          <Pressable
            style={{
              backgroundColor: "#1A1A1A",
              borderWidth: 1,
              borderColor: "#333",
              borderRadius: 12,
              padding: 20,
              width: "100%",
              maxWidth: 500,
              maxHeight: "80%",
            }}
            onPress={() => {}}
          >
            <Text style={{ color: "#E5E5E5", fontSize: 16, fontFamily: "monospace", fontWeight: "bold", marginBottom: 14 }}>
              Approve: {modalTitle}
            </Text>

            <ScrollView style={{ maxHeight: 250, marginBottom: 14 }}>
              <View
                style={{
                  backgroundColor: "#111",
                  borderWidth: 1,
                  borderColor: "#2A2A2A",
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <Text style={{ color: "#A3A3A3", fontSize: 12, fontFamily: "monospace", lineHeight: 18 }}>
                  {modalPlan}
                </Text>
              </View>
            </ScrollView>

            <Text style={{ color: "#737373", fontSize: 12, fontFamily: "monospace", marginBottom: 6 }}>
              PIN
            </Text>
            <TextInput
              value={modalPin}
              onChangeText={setModalPin}
              secureTextEntry
              maxLength={8}
              placeholder="Enter PIN"
              placeholderTextColor="#444"
              autoFocus
              onSubmitEditing={submitApproval}
              style={{
                backgroundColor: "#111",
                color: "#E5E5E5",
                borderWidth: 1,
                borderColor: "#333",
                borderRadius: 8,
                padding: 12,
                fontSize: 18,
                fontFamily: "monospace",
                textAlign: "center",
                letterSpacing: 6,
                marginBottom: 14,
              }}
            />

            {modalError ? (
              <Text style={{ color: "#EF4444", fontSize: 12, fontFamily: "monospace", marginBottom: 10 }}>
                {modalError}
              </Text>
            ) : null}

            <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end" }}>
              <Pressable
                onPress={() => setModalVisible(false)}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: "#2A2A2A",
                }}
              >
                <Text style={{ color: "#A3A3A3", fontSize: 14, fontFamily: "monospace", fontWeight: "bold" }}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={submitApproval}
                disabled={modalLoading}
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: modalLoading ? "#333" : "#22C55E",
                }}
              >
                <Text style={{ color: "#fff", fontSize: 14, fontFamily: "monospace", fontWeight: "bold" }}>
                  {modalLoading ? "Approving..." : "Approve"}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <StatusBar style="light" />
    </View>
  );
}
