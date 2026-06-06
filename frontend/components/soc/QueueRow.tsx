// QueueRow — one item in the queue list. Status pill, title, sequence,
// inline action button (run / cancel / skip) chosen by status.

import { Pressable, Text, View } from "react-native";
import {
  colors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  withAlpha,
} from "../../lib/design-tokens";

export type QueueItemStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface QueueItemRow {
  id: number;
  seq: number;
  title: string;
  description?: string | null;
  status: QueueItemStatus | string;
  started_at?: string | null;
  completed_at?: string | null;
}

interface QueueRowProps {
  item: QueueItemRow;
  onRun?: (item: QueueItemRow) => void;
  onCancel?: (item: QueueItemRow) => void;
  onSkip?: (item: QueueItemRow) => void;
  onPress?: (item: QueueItemRow) => void;
  busyId?: number | null;
}

function statusVisuals(status: string): { color: string; label: string; dot: string } {
  switch (status) {
    case "running": return { color: colors.success, label: "running", dot: colors.success };
    case "done": return { color: colors.accent, label: "done", dot: colors.accent };
    case "failed": return { color: colors.error, label: "failed", dot: colors.error };
    case "skipped": return { color: colors.text.tertiary, label: "skipped", dot: colors.text.tertiary };
    case "pending":
    default:
      return { color: colors.warning, label: "pending", dot: colors.warning };
  }
}

export function QueueRow({ item, onRun, onCancel, onSkip, onPress, busyId }: QueueRowProps) {
  const vis = statusVisuals(item.status);
  const busy = busyId === item.id;

  return (
    <Pressable
      onPress={() => onPress?.(item)}
      style={({ pressed }) => ({
        backgroundColor: colors.gray[800],
        borderRadius: radius.md,
        padding: spacing.md,
        borderLeftWidth: 3,
        borderLeftColor: vis.dot,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.04)",
        opacity: pressed ? 0.92 : 1,
      })}
    >
      {/* Title row */}
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: spacing.xs }}>
        <Text
          style={{
            color: colors.text.tertiary,
            fontFamily: "monospace",
            fontSize: fontSize.xs,
            marginRight: spacing.sm,
          }}
        >
          #{item.seq}
        </Text>
        <Text
          style={{ flex: 1, color: colors.text.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}
          numberOfLines={1}
        >
          {item.title}
        </Text>
      </View>

      {/* Description */}
      {item.description ? (
        <Text
          style={{ color: colors.text.tertiary, fontSize: fontSize.xs, marginBottom: spacing.sm }}
          numberOfLines={2}
        >
          {item.description}
        </Text>
      ) : null}

      {/* Status + actions */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: withAlpha(vis.color, 0.14),
            borderRadius: radius.sm,
            paddingHorizontal: spacing.sm,
            paddingVertical: 2,
          }}
        >
          <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: vis.dot, marginRight: spacing.xs }} />
          <Text style={{ color: vis.color, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>
            {vis.label}
          </Text>
        </View>

        <View style={{ flex: 1 }} />

        {item.status === "pending" && onRun ? (
          <ActionButton label="run" color={colors.success} onPress={() => onRun(item)} disabled={busy} />
        ) : null}
        {item.status === "pending" && onSkip ? (
          <ActionButton label="skip" color={colors.text.tertiary} onPress={() => onSkip(item)} disabled={busy} />
        ) : null}
        {item.status === "running" && onCancel ? (
          <ActionButton label="cancel" color={colors.error} onPress={() => onCancel(item)} />
        ) : null}
      </View>
    </Pressable>
  );
}

function ActionButton({
  label,
  color,
  onPress,
  disabled,
}: {
  label: string;
  color: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        backgroundColor: withAlpha(color, 0.18),
        borderRadius: radius.sm,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs + 2,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color, fontSize: fontSize.xs, fontWeight: fontWeight.bold }}>{label}</Text>
    </Pressable>
  );
}
