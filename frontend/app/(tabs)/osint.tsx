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

  // If a profile is selected, show the full dossier
  if (selectedProfile) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0a0a0a" }}>
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
  const gap = 12;
  const bubbleWidth = (screenWidth - 32 - gap * (columns - 1)) / columns;

  return (
    <View style={{ flex: 1, backgroundColor: "#0a0a0a" }}>
      <StatusBar style="light" />

      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + 12,
          paddingBottom: 16,
          paddingHorizontal: 20,
          borderBottomWidth: 1,
          borderBottomColor: "#151515",
        }}
      >
        <Text
          style={{
            color: "#e5e5e5",
            fontSize: 22,
            fontFamily: "SpaceMono",
            fontWeight: "bold",
            letterSpacing: 3,
          }}
        >
          INTELLIGENCE
        </Text>
        <Text
          style={{
            color: "#333",
            fontSize: 10,
            fontFamily: "SpaceMono",
            letterSpacing: 2,
            marginTop: 2,
          }}
        >
          {imageProfiles.length} SUBJECT{imageProfiles.length !== 1 ? "S" : ""} UNDER SURVEILLANCE
        </Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#333" />
        }
      >
        {/* Scanning indicator */}
        {isScanning && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              backgroundColor: "#0d1117",
              borderRadius: 10,
              padding: 12,
              marginBottom: 16,
              borderWidth: 1,
              borderColor: "#00e5ff18",
            }}
          >
            <ActivityIndicator color="#00e5ff" size="small" />
            <Text style={{ color: "#00e5ff", fontSize: 11, fontFamily: "SpaceMono", flex: 1 }}>
              SCANNING IN PROGRESS...
            </Text>
          </View>
        )}

        {/* Loading state */}
        {loading && profiles.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 60 }}>
            <ActivityIndicator color="#333" size="large" />
          </View>
        )}

        {/* VIP Bubbles Grid */}
        {imageProfiles.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
            {imageProfiles.map(p => (
              <VipCard
                key={p.id}
                profile={p}
                findings={findings.filter(f => f.profile_id === p.id)}
                width={bubbleWidth}
                onPress={() => setSelectedProfile(p)}
                onScan={async () => {
                  setIsScanning(true);
                  try { await triggerOsintScan(p.id); } catch {}
                  setTimeout(refresh, 3000);
                }}
              />
            ))}

            {/* Add new subject */}
            <Pressable onPress={() => setShowAddModal(true)}>
              {({ pressed }) => (
                <View
                  style={{
                    width: bubbleWidth,
                    backgroundColor: pressed ? "#111" : "#0a0a0a",
                    borderRadius: 16,
                    padding: 20,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: "#1a1a1a",
                    borderStyle: "dashed",
                    minHeight: bubbleWidth * 1.3,
                  }}
                >
                  <View
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: 32,
                      borderWidth: 2,
                      borderColor: "#222",
                      borderStyle: "dashed",
                      justifyContent: "center",
                      alignItems: "center",
                      marginBottom: 12,
                    }}
                  >
                    <Text style={{ color: "#333", fontSize: 24 }}>+</Text>
                  </View>
                  <Text
                    style={{
                      color: "#444",
                      fontFamily: "SpaceMono",
                      fontSize: 9,
                      fontWeight: "bold",
                      letterSpacing: 1.5,
                      textAlign: "center",
                    }}
                  >
                    NEW SUBJECT
                  </Text>
                </View>
              )}
            </Pressable>
          </View>
        )}

        {/* Empty state — no profiles at all */}
        {!loading && imageProfiles.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 80 }}>
            <View
              style={{
                width: 100,
                height: 100,
                borderRadius: 50,
                borderWidth: 2,
                borderColor: "#1a1a1a",
                justifyContent: "center",
                alignItems: "center",
                marginBottom: 24,
              }}
            >
              <Text style={{ color: "#222", fontSize: 40 }}>+</Text>
            </View>
            <Text
              style={{
                color: "#555",
                fontFamily: "SpaceMono",
                fontSize: 14,
                fontWeight: "bold",
                letterSpacing: 2,
                marginBottom: 8,
              }}
            >
              NO SUBJECTS
            </Text>
            <Text
              style={{
                color: "#333",
                fontFamily: "SpaceMono",
                fontSize: 11,
                textAlign: "center",
                lineHeight: 18,
                marginBottom: 24,
                paddingHorizontal: 40,
              }}
            >
              Upload a photo to begin an intelligence investigation
            </Text>
            <Pressable
              onPress={() => setShowAddModal(true)}
              style={({ pressed }) => ({
                backgroundColor: pressed ? "#152030" : "#0d1520",
                borderWidth: 1,
                borderColor: "#00e5ff33",
                borderRadius: 10,
                paddingHorizontal: 28,
                paddingVertical: 12,
              })}
            >
              <Text
                style={{
                  color: "#00e5ff",
                  fontFamily: "SpaceMono",
                  fontSize: 12,
                  fontWeight: "bold",
                  letterSpacing: 1,
                }}
              >
                START INVESTIGATION
              </Text>
            </Pressable>
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

