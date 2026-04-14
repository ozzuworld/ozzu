import { View, Text, Pressable } from "react-native";
import { colors, spacing, radius, fontSize, fontWeight, withAlpha, statusPillStyle } from "../../lib/design-tokens";
import { HUMAN_STATUS, relativeTime } from "../../lib/directive-constants";
import type { Directive } from "../../lib/bridge-api";

interface DirectiveListItemProps {
  directive: Directive;
  onPress: (directive: Directive) => void;
  variant?: "list" | "board";
}

export function DirectiveListItem({ directive, onPress, variant = "list" }: DirectiveListItemProps) {
  const pill = statusPillStyle(directive.status);

  return (
    <Pressable
      onPress={() => onPress(directive)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: pressed ? colors.bg.surface : colors.bg.elevated,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderRadius: radius.md,
        gap: spacing.md,
        minHeight: 56,
      })}
    >
      {/* Emoji */}
      <Text style={{ fontSize: 16, width: 24, textAlign: "center" }}>
        {directive.emoji || ""}
      </Text>

      {/* Title + optional work summary */}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            color: colors.text.primary,
            fontSize: fontSize.lg,
            fontWeight: fontWeight.medium,
          }}
          numberOfLines={1}
        >
          {directive.title}
        </Text>
        {variant === "board" && directive.work_summary ? (
          <Text
            style={{
              color: colors.text.tertiary,
              fontSize: fontSize.xs,
              lineHeight: 14,
            }}
            numberOfLines={2}
          >
            {directive.work_summary}
          </Text>
        ) : null}
      </View>

      {/* Status pill */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          backgroundColor: pill.bg,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: radius.full,
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
            fontSize: fontSize.xs,
            fontWeight: fontWeight.medium,
          }}
        >
          {HUMAN_STATUS[directive.status] || directive.status}
        </Text>
      </View>

      {/* Relative time */}
      <Text
        style={{
          color: colors.text.disabled,
          fontSize: fontSize.md,
          minWidth: 36,
          textAlign: "right",
        }}
      >
        {relativeTime(directive.updatedAt)}
      </Text>
    </Pressable>
  );
}
