// NowTab — focal "what's happening" view for an engagement.
// LiveExecBanner if anything is running, "Next up" (first 3 pending), then
// "Recent findings" (last 5 sorted severity/recency). The dashboard.

import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  colors,
  fontSize,
  fontWeight,
  spacing,
} from "../../lib/design-tokens";
import { FindingRow, type FindingRowData } from "./FindingRow";
import { LiveExecBanner, type RunningItem } from "./LiveExecBanner";
import { QueueRow, type QueueItemRow } from "./QueueRow";
import { SEVERITY_ORDER } from "./phaseColors";

interface NowTabProps {
  engagementId: string;
  queue: QueueItemRow[];
  findings: FindingRowData[];
  busyId: number | null;
  onRun: (item: QueueItemRow) => void;
  onCancel: (item: QueueItemRow) => void;
  onSkip: (item: QueueItemRow) => void;
  onOpenExec: (item: RunningItem) => void;
  onOutputUpdate: (itemId: number, output: string) => void;
  onFindingPress: (finding: FindingRowData) => void;
}

function severityRank(sev: string): number {
  const i = (SEVERITY_ORDER as readonly string[]).indexOf((sev || "").toLowerCase());
  return i < 0 ? 99 : i;
}

export function NowTab(props: NowTabProps) {
  const { engagementId, queue, findings, busyId, onRun, onCancel, onSkip, onOpenExec, onOutputUpdate, onFindingPress } = props;

  const running = queue.find((q) => q.status === "running");
  const runningAsRunning: RunningItem | null = running
    ? {
        id: running.id,
        seq: running.seq,
        title: running.title,
        output: (running as any).output ?? null,
        started_at: (running as any).started_at ?? null,
      }
    : null;

  const nextUp = useMemo(
    () => queue.filter((q) => q.status === "pending").slice(0, 3),
    [queue],
  );

  const recentFindings = useMemo(
    () =>
      [...findings]
        .sort((a, b) => {
          const sd = severityRank(a.severity) - severityRank(b.severity);
          if (sd !== 0) return sd;
          const ta = a.discovered_at ? new Date(a.discovered_at).getTime() : 0;
          const tb = b.discovered_at ? new Date(b.discovered_at).getTime() : 0;
          return tb - ta;
        })
        .slice(0, 5),
    [findings],
  );

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl }}
    >
      {/* Live exec banner */}
      {runningAsRunning ? (
        <LiveExecBanner
          item={runningAsRunning}
          engagementId={engagementId}
          onOpenFull={() => onOpenExec(runningAsRunning)}
          onCancel={() => onCancel(running as QueueItemRow)}
          onOutputUpdate={onOutputUpdate}
        />
      ) : null}

      {/* Next up */}
      <SectionTitle title="⏭ Next up" empty={nextUp.length === 0 ? "queue is empty" : undefined} />
      {nextUp.length > 0 ? (
        <View style={{ gap: spacing.sm, marginBottom: spacing.lg }}>
          {nextUp.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              busyId={busyId}
              onRun={onRun}
              onSkip={onSkip}
            />
          ))}
        </View>
      ) : null}

      {/* Recent findings */}
      <SectionTitle
        title="🚨 Recent findings"
        rightLabel={findings.length > recentFindings.length ? `+${findings.length - recentFindings.length} more` : undefined}
        empty={recentFindings.length === 0 ? "no findings yet" : undefined}
      />
      {recentFindings.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          {recentFindings.map((f) => (
            <FindingRow key={f.id} finding={f} onPress={onFindingPress} />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function SectionTitle({ title, rightLabel, empty }: { title: string; rightLabel?: string; empty?: string }) {
  return (
    <View style={{ marginBottom: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text
          style={{
            flex: 1,
            color: colors.text.secondary,
            fontSize: fontSize.sm,
            fontWeight: fontWeight.semibold,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {title}
        </Text>
        {rightLabel ? (
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, fontFamily: "monospace" }}>
            {rightLabel}
          </Text>
        ) : null}
      </View>
      {empty ? (
        <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, marginTop: spacing.xs, marginBottom: spacing.lg }}>
          {empty}
        </Text>
      ) : null}
    </View>
  );
}
