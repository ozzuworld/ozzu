import { View, Text, Pressable } from "react-native";
import { colors, spacing, radius, fontWeight, withAlpha, statusPillStyle } from "../../lib/design-tokens";
import { HUMAN_STATUS, relativeTime } from "../../lib/directive-constants";
import type { Directive } from "../../lib/bridge-api";

interface DirectiveListItemProps {
  directive: Directive;
  onPress: (directive: Directive) => void;
  variant?: "list" | "board";
  showDivider?: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  feature: colors.brand.blue,
  epic: colors.brand.purple,
  explore: colors.accent,
  quick: "#6B7280",
};

export function DirectiveListItem({ directive, onPress, variant = "list", showDivider = true }: DirectiveListItemProps) {
  const pill = statusPillStyle(directive.status);
  const statusColor = colors.status[directive.status] || colors.gray[300];

  // Epic progress
  const isEpic = directive.type === "epic" && Array.isArray(directive.phases) && directive.phases.length > 0;
  const epicDone = isEpic ? directive.phases!.filter((p) => p.status === "completed").length : 0;
  const epicTotal = isEpic ? directive.phases!.length : 0;
  const epicPct = epicTotal > 0 ? Math.round((epicDone / epicTotal) * 100) : 0;

  const typeColor = TYPE_COLORS[directive.type] || "#6B7280";
  const isHighPriority = (directive.priority ?? 3) <= 2;

  return (
    <Pressable
      onPress={() => onPress(directive)}
      style={({ pressed }) => ({
        opacity: pressed ? 0.85 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      <View
        style={{
          backgroundColor: colors.bg.elevated,
          borderRadius: 10,
          borderLeftWidth: 3,
          borderLeftColor: statusColor,
          marginBottom: 6,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderWidth: 1,
          borderColor: withAlpha("#ffffff", 0.03),
        }}
      >
        {/* Row 1: emoji + title + time */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 18 }}>
            {directive.emoji || ""}
          </Text>
          <Text
            style={{
              flex: 1,
              color: colors.text.primary,
              fontSize: 14,
              fontWeight: fontWeight.medium,
            }}
            numberOfLines={1}
          >
            {directive.title}
          </Text>
          <Text
            style={{
              color: colors.text.disabled,
              fontSize: 10,
            }}
          >
            {relativeTime(directive.updatedAt)}
          </Text>
        </View>

        {/* Row 2: tags — status + type + priority (if high) */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 7, marginLeft: 26 }}>
          {/* Status tag */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              backgroundColor: pill.bg,
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 4,
            }}
          >
            <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: pill.dot }} />
            <Text style={{ color: pill.text, fontSize: 10, fontWeight: fontWeight.medium }}>
              {HUMAN_STATUS[directive.status] || directive.status}
            </Text>
          </View>

          {/* Type tag */}
          <View
            style={{
              backgroundColor: withAlpha(typeColor, 0.1),
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 4,
            }}
          >
            <Text style={{ color: typeColor, fontSize: 10, fontWeight: fontWeight.medium }}>
              {directive.type}
            </Text>
          </View>

          {/* Priority tag — only show P1/P2 */}
          {isHighPriority ? (
            <View
              style={{
                backgroundColor: withAlpha(directive.priority! <= 1 ? colors.error : colors.warning, 0.12),
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 4,
              }}
            >
              <Text style={{ color: directive.priority! <= 1 ? "#FCA5A5" : "#FCD34D", fontSize: 10, fontWeight: fontWeight.bold }}>
                P{directive.priority}
              </Text>
            </View>
          ) : null}

          {/* Epic phase count */}
          {isEpic ? (
            <Text style={{ color: colors.text.disabled, fontSize: 10, marginLeft: 2 }}>
              {epicDone}/{epicTotal}
            </Text>
          ) : null}
        </View>

        {/* Epic progress bar — minimal */}
        {isEpic ? (
          <View style={{ marginTop: 6, marginLeft: 26 }}>
            <View style={{ height: 3, backgroundColor: withAlpha("#ffffff", 0.06), borderRadius: 2, overflow: "hidden" }}>
              <View style={{ width: `${epicPct}%` as any, height: "100%", backgroundColor: colors.success, borderRadius: 2 }} />
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
