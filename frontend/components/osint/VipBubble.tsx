import { View, Text, Pressable, Image, ActivityIndicator } from "react-native";
import { useState, useEffect } from "react";
import { getBridgeUrl, getAuthHeaders, type OsintProfile, type OsintFinding } from "../../lib/bridge-api";

interface Props {
  profile: OsintProfile;
  findings: OsintFinding[];
  onPress: () => void;
}

export function VipBubble({ profile, findings, onPress }: Props) {
  const [imageError, setImageError] = useState(false);

  // Extract identity from findings
  const identityFinding = findings.find(
    (f) => f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates"
  );
  const topCandidate = identityFinding?.raw_data?.candidates?.[0];
  const identityName = topCandidate?.name || profile.display_name || "Unknown Subject";
  const confidence = topCandidate?.confidence || 0;

  // Count key stats
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  const totalFindings = findings.length;
  const faceMatches = findings.filter((f) => f.raw_data?.type === "verified_face_matches").length;
  const sceneAnalysis = findings.find((f) => f.raw_data?.type === "scene_analysis");
  const discoveredProfiles = findings.filter((f) => f.raw_data?.type === "discovered_profile").length;

  // Image URL
  const imageUrl = `${getBridgeUrl()}/osint/images/${profile.id}/thumbnail`;

  // Threat level color
  const threatColor = criticalCount > 0 ? "#f44336" : highCount > 0 ? "#ff9800" : "#4caf50";
  const threatLabel = criticalCount > 0 ? "HIGH EXPOSURE" : highCount > 0 ? "MODERATE" : "LOW RISK";

  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <View
          style={{
            backgroundColor: pressed ? "#1a1a1a" : "#111",
            borderRadius: 16,
            padding: 20,
            alignItems: "center",
            borderWidth: 1,
            borderColor: pressed ? threatColor : "#2a2a2a",
          }}
        >
          {/* Photo bubble with ring */}
          <View
            style={{
              width: 110,
              height: 110,
              borderRadius: 55,
              borderWidth: 3,
              borderColor: threatColor,
              padding: 3,
              marginBottom: 12,
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
                  backgroundColor: "#222",
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 36 }}>👤</Text>
              </View>
            )}
          </View>

          {/* Name */}
          <Text
            style={{
              color: "#fff",
              fontFamily: "SpaceMono",
              fontSize: 16,
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

          {/* Confidence */}
          {confidence > 0 && (
            <Text
              style={{
                color: confidence > 0.7 ? "#4caf50" : "#ffab00",
                fontFamily: "SpaceMono",
                fontSize: 10,
                marginBottom: 10,
              }}
            >
              {(confidence * 100).toFixed(0)}% IDENTITY CONFIDENCE
            </Text>
          )}

          {/* Threat badge */}
          <View
            style={{
              backgroundColor: threatColor + "22",
              borderRadius: 4,
              paddingHorizontal: 10,
              paddingVertical: 4,
              marginBottom: 12,
            }}
          >
            <Text
              style={{
                color: threatColor,
                fontFamily: "SpaceMono",
                fontSize: 10,
                fontWeight: "bold",
                letterSpacing: 1.5,
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
            }}
          >
            <StatBubble
              value={totalFindings}
              label="FINDINGS"
              color="#888"
            />
            {criticalCount > 0 && (
              <StatBubble
                value={criticalCount}
                label="CRITICAL"
                color="#f44336"
              />
            )}
            {highCount > 0 && (
              <StatBubble value={highCount} label="HIGH" color="#ff9800" />
            )}
            {discoveredProfiles > 0 && (
              <StatBubble
                value={discoveredProfiles}
                label="PROFILES"
                color="#00e5ff"
              />
            )}
          </View>

          {/* Tap hint */}
          <Text
            style={{
              color: "#555",
              fontFamily: "SpaceMono",
              fontSize: 9,
              marginTop: 12,
              letterSpacing: 1,
            }}
          >
            TAP TO OPEN DOSSIER
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function StatBubble({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color: string;
}) {
  return (
    <View style={{ alignItems: "center" }}>
      <Text
        style={{
          color,
          fontFamily: "SpaceMono",
          fontSize: 18,
          fontWeight: "bold",
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          color: "#666",
          fontFamily: "SpaceMono",
          fontSize: 8,
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
