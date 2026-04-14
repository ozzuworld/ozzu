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

  return (
    <Pressable
      onPress={() => onPress(directive)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? withAlpha("#ffffff", 0.03) : "transparent",
        paddingHorizontal: 0,
        paddingVertical: 10,
        borderBottomWidth: showDivider ? 0.5 : 0,
        borderBottomColor: withAlpha("#ffffff", 0.06),
      })}
    >
      {/* Single horizontal row: emoji | title | pill | time */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {/* Emoji — small, fixed width */}
        <Text style={{ fontSize: 15, width: 20, textAlign: "center" }}>
          {directive.emoji || ""}
        </Text>

        {/* Title — takes remaining space, single line */}
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

        {/* Status pill — compact, right-aligned */}
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

        {/* Time — right edge */}
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

      {/* Board variant: 2nd row with work summary */}
      {variant === "board" && directive.work_summary ? (
        <Text
          style={{
            color: colors.text.disabled,
            fontSize: 11,
            marginTop: 3,
            marginLeft: 30,
            lineHeight: 15,
          }}
          numberOfLines={1}
        >
          {directive.work_summary}
        </Text>
      ) : null}
    </Pressable>
  );
}
