import { View, Text, Pressable, Image, Alert } from "react-native";
import { useState } from "react";
import { getBridgeUrl, getAuthHeaders, triggerOsintScan, type OsintProfile, type OsintFinding } from "../../lib/bridge-api";

interface Props {
  profile: OsintProfile;
  findings: OsintFinding[];
  onPress: () => void;
  onScanComplete?: () => void;
}

export function VipBubble({ profile, findings, onPress, onScanComplete }: Props) {
  const [imageError, setImageError] = useState(false);
  const [scanning, setScanning] = useState(false);

  // Extract identity from findings
  const identityFinding = findings.find(
    (f) => f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates"
  );
  const topCandidate = identityFinding?.raw_data?.candidates?.[0];
  const identityName = topCandidate?.name || profile.label || "Unknown Subject";
  const confidence = topCandidate?.confidence || 0;

  // Count key stats
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  const newFindings = findings.filter((f) => f.status === "new").length;
  const totalFindings = findings.length;
  const discoveredProfiles = findings.filter((f) => f.raw_data?.type === "discovered_profile").length;
  const matchPages = findings.find((f) => f.raw_data?.type === "unverified_matches")?.raw_data?.sourceUrls?.length || 0;
  const verifiedMatches = findings.find((f) => f.raw_data?.type === "verified_face_matches")?.raw_data?.verifiedMatches?.length || 0;

  // Image URL
  const imageUrl = `${getBridgeUrl()}/osint/images/${profile.id}/thumbnail`;

  // Threat level
  const threatColor = criticalCount > 0 ? "#ef4444" : highCount > 0 ? "#f97316" : totalFindings > 5 ? "#eab308" : "#22c55e";
  const threatLabel = criticalCount > 0 ? "HIGH EXPOSURE" : highCount > 0 ? "MODERATE" : totalFindings > 5 ? "LOW RISK" : "CLEAN";

  const handleLongPress = () => {
    Alert.alert(
      identityName.toUpperCase(),
      `Profile #${profile.id}`,
      [
        {
          text: "Scan Now",
          onPress: async () => {
            setScanning(true);
            try {
              await triggerOsintScan(profile.id);
              onScanComplete?.();
            } catch {}
            setScanning(false);
          },
        },
        { text: "Cancel", style: "cancel" },
      ]
    );
  };

  return (
    <Pressable onPress={onPress} onLongPress={handleLongPress}>
      {({ pressed }) => (
        <View
          style={{
            backgroundColor: pressed ? "#1a1a1a" : "#0a0a0a",
            borderRadius: 16,
            padding: 20,
            alignItems: "center",
            borderWidth: 1,
            borderColor: pressed ? threatColor : "#1a1a1a",
          }}
        >
          {/* Photo bubble with threat ring + overlays */}
          <View style={{ marginBottom: 14 }}>
            <View
              style={{
                width: 110,
                height: 110,
                borderRadius: 55,
                borderWidth: 3,
                borderColor: threatColor,
                padding: 3,
              }}
            >
              {!imageError ? (
                <Image
                  source={{ uri: imageUrl, headers: getAuthHeaders() }}
                  style={{ width: "100%", height: "100%", borderRadius: 50 }}
                  onError={() => setImageError(true)}
                />
              ) : (
                <View
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: 50,
                    backgroundColor: "#1a1a1a",
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <Text style={{ fontSize: 36 }}>{"👤"}</Text>
                </View>
              )}
            </View>

            {/* Alert dot — pulsing red for critical/high new findings */}
            {(criticalCount > 0 || highCount > 0) && newFindings > 0 && (
              <View
                style={{
                  position: "absolute",
                  top: 2,
                  right: 2,
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: "#ef4444",
                  borderWidth: 2,
                  borderColor: "#0a0a0a",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text style={{ color: "#fff", fontSize: 7, fontWeight: "bold", fontFamily: "SpaceMono" }}>
                  {newFindings > 9 ? "!" : newFindings}
                </Text>
              </View>
            )}

            {/* Confidence badge overlay — bottom right of photo */}
            {confidence > 0 && (
              <View
                style={{
                  position: "absolute",
                  bottom: -2,
                  right: -2,
                  backgroundColor: confidence > 0.7 ? "#22c55e22" : "#eab30822",
                  borderRadius: 8,
                  paddingHorizontal: 5,
                  paddingVertical: 2,
                  borderWidth: 1,
                  borderColor: confidence > 0.7 ? "#22c55e44" : "#eab30844",
                }}
              >
                <Text
                  style={{
                    color: confidence > 0.7 ? "#22c55e" : "#eab308",
                    fontFamily: "SpaceMono",
                    fontSize: 8,
                    fontWeight: "bold",
                  }}
                >
                  {(confidence * 100).toFixed(0)}%
                </Text>
              </View>
            )}

            {/* Scanning indicator */}
            {scanning && (
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  borderRadius: 55,
                  backgroundColor: "#00000088",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text style={{ color: "#00e5ff", fontFamily: "SpaceMono", fontSize: 9 }}>SCANNING</Text>
              </View>
            )}
          </View>

          {/* Name */}
          <Text
            style={{
              color: "#e5e5e5",
              fontFamily: "SpaceMono",
              fontSize: 15,
              fontWeight: "bold",
              textTransform: "uppercase",
              letterSpacing: 1.5,
              textAlign: "center",
              marginBottom: 2,
            }}
            numberOfLines={1}
          >
            {identityName}
          </Text>

          {/* Subtitle — identity confidence text */}
          <Text
            style={{
              color: "#525252",
              fontFamily: "SpaceMono",
              fontSize: 9,
              marginBottom: 10,
              letterSpacing: 0.5,
            }}
          >
            {confidence > 0
              ? `${(confidence * 100).toFixed(0)}% IDENTITY CONFIDENCE`
              : "UNIDENTIFIED SUBJECT"}
          </Text>

          {/* Threat badge */}
          <View
            style={{
              backgroundColor: threatColor + "18",
              borderRadius: 4,
              paddingHorizontal: 12,
              paddingVertical: 4,
              marginBottom: 14,
              borderWidth: 1,
              borderColor: threatColor + "33",
            }}
          >
            <Text
              style={{
                color: threatColor,
                fontFamily: "SpaceMono",
                fontSize: 10,
                fontWeight: "bold",
                letterSpacing: 2,
              }}
            >
              {threatLabel}
            </Text>
          </View>

          {/* Stats row */}
          <View
            style={{
              flexDirection: "row",
              gap: 16,
              justifyContent: "center",
              marginBottom: 4,
            }}
          >
            <StatBubble value={totalFindings} label="FINDINGS" color="#a3a3a3" />
            {criticalCount > 0 && (
              <StatBubble value={criticalCount} label="CRITICAL" color="#ef4444" />
            )}
            {highCount > 0 && (
              <StatBubble value={highCount} label="HIGH" color="#f97316" />
            )}
            {verifiedMatches > 0 && (
              <StatBubble value={verifiedMatches} label="FACE HITS" color="#ef4444" />
            )}
            {matchPages > 0 && (
              <StatBubble value={matchPages} label="MATCHES" color="#eab308" />
            )}
            {discoveredProfiles > 0 && (
              <StatBubble value={discoveredProfiles} label="PROFILES" color="#00e5ff" />
            )}
          </View>

          {/* Dashed divider */}
          <View style={{ width: "60%", height: 1, borderTopWidth: 1, borderStyle: "dashed", borderColor: "#222", marginVertical: 10 }} />

          {/* Tap hint */}
          <Text
            style={{
              color: "#404040",
              fontFamily: "SpaceMono",
              fontSize: 9,
              letterSpacing: 1.5,
            }}
          >
            TAP TO OPEN DOSSIER
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function StatBubble({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <View style={{ alignItems: "center", minWidth: 40 }}>
      <Text style={{ color, fontFamily: "SpaceMono", fontSize: 18, fontWeight: "bold" }}>
        {value}
      </Text>
      <Text style={{ color: "#525252", fontFamily: "SpaceMono", fontSize: 7, letterSpacing: 0.5 }}>
        {label}
      </Text>
    </View>
  );
}
