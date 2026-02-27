import { useState, useCallback, useEffect, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  Alert,
  ActivityIndicator,
  TextInput,
  Dimensions,
  LayoutAnimation,
  Platform,
  UIManager,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { StatusBadge } from "../components/StatusBadge";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { useOsint, useOsintGraph, useOsintAlerts, useOsintGroups, useOsintToolStatus } from "../lib/osint-hooks";
import {
  deleteOsintProfile,
  triggerOsintScan,
  triggerOsintScanAll,
  setOsintSchedule,
  fetchOsintReport,
  triggerOsintCorrelation,
  fetchOsintCorrelations,
  bulkUpdateOsintFindings,
  type OsintProfile,
  type OsintCorrelation,
} from "../lib/bridge-api";
import {
  SEVERITY_EMOJI,
  SEVERITY_COLORS,
  SEVERITY_ORDER,
  PROFILE_TYPE_EMOJI,
  MODULE_EMOJI,
  MODULE_LABELS,
  FINDING_STATUS_EMOJI,
  FINDING_STATUS_COLORS,
  scoreColor,
  scoreLabel,
} from "../lib/osint-constants";
import { FindingCard } from "../components/osint/FindingCard";
import { FindingGroup } from "../components/osint/FindingGroup";
import { CorrelationCard } from "../components/osint/CorrelationCard";
import { ScoreTrend } from "../components/osint/ScoreTrend";
import { AddProfileModal } from "../components/osint/AddProfileModal";
import { EntityGraph } from "../components/osint/EntityGraph";
import { ReportModal } from "../components/osint/ReportModal";
import { ReportList } from "../components/osint/ReportList";
import { AlertBanner } from "../components/osint/AlertBanner";
import { AlertList } from "../components/osint/AlertList";
import { GroupManager } from "../components/osint/GroupManager";
import { RemediationList } from "../components/osint/RemediationList";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const TOP_BAR_HEIGHT = 48;

const VIEW_TABS = [
  { key: "findings", label: "FINDINGS", emoji: "🔍" },
  { key: "graph", label: "GRAPH", emoji: "🕸" },
  { key: "correlations", label: "LINKS", emoji: "🔗" },
  { key: "reports", label: "REPORTS", emoji: "📊" },
  { key: "fixit", label: "FIX IT", emoji: "🔧" },
];

type GroupBy = "severity" | "module" | "profile";

export default function OsintScreen() {
  const router = useRouter();
  const { insets, isPhone } = usePhoneLayout();
  const screenWidth = Dimensions.get("window").width;
  const {
    profiles,
    findings,
    score,
    schedule,
    scoreHistory,
    loading,
    error,
    refresh,
    isScanning,
    setIsScanning,
  } = useOsint();
  const graph = useOsintGraph();
  const { alerts, unreadCount, refresh: refreshAlerts } = useOsintAlerts();
  const { groups, refresh: refreshGroups } = useOsintGroups();
  const { availableCount, totalCount } = useOsintToolStatus();

  const [activeView, setActiveView] = useState("findings");
  const [showAlerts, setShowAlerts] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportData, setReportData] = useState<{ markdown: string } | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [correlations, setCorrelations] = useState<OsintCorrelation[]>([]);
  const [correlationsLoading, setCorrelationsLoading] = useState(false);
  const [correlating, setCorrelating] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("severity");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("new");
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [profilesExpanded, setProfilesExpanded] = useState(true);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refresh(), graph.refresh()]);
    setRefreshing(false);
  }, [refresh, graph.refresh]);

  const handleScan = async (profileId: number) => {
    try {
      setIsScanning(true);
      await triggerOsintScan(profileId);
    } catch (err: any) {
      Alert.alert("Scan Error", err.message);
      setIsScanning(false);
    }
  };

  const handleScanAll = async () => {
    if (profiles.length === 0) {
      Alert.alert("No Profiles", "Add a profile first to scan.");
      return;
    }
    setIsScanning(true);
    try {
      await triggerOsintScanAll();
    } catch (err: any) {
      Alert.alert("Scan Error", err.message);
      setIsScanning(false);
    }
  };

  const handleDeleteProfile = (profile: OsintProfile) => {
    Alert.alert("Delete Profile", `Remove "${profile.label}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteOsintProfile(profile.id);
          refresh();
        },
      },
    ]);
  };

  const loadCorrelations = useCallback(async () => {
    try {
      setCorrelationsLoading(true);
      const data = await fetchOsintCorrelations();
      setCorrelations(data);
    } catch {
      // ignore
    } finally {
      setCorrelationsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeView === "correlations") loadCorrelations();
  }, [activeView, loadCorrelations]);

  const handleCorrelate = async () => {
    try {
      setCorrelating(true);
      await triggerOsintCorrelation();
      setTimeout(loadCorrelations, 2000);
    } catch (err: any) {
      Alert.alert("Correlation Error", err.message);
    } finally {
      setCorrelating(false);
    }
  };

  const handleOpenReport = async () => {
    setReportLoading(true);
    setShowReport(true);
    try {
      const report = await fetchOsintReport();
      setReportData(report);
    } catch (err: any) {
      Alert.alert("Report Error", err.message);
      setShowReport(false);
    } finally {
      setReportLoading(false);
    }
  };

  // Filtered + searched findings (status filter + text search)
  const filteredFindings = useMemo(() => {
    let ff = findings;
    if (statusFilter !== "all") {
      ff = ff.filter((f) => f.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      ff = ff.filter(
        (f) =>
          f.title.toLowerCase().includes(q) ||
          (f.description && f.description.toLowerCase().includes(q)) ||
          f.category.toLowerCase().includes(q)
      );
    }
    return ff;
  }, [findings, searchQuery, statusFilter]);

  // Grouped findings
  const groupedFindings = useMemo(() => {
    if (groupBy === "severity") {
      const groups: Record<string, typeof findings> = {};
      for (const sev of ["critical", "high", "medium", "low", "info"]) {
        const items = filteredFindings.filter((f) => f.severity === sev);
        if (items.length > 0) groups[sev] = items;
      }
      return Object.entries(groups).map(([key, items]) => ({
        key,
        title: key.toUpperCase(),
        emoji: SEVERITY_EMOJI[key] || "⚪",
        color: SEVERITY_COLORS[key] || "#6B7280",
        findings: items,
      }));
    }
    if (groupBy === "module") {
      const groups: Record<string, typeof findings> = {};
      for (const f of filteredFindings) {
        const mod = f.module || "unknown";
        if (!groups[mod]) groups[mod] = [];
        groups[mod].push(f);
      }
      return Object.entries(groups)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([key, items]) => ({
          key,
          title: MODULE_LABELS[key] || key.toUpperCase(),
          emoji: MODULE_EMOJI[key] || "🔍",
          color: "#06B6D4",
          findings: items,
        }));
    }
    // by profile
    const groups: Record<string, typeof findings> = {};
    for (const f of filteredFindings) {
      const pid = String(f.profile_id || "unlinked");
      if (!groups[pid]) groups[pid] = [];
      groups[pid].push(f);
    }
    return Object.entries(groups)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, items]) => {
        const profile = profiles.find((p) => String(p.id) === key);
        return {
          key,
          title: profile ? profile.label : "Unlinked",
          emoji: profile ? PROFILE_TYPE_EMOJI[profile.profile_type] || "📋" : "📋",
          color: "#A855F7",
          findings: items,
        };
      });
  }, [filteredFindings, groupBy, profiles]);

  // Status counts for summary strip
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { new: 0, acknowledged: 0, remediated: 0, false_positive: 0 };
    for (const f of findings) {
      if (counts[f.status] !== undefined) counts[f.status]++;
    }
    return counts;
  }, [findings]);

  // Score delta
  const scoreDelta = useMemo(() => {
    if (scoreHistory.length < 2) return null;
    const sorted = [...scoreHistory].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );
    const prev = sorted[sorted.length - 2].score;
    const curr = sorted[sorted.length - 1].score;
    return curr - prev;
  }, [scoreHistory]);

  const exposureScore = score?.score ?? 0;
  const sColor = scoreColor(exposureScore);
  const sLabel = scoreLabel(exposureScore);
  const chartWidth = Math.min(screenWidth - 64, 360);

  return (
    <View style={{ flex: 1, backgroundColor: "#111111" }}>
      <StatusBar style="light" />

      {/* Top bar */}
      <View
        style={{
          height: TOP_BAR_HEIGHT + insets.top,
          paddingTop: insets.top,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: "#222",
        }}
      >
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={{ color: "#525252", fontSize: 20, fontFamily: "monospace" }}>←</Text>
        </Pressable>
        <Text
          style={{
            color: "#06B6D4",
            fontSize: 13,
            fontFamily: "monospace",
            fontWeight: "bold",
            letterSpacing: 3,
          }}
        >
          OSINT
        </Text>
        <StatusBadge />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#525252" />
        }
      >
        {/* ─── ALERT BANNER ─── */}
        {showAlerts ? (
          <View style={{ height: 300, marginBottom: 12 }}>
            <AlertList alerts={alerts} onRefresh={refreshAlerts} onClose={() => setShowAlerts(false)} />
          </View>
        ) : (
          <AlertBanner alerts={alerts} unreadCount={unreadCount} onPress={() => setShowAlerts(true)} />
        )}

        {/* ─── GROUP SELECTOR ─── */}
        <GroupManager
          groups={groups}
          profiles={profiles}
          selectedGroupId={selectedGroupId}
          onSelectGroup={setSelectedGroupId}
          onRefresh={() => { refreshGroups(); refresh(); }}
        />

        {/* ─── TOOL STATUS ─── */}
        {totalCount > 0 && (
          <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: 4 }}>
            <Text style={{ color: "#555", fontFamily: "monospace", fontSize: 9 }}>
              CLI TOOLS: {availableCount}/{totalCount}
            </Text>
          </View>
        )}

        {/* ─── SCORE HERO CARD ─── */}
        <View
          style={{
            backgroundColor: "#1A1A1A",
            borderRadius: 12,
            padding: 16,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: isScanning ? "#06B6D4" : "#252525",
            flexDirection: isPhone ? "column" : "row",
            gap: 12,
          }}
        >
          {/* Left: Score number + label */}
          <View style={{ alignItems: isPhone ? "center" : "flex-start", flex: isPhone ? undefined : 1 }}>
            <Text
              style={{
                color: "#737373",
                fontSize: 10,
                fontFamily: "monospace",
                letterSpacing: 2,
                marginBottom: 2,
              }}
            >
              EXPOSURE SCORE
            </Text>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text
                style={{
                  color: sColor,
                  fontSize: 44,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                }}
              >
                {exposureScore}
              </Text>
              {scoreDelta !== null && scoreDelta !== 0 && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                  <Text
                    style={{
                      color: scoreDelta > 0 ? "#EF4444" : "#22C55E",
                      fontSize: 13,
                      fontFamily: "monospace",
                      fontWeight: "bold",
                    }}
                  >
                    {scoreDelta > 0 ? "▲" : "▼"} {Math.abs(scoreDelta)}
                  </Text>
                </View>
              )}
            </View>
            <Text
              style={{
                color: sColor,
                fontSize: 11,
                fontFamily: "monospace",
                fontWeight: "600",
                letterSpacing: 2,
              }}
            >
              {sLabel}
            </Text>
          </View>

          {/* Right: Severity breakdown */}
          {score && score.totalFindings > 0 && (
            <View style={{ gap: 3, minWidth: 120 }}>
              {Object.entries(score.breakdown)
                .sort(([a], [b]) => (SEVERITY_ORDER[a] ?? 9) - (SEVERITY_ORDER[b] ?? 9))
                .map(([sev, count]) => {
                  const pct = score.totalFindings > 0 ? (count / score.totalFindings) * 100 : 0;
                  return (
                    <View key={sev} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={{ fontSize: 10 }}>{SEVERITY_EMOJI[sev]}</Text>
                      <Text
                        style={{
                          color: "#737373",
                          fontSize: 9,
                          fontFamily: "monospace",
                          width: 52,
                        }}
                      >
                        {sev.toUpperCase()}
                      </Text>
                      <View
                        style={{
                          flex: 1,
                          height: 4,
                          backgroundColor: "#252525",
                          borderRadius: 2,
                        }}
                      >
                        <View
                          style={{
                            height: 4,
                            width: `${Math.max(2, pct)}%`,
                            backgroundColor: SEVERITY_COLORS[sev] || "#6B7280",
                            borderRadius: 2,
                          }}
                        />
                      </View>
                      <Text
                        style={{
                          color: SEVERITY_COLORS[sev] || "#6B7280",
                          fontSize: 10,
                          fontFamily: "monospace",
                          fontWeight: "bold",
                          width: 24,
                          textAlign: "right",
                        }}
                      >
                        {count}
                      </Text>
                    </View>
                  );
                })}
            </View>
          )}
        </View>

        {/* Score sparkline */}
        {scoreHistory.length >= 2 && (
          <View style={{ marginBottom: 12, paddingHorizontal: 4 }}>
            <ScoreTrend scoreHistory={scoreHistory} width={chartWidth} />
          </View>
        )}

        {/* Scanning indicator */}
        {isScanning && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: "#0A1A2A",
              borderRadius: 8,
              padding: 10,
              marginBottom: 12,
              borderWidth: 1,
              borderColor: "#06B6D430",
            }}
          >
            <ActivityIndicator color="#06B6D4" size="small" />
            <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
              SCANNING...
            </Text>
            <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
              Polling every 3s
            </Text>
          </View>
        )}

        {/* Schedule + Last scan */}
        {schedule && (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
              paddingHorizontal: 4,
            }}
          >
            <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
              {schedule.lastScanAt
                ? `LAST: ${new Date(schedule.lastScanAt).toLocaleDateString()} ${new Date(
                    schedule.lastScanAt
                  ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "NO SCANS YET"}
            </Text>
            <Pressable
              onPress={async () => {
                const options = [0, 6, 12, 24, 48];
                const current = schedule.intervalHours;
                const nextIdx = (options.indexOf(current) + 1) % options.length;
                try {
                  await setOsintSchedule(options[nextIdx]);
                  refresh();
                } catch (err: any) {
                  Alert.alert("Schedule Error", err.message);
                }
              }}
            >
              <Text
                style={{
                  color: schedule.enabled ? "#22C55E" : "#525252",
                  fontSize: 10,
                  fontFamily: "monospace",
                }}
              >
                {schedule.enabled ? `EVERY ${schedule.intervalHours}H` : "SCHEDULE: OFF"} ▸
              </Text>
            </Pressable>
          </View>
        )}

        {/* Action buttons */}
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
          <Pressable
            onPress={() => setShowAddModal(true)}
            style={({ pressed }) => ({
              flex: 1,
              backgroundColor: pressed ? "#1E3A5F" : "#0E2A4F",
              borderWidth: 1,
              borderColor: "#3B82F6",
              borderRadius: 8,
              paddingVertical: 10,
              alignItems: "center",
            })}
          >
            <Text
              style={{ color: "#60A5FA", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}
            >
              + ADD PROFILE
            </Text>
          </Pressable>
          <Pressable
            onPress={handleScanAll}
            disabled={isScanning || profiles.length === 0}
            style={({ pressed }) => ({
              flex: 1,
              backgroundColor: pressed ? "#1E3A2F" : "#0E2A1F",
              borderWidth: 1,
              borderColor: isScanning ? "#525252" : "#22C55E",
              borderRadius: 8,
              paddingVertical: 10,
              alignItems: "center",
              opacity: isScanning || profiles.length === 0 ? 0.5 : 1,
            })}
          >
            <Text
              style={{ color: "#4ADE80", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}
            >
              {isScanning ? "SCANNING..." : "SCAN ALL"}
            </Text>
          </Pressable>
        </View>

        {/* ─── PROFILES ─── */}
        {profiles.length > 0 && (
          <View style={{ marginBottom: 12 }}>
            <Pressable
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setProfilesExpanded(!profilesExpanded);
              }}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}
            >
              <Text
                style={{
                  color: "#525252",
                  fontSize: 11,
                  fontFamily: "monospace",
                  letterSpacing: 2,
                  flex: 1,
                }}
              >
                PROFILES ({profiles.length})
              </Text>
              <Text style={{ color: "#525252", fontSize: 10 }}>
                {profilesExpanded ? "▲" : "▼"}
              </Text>
            </Pressable>
            {profilesExpanded &&
              profiles.map((p) => {
                const profileFindings = findings.filter((f) => f.profile_id === p.id);
                const highestSev = profileFindings.reduce((best, f) => {
                  const o = SEVERITY_ORDER[f.severity] ?? 9;
                  return o < best.order ? { order: o, sev: f.severity } : best;
                }, { order: 9, sev: "info" });
                return (
                  <View
                    key={p.id}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      backgroundColor: "#1A1A1A",
                      borderRadius: 10,
                      padding: 10,
                      marginBottom: 6,
                      gap: 8,
                    }}
                  >
                    <View
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 16,
                        backgroundColor: "#252525",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ fontSize: 16 }}>
                        {PROFILE_TYPE_EMOJI[p.profile_type] || "📋"}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          color: "#E5E5E5",
                          fontSize: 12,
                          fontFamily: "monospace",
                          fontWeight: "600",
                        }}
                      >
                        {p.label}
                      </Text>
                      <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
                        {p.value}
                      </Text>
                    </View>
                    {profileFindings.length > 0 && (
                      <View
                        style={{
                          backgroundColor: `${SEVERITY_COLORS[highestSev.sev] || "#6B7280"}20`,
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                          borderRadius: 8,
                        }}
                      >
                        <Text
                          style={{
                            color: SEVERITY_COLORS[highestSev.sev] || "#6B7280",
                            fontSize: 10,
                            fontFamily: "monospace",
                            fontWeight: "bold",
                          }}
                        >
                          {profileFindings.length}
                        </Text>
                      </View>
                    )}
                    <Pressable
                      onPress={() => handleScan(p.id)}
                      disabled={isScanning}
                      style={({ pressed }) => ({
                        backgroundColor: pressed ? "#252525" : "#1E1E1E",
                        borderWidth: 1,
                        borderColor: "#333",
                        borderRadius: 6,
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        opacity: isScanning ? 0.5 : 1,
                      })}
                    >
                      <Text style={{ color: "#06B6D4", fontSize: 10, fontFamily: "monospace" }}>
                        SCAN
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleDeleteProfile(p)}
                      style={({ pressed }) => ({
                        backgroundColor: pressed ? "#3A1A1A" : "transparent",
                        borderRadius: 6,
                        paddingHorizontal: 6,
                        paddingVertical: 4,
                      })}
                    >
                      <Text style={{ color: "#EF4444", fontSize: 10, fontFamily: "monospace" }}>
                        DEL
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
          </View>
        )}

        {/* No profiles empty state */}
        {!loading && profiles.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 24 }}>
            <Text style={{ fontSize: 36, marginBottom: 8 }}>🔍</Text>
            <Text
              style={{
                color: "#737373",
                fontSize: 13,
                fontFamily: "monospace",
                textAlign: "center",
                marginBottom: 12,
              }}
            >
              Add Your First Profile
            </Text>
            <Text
              style={{
                color: "#525252",
                fontSize: 11,
                fontFamily: "monospace",
                textAlign: "center",
                lineHeight: 18,
              }}
            >
              Email, username, phone, domain, or IP{"\n"}to start scanning for exposures
            </Text>
            <Pressable
              onPress={() => setShowAddModal(true)}
              style={{
                marginTop: 16,
                backgroundColor: "#0E2A4F",
                borderWidth: 1,
                borderColor: "#3B82F6",
                borderRadius: 8,
                paddingHorizontal: 24,
                paddingVertical: 10,
              }}
            >
              <Text
                style={{
                  color: "#60A5FA",
                  fontSize: 12,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                }}
              >
                + ADD PROFILE
              </Text>
            </Pressable>
          </View>
        )}

        {/* ─── TAB BAR ─── */}
        <View
          style={{
            flexDirection: "row",
            marginBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: "#1A1A1A",
          }}
        >
          {VIEW_TABS.map((tab) => {
            const active = activeView === tab.key;
            const hasNew =
              tab.key === "findings" && statusCounts.new > 0;
            return (
              <Pressable
                key={tab.key}
                onPress={() => setActiveView(tab.key)}
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  alignItems: "center",
                  borderBottomWidth: active ? 3 : 0,
                  borderBottomColor: "#06B6D4",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Text
                    style={{
                      color: active ? "#06B6D4" : "#525252",
                      fontSize: 11,
                      fontFamily: "monospace",
                      fontWeight: active ? "bold" : "normal",
                    }}
                  >
                    {tab.emoji} {tab.label}
                  </Text>
                  {hasNew && (
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: "#EF4444",
                      }}
                    />
                  )}
                </View>
              </Pressable>
            );
          })}
        </View>

        {/* ─── FINDINGS VIEW ─── */}
        {activeView === "findings" && (
          <>
            {findings.length > 0 && (
              <>
                {/* Status filter pills */}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginBottom: 8 }}
                >
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    {([
                      { key: "new", label: "NEW", emoji: "\uD83C\uDD95" },
                      { key: "acknowledged", label: "ACK", emoji: "\uD83D\uDC41" },
                      { key: "remediated", label: "FIXED", emoji: "\u2705" },
                      { key: "false_positive", label: "FP", emoji: "\uD83D\uDEAB" },
                      { key: "all", label: "ALL", emoji: "" },
                    ] as const).map((pill) => {
                      const active = statusFilter === pill.key;
                      const count = pill.key === "all" ? findings.length : (statusCounts[pill.key] || 0);
                      const pillColor = pill.key === "all" ? "#525252" : (FINDING_STATUS_COLORS[pill.key] || "#525252");
                      return (
                        <Pressable key={pill.key} onPress={() => setStatusFilter(pill.key)}>
                          <View style={{
                            backgroundColor: active ? `${pillColor}25` : "#1A1A1A",
                            borderWidth: 1,
                            borderColor: active ? pillColor : "#252525",
                            borderRadius: 6,
                            paddingHorizontal: 10,
                            paddingVertical: 5,
                            flexDirection: "row",
                            gap: 4,
                            alignItems: "center",
                          }}>
                            {pill.emoji ? <Text style={{ fontSize: 10 }}>{pill.emoji}</Text> : null}
                            <Text style={{
                              color: active ? pillColor : "#525252",
                              fontSize: 10,
                              fontFamily: "monospace",
                              fontWeight: active ? "bold" : "normal",
                            }}>
                              {pill.label} {count}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>

                {/* Bulk action bar */}
                {statusFilter === "new" && statusCounts.new > 0 && (
                  <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
                    {statusCounts.new > 0 && (statusCounts as any).info !== undefined && findings.filter((f) => f.status === "new" && f.severity === "info").length > 0 && (
                      <Pressable
                        disabled={bulkUpdating}
                        onPress={() => {
                          const infoCount = findings.filter((f) => f.status === "new" && f.severity === "info").length;
                          Alert.alert("Acknowledge Info", `Mark ${infoCount} info-level findings as acknowledged?`, [
                            { text: "Cancel", style: "cancel" },
                            { text: "ACK ALL INFO", onPress: async () => {
                              setBulkUpdating(true);
                              try {
                                await bulkUpdateOsintFindings({ status: "acknowledged", severity: "info", currentStatus: "new" });
                                refresh();
                              } catch (e: any) { Alert.alert("Error", e.message); }
                              setBulkUpdating(false);
                            }},
                          ]);
                        }}
                      >
                        <View style={{ backgroundColor: "#1A1A0A", borderWidth: 1, borderColor: "#444", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}>
                          <Text style={{ color: "#EAB308", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
                            {bulkUpdating ? "..." : `\uD83D\uDC41 ACK ALL INFO (${findings.filter((f) => f.status === "new" && f.severity === "info").length})`}
                          </Text>
                        </View>
                      </Pressable>
                    )}
                    <Pressable
                      disabled={bulkUpdating}
                      onPress={() => {
                        Alert.alert("Acknowledge All", `Mark all ${statusCounts.new} new findings as acknowledged?`, [
                          { text: "Cancel", style: "cancel" },
                          { text: "ACK ALL", onPress: async () => {
                            setBulkUpdating(true);
                            try {
                              await bulkUpdateOsintFindings({ status: "acknowledged", currentStatus: "new" });
                              refresh();
                            } catch (e: any) { Alert.alert("Error", e.message); }
                            setBulkUpdating(false);
                          }},
                        ]);
                      }}
                    >
                      <View style={{ backgroundColor: "#0A1A1A", borderWidth: 1, borderColor: "#444", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}>
                        <Text style={{ color: "#06B6D4", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
                          {bulkUpdating ? "..." : `\uD83D\uDC41 ACK ALL (${statusCounts.new})`}
                        </Text>
                      </View>
                    </Pressable>
                  </View>
                )}
                {statusFilter === "acknowledged" && statusCounts.acknowledged > 0 && (
                  <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
                    <Pressable
                      disabled={bulkUpdating}
                      onPress={() => {
                        Alert.alert("Fix All", `Mark all ${statusCounts.acknowledged} acknowledged findings as fixed?`, [
                          { text: "Cancel", style: "cancel" },
                          { text: "FIXED ALL", onPress: async () => {
                            setBulkUpdating(true);
                            try {
                              await bulkUpdateOsintFindings({ status: "remediated", currentStatus: "acknowledged" });
                              refresh();
                            } catch (e: any) { Alert.alert("Error", e.message); }
                            setBulkUpdating(false);
                          }},
                        ]);
                      }}
                    >
                      <View style={{ backgroundColor: "#0A1A0A", borderWidth: 1, borderColor: "#444", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}>
                        <Text style={{ color: "#22C55E", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
                          {bulkUpdating ? "..." : `\u2705 FIXED ALL (${statusCounts.acknowledged})`}
                        </Text>
                      </View>
                    </Pressable>
                    <Pressable
                      disabled={bulkUpdating}
                      onPress={() => {
                        Alert.alert("Reopen All", `Reopen all ${statusCounts.acknowledged} acknowledged findings?`, [
                          { text: "Cancel", style: "cancel" },
                          { text: "REOPEN ALL", onPress: async () => {
                            setBulkUpdating(true);
                            try {
                              await bulkUpdateOsintFindings({ status: "new", currentStatus: "acknowledged" });
                              refresh();
                            } catch (e: any) { Alert.alert("Error", e.message); }
                            setBulkUpdating(false);
                          }},
                        ]);
                      }}
                    >
                      <View style={{ backgroundColor: "#1A0A0A", borderWidth: 1, borderColor: "#444", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}>
                        <Text style={{ color: "#EF4444", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
                          {bulkUpdating ? "..." : `\uD83C\uDD95 REOPEN ALL (${statusCounts.acknowledged})`}
                        </Text>
                      </View>
                    </Pressable>
                  </View>
                )}

                {/* Search bar */}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    backgroundColor: "#1A1A1A",
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    marginBottom: 10,
                    borderWidth: 1,
                    borderColor: searchQuery ? "#06B6D430" : "#252525",
                  }}
                >
                  <Text style={{ color: "#525252", fontSize: 12, marginRight: 6 }}>🔍</Text>
                  <TextInput
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder="Search findings..."
                    placeholderTextColor="#333"
                    style={{
                      flex: 1,
                      color: "#E5E5E5",
                      fontSize: 12,
                      fontFamily: "monospace",
                      paddingVertical: 8,
                    }}
                  />
                  {searchQuery.length > 0 && (
                    <Pressable onPress={() => setSearchQuery("")}>
                      <Text style={{ color: "#525252", fontSize: 14 }}>✕</Text>
                    </Pressable>
                  )}
                </View>

                {/* Group-by toggle */}
                <View style={{ flexDirection: "row", gap: 6, marginBottom: 10 }}>
                  {(["severity", "module", "profile"] as GroupBy[]).map((g) => (
                    <Pressable
                      key={g}
                      onPress={() => setGroupBy(g)}
                      style={{
                        backgroundColor: groupBy === g ? "#1E1E1E" : "transparent",
                        borderWidth: 1,
                        borderColor: groupBy === g ? "#444" : "#252525",
                        borderRadius: 6,
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                      }}
                    >
                      <Text
                        style={{
                          color: groupBy === g ? "#E5E5E5" : "#525252",
                          fontSize: 10,
                          fontFamily: "monospace",
                          fontWeight: groupBy === g ? "bold" : "normal",
                        }}
                      >
                        BY {g.toUpperCase()}
                      </Text>
                    </Pressable>
                  ))}
                  <View style={{ flex: 1 }} />
                  <Text
                    style={{
                      color: "#525252",
                      fontSize: 10,
                      fontFamily: "monospace",
                      alignSelf: "center",
                    }}
                  >
                    {filteredFindings.length} results
                  </Text>
                </View>

                {/* Grouped findings */}
                {groupedFindings.map((group) => (
                  <FindingGroup
                    key={group.key}
                    title={group.title}
                    emoji={group.emoji}
                    color={group.color}
                    findings={group.findings}
                    onStatusChange={refresh}
                    defaultExpanded={groupedFindings.length <= 4}
                  />
                ))}

                {filteredFindings.length === 0 && searchQuery && (
                  <View style={{ alignItems: "center", paddingVertical: 20 }}>
                    <Text style={{ color: "#525252", fontSize: 12, fontFamily: "monospace" }}>
                      No findings matching "{searchQuery}"
                    </Text>
                    <Pressable onPress={() => setSearchQuery("")} style={{ marginTop: 8 }}>
                      <Text style={{ color: "#06B6D4", fontSize: 12, fontFamily: "monospace" }}>
                        Clear Search
                      </Text>
                    </Pressable>
                  </View>
                )}
              </>
            )}

            {!loading && findings.length === 0 && profiles.length > 0 && (
              <View style={{ alignItems: "center", paddingVertical: 24 }}>
                <Text style={{ fontSize: 28, marginBottom: 8 }}>🛡</Text>
                <Text
                  style={{
                    color: "#737373",
                    fontSize: 12,
                    fontFamily: "monospace",
                    textAlign: "center",
                  }}
                >
                  No findings yet
                </Text>
                <Pressable
                  onPress={handleScanAll}
                  disabled={isScanning}
                  style={{
                    marginTop: 12,
                    backgroundColor: "#0E2A1F",
                    borderWidth: 1,
                    borderColor: "#22C55E",
                    borderRadius: 8,
                    paddingHorizontal: 20,
                    paddingVertical: 8,
                  }}
                >
                  <Text
                    style={{
                      color: "#4ADE80",
                      fontSize: 11,
                      fontFamily: "monospace",
                      fontWeight: "bold",
                    }}
                  >
                    SCAN ALL PROFILES
                  </Text>
                </Pressable>
              </View>
            )}
          </>
        )}

        {/* ─── GRAPH VIEW ─── */}
        {activeView === "graph" && (
          <EntityGraph
            entities={graph.entities}
            relationships={graph.relationships}
            summary={graph.summary}
            loading={graph.loading}
          />
        )}

        {/* ─── CORRELATIONS VIEW ─── */}
        {activeView === "correlations" && (
          <View style={{ gap: 10 }}>
            {/* Header with correlate button */}
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  color: "#06B6D4",
                  fontSize: 11,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 2,
                }}
              >
                🔗 IDENTITY LINKS ({correlations.length})
              </Text>
              <Pressable
                onPress={handleCorrelate}
                disabled={correlating || profiles.length < 2}
                style={{
                  backgroundColor: "#1A1A2E",
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 4,
                  borderWidth: 1,
                  borderColor: "#333",
                }}
              >
                <Text
                  style={{
                    color: correlating ? "#525252" : "#A855F7",
                    fontSize: 10,
                    fontFamily: "monospace",
                    fontWeight: "bold",
                  }}
                >
                  {correlating ? "ANALYZING..." : "RUN ANALYSIS"}
                </Text>
              </Pressable>
            </View>

            {/* Correlation stats strip */}
            {correlations.length > 0 && (
              <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: 4 }}>
                <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
                  AVG CONF:{" "}
                  <Text style={{ color: "#A3A3A3", fontWeight: "bold" }}>
                    {Math.round(
                      (correlations.reduce((s, c) => s + c.confidence, 0) / correlations.length) *
                        100
                    )}
                    %
                  </Text>
                </Text>
                <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
                  TOP TYPE:{" "}
                  <Text style={{ color: "#A3A3A3", fontWeight: "bold" }}>
                    {(() => {
                      const counts: Record<string, number> = {};
                      for (const c of correlations)
                        counts[c.correlation_type] = (counts[c.correlation_type] || 0) + 1;
                      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
                      return top ? top[0].replace(/_/g, " ") : "-";
                    })()}
                  </Text>
                </Text>
              </View>
            )}

            {correlationsLoading && <ActivityIndicator color="#06B6D4" size="small" />}

            {!correlationsLoading && correlations.length === 0 && (
              <View style={{ alignItems: "center", paddingVertical: 24 }}>
                <Text style={{ fontSize: 28, marginBottom: 8 }}>🔗</Text>
                <Text
                  style={{
                    color: "#737373",
                    fontSize: 12,
                    fontFamily: "monospace",
                    textAlign: "center",
                  }}
                >
                  No identity links found yet
                </Text>
                <Text
                  style={{
                    color: "#525252",
                    fontSize: 11,
                    fontFamily: "monospace",
                    textAlign: "center",
                    marginTop: 4,
                  }}
                >
                  Run analysis after scanning 2+ profiles
                </Text>
                {profiles.length >= 2 && (
                  <Pressable
                    onPress={handleCorrelate}
                    disabled={correlating}
                    style={{
                      marginTop: 12,
                      backgroundColor: "#1A1A2E",
                      borderWidth: 1,
                      borderColor: "#A855F7",
                      borderRadius: 8,
                      paddingHorizontal: 20,
                      paddingVertical: 8,
                    }}
                  >
                    <Text
                      style={{
                        color: "#A855F7",
                        fontSize: 11,
                        fontFamily: "monospace",
                        fontWeight: "bold",
                      }}
                    >
                      RUN ANALYSIS
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            {/* Sorted by confidence descending */}
            {[...correlations]
              .sort((a, b) => b.confidence - a.confidence)
              .map((c) => (
                <CorrelationCard key={c.id} correlation={c} />
              ))}
          </View>
        )}

        {/* ─── REPORTS VIEW ─── */}
        {activeView === "reports" && (
          <View style={{ gap: 12 }}>
            <Pressable
              onPress={handleOpenReport}
              style={({ pressed }) => ({
                backgroundColor: pressed ? "#1E2A3F" : "#0E1A2F",
                borderWidth: 1,
                borderColor: "#3B82F6",
                borderRadius: 8,
                paddingVertical: 10,
                alignItems: "center",
              })}
            >
              <Text
                style={{
                  color: "#60A5FA",
                  fontSize: 12,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                }}
              >
                📄 VIEW LIVE REPORT
              </Text>
            </Pressable>
            <ReportList onError={(msg) => Alert.alert("Error", msg)} />
          </View>
        )}

        {/* ─── FIX IT VIEW ─── */}
        {activeView === "fixit" && (
          <RemediationList />
        )}

        {error && (
          <View style={{ alignItems: "center", paddingVertical: 20 }}>
            <Text style={{ color: "#EF4444", fontSize: 12, fontFamily: "monospace" }}>
              {error}
            </Text>
          </View>
        )}
      </ScrollView>

      <AddProfileModal
        visible={showAddModal}
        onClose={() => setShowAddModal(false)}
        onCreated={refresh}
      />

      <ReportModal
        visible={showReport}
        onClose={() => setShowReport(false)}
        report={reportData}
        loading={reportLoading}
      />
    </View>
  );
}
