import { useState } from "react";
import { View, Text, Pressable, LayoutAnimation, ScrollView, Image } from "react-native";
import { type BusinessTask, getAttachmentUrl } from "../../lib/bridge-api";

const STATUS_ICON: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  done: "●",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "#525252",
  in_progress: "#EAB308",
  done: "#22C55E",
};

const PRIORITY_BADGE: Record<string, { label: string; color: string }> = {
  high: { label: "HIGH", color: "#EF4444" },
  medium: { label: "MED", color: "#F97316" },
  low: { label: "LOW", color: "#3B82F6" },
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
    if (diff < 0) return { label, color: "#EF4444" };
    if (diff <= 2) return { label, color: "#EAB308" };
    return { label, color: "#525252" };
  };

  const due = formatDue(task.due_date);

  const toggleExpand = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((e) => !e);
  };

  return (
    <Pressable onPress={toggleExpand} onLongPress={onLongPress}>
      <View
        style={{
          backgroundColor: "#1A1A1A",
          borderRadius: 8,
          padding: 12,
          marginBottom: 6,
          opacity: isDone ? 0.6 : 1,
        }}
      >
        {/* Collapsed header row */}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Pressable onPress={onToggle} hitSlop={12} style={{ marginRight: 10 }}>
            <Text style={{ color: STATUS_COLOR[task.status], fontSize: 18 }}>
              {STATUS_ICON[task.status]}
            </Text>
          </Pressable>

          <View style={{ flex: 1 }}>
            <Text
              style={{
                color: isDone ? "#525252" : "#E5E5E5",
                fontSize: 13,
                textDecorationLine: isDone ? "line-through" : "none",
              }}
              numberOfLines={1}
            >
              {task.title}
            </Text>
          </View>

          {/* Badges */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 8 }}>
            {attachCount > 0 ? (
              <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 9 }}>📎 {attachCount}</Text>
            ) : null}
            {due ? (
              <Text style={{ color: due.color, fontFamily: "monospace", fontSize: 9 }}>{due.label}</Text>
            ) : null}
            <View style={{ backgroundColor: pBadge.color + "22", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3 }}>
              <Text style={{ color: pBadge.color, fontFamily: "monospace", fontSize: 8, fontWeight: "bold" }}>
                {pBadge.label}
              </Text>
            </View>
          </View>
        </View>

        {/* Expanded content */}
        {expanded ? (
          <View style={{ marginTop: 10, marginLeft: 28 }}>
            {task.description ? (
              <Text style={{ color: "#737373", fontSize: 12, lineHeight: 18, marginBottom: 6 }}>
                {task.description}
              </Text>
            ) : null}
            {task.notes ? (
              <Text style={{ color: "#525252", fontSize: 11, fontStyle: "italic", marginBottom: 6 }} numberOfLines={2}>
                {task.notes}
              </Text>
            ) : null}

            {/* Details button */}
            <Pressable
              onPress={onPress}
              style={{
                alignSelf: "flex-start",
                backgroundColor: "#06B6D422",
                paddingHorizontal: 12,
                paddingVertical: 5,
                borderRadius: 4,
                marginTop: 4,
              }}
            >
              <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>DETAILS</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