// ─── VIP Card ───
function VipCard({
  profile,
  findings,
  width,
  onPress,
  onScan,
}: {
  profile: OsintProfile;
  findings: any[];
  width: number;
  onPress: () => void;
  onScan: () => void;
}) {
  const [imageError, setImageError] = useState(false);
  const imageUrl = `${getBridgeUrl()}/osint/images/${profile.id}/thumbnail`;

  // Extract identity
  const identityFinding = findings.find(
    f => f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates"
  );
  const topCandidate = identityFinding?.raw_data?.candidates?.[0];
  const identityName = topCandidate?.name || profile.display_name || "Unknown";

  // Threat stats
  const criticalCount = findings.filter(f => f.severity === "critical").length;
  const highCount = findings.filter(f => f.severity === "high").length;
  const totalFindings = findings.length;
  const newFindings = findings.filter(f => f.status === "new").length;

  const threatColor = criticalCount > 0 ? "#ef4444" : highCount > 0 ? "#f97316" : totalFindings > 5 ? "#eab308" : "#22c55e";
  const threatLabel = criticalCount > 0 ? "HIGH" : highCount > 0 ? "MED" : totalFindings > 5 ? "LOW" : "CLEAR";

  const photoSize = Math.min(width * 0.55, 80);

  return (
    <Pressable onPress={onPress} onLongPress={onScan}>
      {({ pressed }) => (
        <View
          style={{
            width,
            backgroundColor: pressed ? "#111" : "#0d0d0d",
            borderRadius: 16,
            paddingVertical: 20,
            paddingHorizontal: 12,
            alignItems: "center",
            borderWidth: 1,
            borderColor: pressed ? threatColor + "44" : "#151515",
          }}
        >
          {/* Photo with threat ring */}
          <View style={{ marginBottom: 12, position: "relative" }}>
            <View
              style={{
                width: photoSize + 6,
                height: photoSize + 6,
                borderRadius: (photoSize + 6) / 2,
                borderWidth: 2.5,
                borderColor: threatColor,
                padding: 3,
              }}
            >
              {!imageError ? (
                <Image
                  source={{ uri: imageUrl, headers: getAuthHeaders() }}
                  style={{
                    width: photoSize,
                    height: photoSize,
                    borderRadius: photoSize / 2,
                  }}
                  onError={() => setImageError(true)}
                />
              ) : (
                <View
                  style={{
                    width: photoSize,
                    height: photoSize,
                    borderRadius: photoSize / 2,
                    backgroundColor: "#151515",
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <Text style={{ fontSize: 28, color: "#333" }}>?</Text>
                </View>
              )}
            </View>

            {/* Alert badge */}
            {newFindings > 0 && (criticalCount > 0 || highCount > 0) && (
              <View
                style={{
                  position: "absolute",
                  top: -2,
                  right: -2,
                  minWidth: 18,
                  height: 18,
                  borderRadius: 9,
                  backgroundColor: "#ef4444",
                  borderWidth: 2,
                  borderColor: "#0d0d0d",
                  justifyContent: "center",
                  alignItems: "center",
                  paddingHorizontal: 4,
                }}
              >
                <Text style={{ color: "#fff", fontSize: 8, fontWeight: "bold", fontFamily: "SpaceMono" }}>
                  {newFindings > 9 ? "9+" : newFindings}
                </Text>
              </View>
            )}
          </View>

          {/* Name */}
          <Text
            style={{
              color: "#d4d4d4",
              fontFamily: "SpaceMono",
              fontSize: 11,
              fontWeight: "bold",
              textTransform: "uppercase",
              letterSpacing: 1,
              textAlign: "center",
              marginBottom: 4,
            }}
            numberOfLines={1}
          >
            {identityName}
          </Text>

          {/* Threat badge */}
          <View
            style={{
              backgroundColor: threatColor + "15",
              borderRadius: 4,
              paddingHorizontal: 10,
              paddingVertical: 3,
              borderWidth: 1,
              borderColor: threatColor + "30",
            }}
          >
            <Text
              style={{
                color: threatColor,
                fontFamily: "SpaceMono",
                fontSize: 8,
                fontWeight: "bold",
                letterSpacing: 2,
              }}
            >
              {threatLabel}
            </Text>
          </View>

          {/* Stats */}
          {totalFindings > 0 && (
            <Text
              style={{
                color: "#333",
                fontFamily: "SpaceMono",
                fontSize: 8,
                marginTop: 8,
                letterSpacing: 0.5,
              }}
            >
              {totalFindings} FINDING{totalFindings !== 1 ? "S" : ""}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}
