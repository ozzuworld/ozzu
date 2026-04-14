import { useState, useCallback } from "react";
import { View, Text, Pressable, LayoutAnimation } from "react-native";
import { ACTOR_COLORS, relativeTime } from "../../lib/directive-constants";
import { colors, spacing, radius, fontSize, fontWeight, withAlpha, auditTypeColors } from "../../lib/design-tokens";

interface ActivityEntry {
  timestamp: number;
  type: string;
  actor?: string;
  message: string;
}

interface AuditTrailProps {
  entries: ActivityEntry[];
  collapsed?: boolean;
  maxCollapsed?: number;
}

export function AuditTrail({ entries, collapsed = true, maxCollapsed = 3 }: AuditTrailProps) {
  const [expanded, setExpanded] = useState(!collapsed);

  const toggle = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((p) => !p);
  }, []);

  if (entries.length === 0) return null;

  const shown = expanded ? entries : entries.slice(-maxCollapsed).reverse();

  return (
    <View style={{ marginTop: spacing.sm }}>
      <Pressable
        onPress={toggle}
        style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs, marginBottom: spacing.sm }}
      >
        <Text style={{
          color: colors.text.disabled,
          fontSize: fontSize.xs,
          fontWeight: fontWeight.bold,
          letterSpacing: 0.5,
        }}>
          ACTIVITY ({entries.length})
        </Text>
        <Text style={{ color: colors.accent, fontSize: fontSize.xs }}>
          {expanded ? "\u25B2" : "\u25BC"}
        </Text>
      </Pressable>

      {shown.map((entry, i) => {
        const dotColor = auditTypeColors[entry.type] || colors.text.disabled;
        const actorColor = ACTOR_COLORS[entry.actor || ""] || colors.text.tertiary;
        const isLast = i === shown.length - 1;

        return (
          <View
            key={expanded ? i : `c-${i}`}
            style={{ flexDirection: "row", minHeight: 28 }}
          >
            {/* Timeline rail */}
            <View style={{ width: 16, alignItems: "center" }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor, marginTop: 4 }} />
              {!isLast ? (
                <View style={{ width: 1, flex: 1, backgroundColor: colors.border.subtle, marginVertical: 1 }} />
              ) : null}
            </View>

            {/* Content */}
            <View style={{ flex: 1, paddingBottom: spacing.sm, paddingLeft: spacing.xs }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                <Text style={{ color: colors.text.disabled, fontSize: 9 }}>
                  {relativeTime(entry.timestamp)}
                </Text>
                {entry.actor ? (
                  <Text style={{
                    color: actorColor,
                    fontSize: 9,
                    fontWeight: fontWeight.bold,
                    backgroundColor: withAlpha(actorColor, 0.1),
                    paddingHorizontal: 4,
                    paddingVertical: 1,
                    borderRadius: radius.xs,
                    overflow: "hidden",
                  }}>
                    {entry.actor}
                  </Text>
                ) : null}
              </View>
              <Text
                style={{ color: colors.text.tertiary, fontSize: 9, lineHeight: 14 }}
                numberOfLines={expanded ? undefined : 1}
              >
                {entry.message}
              </Text>
            </View>
          </View>
        );
      })}

      {!expanded && entries.length > maxCollapsed ? (
        <Pressable onPress={toggle}>
          <Text style={{ color: colors.accent, fontSize: 9, marginTop: 2, marginLeft: 16 }}>
            +{entries.length - maxCollapsed} more entries
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
