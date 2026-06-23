// EngagementCard — list card for one SOC engagement. ProjectCard visual language, executed strong:
// a 4px status-colored left accent + visible border (cards no longer melt into the bg), a status
// dot + id, a prominent phase / LIVE chip, readable queue progress, severity chips on solid dark
// chips (no more grey-on-grey INFO), and readable metadata at gray[200] not the old dim gray[400].
// dir_1782174065724.

import { Pressable, Text, View } from "react-native";
import { colors, fontSize, fontWeight, radius, spacing, withAlpha } from "../../lib/design-tokens";
import { ProgressBar } from "../business/ProgressBar";
import { phaseColor, phaseLabel } from "./phaseColors";
import { safe } from "./safe";

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

// Severity chip colors — readable on a solid dark chip. INFO is a light grey, not the dim tertiary.
const SEV: Record<string, string> = {
  crit: colors.error,
  high: colors.brand.orange,
  med: colors.warning,
  low: colors.brand.blue,
  info: colors.gray[200],
};

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
  return `${Math.floor(h / 24)}d ago`;
}

function num(v: any): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

export function EngagementCard({ engagement, onPress }: EngagementCardProps) {
  const phase = engagement.engagement_phase || "scoping";
  const queueTotal = num(engagement.queue_total);
  const queueDone = num(engagement.queue_done);
  const queueRunning = num(engagement.queue_running);
  const queuePending = num(engagement.queue_pending);
  const isLive = queueRunning > 0;

  // Accent identity: LIVE green when a step is running, otherwise the engagement's phase color.
  const accent = isLive ? colors.success : phaseColor(phase);

  const crit = num(engagement.critical_count);
  const high = num(engagement.high_count);
  const med = num(engagement.medium_count);
  const low = num(engagement.low_count);
  const info = num(engagement.info_count);
  const hasFindings = crit + high + med + low + info > 0;
  const pct = queueTotal > 0 ? Math.round((queueDone / queueTotal) * 100) : 0;
  const lastActivity = relativeTime(engagement.last_activity_at);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] })}
    >
      <View
        style={{
          backgroundColor: colors.gray[800],
          borderRadius: radius.lg,
          borderLeftWidth: 4,
          borderLeftColor: accent,
          borderTopWidth: 1,
          borderRightWidth: 1,
          borderBottomWidth: 1,
          borderColor: colors.border.default,
          paddingVertical: spacing.md + 1,
          paddingHorizontal: spacing.md + 2,
        }}
      >
        {/* Header: status dot + id … phase / LIVE chip */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: accent }} />
          <Text
            style={{ color: colors.gray[50], fontSize: fontSize.base, fontWeight: fontWeight.semibold, flex: 1, letterSpacing: 0.2 }}
            numberOfLines={1}
          >
            {safe(engagement.id, "—")}
          </Text>
          {isLive ? <Chip text="● LIVE" color={colors.success} /> : <Chip text={phaseLabel(phase).toUpperCase()} color={accent} />}
        </View>

        {/* Client + type */}
        <Text style={{ color: colors.gray[200], fontSize: fontSize.sm, marginTop: 5 }} numberOfLines={1}>
          {safe(engagement.client_name, "—")}
          {engagement.engagement_type ? `  ·  ${engagement.engagement_type.replace(/_/g, " ")}` : ""}
        </Text>

        {/* Queue progress */}
        {queueTotal > 0 ? (
          <View style={{ marginTop: spacing.sm + 2 }}>
            <ProgressBar done={queueDone} total={queueTotal} color={accent} height={6} />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 5 }}>
              <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: fontSize.xs }}>
                {queueDone}/{queueTotal} steps{queuePending > 0 ? `  ·  ${queuePending} queued` : ""}
              </Text>
              <Text style={{ color: accent, fontFamily: "monospace", fontSize: fontSize.xs, fontWeight: fontWeight.bold }}>{pct}%</Text>
            </View>
          </View>
        ) : (
          <Text style={{ color: colors.gray[300], fontSize: fontSize.xs, marginTop: spacing.sm + 2 }}>idle — no steps run yet</Text>
        )}

        {/* Footer: findings chips … timestamp */}
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.sm + 2, gap: spacing.xs }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, flex: 1 }}>
            {crit > 0 ? <Sev n={crit} label="CRIT" color={SEV.crit} /> : null}
            {high > 0 ? <Sev n={high} label="HIGH" color={SEV.high} /> : null}
            {med > 0 ? <Sev n={med} label="MED" color={SEV.med} /> : null}
            {low > 0 ? <Sev n={low} label="LOW" color={SEV.low} /> : null}
            {info > 0 ? <Sev n={info} label="INFO" color={SEV.info} /> : null}
            {!hasFindings ? <Text style={{ color: colors.gray[300], fontSize: fontSize.xs }}>no findings yet</Text> : null}
          </View>
          <Text style={{ color: colors.gray[300], fontSize: fontSize.xs, fontFamily: "monospace" }}>{lastActivity}</Text>
        </View>
      </View>
    </Pressable>
  );
}

function Chip({ text, color }: { text: string; color: string }) {
  return (
    <View
      style={{
        backgroundColor: withAlpha(color, 0.16),
        borderColor: withAlpha(color, 0.42),
        borderWidth: 1,
        borderRadius: radius.full,
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color, fontSize: 10, fontWeight: fontWeight.bold, letterSpacing: 0.4 }}>{text}</Text>
    </View>
  );
}

function Sev({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: colors.gray[700],
        borderRadius: radius.sm,
        paddingHorizontal: 7,
        paddingVertical: 3,
      }}
    >
      <Text style={{ color, fontSize: fontSize.xs, fontWeight: fontWeight.bold, fontFamily: "monospace" }}>{n}</Text>
      <Text style={{ color, fontSize: 10, fontWeight: fontWeight.semibold, letterSpacing: 0.3 }}>{label}</Text>
    </View>
  );
}
