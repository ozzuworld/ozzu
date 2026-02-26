import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { StatusBadge } from "../components/StatusBadge";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { useOsint } from "../lib/osint-hooks";
import {
  deleteOsintProfile,
  triggerOsintScan,
  type OsintProfile,
} from "../lib/bridge-api";
import {
  SEVERITY_EMOJI,
  SEVERITY_COLORS,
  PROFILE_TYPE_EMOJI,
  scoreColor,
  scoreLabel,
} from "../lib/osint-constants";
import { FindingCard } from "../components/osint/FindingCard";
import { AddProfileModal } from "../components/osint/AddProfileModal";

const TOP_BAR_HEIGHT = 48;

const FILTER_CHIPS = [
  { key: "all", label: "ALL", emoji: "🌍" },
  { key: "critical", label: "CRITICAL", emoji: "🔴" },
  { key: "high", label: "HIGH", emoji: "🟠" },
  { key: "medium", label: "MEDIUM", emoji: "🟡" },
  { key: "low", label: "LOW", emoji: "🔵" },
  { key: "info", label: "INFO", emoji: "⚪" },
];

export default function OsintScreen() {
  const router = useRouter();
  const { insets, isPhone } = usePhoneLayout();
  const { profiles, findings, score, loading, error, refresh, isScanning, setIsScanning } = useOsint();

  const [filter, setFilter] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

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
      for (const p of profiles) {
        await triggerOsintScan(p.id);
      }
    } catch (err: any) {
      Alert.alert("Scan Error", err.message);
    }
  };

  const handleDeleteProfile = (profile: OsintProfile) => {
    Alert.alert(
      "🗑 Delete Profile",
      `Remove "${profile.label}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await deleteOsintProfile(profile.id);
            refresh();
          },
        },
      ]
    );
  };

  const filteredFindings = filter === "all"
    ? findings
    : findings.filter((f) => f.severity === filter);

  const exposureScore = score?.score ?? 0;
  const sColor = scoreColor(exposureScore);
  const sLabel = scoreLabel(exposureScore);

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
          🛡 OSINT
        </Text>
        <StatusBadge />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#525252"
          />
        }
      >
        {/* Exposure Score */}
        <View
          style={{
            backgroundColor: "#1A1A1A",
            borderRadius: 12,
            padding: 16,
            marginBottom: 16,
            alignItems: "center",
            borderWidth: 1,
            borderColor: "#252525",
          }}
        >
          <Text style={{ color: "#737373", fontSize: 11, fontFamily: "monospace", letterSpacing: 2 }}>
            EXPOSURE SCORE
          </Text>
          <Text
            style={{
              color: sColor,
              fontSize: 48,
              fontFamily: "monospace",
              fontWeight: "bold",
              marginVertical: 4,
            }}
          >
            {exposureScore}
          </Text>
          <Text style={{ color: sColor, fontSize: 12, fontFamily: "monospace", fontWeight: "600", letterSpacing: 2 }}>
            {sLabel}
          </Text>
          {score && score.totalFindings > 0 && (
            <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
              {Object.entries(score.breakdown).map(([sev, count]) => (
                <Text key={sev} style={{ color: SEVERITY_COLORS[sev] || "#6B7280", fontSize: 11, fontFamily: "monospace" }}>
                  {SEVERITY_EMOJI[sev]} {count}
                </Text>
              ))}
            </View>
          )}
        </View>

        {/* Action buttons */}
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
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
            <Text style={{ color: "#60A5FA", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
              ➕ ADD PROFILE
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
            <Text style={{ color: "#4ADE80", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
              {isScanning ? "⏳ SCANNING..." : "🔍 SCAN ALL"}
            </Text>
          </Pressable>
        </View>

        {/* Profiles */}
        {profiles.length > 0 && (
          <View style={{ marginBottom: 16 }}>
            <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace", letterSpacing: 2, marginBottom: 8 }}>
              PROFILES ({profiles.length})
            </Text>
            {profiles.map((p) => (
              <View
                key={p.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: "#1A1A1A",
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 6,
                  gap: 8,
                }}
              >
                <Text style={{ fontSize: 16 }}>{PROFILE_TYPE_EMOJI[p.profile_type] || "📋"}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#E5E5E5", fontSize: 12, fontFamily: "monospace", fontWeight: "600" }}>
                    {p.label}
                  </Text>
                  <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace" }}>
                    {p.profile_type === "password" ? `${p.value}` : p.value}
                  </Text>
                </View>
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
                  <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace" }}>🔍</Text>
                </Pressable>
                <Pressable
                  onPress={() => handleDeleteProfile(p)}
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? "#3A1A1A" : "#1E1E1E",
                    borderWidth: 1,
                    borderColor: "#333",
                    borderRadius: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                  })}
                >
                  <Text style={{ color: "#EF4444", fontSize: 11, fontFamily: "monospace" }}>🗑</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* No profiles empty state */}
        {!loading && profiles.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 20 }}>
            <Text style={{ fontSize: 32, marginBottom: 8 }}>🛡</Text>
            <Text style={{ color: "#525252", fontSize: 12, fontFamily: "monospace", textAlign: "center" }}>
              Add an email, username, or password{"\n"}to start scanning for exposures
            </Text>
          </View>
        )}

        {/* Filter chips */}
        {findings.length > 0 && (
          <>
            <View style={{ flexDirection: "row", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              {FILTER_CHIPS.map((chip) => {
                const active = filter === chip.key;
                const count = chip.key === "all"
                  ? findings.length
                  : findings.filter((f) => f.severity === chip.key).length;
                return (
                  <Pressable
                    key={chip.key}
                    onPress={() => setFilter(chip.key)}
                    style={{
                      backgroundColor: active ? "#1E1E1E" : "transparent",
                      borderWidth: 1,
                      borderColor: active ? "#444" : "#252525",
                      borderRadius: 6,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                    }}
                  >
                    <Text
                      style={{
                        color: active ? "#E5E5E5" : "#525252",
                        fontSize: 11,
                        fontFamily: "monospace",
                        fontWeight: active ? "bold" : "normal",
                      }}
                    >
                      {chip.emoji} {chip.label} {count > 0 ? `(${count})` : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Findings list */}
            <Text style={{ color: "#525252", fontSize: 11, fontFamily: "monospace", letterSpacing: 2, marginBottom: 8 }}>
              FINDINGS ({filteredFindings.length})
            </Text>
          </>
        )}

        {filteredFindings.map((f) => (
          <FindingCard key={f.id} finding={f} onStatusChange={refresh} />
        ))}

        {findings.length > 0 && filteredFindings.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 20 }}>
            <Text style={{ fontSize: 24, marginBottom: 8 }}>🔍</Text>
            <Text style={{ color: "#525252", fontSize: 12, fontFamily: "monospace", textAlign: "center" }}>
              No {filter} findings
            </Text>
            <Pressable onPress={() => setFilter("all")} style={{ marginTop: 8 }}>
              <Text style={{ color: "#06B6D4", fontSize: 12, fontFamily: "monospace" }}>Show All</Text>
            </Pressable>
          </View>
        )}

        {error && (
          <View style={{ alignItems: "center", paddingVertical: 20 }}>
            <Text style={{ color: "#EF4444", fontSize: 12, fontFamily: "monospace" }}>
              ⚠️ {error}
            </Text>
          </View>
        )}
      </ScrollView>

      <AddProfileModal
        visible={showAddModal}
        onClose={() => setShowAddModal(false)}
        onCreated={refresh}
      />
    </View>
  );
}
