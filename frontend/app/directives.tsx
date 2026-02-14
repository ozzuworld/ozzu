import { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  Animated,
  LayoutAnimation,
  UIManager,
  Platform,
  useWindowDimensions,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { fetchDirectives, type Directive } from "../lib/bridge-api";

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
};

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  planned: 1,
  planning: 2,
  pending: 3,
  approved: 4,
  blocked: 5,
  completed: 6,
  failed: 7,
  cancelled: 8,
  stale: 9,
};

const FILTER_CHIPS = [
  { key: "all", label: "ALL" },
  { key: "pending", label: "PENDING" },
  { key: "in_progress", label: "IN PROGRESS" },
  { key: "planned", label: "PLANNED" },
  { key: "completed", label: "COMPLETED" },
  { key: "failed", label: "FAILED" },
  { key: "cancelled", label: "CANCELLED" },
];

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

function DirectiveCard({
  directive,
  isTabletLandscape,
}: {
  directive: Directive;
  isTabletLandscape: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = STATUS_COLORS[directive.status] || "#737373";

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
      {/* Collapsed header */}
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
        <Text
          style={{
            color: "#525252",
            fontSize: 12,
            fontFamily: "monospace",
          }}
        >
          {expanded ? "▲" : "▼"}
        </Text>
      </View>

      {/* Meta row: type badge, priority, relative time */}
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
        <Text
          style={{
            color: "#525252",
            fontSize: 10,
            fontFamily: "monospace",
          }}
        >
          {relativeTime(directive.updatedAt)}
        </Text>
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
          {directive.status?.toUpperCase().replace("_", " ")}
        </Text>
      </View>

      {/* Expanded content */}
      {expanded && (
        <View style={{ marginTop: 12 }}>
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

          {/* Failure reason */}
          {directive.failureReason ? (
            <View
              style={{
                backgroundColor: "rgba(239,68,68,0.1)",
                borderWidth: 1,
                borderColor: "rgba(239,68,68,0.3)",
                borderRadius: 6,
                padding: 10,
                marginBottom: 10,
              }}
            >
              <Text
                style={{
                  color: "#EF4444",
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 1,
                  marginBottom: 4,
                }}
              >
                FAILURE REASON
              </Text>
              <Text
                style={{
                  color: "#FCA5A5",
                  fontSize: 11,
                  fontFamily: "monospace",
                  lineHeight: 16,
                }}
              >
                {directive.failureReason}
              </Text>
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

          {/* Activity log */}
          {directive.activity_log && directive.activity_log.length > 0 ? (
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
                ACTIVITY
              </Text>
              {directive.activity_log.map((entry, i) => (
                <View
                  key={i}
                  style={{
                    flexDirection: "row",
                    gap: 8,
                    marginLeft: 8,
                    marginBottom: 2,
                  }}
                >
                  <Text
                    style={{
                      color: "#525252",
                      fontSize: 10,
                      fontFamily: "monospace",
                    }}
                  >
                    {formatTimestamp(entry.timestamp)}
                  </Text>
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
      <Text
        style={{
          color: "#A3A3A3",
          fontSize: 11,
          fontFamily: "monospace",
        }}
      >
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
  const [filter, setFilter] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDirectives = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchDirectives();
      setDirectives(data);
    } catch (e: any) {
      setError(e.message || "Failed to load directives");
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadDirectives();
    setRefreshing(false);
  }, [loadDirectives]);

  // Load on screen focus
  useFocusEffect(
    useCallback(() => {
      loadDirectives();
    }, [loadDirectives])
  );

  // Compute status counts
  const statusCounts: Record<string, number> = {};
  for (const d of directives) {
    statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
  }

  // Filter
  const filtered =
    filter === "all"
      ? directives
      : directives.filter((d) => d.status === filter);

  // Sort: active statuses first, then terminal, within each group by updatedAt desc
  const sorted = [...filtered].sort((a, b) => {
    const orderA = STATUS_ORDER[a.status] ?? 99;
    const orderB = STATUS_ORDER[b.status] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return b.updatedAt - a.updatedAt;
  });

  const hPad = Math.max(16, insets.left, insets.right);

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
            style={{
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 6,
            }}
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

      {/* Status Filter Chips */}
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
          const count =
            chip.key === "all"
              ? directives.length
              : statusCounts[chip.key] || 0;
          const chipColor =
            chip.key === "all" ? "#06B6D4" : STATUS_COLORS[chip.key] || "#737373";

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
                backgroundColor: isActive
                  ? `${chipColor}15`
                  : "#1A1A1A",
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

      {/* Divider */}
      <View style={{ height: 1, backgroundColor: "#222", marginHorizontal: hPad }} />

      {/* Directive List */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: hPad,
          paddingBottom: Math.max(24, insets.bottom),
          gap: 10,
          ...(isTabletLandscape
            ? { flexDirection: "row", flexWrap: "wrap" }
            : {}),
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
        {error ? (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              paddingVertical: 60,
            }}
          >
            <Text
              style={{
                color: "#EF4444",
                fontSize: 12,
                fontFamily: "monospace",
                textAlign: "center",
              }}
            >
              {error}
            </Text>
            <Pressable onPress={loadDirectives} style={{ marginTop: 12 }}>
              <Text
                style={{
                  color: "#06B6D4",
                  fontSize: 12,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                }}
              >
                TAP TO RETRY
              </Text>
            </Pressable>
          </View>
        ) : sorted.length === 0 ? (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              paddingVertical: 60,
            }}
          >
            <Text
              style={{
                color: "#06B6D4",
                fontSize: 13,
                fontFamily: "monospace",
                opacity: 0.6,
              }}
            >
              No directives found
            </Text>
          </View>
        ) : isTabletLandscape ? (
          // 2-column layout for tablet landscape
          sorted.map((d) => (
            <View
              key={d.id}
              style={{ width: "48%", marginBottom: 2 }}
            >
              <DirectiveCard directive={d} isTabletLandscape={false} />
            </View>
          ))
        ) : (
          sorted.map((d) => (
            <DirectiveCard
              key={d.id}
              directive={d}
              isTabletLandscape={false}
            />
          ))
        )}
      </ScrollView>

      <StatusBar style="light" />
    </View>
  );
}
