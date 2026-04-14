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

export function DirectiveListItem({ directive, onPress, variant = "list", showDivider = true }: DirectiveListItemProps) {
  const pill = statusPillStyle(directive.status);
  const statusColor = colors.status[directive.status] || "#737373";

  // Epic progress
  const isEpic = directive.type === "epic" && Array.isArray(directive.phases) && directive.phases.length > 0;
  const epicDone = isEpic ? directive.phases!.filter((p) => p.status === "completed").length : 0;
  const epicTotal = isEpic ? directive.phases!.length : 0;
  const epicPct = epicTotal > 0 ? Math.round((epicDone / epicTotal) * 100) : 0;

  // Subtitle: work_summary first, then description
  const subtitle = directive.work_summary || directive.description || null;

  return (
    <Pressable
      onPress={() => onPress(directive)}
      style={({ pressed }) => ({
        opacity: pressed ? 0.92 : 1,
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      <View
        style={{
          backgroundColor: colors.bg.elevated,
          borderRadius: 12,
          borderLeftWidth: 3,
          borderLeftColor: statusColor,
          marginBottom: 10,
          padding: 14,
          borderWidth: 1,
          borderColor: withAlpha("#ffffff", 0.04),
        }}
      >
        {/* Row 1: emoji + title + status dot + time */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ fontSize: 22, width: 30, textAlign: "center" }}>
            {directive.emoji || ""}
          </Text>
          <Text
            style={{
              flex: 1,
              color: colors.text.primary,
              fontSize: 15,
              fontWeight: fontWeight.semibold,
            }}
            numberOfLines={1}
          >
            {directive.title}
          </Text>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: statusColor,
            }}
          />
          <Text
            style={{
              color: colors.text.disabled,
              fontSize: 11,
              minWidth: 32,
              textAlign: "right",
            }}
          >
            {relativeTime(directive.updatedAt)}
          </Text>
        </View>

        {/* Row 2: description / work_summary — 2 lines */}
        {subtitle ? (
          <Text
            style={{
              color: colors.text.tertiary,
              fontSize: 12,
              lineHeight: 17,
              marginTop: 8,
              marginLeft: 40,
            }}
            numberOfLines={2}
          >
            {subtitle}
          </Text>
        ) : null}

        {/* Row 3: status pill + type badge */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, marginLeft: 40 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              backgroundColor: pill.bg,
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderRadius: 10,
            }}
          >
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: pill.dot,
              }}
            />
            <Text
              style={{
                color: pill.text,
                fontSize: 10,
                fontWeight: fontWeight.semibold,
              }}
            >
              {HUMAN_STATUS[directive.status] || directive.status}
            </Text>
          </View>

          {directive.type ? (
            <View
              style={{
                backgroundColor: withAlpha("#ffffff", 0.06),
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: 10,
              }}
            >
              <Text style={{ color: colors.text.disabled, fontSize: 10, fontWeight: fontWeight.medium }}>
                {directive.type}
              </Text>
            </View>
          ) : null}

          {directive.priority && directive.priority > 0 ? (
            <View
              style={{
                backgroundColor: withAlpha("#ffffff", 0.06),
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: 10,
              }}
            >
              <Text style={{ color: colors.text.disabled, fontSize: 10, fontWeight: fontWeight.medium }}>
                P{directive.priority}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Row 4: epic progress bar */}
        {isEpic ? (
          <View style={{ marginTop: 10, marginLeft: 40 }}>
            <View
              style={{
                height: 4,
                backgroundColor: withAlpha("#ffffff", 0.08),
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  width: `${epicPct}%`,
                  height: "100%",
                  backgroundColor: colors.accent,
                  borderRadius: 2,
                }}
              />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
              <Text style={{ color: colors.text.disabled, fontSize: 10, fontFamily: "monospace" }}>
                {epicDone}/{epicTotal} phases
              </Text>
              <Text style={{ color: colors.text.tertiary, fontSize: 10, fontFamily: "monospace", fontWeight: fontWeight.bold }}>
                {epicPct}%
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
