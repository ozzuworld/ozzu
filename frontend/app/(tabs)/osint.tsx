import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  ActivityIndicator,
  Dimensions,
  Image,
  Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { useOsint } from "../../lib/osint-hooks";
import {
  triggerOsintScan,
  getBridgeUrl,
  getAuthHeaders,
  type OsintProfile,
} from "../../lib/bridge-api";
import { AddProfileModal } from "../../components/osint/AddProfileModal";
import { IntelDossier } from "../../components/osint/IntelDossier";

export default function OsintScreen() {
  const { insets } = usePhoneLayout();
  const screenWidth = Dimensions.get("window").width;
  const {
    profiles,
    findings,
    loading,
    refresh,
    isScanning,
    setIsScanning,
  } = useOsint();

  const [refreshing, setRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<OsintProfile | null>(null);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  // Full-screen dossier when a subject is selected
  if (selectedProfile) {
    return (
      <View style={{ flex: 1, backgroundColor: "#080808" }}>
        <StatusBar style="light" />
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <IntelDossier
            profile={selectedProfile}
            findings={findings.filter(f => f.profile_id === selectedProfile.id)}
            allFindings={findings}
            onBack={() => setSelectedProfile(null)}
          />
        </View>
      </View>
    );
  }

  const imageProfiles = profiles.filter(p => p.profile_type === "image");
  const columns = screenWidth > 500 ? 3 : 2;
  const gap = 14;
  const cardW = (screenWidth - 40 - gap * (columns - 1)) / columns;

  return (
    <View style={{ flex: 1, backgroundColor: "#080808" }}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={{ paddingTop: insets.top + 16, paddingBottom: 20, paddingHorizontal: 24 }}>
        <Text style={{ color: "#f5f5f5", fontSize: 24, fontWeight: "700", letterSpacing: 1 }}>
          Intelligence
        </Text>
        <Text style={{ color: "#2a2a2a", fontSize: 11, marginTop: 4, letterSpacing: 1 }}>
          {imageProfiles.length > 0
            ? `${imageProfiles.length} subject${imageProfiles.length !== 1 ? "s" : ""} monitored`
            : "No subjects yet"}
        </Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#222" />}
      >
        {/* Scanning banner */}
        {isScanning && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#0a1218", borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: "#0e2a3a" }}>
            <ActivityIndicator color="#00b4d8" size="small" />
            <Text style={{ color: "#00b4d8", fontSize: 12, fontWeight: "600", flex: 1 }}>Scanning...</Text>
          </View>
        )}

        {loading && profiles.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 80 }}>
            <ActivityIndicator color="#222" size="large" />
          </View>
        )}

        {/* Subject grid */}
        {imageProfiles.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
            {imageProfiles.map(p => (
              <SubjectCard
                key={p.id}
                profile={p}
                findings={findings.filter(f => f.profile_id === p.id)}
                width={cardW}
                onPress={() => setSelectedProfile(p)}
                onScan={async () => {
                  setIsScanning(true);
                  try { await triggerOsintScan(p.id); } catch {}
                  setTimeout(refresh, 3000);
                }}
              />
            ))}

            {/* Add subject card */}
            <Pressable onPress={() => setShowAddModal(true)}>
              {({ pressed }) => (
                <View style={{
                  width: cardW,
                  aspectRatio: 0.85,
                  backgroundColor: pressed ? "#0e0e0e" : "transparent",
                  borderRadius: 20,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: 1.5,
                  borderColor: "#1a1a1a",
                  borderStyle: "dashed",
                }}>
                  <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: "#111", justifyContent: "center", alignItems: "center", marginBottom: 10 }}>
                    <Text style={{ color: "#333", fontSize: 22, fontWeight: "300" }}>+</Text>
                  </View>
                  <Text style={{ color: "#2a2a2a", fontSize: 10, fontWeight: "600", letterSpacing: 1 }}>
                    ADD SUBJECT
                  </Text>
                </View>
              )}
            </Pressable>
          </View>
        )}

        {/* Empty state */}
        {!loading && imageProfiles.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 100 }}>
            <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: "#0e0e0e", justifyContent: "center", alignItems: "center", marginBottom: 28 }}>
              <Text style={{ color: "#1a1a1a", fontSize: 32 }}>+</Text>
            </View>
            <Text style={{ color: "#666", fontSize: 16, fontWeight: "600", marginBottom: 6 }}>
              No Subjects
            </Text>
            <Text style={{ color: "#2a2a2a", fontSize: 12, textAlign: "center", lineHeight: 18, marginBottom: 28, paddingHorizontal: 40 }}>
              Upload a photo to begin an intelligence investigation
            </Text>
            <Pressable
              onPress={() => setShowAddModal(true)}
              style={({ pressed }) => ({
                backgroundColor: pressed ? "#0e2a3a" : "#0a1a28",
                borderRadius: 12,
                paddingHorizontal: 32,
                paddingVertical: 14,
              })}
            >
              <Text style={{ color: "#00b4d8", fontSize: 13, fontWeight: "700" }}>
                Start Investigation
              </Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      <AddProfileModal visible={showAddModal} onClose={() => setShowAddModal(false)} onCreated={refresh} />
    </View>
  );
}

