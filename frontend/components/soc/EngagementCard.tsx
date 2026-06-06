// EngagementCard — list-screen card for one SOC engagement.
// ProjectCard.tsx visual language: phase-colored left border, big title,
// queue progress bar, severity counters, live-exec indicator, last-activity timestamp.

import { Pressable, Text, View } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing, withAlpha } from "../../lib/design-tokens";
import { ProgressBar } from "../business/ProgressBar";
import { PhasePill } from "./PhasePill";
import { phaseColor } from "./phaseColors";

export interface EngagementSummary {
  id: string;
  client_name: string;
  engagement_type: string;
  status: string;
  engagement_phase?: string | null;
  findings_count?: number;
  critical_count?: number;
  high_count?: number;
  medium_count?: number;
  low_count?: number;
  info_count?: number;
  queue_total?: number;
  queue_done?: number;
  queue_running?: number;
  queue_pending?: number;
  queue_failed?: number;
  last_activity_at?: string | null;
  created_at?: string;
}

interface EngagementCardProps {
  engagement: EngagementSummary;
  onPress: () => void;
}

function relativeTime(iso?: string | null): string {
  if (!iso) return "no activity";
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return "no activity";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function num(v: any): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

export function EngagementCard({ engagement, onPress }: EngagementCardProps) {
  const accent = phaseColor(engagement.engagement_phase);
  const queueTotal = num(engagement.queue_total);
  const queueDone = num(engagement.queue_done);
  const queueRunning = num(engagement.queue_running);
  const queuePending = num(engagement.queue_pending);

  const crit = num(engagement.critical_count);
  const high = num(engagement.high_count);
  const med = num(engagement.medium_count);
  const low = num(engagement.low_count);
  const info = num(engagement.info_count);
  const hasFindings = crit + high + med + low + info > 0;

  const isLive = queueRunning > 0;
  const lastActivity = relativeTime(engagement.last_activity_at);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}
    >
      <View
        style={{
          backgroundColor: colors.gray[800],
          borderRadius: radius.lg,
          borderLeftWidth: 3,
          borderLeftColor: accent,
          padding: spacing.lg,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.04)",
        }}
      >
        {/* Header row: id + live dot */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: spacing.xs,
          }}
        >
          <Text
            style={{ color: colors.gray[50], fontSize: fontSize.lg, fontWeight: fontWeight.semibold, flex: 1 }}
            numberOfLines={1}
          >
            {engagement.id}
          </Text>
          {isLive ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                backgroundColor: withAlpha(colors.success, 0.18),
                borderRadius: radius.full,
                paddingHorizontal: spacing.sm,
                paddingVertical: 2,
              }}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success }} />
              <Text style={{ color: colors.success, fontSize: fontSize.xs, fontWeight: fontWeight.bold }}>LIVE</Text>
            </View>
          ) : (
            <Text style={{ color: colors.gray[400], fontSize: fontSize.xs, fontFamily: "monospace" }}>
              {lastActivity}
            </Text>
          )}
        </View>

        {/* Client + phase row */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            marginBottom: spacing.md,
          }}
        >
          <Text style={{ color: colors.gray[300], fontSize: fontSize.md, flex: 1 }} numberOfLines={1}>
            {engagement.client_name} · {engagement.engagement_type}
          </Text>
          <PhasePill phase={engagement.engagement_phase} size="sm" />
        </View>

        {/* Queue progress */}
        {queueTotal > 0 ? (
          <View style={{ marginBottom: spacing.sm }}>
            <ProgressBar done={queueDone} total={queueTotal} color={accent} height={5} />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs }}>
              <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: fontSize.xs }}>
                {queueDone}/{queueTotal} done
              </Text>
              <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: fontSize.xs }}>
                {queuePending} queued
              </Text>
            </View>
          </View>
        ) : (
          <Text style={{ color: colors.gray[400], fontSize: fontSize.xs, marginBottom: spacing.sm }}>
            no queue yet
          </Text>
        )}

        {/* Findings counters */}
        {hasFindings ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
            {crit > 0 ? <Counter count={crit} color={colors.error} label="crit" /> : null}
            {high > 0 ? <Counter count={high} color={colors.brand.orange} label="high" /> : null}
            {med > 0 ? <Counter count={med} color={colors.warning} label="med" /> : null}
            {low > 0 ? <Counter count={low} color={colors.brand.blue} label="low" /> : null}
            {info > 0 ? <Counter count={info} color={colors.text.tertiary} label="info" /> : null}
          </View>
        ) : (
          <Text style={{ color: colors.gray[400], fontSize: fontSize.xs }}>no findings yet</Text>
        )}
      </View>
    </Pressable>
  );
}

function Counter({ count, color, label }: { count: number; color: string; label: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        backgroundColor: withAlpha(color, 0.14),
        borderRadius: radius.sm,
        paddingHorizontal: spacing.xs + 2,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color, fontSize: fontSize.xs, fontWeight: fontWeight.bold, fontFamily: "monospace" }}>
        {count}
      </Text>
      <Text style={{ color, fontSize: fontSize.xs, fontWeight: fontWeight.medium, textTransform: "uppercase" }}>
        {label}
      </Text>
    </View>
  );
}
