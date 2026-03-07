import { View, Text, ScrollView, Pressable, Linking } from "react-native";
import type { OsintFinding } from "../../lib/bridge-api";

interface Props {
  findings: OsintFinding[];
}

export function FaceSearchResults({ findings }: Props) {
  const faceFindings = findings.filter(f => f.module === "face-search" || f.module === "scene-analysis" || f.module === "identity-resolver");

  const verifiedMatches = faceFindings.filter(f => f.raw_data?.type === "verified_face_matches" || f.raw_data?.type === "biometric_face_matches");
  const identityCandidates = faceFindings.filter(f => f.raw_data?.type === "identity_candidates");
  const discoveredProfiles = faceFindings.filter(f => f.raw_data?.type === "discovered_profile");
  const sceneAnalysis = faceFindings.filter(f => f.raw_data?.type === "scene_analysis");
  const pivotRecs = faceFindings.filter(f => f.raw_data?.type === "pivot_recommendation");

  if (faceFindings.length === 0) {
    return (
      <View style={{ padding: 20 }}>
        <Text style={{ color: "#666", fontFamily: "SpaceMono", textAlign: "center", fontSize: 12 }}>
          No face search results. Upload an image profile and run a scan.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, padding: 12 }}>
      {/* Verified face matches */}
      {verifiedMatches.map((f, i) => {
        const matches = f.raw_data?.verifiedMatches || [];
        return (
          <View key={`vm-${i}`} style={{ marginBottom: 16 }}>
            <Text style={{ color: "#f44336", fontFamily: "SpaceMono", fontSize: 13, fontWeight: "bold", marginBottom: 8 }}>
              VERIFIED FACE MATCHES ({matches.length})
            </Text>
            {matches.slice(0, 10).map((m: any, j: number) => (
              <Pressable
                key={j}
                onPress={() => m.sourceUrl && Linking.openURL(m.sourceUrl)}
                style={{ backgroundColor: "#1a1a1a", borderRadius: 8, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: m.similarity > 0.7 ? "#f44336" : "#ffab00" }}
              >
                <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 12 }}>
                  {(m.similarity * 100).toFixed(1)}% — {m.title || "Unknown"}
                </Text>
                <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 10, marginTop: 2 }} numberOfLines={1}>
                  {m.sourceUrl}
                </Text>
                <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 9, marginTop: 2 }}>
                  Engine: {m.engine}
                </Text>
              </Pressable>
            ))}
          </View>
        );
      })}

      {/* Identity candidates */}
      {identityCandidates.map((f, i) => {
        const candidates = f.raw_data?.candidates || [];
        return (
          <View key={`ic-${i}`} style={{ marginBottom: 16 }}>
            <Text style={{ color: "#ffab00", fontFamily: "SpaceMono", fontSize: 13, fontWeight: "bold", marginBottom: 8 }}>
              IDENTITY CANDIDATES ({candidates.length})
            </Text>
            {candidates.slice(0, 10).map((c: any, j: number) => (
              <View key={j} style={{ backgroundColor: "#1a1a1a", borderRadius: 8, padding: 10, marginBottom: 6 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 13, fontWeight: "bold" }}>
                    "{c.name}"
                  </Text>
                  <Text style={{ color: c.confidence > 0.7 ? "#4caf50" : "#ffab00", fontFamily: "SpaceMono", fontSize: 12 }}>
                    {(c.confidence * 100).toFixed(0)}%
                  </Text>
                </View>
                <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 10, marginTop: 2 }}>
                  {c.sourceCount} source(s): {c.platforms?.join(", ")}
                </Text>
              </View>
            ))}
          </View>
        );
      })}

      {/* Discovered social profiles */}
      {discoveredProfiles.length > 0 && (
        <View style={{ marginBottom: 16 }}>
          <Text style={{ color: "#00e5ff", fontFamily: "SpaceMono", fontSize: 13, fontWeight: "bold", marginBottom: 8 }}>
            DISCOVERED PROFILES ({discoveredProfiles.length})
          </Text>
          {discoveredProfiles.map((f, i) => (
            <Pressable
              key={i}
              onPress={() => f.source_url && Linking.openURL(f.source_url)}
              style={{ backgroundColor: "#1a1a1a", borderRadius: 8, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: "#00e5ff" }}
            >
              <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 12 }}>
                {f.raw_data?.platform}: @{f.raw_data?.username}
              </Text>
              <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 10, marginTop: 2 }}>
                Similarity: {((f.raw_data?.similarity || 0) * 100).toFixed(1)}%
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Scene analysis */}
      {sceneAnalysis.map((f, i) => (
        <View key={`sa-${i}`} style={{ marginBottom: 16 }}>
          <Text style={{ color: "#9c27b0", fontFamily: "SpaceMono", fontSize: 13, fontWeight: "bold", marginBottom: 8 }}>
            SCENE ANALYSIS
          </Text>
          <View style={{ backgroundColor: "#1a1a1a", borderRadius: 8, padding: 12 }}>
            <Text style={{ color: "#ccc", fontFamily: "SpaceMono", fontSize: 11, lineHeight: 18 }}>
              {f.description}
            </Text>
          </View>
        </View>
      ))}

      {/* Pivot recommendations */}
      {pivotRecs.length > 0 && (
        <View style={{ marginBottom: 16 }}>
          <Text style={{ color: "#4caf50", fontFamily: "SpaceMono", fontSize: 13, fontWeight: "bold", marginBottom: 8 }}>
            PIVOT RECOMMENDATIONS ({pivotRecs.length})
          </Text>
          {pivotRecs.slice(0, 10).map((f, i) => (
            <View key={i} style={{ backgroundColor: "#1a1a1a", borderRadius: 8, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: f.raw_data?.autoExecute ? "#4caf50" : "#555" }}>
              <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 11 }}>
                {f.title}
              </Text>
              {f.raw_data?.autoExecute && (
                <Text style={{ color: "#4caf50", fontFamily: "SpaceMono", fontSize: 9, marginTop: 2 }}>
                  AUTO-EXECUTING
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
