import { useState, useCallback, useRef, useEffect } from "react";
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
  Animated,
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

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

export default function OsintScreen() {
  const { insets } = usePhoneLayout();
  const { profiles, findings, loading, refresh, isScanning, setIsScanning } = useOsint();
  const [refreshing, setRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<OsintProfile | null>(null);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  if (selectedProfile) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000" }}>
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

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <StatusBar style="light" />

      {/* Subtle grid background effect */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0.03 }}>
        {Array.from({ length: 20 }).map((_, i) => (
          <View key={`h${i}`} style={{ position: "absolute", top: i * 40, left: 0, right: 0, height: 1, backgroundColor: "#fff" }} />
        ))}
        {Array.from({ length: 12 }).map((_, i) => (
          <View key={`v${i}`} style={{ position: "absolute", left: i * 40, top: 0, bottom: 0, width: 1, backgroundColor: "#fff" }} />
        ))}
      </View>

      {/* Header */}
      <View style={{ paddingTop: insets.top + 20, paddingHorizontal: 24, paddingBottom: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View>
            <Text style={{ color: "#f5f5f5", fontSize: 20, fontWeight: "800", letterSpacing: 2 }}>
              INTELLIGENCE
            </Text>
            {isScanning && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
                <PulsingDot color="#00b4d8" size={6} />
                <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "600" }}>SCANNING</Text>
              </View>
            )}
          </View>
          <Pressable onPress={() => setShowAddModal(true)} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "#111", justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: "#1a1a1a" }}>
            <Text style={{ color: "#555", fontSize: 18, fontWeight: "300" }}>+</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111" />}
      >
        {loading && profiles.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 100 }}>
            <ActivityIndicator color="#222" size="large" />
          </View>
        )}

        {/* Subjects — floating target field */}
        {imageProfiles.length > 0 && (
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            {imageProfiles.map((p, idx) => (
              <SubjectRow
                key={p.id}
                profile={p}
                findings={findings.filter(f => f.profile_id === p.id)}
                onPress={() => setSelectedProfile(p)}
                onScan={async () => {
                  setIsScanning(true);
                  try { await triggerOsintScan(p.id); } catch {}
                  setTimeout(refresh, 3000);
                }}
                index={idx}
              />
            ))}
          </View>
        )}

        {/* Empty state */}
        {!loading && imageProfiles.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 100 }}>
            <View style={{ width: 100, height: 100, borderRadius: 50, borderWidth: 1, borderColor: "#1a1a1a", justifyContent: "center", alignItems: "center", marginBottom: 24 }}>
              <View style={{ width: 60, height: 60, borderRadius: 30, borderWidth: 1, borderColor: "#1a1a1a", justifyContent: "center", alignItems: "center" }}>
                <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: "#1a1a1a" }} />
              </View>
            </View>
            <Text style={{ color: "#444", fontSize: 14, fontWeight: "700", letterSpacing: 2, marginBottom: 8 }}>NO TARGETS</Text>
            <Text style={{ color: "#222", fontSize: 11, textAlign: "center", marginBottom: 28 }}>
              Add a subject to begin surveillance
            </Text>
            <Pressable onPress={() => setShowAddModal(true)} style={({ pressed }) => ({ backgroundColor: pressed ? "#0e2a3a" : "#0a1520", borderRadius: 24, paddingHorizontal: 28, paddingVertical: 12 })}>
              <Text style={{ color: "#00b4d8", fontSize: 12, fontWeight: "700" }}>NEW INVESTIGATION</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      <AddProfileModal visible={showAddModal} onClose={() => setShowAddModal(false)} onCreated={refresh} />
    </View>
  );
}

