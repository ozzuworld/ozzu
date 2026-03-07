import { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, ActivityIndicator } from "react-native";
import { fetchOsintEkf, type EkfSummary } from "../../lib/bridge-api";

interface Props {
  profileId: number;
}

const ATTR_LABELS: Record<string, { label: string; emoji: string; isPercent?: boolean }> = {
  identity_certainty: { label: "Identity Certainty", emoji: "🎯", isPercent: true },
  name_confidence: { label: "Name Confidence", emoji: "👤", isPercent: true },
  location_confidence: { label: "Location Confidence", emoji: "📍", isPercent: true },
  age_estimate: { label: "Age Estimate", emoji: "🎂" },
  employer_confidence: { label: "Employer Confidence", emoji: "🏢", isPercent: true },
  online_presence: { label: "Online Presence", emoji: "🌐" },
  threat_level: { label: "Threat Level", emoji: "⚠" },
};

export function EKFDashboard({ profileId }: Props) {
  const [summary, setSummary] = useState<EkfSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchOsintEkf(profileId);
      setSummary(data.summary);
    } catch {}
    setLoading(false);
  }, [profileId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <ActivityIndicator color="#00e5ff" style={{ marginTop: 20 }} />;

  if (!summary) {
    return (
      <View style={{ padding: 20 }}>
        <Text style={{ color: "#666", fontFamily: "SpaceMono", textAlign: "center", fontSize: 12 }}>
          No EKF state available. Run a scan to generate intelligence estimates.
        </Text>
      </View>
    );
  }

  const ci = summary.confidence_intervals || {};

  return (
    <ScrollView style={{ flex: 1, padding: 12 }}>
      <Text style={{ color: "#00e5ff", fontFamily: "SpaceMono", fontSize: 13, marginBottom: 4 }}>
        EXTENDED KALMAN FILTER — INTELLIGENCE FUSION
      </Text>
      <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 10, marginBottom: 16 }}>
        {summary.observations} observations fused from multiple sensors
      </Text>

      {Object.entries(ATTR_LABELS).map(([key, { label, emoji, isPercent }]) => {
        const ciData = ci[key];
        const value = ciData?.value ?? 0;
        const stddev = ciData?.stddev ?? 0;
        const displayVal = (summary as any)[key] || (isPercent ? `${(value * 100).toFixed(1)}%` : value.toFixed(1));

        // Confidence bar (0-1 for percents, 0-100 for scores)
        const barValue = isPercent ? Math.min(1, Math.max(0, value)) : Math.min(1, Math.max(0, value / 100));
        const barColor = barValue > 0.7 ? "#4caf50" : barValue > 0.4 ? "#ffab00" : "#f44336";

        return (
          <View key={key} style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
              <Text style={{ color: "#ccc", fontFamily: "SpaceMono", fontSize: 12 }}>
                {emoji} {label}
              </Text>
              <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 12, fontWeight: "bold" }}>
                {displayVal}
              </Text>
            </View>

            {/* Confidence bar */}
            <View style={{ height: 6, backgroundColor: "#222", borderRadius: 3, overflow: "hidden" }}>
              <View style={{ height: 6, width: `${barValue * 100}%`, backgroundColor: barColor, borderRadius: 3 }} />
            </View>

            {/* Uncertainty range */}
            {stddev > 0.01 && (
              <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 9, marginTop: 2 }}>
                95% CI: [{isPercent ? `${(Math.max(0, ciData.ci95_low) * 100).toFixed(1)}%` : ciData.ci95_low.toFixed(1)}, {isPercent ? `${(Math.min(1, ciData.ci95_high) * 100).toFixed(1)}%` : ciData.ci95_high.toFixed(1)}] | σ={isPercent ? (stddev * 100).toFixed(2) : stddev.toFixed(2)}
              </Text>
            )}
          </View>
        );
      })}

      <View style={{ marginTop: 20, padding: 12, backgroundColor: "#111", borderRadius: 8, borderWidth: 1, borderColor: "#222" }}>
        <Text style={{ color: "#00e5ff", fontFamily: "SpaceMono", fontSize: 11, marginBottom: 6 }}>
          HOW IT WORKS
        </Text>
        <Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 10, lineHeight: 16 }}>
          The Extended Kalman Filter fuses observations from all scanner modules (face search, social intel, breach data, etc.) into unified confidence estimates. Each module has calibrated noise parameters — LinkedIn is trusted more for employer data, face search for identity, scene analysis for location. More scans = lower uncertainty.
        </Text>
      </View>
    </ScrollView>
  );
}
