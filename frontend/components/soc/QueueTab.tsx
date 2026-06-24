// QueueTab — all queue items, filter pills at top.

import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  colors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  withAlpha,
} from "../../lib/design-tokens";
import { QueueRow, type QueueItemRow } from "./QueueRow";

type QueueFilter = "all" | "pending" | "running" | "done" | "failed" | "skipped";

const FILTERS: QueueFilter[] = ["all", "pending", "running", "done", "failed", "skipped"];

interface QueueTabProps {
  queue: QueueItemRow[];
  busyId: number | null;
  onRun: (item: QueueItemRow) => void;
  onCancel: (item: QueueItemRow) => void;
  onSkip: (item: QueueItemRow) => void;
  onItemPress?: (item: QueueItemRow) => void;
}

export function QueueTab({ queue, busyId, onRun, onCancel, onSkip, onItemPress }: QueueTabProps) {
  const [filter, setFilter] = useState<QueueFilter>("all");

  const counts = useMemo(() => {
    const c: Record<QueueFilter, number> = {
      all: queue.length,
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    };
    for (const q of queue) {
      if ((c as any)[q.status] !== undefined) (c as any)[q.status]++;
    }
    return c;
  }, [queue]);

  const filtered = useMemo(
    () => (filter === "all" ? queue : queue.filter((q) => q.status === filter)),
    [queue, filter],
  );

  return (
    <View style={{ flex: 1 }}>
      {/* Filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs }}
      >
        {FILTERS.map((f) => {
          const selected = filter === f;
          const c = counts[f];
          if (c === 0 && f !== "all") return null;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.xs + 2,
                borderRadius: radius.full,
                backgroundColor: selected ? colors.accent : withAlpha(colors.text.secondary, 0.08),
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Text
                style={{
                  color: selected ? colors.bg.base : colors.text.secondary,
                  fontSize: fontSize.sm,
                  fontWeight: selected ? fontWeight.semibold : fontWeight.medium,
                }}
              >
                {f}
              </Text>
              <Text
                style={{
                  color: selected ? colors.bg.base : colors.text.tertiary,
                  fontSize: fontSize.xs,
                  fontFamily: "monospace",
                  marginLeft: spacing.xs,
                }}
              >
                {c}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm }}
      >
        {filtered.length === 0 ? (
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.sm, textAlign: "center", marginTop: spacing.lg }}>
            No items in this bucket
          </Text>
        ) : (
          filtered.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              busyId={busyId}
              onRun={onRun}
              onCancel={onCancel}
              onSkip={onSkip}
              onPress={onItemPress}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}
