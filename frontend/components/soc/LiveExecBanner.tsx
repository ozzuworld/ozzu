// LiveExecBanner — surfaced on the Now tab when any queue item is running.
// Tail of stdout (last 5 lines), monospace, cancel button + "open full" CTA.
// Subscribes to socExecOutput via useBridgeStream so the tail updates without refetch.

import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import {
  colors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  withAlpha,
} from "../../lib/design-tokens";
import { useBridgeStream } from "../../lib/useBridgeStream";

export interface RunningItem {
  id: number;
  seq: number;
  title: string;
  output: string | null;
  started_at: string | null;
}

interface LiveExecBannerProps {
  item: RunningItem;
  engagementId: string;
  onOpenFull: () => void;
  onCancel: () => void;
  onOutputUpdate: (itemId: number, output: string) => void;
}

function lastLines(text: string | null | undefined, n: number): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n));
}

function elapsed(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function LiveExecBanner({
  item,
  engagementId,
  onOpenFull,
  onCancel,
  onOutputUpdate,
}: LiveExecBannerProps) {
  // Hook up the streaming output. Parent owns the queue state — we just push
  // the new tail upward when a chunk arrives.
  useBridgeStream(
    "socExecOutput",
    (msg: any) => {
      if (msg.item_id === item.id) onOutputUpdate(item.id, msg.output || "");
    },
    { filter: (msg: any) => msg && msg.engagement_id === engagementId },
  );

  const tail = useMemo(() => lastLines(item.output, 5), [item.output]);
  const dur = elapsed(item.started_at);

  return (
    <View
      style={{
        backgroundColor: withAlpha(colors.success, 0.08),
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: withAlpha(colors.success, 0.35),
        padding: spacing.md,
        marginBottom: spacing.md,
      }}
    >
      {/* Header row: pulse + title + elapsed */}
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: spacing.sm }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: colors.success,
            marginRight: spacing.sm,
          }}
        />
        <Text
          style={{ flex: 1, color: colors.text.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}
          numberOfLines={1}
        >
          #{item.seq} {item.title}
        </Text>
        <Text style={{ color: colors.success, fontSize: fontSize.xs, fontFamily: "monospace" }}>{dur}</Text>
      </View>

      {/* Tail of output */}
      <View
        style={{
          backgroundColor: colors.bg.base,
          borderRadius: radius.sm,
          padding: spacing.sm,
          marginBottom: spacing.sm,
          minHeight: 60,
        }}
      >
        {tail.length === 0 ? (
          <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: fontSize.xs }}>
            (no output yet)
          </Text>
        ) : (
          tail.map((line, i) => (
            <Text
              key={i}
              numberOfLines={1}
              style={{
                color: colors.text.secondary,
                fontFamily: "monospace",
                fontSize: fontSize.xs,
                lineHeight: 15,
              }}
            >
              {line || " "}
            </Text>
          ))
        )}
      </View>

      {/* Actions */}
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <Pressable
          onPress={onOpenFull}
          style={({ pressed }) => ({
            flex: 1,
            backgroundColor: colors.bg.elevated,
            borderRadius: radius.sm,
            paddingVertical: spacing.sm,
            alignItems: "center",
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text style={{ color: colors.accent, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
            ▶ open full output
          </Text>
        </Pressable>
        <Pressable
          onPress={onCancel}
          style={({ pressed }) => ({
            backgroundColor: withAlpha(colors.error, 0.18),
            borderRadius: radius.sm,
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.md,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text style={{ color: colors.error, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