// ─── Subject Card ───
function SubjectCard({ profile, findings, width, onPress, onScan }: {
  profile: OsintProfile; findings: any[]; width: number; onPress: () => void; onScan: () => void;
}) {
  const [imgErr, setImgErr] = useState(false);
  const imageUrl = `${getBridgeUrl()}/osint/images/${profile.id}/thumbnail`;

  const idFinding = findings.find(f => f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates");
  const name = idFinding?.raw_data?.candidates?.[0]?.name || profile.display_name || "Unknown";

  const critical = findings.filter(f => f.severity === "critical").length;
  const high = findings.filter(f => f.severity === "high").length;
  const total = findings.length;
  const newCount = findings.filter(f => f.status === "new").length;

  const ringColor = critical > 0 ? "#dc2626" : high > 0 ? "#ea580c" : total > 5 ? "#ca8a04" : "#16a34a";
  const statusText = critical > 0 ? "HIGH RISK" : high > 0 ? "MODERATE" : total > 5 ? "LOW RISK" : "CLEAR";

  const photoSize = Math.min(width * 0.48, 72);

  return (
    <Pressable onPress={onPress} onLongPress={() => {
      Alert.alert(name, `Subject #${profile.id}`, [
        { text: "Scan Now", onPress: onScan },
        { text: "Cancel", style: "cancel" },
      ]);
    }}>
      {({ pressed }) => (
        <View style={{
          width,
          aspectRatio: 0.85,
          backgroundColor: pressed ? "#111" : "#0c0c0c",
          borderRadius: 20,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: pressed ? ringColor + "55" : "#141414",
          paddingHorizontal: 8,
        }}>
          {/* Photo */}
          <View style={{ position: "relative", marginBottom: 14 }}>
            <View style={{
              width: photoSize + 8,
              height: photoSize + 8,
              borderRadius: (photoSize + 8) / 2,
              borderWidth: 2.5,
              borderColor: ringColor,
              justifyContent: "center",
              alignItems: "center",
            }}>
              {!imgErr ? (
                <Image
                  source={{ uri: imageUrl, headers: getAuthHeaders() }}
                  style={{ width: photoSize, height: photoSize, borderRadius: photoSize / 2 }}
                  onError={() => setImgErr(true)}
                />
              ) : (
                <View style={{ width: photoSize, height: photoSize, borderRadius: photoSize / 2, backgroundColor: "#141414", justifyContent: "center", alignItems: "center" }}>
                  <Text style={{ fontSize: 24, color: "#222" }}>?</Text>
                </View>
              )}
            </View>

            {/* New findings badge */}
            {newCount > 0 && (critical > 0 || high > 0) && (
              <View style={{
                position: "absolute", top: -3, right: -3,
                minWidth: 20, height: 20, borderRadius: 10,
                backgroundColor: "#dc2626", borderWidth: 2.5, borderColor: "#0c0c0c",
                justifyContent: "center", alignItems: "center", paddingHorizontal: 4,
              }}>
                <Text style={{ color: "#fff", fontSize: 9, fontWeight: "800" }}>
                  {newCount > 9 ? "9+" : newCount}
                </Text>
              </View>
            )}
          </View>

          {/* Name */}
          <Text style={{ color: "#ccc", fontSize: 12, fontWeight: "700", textAlign: "center", marginBottom: 6 }} numberOfLines={1}>
            {name}
          </Text>

          {/* Status */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: ringColor }} />
            <Text style={{ color: ringColor, fontSize: 8, fontWeight: "700", letterSpacing: 1 }}>
              {statusText}
            </Text>
          </View>

          {/* Finding count */}
          {total > 0 && (
            <Text style={{ color: "#222", fontSize: 9, marginTop: 8 }}>
              {total} finding{total !== 1 ? "s" : ""}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}