// ─── Subject Row — profile card with photo, threat glow, stats ───
function SubjectRow({ profile, findings, onPress, onScan, index }: {
  profile: OsintProfile; findings: any[]; onPress: () => void; onScan: () => void; index: number;
}) {
  const [imgErr, setImgErr] = useState(false);
  const imageUrl = `${getBridgeUrl()}/osint/images/${profile.id}/thumbnail`;

  const idFinding = findings.find(f => f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates");
  const topCandidate = idFinding?.raw_data?.candidates?.[0];
  const name = topCandidate?.name || profile.display_name || "Unknown";
  const confidence = topCandidate?.confidence || 0;

  const crit = findings.filter(f => f.severity === "critical").length;
  const high = findings.filter(f => f.severity === "high").length;
  const total = findings.length;
  const newCount = findings.filter(f => f.status === "new").length;
  const faceMatches = findings.filter(f => f.raw_data?.type === "verified_face_matches").reduce((n, f) => n + (f.raw_data?.verifiedMatches?.length || 0), 0);
  const profiles_found = findings.filter(f => f.raw_data?.type === "discovered_profile").length;

  const threatColor = crit > 0 ? "#dc2626" : high > 0 ? "#ea580c" : total > 5 ? "#ca8a04" : "#16a34a";
  const threatLabel = crit > 0 ? "HIGH" : high > 0 ? "MED" : total > 5 ? "LOW" : "CLR";

  return (
    <Pressable onPress={onPress} onLongPress={() => Alert.alert(name, `#${profile.id}`, [{ text: "Scan", onPress: onScan }, { text: "Cancel", style: "cancel" }])}>
      {({ pressed }) => (
        <View style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: pressed ? "#0a0a0a" : "#050505",
          borderRadius: 16,
          padding: 14,
          marginBottom: 10,
          borderWidth: 1,
          borderColor: pressed ? threatColor + "33" : "#111",
        }}>
          {/* Photo with glow ring */}
          <View style={{ position: "relative", marginRight: 16 }}>
            {/* Glow effect */}
            <View style={{
              position: "absolute", top: -4, left: -4, right: -4, bottom: -4,
              borderRadius: 34, backgroundColor: threatColor, opacity: 0.08,
            }} />
            <View style={{
              width: 56, height: 56, borderRadius: 28,
              borderWidth: 2.5, borderColor: threatColor,
              overflow: "hidden",
            }}>
              {!imgErr ? (
                <Image source={{ uri: imageUrl, headers: getAuthHeaders() }} style={{ width: 51, height: 51, borderRadius: 25 }} onError={() => setImgErr(true)} />
              ) : (
                <View style={{ width: 51, height: 51, borderRadius: 25, backgroundColor: "#111", justifyContent: "center", alignItems: "center" }}>
                  <Text style={{ color: "#222", fontSize: 20 }}>?</Text>
                </View>
              )}
            </View>
            {/* New badge */}
            {newCount > 0 && (crit > 0 || high > 0) && (
              <View style={{ position: "absolute", top: -4, right: -4, width: 18, height: 18, borderRadius: 9, backgroundColor: "#dc2626", borderWidth: 2, borderColor: "#050505", justifyContent: "center", alignItems: "center" }}>
                <Text style={{ color: "#fff", fontSize: 8, fontWeight: "900" }}>{newCount > 9 ? "!" : newCount}</Text>
              </View>
            )}
          </View>

          {/* Info */}
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#e5e5e5", fontSize: 14, fontWeight: "700", marginBottom: 3 }} numberOfLines={1}>{name}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <MiniStat value={total} label="findings" />
              {faceMatches > 0 && <MiniStat value={faceMatches} label="faces" color="#a855f7" />}
              {profiles_found > 0 && <MiniStat value={profiles_found} label="profiles" color="#00b4d8" />}
            </View>
          </View>

          {/* Threat indicator */}
          <View style={{ alignItems: "center", marginLeft: 8 }}>
            {/* Circular threat badge */}
            <View style={{
              width: 38, height: 38, borderRadius: 19,
              borderWidth: 2, borderColor: threatColor,
              justifyContent: "center", alignItems: "center",
              backgroundColor: threatColor + "0a",
            }}>
              <Text style={{ color: threatColor, fontSize: 10, fontWeight: "900", letterSpacing: 0.5 }}>{threatLabel}</Text>
            </View>
          </View>

          {/* Chevron */}
          <Text style={{ color: "#1a1a1a", fontSize: 16, marginLeft: 8 }}>{">"}</Text>
        </View>
      )}
    </Pressable>
  );
}

function MiniStat({ value, label, color }: { value: number; label: string; color?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Text style={{ color: color || "#555", fontSize: 12, fontWeight: "800" }}>{value}</Text>
      <Text style={{ color: "#2a2a2a", fontSize: 9 }}>{label}</Text>
    </View>
  );
}

function PulsingDot({ color, size }: { color: string; size: number }) {
  const anim = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: anim }} />;
}
