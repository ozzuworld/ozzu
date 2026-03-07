import { View, Text, Pressable } from "react-native";
import type { IdentityCluster } from "../../lib/bridge-api";

function confidenceColor(conf: number): string {
  if (conf >= 70) return "#22C55E";
  if (conf >= 50) return "#EAB308";
  if (conf >= 30) return "#F97316";
  return "#6B7280";
}

function barWidth(score: number): string {
  return `${Math.max(Math.round(score * 100), 2)}%`;
}

interface Props {
  cluster: IdentityCluster;
  onPress?: () => void;
}

export function IdentityClusterCard({ cluster, onPress }: Props) {
  const color = confidenceColor(cluster.confidence);

  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: "#111111",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "#222",
        padding: 12,
        gap: 8,
      }}
    >
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: 16 }}>🧬</Text>
        <Text style={{ color: "#E5E5E5", fontSize: 12, fontFamily: "monospace", fontWeight: "bold", flex: 1 }} numberOfLines={1}>
          {cluster.cluster_label}
        </Text>
        <View style={{ backgroundColor: `${color}20`, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
          <Text style={{ color, fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>
            {cluster.confidence}%
          </Text>
        </View>
      </View>

      {/* Stats row */}
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
          <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>ENTITIES</Text>
          <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{cluster.entity_count}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
          <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>PROFILES</Text>
          <Text style={{ color: "#A855F7", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{cluster.profile_count}</Text>
        </View>
      </View>

      {/* Breakdown bars */}
      {cluster.breakdown && (
        <View style={{ gap: 3 }}>
          {[
            { label: "FACE", score: cluster.breakdown.faceScore, color: "#EC4899" },
            { label: "USER", score: cluster.breakdown.usernameScore, color: "#22C55E" },
            { label: "EMAIL", score: cluster.breakdown.emailScore, color: "#3B82F6" },
            { label: "BREACH", score: cluster.breakdown.breachScore, color: "#EF4444" },
            { label: "PLAT", score: cluster.breakdown.platformScore, color: "#F59E0B" },
          ].filter(b => b.score > 0).map((b) => (
            <View key={b.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ color: "#404040", fontSize: 8, fontFamily: "monospace", width: 36 }}>{b.label}</Text>
              <View style={{ flex: 1, height: 4, backgroundColor: "#1A1A1A", borderRadius: 2 }}>
                <View style={{ width: barWidth(b.score), height: 4, backgroundColor: b.color, borderRadius: 2 }} />
              </View>
              <Text style={{ color: "#525252", fontSize: 8, fontFamily: "monospace", width: 28, textAlign: "right" }}>
                {Math.round(b.score * 100)}%
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Evidence */}
      {cluster.evidence && (
        <Text style={{ color: "#404040", fontSize: 9, fontFamily: "monospace", fontStyle: "italic" }} numberOfLines={1}>
          {cluster.evidence}
        </Text>
      )}
    </Pressable>
  );
}
