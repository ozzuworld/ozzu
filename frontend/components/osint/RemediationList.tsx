import { useState, useEffect, useCallback } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, Linking, LayoutAnimation, Platform, UIManager } from "react-native";
import {
  fetchAllOsintRemediations,
  fetchAllOsintRemediationStats,
  updateOsintRemediation,
  generateAllOsintRemediations,
  type OsintRemediation,
  type OsintRemediationStats,
} from "../../lib/bridge-api";
import {
  SEVERITY_COLORS,
  REMEDIATION_TYPE_EMOJI,
  REMEDIATION_STATUS_EMOJI,
  REMEDIATION_STATUS_COLORS,
} from "../../lib/osint-constants";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const PRIORITY_LABELS: Record<number, string> = { 1: "P1 — CRITICAL", 2: "P2 — HIGH", 3: "P3 — MEDIUM" };
const PRIORITY_COLORS: Record<number, string> = { 1: "#EF4444", 2: "#F97316", 3: "#EAB308" };

interface Props {
  profileId?: number;
}

export function RemediationList({ profileId }: Props) {
  const [remediations, setRemediations] = useState<OsintRemediation[]>([]);
  const [stats, setStats] = useState<OsintRemediationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [filter, setFilter] = useState<string>("all");

  const load = useCallback(async () => {
    try {
      const status = filter === "all" ? undefined : filter;
      const [rems, st] = await Promise.all([
        fetchAllOsintRemediations({ status, profileId }),
        fetchAllOsintRemediationStats(profileId),
      ]);
      setRemediations(rems);
      setStats(st);
    } catch (err) {
      console.error("Failed to load remediations:", err);
    } finally {
      setLoading(false);
    }
  }, [filter, profileId]);

  useEffect(() => { load(); }, [load]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await generateAllOsintRemediations();
      await load();
    } finally {
      setGenerating(false);
    }
  };

  const handleStatusChange = async (id: number, newStatus: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    await updateOsintRemediation(id, { status: newStatus });
    load();
  };

  // Group by priority
  const grouped: Record<number, OsintRemediation[]> = {};
  for (const r of remediations) {
    if (!grouped[r.priority]) grouped[r.priority] = [];
    grouped[r.priority].push(r);
  }

  const completedCount = stats?.completed || 0;
  const totalCount = stats?.total || 0;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <View style={{ flex: 1 }}>
      {/* Progress bar */}
      {stats && totalCount > 0 && (
        <View style={{ padding: 12, backgroundColor: "#1A1A1A", borderRadius: 8, marginBottom: 8 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
            <Text style={{ color: "#AAA", fontFamily: "monospace", fontSize: 11 }}>
              LOCKDOWN PROGRESS
            </Text>
            <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
              {completedCount}/{totalCount} ({progressPercent}%)
            </Text>
          </View>
          <View style={{ height: 6, backgroundColor: "#333", borderRadius: 3, overflow: "hidden" }}>
            <View style={{
              height: 6,
              backgroundColor: progressPercent === 100 ? "#22C55E" : "#06B6D4",
              borderRadius: 3,
              width: `${progressPercent}%`,
            }} />
          </View>
          <View style={{ flexDirection: "row", marginTop: 6, gap: 12 }}>
            <Text style={{ color: "#EAB308", fontFamily: "monospace", fontSize: 10 }}>
              {REMEDIATION_STATUS_EMOJI.pending} {stats.pending} pending
            </Text>
            <Text style={{ color: "#3B82F6", fontFamily: "monospace", fontSize: 10 }}>
              {REMEDIATION_STATUS_EMOJI.in_progress} {stats.in_progress || 0} active
            </Text>
            <Text style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 10 }}>
              {REMEDIATION_STATUS_EMOJI.completed} {stats.completed} done
            </Text>
          </View>
        </View>
      )}

      {/* Actions row */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8, gap: 8 }}>
        <Pressable
          onPress={handleGenerate}
          disabled={generating}
          style={{ backgroundColor: "#06B6D4", borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6, opacity: generating ? 0.5 : 1 }}
        >
          <Text style={{ color: "#000", fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
            {generating ? "GENERATING..." : "GENERATE"}
          </Text>
        </Pressable>

        {/* Filter pills */}
        <View style={{ flexDirection: "row", gap: 4 }}>
          {["all", "pending", "completed", "dismissed"].map((f) => (
            <Pressable
              key={f}
              onPress={() => { setFilter(f); setLoading(true); }}
              style={{
                backgroundColor: filter === f ? "#06B6D4" : "#222",
                borderRadius: 4,
                paddingHorizontal: 8,
                paddingVertical: 4,
              }}
            >
              <Text style={{
                color: filter === f ? "#000" : "#888",
                fontFamily: "monospace",
                fontSize: 10,
                fontWeight: filter === f ? "bold" : "normal",
              }}>
                {f.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color="#06B6D4" style={{ marginTop: 20 }} />
      ) : remediations.length === 0 ? (
        <View style={{ padding: 20, alignItems: "center" }}>
          <Text style={{ color: "#666", fontFamily: "monospace", fontSize: 12 }}>
            No remediations yet. Tap GENERATE to create fix-it tasks from your scan findings.
          </Text>
        </View>
      ) : (
        Object.entries(grouped)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([priority, items]) => (
            <View key={priority} style={{ marginBottom: 12 }}>
              <Text style={{
                color: PRIORITY_COLORS[Number(priority)] || "#888",
                fontFamily: "monospace",
                fontSize: 11,
                fontWeight: "bold",
                marginBottom: 4,
                marginLeft: 4,
              }}>
                {PRIORITY_LABELS[Number(priority)] || `P${priority}`} ({items.length})
              </Text>
              {items.map((rem) => (
                <RemediationItem
                  key={rem.id}
                  remediation={rem}
                  onStatusChange={handleStatusChange}
                />
              ))}
            </View>
          ))
      )}
    </View>
  );
}

function RemediationItem({ remediation, onStatusChange }: {
  remediation: OsintRemediation;
  onStatusChange: (id: number, status: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = REMEDIATION_STATUS_COLORS[remediation.status] || "#888";
  const statusEmoji = REMEDIATION_STATUS_EMOJI[remediation.status] || "⏳";
  const typeEmoji = REMEDIATION_TYPE_EMOJI[remediation.remediation_type] || "🔧";
  const isCompleted = remediation.status === "completed";
  const isDismissed = remediation.status === "dismissed";

  return (
    <Pressable
      onPress={() => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setExpanded(!expanded);
      }}
      style={{
        backgroundColor: "#1A1A1A",
        borderRadius: 6,
        padding: 10,
        marginBottom: 4,
        borderLeftWidth: 3,
        borderLeftColor: statusColor,
        opacity: isDismissed ? 0.5 : 1,
      }}
    >
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Pressable
          onPress={(e) => {
            e.stopPropagation?.();
            if (!isCompleted) {
              onStatusChange(remediation.id, "completed");
            } else {
              onStatusChange(remediation.id, "pending");
            }
          }}
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            borderWidth: 2,
            borderColor: isCompleted ? "#22C55E" : "#555",
            backgroundColor: isCompleted ? "#22C55E" : "transparent",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {isCompleted && <Text style={{ color: "#000", fontSize: 12 }}>✓</Text>}
        </Pressable>

        <Text style={{ fontSize: 14 }}>{typeEmoji}</Text>
        <Text
          style={{
            color: isCompleted ? "#666" : "#DDD",
            fontFamily: "monospace",
            fontSize: 12,
            flex: 1,
            textDecorationLine: isCompleted ? "line-through" : "none",
          }}
          numberOfLines={expanded ? undefined : 1}
        >
          {remediation.title}
        </Text>
        <Text style={{ fontSize: 12 }}>{statusEmoji}</Text>
      </View>

      {/* Expanded details */}
      {expanded && (
        <View style={{ marginTop: 8, marginLeft: 26 }}>
          {remediation.description && (
            <Text style={{ color: "#999", fontFamily: "monospace", fontSize: 11, marginBottom: 6 }}>
              {remediation.description}
            </Text>
          )}

          {remediation.profile_label && (
            <Text style={{ color: "#555", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>
              Profile: {remediation.profile_label}
            </Text>
          )}

          {remediation.finding_title && (
            <Text style={{ color: "#555", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>
              Finding: {remediation.finding_severity ? `${SEVERITY_COLORS[remediation.finding_severity] ? "●" : ""} ` : ""}{remediation.finding_title}
            </Text>
          )}

          <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
            {remediation.action_url && (
              <Pressable
                onPress={() => Linking.openURL(remediation.action_url!)}
                style={{ backgroundColor: "#06B6D4", borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4 }}
              >
                <Text style={{ color: "#000", fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
                  {remediation.action_type === "link" ? "OPEN LINK" : "VIEW"}
                </Text>
              </Pressable>
            )}

            {!isCompleted && !isDismissed && (
              <Pressable
                onPress={() => onStatusChange(remediation.id, "completed")}
                style={{ backgroundColor: "#22C55E", borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4 }}
              >
                <Text style={{ color: "#000", fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>DONE</Text>
              </Pressable>
            )}

            {!isDismissed && (
              <Pressable
                onPress={() => onStatusChange(remediation.id, "dismissed")}
                style={{ backgroundColor: "#333", borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4 }}
              >
                <Text style={{ color: "#888", fontFamily: "monospace", fontSize: 10 }}>DISMISS</Text>
              </Pressable>
            )}

            {(isCompleted || isDismissed) && (
              <Pressable
                onPress={() => onStatusChange(remediation.id, "pending")}
                style={{ backgroundColor: "#333", borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4 }}
              >
                <Text style={{ color: "#EAB308", fontFamily: "monospace", fontSize: 10 }}>REOPEN</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </Pressable>
  );
}
