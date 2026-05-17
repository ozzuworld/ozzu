import { useState } from "react";
import { View, Text, Pressable, LayoutAnimation } from "react-native";
import { type BusinessTask, type TaskRequirement } from "../../lib/bridge-api";
import { formatCOPCompact } from "./CostField";

import { colors } from "../../lib/design-tokens";
const STATUS_COLOR: Record<string, string> = {
  pending: colors.gray[400],
  in_progress: colors.brand.amberDeep,
  done: colors.success,
};

const PRIORITY_BADGE: Record<string, { label: string; color: string }> = {
  high: { label: "HIGH", color: colors.error },
  medium: { label: "MED", color: colors.brand.orange },
  low: { label: "LOW", color: colors.brand.blue },
};

interface TaskCardProps {
  task: BusinessTask;
  onToggle: () => void;
  onPress: () => void;
  onLongPress?: () => void;
}

export function TaskCard({ task, onToggle, onPress, onLongPress }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isDone = task.status === "done";
  const pBadge = PRIORITY_BADGE[task.priority] || PRIORITY_BADGE.medium;
  const attachCount = task.attachment_count || 0;

  const formatDue = (d: string | null) => {
    if (!d) return null;
    const date = new Date(d);
    const now = new Date();
    const diff = Math.ceil((date.getTime() - now.getTime()) / 86400000);
    const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (diff < 0) return { label, color: colors.error };
    if (diff <= 2) return { label, color: colors.brand.amberDeep };
    return { label, color: colors.gray[400] };
  };

  const due = formatDue(task.due_date);

  const toggleExpand = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((e) => !e);
  };

  return (
    <Pressable
      onPress={toggleExpand}
      onLongPress={onLongPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <View
        style={{
          backgroundColor: colors.gray[800],
          borderRadius: 10,
          padding: 14,
          marginBottom: 8,
          opacity: isDone ? 0.55 : 1,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.03)",
        }}
      >
        {/* Header row */}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Pressable onPress={onToggle} hitSlop={12} style={{ marginRight: 12 }}>
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                borderWidth: 2,
                borderColor: STATUS_COLOR[task.status],
                backgroundColor: isDone ? STATUS_COLOR.done : "transparent",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {task.status === "in_progress" ? (
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: STATUS_COLOR.in_progress }} />
              ) : null}
            </View>
          </Pressable>

          <View style={{ flex: 1 }}>
            <Text
              style={{
                color: isDone ? colors.gray[400] : colors.gray[50],
                fontSize: 14,
                textDecorationLine: isDone ? "line-through" : "none",
              }}
              numberOfLines={1}
            >
              {task.title}
            </Text>
          </View>

          {/* Badges */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginLeft: 8 }}>
            {(() => {
              const reqs: TaskRequirement[] = task.requirements || [];
              if (reqs.length === 0) return null;
              const fulfilled = reqs.filter((r) => r.fulfilled).length;
              const color = fulfilled === 0 ? colors.gray[400] : fulfilled >= reqs.length ? colors.success : colors.brand.amberDeep;
              return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />;
            })()}
            {task.estimated_cost ? (
              <Text style={{ color: colors.accent, fontFamily: "monospace", fontSize: 10 }}>{formatCOPCompact(task.estimated_cost)}</Text>
            ) : null}
            {(task.expense_count || 0) > 0 ? (
              <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10 }}>$ {task.expense_count}</Text>
            ) : null}
            {attachCount > 0 ? (
              <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10 }}>📎 {attachCount}</Text>
            ) : null}
            {due ? (
              <Text style={{ color: due.color, fontFamily: "monospace", fontSize: 10 }}>{due.label}</Text>
            ) : null}
            <View style={{ backgroundColor: pBadge.color + "18", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
              <Text style={{ color: pBadge.color, fontFamily: "monospace", fontSize: 9, fontWeight: "bold" }}>
                {pBadge.label}
              </Text>
            </View>
          </View>
        </View>

        {/* Expanded content */}
        {expanded ? (
          <View style={{ marginTop: 12, marginLeft: 30 }}>
            {task.description ? (
              <Text style={{ color: colors.gray[300], fontSize: 13, lineHeight: 19, marginBottom: 8 }}>
                {task.description}
              </Text>
            ) : null}
            {task.notes ? (
              <Text style={{ color: colors.gray[400], fontSize: 12, fontStyle: "italic", marginBottom: 8 }} numberOfLines={2}>
                {task.notes}
              </Text>
            ) : null}

            <Pressable
              onPress={onPress}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                backgroundColor: pressed ? "#06B6D433" : "#06B6D418",
                paddingHorizontal: 14,
                paddingVertical: 6,
                borderRadius: 6,
                marginTop: 2,
              })}
            >
              <Text style={{ color: colors.accent, fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>DETAILS</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
