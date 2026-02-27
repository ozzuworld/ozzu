import { useState } from "react";
import { View, Text, Pressable, LayoutAnimation, Platform, UIManager } from "react-native";
import { FindingCard } from "./FindingCard";
import type { OsintFinding } from "../../lib/bridge-api";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  title: string;
  emoji: string;
  color: string;
  findings: OsintFinding[];
  onStatusChange: () => void;
  defaultExpanded?: boolean;
}

export function FindingGroup({ title, emoji, color, findings, onStatusChange, defaultExpanded = true }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(!expanded);
  };

  if (findings.length === 0) return null;

  return (
    <View style={{ marginBottom: 8 }}>
      <Pressable onPress={toggle} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 4 }}>
        <Text style={{ fontSize: 14 }}>{emoji}</Text>
        <Text style={{ color, fontSize: 12, fontFamily: "monospace", fontWeight: "bold", flex: 1 }}>
          {title}
        </Text>
        <View style={{ backgroundColor: `${color}20`, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
          <Text style={{ color, fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{findings.length}</Text>
        </View>
        <Text style={{ color: "#525252", fontSize: 10 }}>{expanded ? "▲" : "▼"}</Text>
      </Pressable>
      {expanded && findings.map((f) => (
        <FindingCard key={f.id} finding={f} onStatusChange={onStatusChange} />
      ))}
    </View>
  );
}
