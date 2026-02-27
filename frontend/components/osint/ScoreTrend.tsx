import { useState, useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { scoreColor } from "../../lib/osint-constants";

interface ScoreHistoryEntry {
  score: number;
  recorded_at: string;
}

interface Props {
  scoreHistory: ScoreHistoryEntry[];
  width?: number;
}

type TimeRange = "24h" | "7d" | "30d";

const RANGE_MS: Record<TimeRange, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function ScoreTrend({ scoreHistory, width = 320 }: Props) {
  const [range, setRange] = useState<TimeRange>("30d");
  const [expanded, setExpanded] = useState(false);
  const barAreaHeight = expanded ? 80 : 40;

  const filtered = useMemo(() => {
    const cutoff = Date.now() - RANGE_MS[range];
    return scoreHistory
      .filter((e) => new Date(e.recorded_at).getTime() >= cutoff)
      .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
  }, [scoreHistory, range]);

  if (filtered.length < 2) {
    return (
      <View style={{ alignItems: "center", paddingVertical: 8 }}>
        <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
          Not enough data yet
        </Text>
      </View>
    );
  }

  const scores = filtered.map((e) => e.score);
  const minScore = Math.max(0, Math.min(...scores) - 5);
  const maxScore = Math.min(100, Math.max(...scores) + 5);
  const scoreRange = maxScore - minScore || 1;

  // Compute bar chart data
  const barWidth = Math.max(2, Math.floor((width - 16) / filtered.length) - 1);
  const currentScore = scores[scores.length - 1];
  const lineColor = scoreColor(currentScore);

  return (
    <View>
      <Pressable onPress={() => setExpanded(!expanded)}>
        <View
          style={{
            backgroundColor: "#0A0A0A",
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#1A1A1A",
            overflow: "hidden",
            padding: 8,
          }}
        >
          {/* Bar chart using Views */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              height: barAreaHeight,
              gap: 1,
              justifyContent: "center",
            }}
          >
            {filtered.map((entry, i) => {
              const heightPct = ((entry.score - minScore) / scoreRange) * 100;
              const isLast = i === filtered.length - 1;
              return (
                <View
                  key={i}
                  style={{
                    width: barWidth,
                    height: `${Math.max(4, heightPct)}%`,
                    backgroundColor: isLast ? lineColor : `${lineColor}60`,
                    borderRadius: 1,
                  }}
                />
              );
            })}
          </View>

          {/* Date labels when expanded */}
          {expanded && (
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                marginTop: 4,
                paddingHorizontal: 2,
              }}
            >
              {[filtered[0], filtered[filtered.length - 1]].map((entry, i) => {
                if (!entry) return null;
                const d = new Date(entry.recorded_at);
                return (
                  <Text
                    key={i}
                    style={{ color: "#333", fontSize: 8, fontFamily: "monospace" }}
                  >
                    {d.getMonth() + 1}/{d.getDate()}
                  </Text>
                );
              })}
            </View>
          )}
        </View>
      </Pressable>

      {/* Range toggle chips */}
      <View style={{ flexDirection: "row", gap: 6, marginTop: 6, justifyContent: "center" }}>
        {(["24h", "7d", "30d"] as TimeRange[]).map((r) => (
          <Pressable
            key={r}
            onPress={() => setRange(r)}
            style={{
              backgroundColor: range === r ? "#1E1E1E" : "transparent",
              borderWidth: 1,
              borderColor: range === r ? "#333" : "#1A1A1A",
              borderRadius: 4,
              paddingHorizontal: 8,
              paddingVertical: 2,
            }}
          >
            <Text
              style={{
                color: range === r ? "#E5E5E5" : "#525252",
                fontSize: 10,
                fontFamily: "monospace",
                fontWeight: range === r ? "bold" : "normal",
              }}
            >
              {r}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
