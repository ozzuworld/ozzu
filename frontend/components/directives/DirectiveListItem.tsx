import { View, Text, Pressable } from "react-native";
import { colors, spacing, radius, fontSize, fontWeight, withAlpha, statusPillStyle } from "../../lib/design-tokens";
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
  const isEpic = directive.type === "epic" && directive.phases && directive.phases.length > 0;
  const epicDone = isEpic ? directive.phases!.filter((p) => p.status === "completed").length : 0;
  const epicTotal = isEpic ? directive.phases!.length : 0;
  const epicPct = epicTotal > 0 ? Math.round((epicDone / epicTotal) * 100) : 0;

  // Pick subtitle: work_summary > description > nothing
  const subtitle = directive.work_summary || directive.description || null;

  // Last activity snippet (most recent activity_log entry)
  const lastActivity = Array.isArray(directive.activity_log) && directive.activity_log.length > 0
    ? directive.activity_log[directive.activity_log.length - 1]
    : null;

  return (
    <Pressable
      onPress={() => onPress(directive)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? withAlpha("#ffffff", 0.05) : colors.bg.elevated,
        borderRadius: radius.md,
        padding: 12,
        marginBottom: showDivider ? 6 : 0,
      })}
    >
      {/* Row 1: emoji + title + status pill + time */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {/* Emoji */}
        <Text style={{ fontSize: 16, width: 22, textAlign: "center" }}>
          {directive.emoji || ""}
        </Text>

        {/* Title */}
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

        {/* Status pill */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            backgroundColor: pill.bg,
            paddingHorizontal: 7,
            paddingVertical: 2,
            borderRadius: 10,
          }}
        >
          <View
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              backgroundColor: pill.dot,
            }}
          />
          <Text
            style={{
              color: pill.text,
              fontSize: 10,
              fontWeight: fontWeight.medium,
            }}
          >
            {HUMAN_STATUS[directive.status] || directive.status}
          </Text>
        </View>

        {/* Time */}
        <Text
          style={{
            color: colors.text.disabled,
            fontSize: 11,
            minWidth: 28,
            textAlign: "right",
          }}
        >
          {relativeTime(directive.updatedAt)}
        </Text>
      </View>

      {/* Row 2: subtitle (description or work_summary) */}
      {subtitle ? (
        <Text
          style={{
            color: colors.text.tertiary,
            fontSize: 12,
            marginTop: 5,
            marginLeft: 30,
            lineHeight: 16,
          }}
          numberOfLines={1}
        >
          {subtitle}
        </Text>
      ) : null}

      {/* Row 3: epic progress bar OR last activity */}
      {isEpic ? (
        <View style={{ marginTop: 6, marginLeft: 30 }}>
          {/* Progress track */}
          <View style={{ height: 3, backgroundColor: withAlpha("#ffffff", 0.06), borderRadius: 2, overflow: "hidden" }}>
            <View
              style={{
                width: `${epicPct}%`,
                height: "100%",
                backgroundColor: colors.accent,
                borderRadius: 2,
              }}
            />
          </View>
          <Text style={{ color: colors.text.disabled, fontSize: 10, marginTop: 3, fontFamily: "monospace" }}>
            {epicDone}/{epicTotal} phases  {epicPct}%
          </Text>
        </View>
      ) : variant === "board" && lastActivity ? (
        <Text
          style={{
            color: colors.text.disabled,
            fontSize: 11,
            marginTop: 5,
            marginLeft: 30,
            lineHeight: 15,
          }}
          numberOfLines={1}
        >
          {lastActivity.actor ? `${lastActivity.actor}: ` : ""}{lastActivity.message}
        </Text>
      ) : null}
    </Pressable>
  );
}
