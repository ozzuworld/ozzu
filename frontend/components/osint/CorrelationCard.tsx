import { useState } from "react";
import { View, Text, Pressable, LayoutAnimation, Platform, UIManager } from "react-native";
import {
  CORRELATION_TYPE_EMOJI,
  CORRELATION_TYPE_LABELS,
  CORRELATION_TYPE_COLORS,
  PROFILE_TYPE_EMOJI,
} from "../../lib/osint-constants";
import type { OsintCorrelation } from "../../lib/bridge-api";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  correlation: OsintCorrelation;
}

export function CorrelationCard({ correlation: c }: Props) {
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(!expanded);
  };

  const typeColor = CORRELATION_TYPE_COLORS[c.correlation_type] || "#525252";
  const typeBg = `${typeColor}15`;
  const confPct = Math.round(c.confidence * 100);
  const confColor = c.confidence >= 0.8 ? "#22C55E" : c.confidence >= 0.5 ? "#EAB308" : "#6B7280";

  let evidence: Record<string, any> | null = null;
  if (c.evidence) {
    try {
      evidence = typeof c.evidence === "string" ? JSON.parse(c.evidence) : c.evidence;
    } catch { /* ignore */ }
  }

  return (
    <Pressable onPress={toggle}>
      <View style={{ backgroundColor: typeBg, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: `${typeColor}30` }}>
        {/* Header row */}
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
          <Text style={{ fontSize: 14 }}>{CORRELATION_TYPE_EMOJI[c.correlation_type] || "🔗"}</Text>
          <Text style={{ color: typeColor, fontSize: 10, fontFamily: "monospace", fontWeight: "bold", marginLeft: 6, flex: 1 }}>
            {CORRELATION_TYPE_LABELS[c.correlation_type] || c.correlation_type.toUpperCase()}
          </Text>
          <Text style={{ color: confColor, fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
            {confPct}%
          </Text>
        </View>

        {/* Confidence bar */}
        <View style={{ height: 3, backgroundColor: "#1A1A1A", borderRadius: 2, marginBottom: 10 }}>
          <View style={{ height: 3, width: `${confPct}%`, backgroundColor: confColor, borderRadius: 2 }} />
        </View>

        {/* Source → Target */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flex: 1, gap: 4 }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: "#1A1A1A", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 14 }}>{PROFILE_TYPE_EMOJI[c.source_type || ""] || "📋"}</Text>
            </View>
            <Text style={{ color: "#E5E5E5", fontSize: 11, fontFamily: "monospace", flex: 1 }} numberOfLines={1}>
              {c.source_label || c.source_value}
            </Text>
          </View>
          <Text style={{ color: typeColor, fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>↔</Text>
          <View style={{ flexDirection: "row", alignItems: "center", flex: 1, gap: 4, justifyContent: "flex-end" }}>
            <Text style={{ color: "#E5E5E5", fontSize: 11, fontFamily: "monospace", flex: 1, textAlign: "right" }} numberOfLines={1}>
              {c.target_label || c.target_value}
            </Text>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: "#1A1A1A", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 14 }}>{PROFILE_TYPE_EMOJI[c.target_type || ""] || "📋"}</Text>
            </View>
          </View>
        </View>

        {/* Evidence preview (first line) */}
        {evidence && !expanded && (
          <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace", marginTop: 6 }} numberOfLines={1}>
            {Object.entries(evidence).slice(0, 1).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("")}
          </Text>
        )}

        {/* Expanded evidence */}
        {expanded && evidence && (
          <View style={{ marginTop: 8, backgroundColor: "#0A0A0A", borderRadius: 6, padding: 8, gap: 3 }}>
            {Object.entries(evidence).map(([key, val]) => (
              <View key={key} style={{ flexDirection: "row", gap: 8 }}>
                <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace", minWidth: 80 }}>{key}:</Text>
                <Text style={{ color: "#A3A3A3", fontSize: 10, fontFamily: "monospace", flex: 1 }}>
                  {typeof val === "object" ? JSON.stringify(val) : String(val)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </Pressable>
  );
}
