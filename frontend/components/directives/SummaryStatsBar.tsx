import { View, Text, Pressable, ScrollView } from "react-native";
import type { Directive } from "../../lib/bridge-api";

const ACTIVE_STATUSES = ["pending", "planning", "planned", "approved", "in_progress", "blocked"];
const FAILED_STATUSES = ["failed", "stale", "deploy_failed"];
const NEEDS_ACTION_STATUSES = ["planned", "blocked", "deploy_failed"];

interface SummaryStatsBarProps {
  directives: Directive[];
  onFilterSelect: (filter: string) => void;
  hPad: number;
}

function StatChip({
  emoji,
  count,
  label,
  color,
  onPress,
}: {
  emoji: string;
  count: number;
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: `${color}12`,
        borderWidth: 1,
        borderColor: `${color}30`,
      }}
    >
      <Text style={{ fontSize: 12 }}>{emoji}</Text>
      <Text
        style={{
          color,
          fontSize: 14,
          fontFamily: "monospace",
          fontWeight: "bold",
        }}
      >
        {count}
      </Text>
      <Text
        style={{
          color: `${color}CC`,
          fontSize: 9,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function SummaryStatsBar({ directives, onFilterSelect, hPad }: SummaryStatsBarProps) {
  const needsAction = directives.filter((d) => NEEDS_ACTION_STATUSES.includes(d.status)).length;
  const active = directives.filter((d) => ACTIVE_STATUSES.includes(d.status)).length;
  const completed = directives.filter((d) => d.status === "completed").length;
  const total = directives.length;
  const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, maxHeight: 48 }}
      contentContainerStyle={{
        paddingHorizontal: hPad,
        gap: 8,
        alignItems: "center",
        paddingVertical: 6,
      }}
    >
      <StatChip emoji="🔥" count={needsAction} label="NEEDS ACTION" color="#F59E0B" onPress={() => onFilterSelect("needs_action")} />
      <StatChip emoji="🚀" count={active} label="ACTIVE" color="#3B82F6" onPress={() => onFilterSelect("active")} />
      <StatChip emoji="✅" count={completed} label="COMPLETED" color="#22C55E" onPress={() => onFilterSelect("completed")} />
      <StatChip emoji="📊" count={successRate} label="% SUCCESS" color="#06B6D4" onPress={() => onFilterSelect("all")} />
    </ScrollView>
  );
}
