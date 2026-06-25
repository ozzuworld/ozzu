// NowTab — OBSERVER view of the autonomous run. DeepSeek drives the engagement; you watch.
// dir_1782169917222 / Phase 2. Replaces the old manual-step "dashboard" (run/skip lived here)
// — those controls now live only in the Queue tab. This leads with: run status (phase / step /
// agent state), executor health (the device's live Wi-Fi + WG, now that the tablet reports),
// a read-only activity feed of what the model is doing, and findings as they land.

import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  colors, fontSize, fontWeight, spacing, radius, withAlpha,
} from "../../lib/design-tokens";
import { FindingRow, type FindingRowData } from "./FindingRow";
import { SEVERITY_ORDER } from "./phaseColors";

export type ExecutorLite = {
  device_id: string;
  online: boolean;
  wifi_ssid: string | null;
  wg_up: boolean;
  battery_pct: number | null;
} | null;

/** Outcomes that signal the loop is dark / stuck (not healthy progress). */
const STALL_OUTCOMES = new Set(["outcome_timeout", "loop_halted", "orphan_resolved"]);

/** 3-min stall threshold = 1.5× the 120s per-step ceiling. */
const STALL_MS = 3 * 60 * 1000;

function minutesSince(isoStr: string | null | undefined): number | null {
  if (!isoStr) return null;
  const ms = Date.now() - new Date(isoStr).getTime();
  if (isNaN(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

function stalledLabel(engagement: any): string {
  const lastCompleted: string | null = engagement?.last_completed_at ?? null;
  const mins = minutesSince(lastCompleted);
  return mins != null ? `Stalled — no activity (${mins}m)` : "Stalled — no activity";
}

/**
 * Computed run status — replaces the binary `live = agent_status==='running'` that
 * kept showing green even when the loop was dark/stalled (night-of-confusion root cause).
 *
 * STALLED  = running + no completed queue step within STALL_MS OR last telemetry is a stall outcome.
 * RUNNING  = running + healthy activity.
 * PAUSED   = paused.
 * DONE     = completed.
 * FAILED   = error.
 * HALTED   = halted (harness force-halted the loop — dir_1782242371780).
 * IDLE     = idle / null / anything else.
 */
export type RunStatus = "running" | "stalled" | "paused" | "completed" | "failed" | "halted" | "idle";

function computeRunStatus(engagement: any): RunStatus {
  const s: string = engagement?.agent_status || "idle";
  if (s !== "running") {
    if (s === "paused") return "paused";
    if (s === "completed") return "completed";
    if (s === "error") return "failed";
    // dir_1782242371780 (correction): a harness-forced abnormal halt. Surface it
    // distinctly so it doesn't masquerade as a never-started 'idle' engagement.
    if (s === "halted") return "halted";
    return "idle";
  }
  // agent_status === "running" — check for staleness
  const recentTelemetry: Array<{ outcome: string; created_at: string }> =
    Array.isArray(engagement?.recent_telemetry) ? engagement.recent_telemetry : [];
  const latestOutcome = recentTelemetry[0]?.outcome ?? null;
  if (latestOutcome && STALL_OUTCOMES.has(latestOutcome)) return "stalled";

  const lastCompleted: string | null = engagement?.last_completed_at ?? null;
  if (lastCompleted) {
    const age = Date.now() - new Date(lastCompleted).getTime();
    if (age > STALL_MS) return "stalled";
  } else {
    // No completed steps at all — only stalled if we've been "running" long enough.
    // Use engagement's updated_at as the start proxy (conservative: no false positives early).
    const updatedAt: string | null = engagement?.updated_at ?? null;
    if (updatedAt) {
      const age = Date.now() - new Date(updatedAt).getTime();
      if (age > STALL_MS) return "stalled";
    }
  }
  return "running";
}

interface NowTabProps {
  engagement: any;
  executor: ExecutorLite;
  queue: any[];
  findings: FindingRowData[];
  onFindingPress: (finding: FindingRowData) => void;
  onStepPress?: (item: any) => void;
  onLaunch?: () => void;
  onStop?: () => void;
  onToggleAuto?: (enabled: boolean) => void;
  onSwitchTab?: (tab: string) => void;
}

function sevRank(s: string): number {
  const i = (SEVERITY_ORDER as readonly string[]).indexOf((s || "").toLowerCase());
  return i < 0 ? 99 : i;
}

export function NowTab({ engagement, executor, queue, findings, onFindingPress, onStepPress, onLaunch, onStop, onToggleAuto, onSwitchTab }: NowTabProps) {
  const autoEnabled = !!engagement?.autonomous_execution_enabled;
  const phase: string = engagement?.engagement_phase || "—";
  const ars = (engagement?.agent_run_state && typeof engagement.agent_run_state === "object") ? engagement.agent_run_state : {};
  const iter = ars.iter ?? ars.iteration ?? ars.current_iter ?? null;

  const running = queue.find((q) => q.status === "running");
  const done = queue.filter((q) => q.status === "done").length;

  const activity = useMemo(
    () => queue.filter((q) => ["running", "done", "failed"].includes(q.status))
      .sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 10),
    [queue],
  );
  const topFindings = useMemo(
    () => [...findings].sort((a, b) => {
      const r = sevRank(a.severity) - sevRank(b.severity);
      if (r !== 0) return r;
      const ta = a.discovered_at ? new Date(a.discovered_at).getTime() : 0;
      const tb = b.discovered_at ? new Date(b.discovered_at).getTime() : 0;
      return tb - ta;
    }).slice(0, 6),
    [findings],
  );

  // ── Honest run status (replaces the binary `live = agent_status==='running'`) ──
  const runStatus: RunStatus = computeRunStatus(engagement);
  const live = runStatus === "running";

  const statusColor: string =
    runStatus === "running"   ? colors.success
    : runStatus === "stalled"  ? colors.warning
    : runStatus === "halted"   ? colors.warning
    : runStatus === "failed"   ? colors.error
    : runStatus === "completed" ? colors.accent
    : runStatus === "paused"   ? colors.status.in_progress
    : colors.text.tertiary;

  const modelLabel = engagement?.model_override?.startsWith?.("claude-") ? "Claude Opus" : "DeepSeek";

  const statusLine: string =
    runStatus === "running"   ? `${modelLabel} is running`
    : runStatus === "stalled"  ? stalledLabel(engagement)
    : runStatus === "failed"   ? "Run errored"
    : runStatus === "halted"   ? "Run halted — no clean conclusion"
    : runStatus === "completed" ? "Run complete"
    : runStatus === "paused"   ? "Paused"
    : "Idle — not launched yet";

  // Telemetry warning rows for stall signals (shown only when stalled)
  const recentTelemetry: Array<{ outcome: string; created_at: string }> =
    runStatus === "stalled" && Array.isArray(engagement?.recent_telemetry)
      ? engagement.recent_telemetry
      : [];

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.md }}>
      {/* Run status */}
      <View style={{ backgroundColor: colors.bg.elevated, borderRadius: radius.lg, borderLeftWidth: 3, borderLeftColor: statusColor, padding: spacing.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: statusColor }} />
          <Text style={{ color: colors.text.primary, fontSize: fontSize.lg, fontWeight: fontWeight.semibold, flex: 1 }}>{statusLine}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: spacing.xl, marginTop: spacing.sm }}>
          <Stat k="Phase" v={phase} />
          <Stat k="Step" v={iter != null ? String(iter) : "—"} />
          <Stat k="Done" v={`${done}/${queue.length}`} />
          <Stat k="Findings" v={String(findings.length)} />
        </View>
        {running ? (
          <Text style={{ color: colors.text.secondary, fontSize: fontSize.sm, marginTop: spacing.sm }} numberOfLines={2}>▶ {running.title}</Text>
        ) : null}
        {/* Telemetry stall warnings — only when stalled and telemetry is available. */}
        {recentTelemetry.slice(0, 2).map((t, i) =>
          t.outcome === "outcome_timeout" ? (
            <Text key={i} style={{ color: colors.warning, fontSize: fontSize.xs, marginTop: i === 0 ? spacing.sm : 2 }}>⚠ A step timed out</Text>
          ) : t.outcome === "loop_halted" ? (
            <Text key={i} style={{ color: colors.warning, fontSize: fontSize.xs, marginTop: i === 0 ? spacing.sm : 2 }}>⚠ Loop halted</Text>
          ) : null
        )}
        {/* Operator's run control — the trigger the app was missing (RULE 3: operator executes). */}
        <View style={{ marginTop: spacing.md }}>
          {live || runStatus === "stalled" ? (
            <RunBtn label="■  Stop run" tone="stop" onPress={onStop} />
          ) : (
            <RunBtn
              label={runStatus === "paused" ? "▶  Continue run" : (runStatus === "completed" || runStatus === "halted") ? "↻  Run again" : "▶  Launch run"}
              tone="go"
              onPress={onLaunch}
            />
          )}
          <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs, marginTop: spacing.xs }}>
            {live ? "Halts after the current step finishes." : runStatus === "stalled" ? "Loop appears stalled — stop to reset." : `${modelLabel} runs this engagement autonomously — you can stop it anytime.`}
          </Text>
        </View>

        {/* Auto-execute switch — operator's call: model proposes & you approve, vs auto-fire (gated). */}
        <Pressable
          onPress={() => onToggleAuto?.(!autoEnabled)}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", marginTop: spacing.md, opacity: pressed ? 0.8 : 1 })}
        >
          <View style={{ flex: 1, paddingRight: spacing.sm }}>
            <Text style={{ color: colors.text.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>Auto-execute steps</Text>
            <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, marginTop: 1 }}>
              {autoEnabled ? `On — ${modelLabel} runs each step itself (membrane-gated).` : "Off — you run each step from the Queue tab."}
            </Text>
          </View>
          <View style={{ width: 46, height: 28, borderRadius: 14, backgroundColor: autoEnabled ? colors.success : colors.gray[600], padding: 3, justifyContent: "center" }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.gray[50], alignSelf: autoEnabled ? "flex-end" : "flex-start" }} />
          </View>
        </Pressable>
      </View>

      {/* Network relay health */}
      {executor ? (
        <View style={{ backgroundColor: colors.bg.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border.subtle }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: !executor.online ? colors.error : !executor.wg_up ? colors.warning : colors.success }} />
            <Text style={{ color: colors.text.primary, fontSize: fontSize.base, fontWeight: fontWeight.medium, flex: 1 }}>{executor.device_id}</Text>
            <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs }}>
              {executor.wifi_ssid || "—"}{executor.battery_pct != null ? ` · ${executor.battery_pct}%` : ""}
            </Text>
          </View>
          {(!executor.online || !executor.wg_up) ? (
            <Text style={{ color: colors.warning, fontSize: fontSize.xs, marginTop: 4 }}>
              ⚠ relay {!executor.online ? "offline" : "WG tunnel stale"} — traffic can't reach the target network
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Live activity */}
      <SectionTitle
        title="⚡ Activity"
        rightLabel={queue.length > activity.length ? `${queue.length} total` : undefined}
        onRightPress={queue.length > activity.length ? () => onSwitchTab?.("queue") : undefined}
        empty={activity.length === 0 ? (live ? "waiting for the first step to run…" : "nothing yet — launch a run to watch it here") : undefined}
      />
      {activity.map((item) => (
        <ActivityRow key={item.id} item={item} onPress={() => onStepPress?.(item)} />
      ))}

      {/* Findings */}
      <SectionTitle
        title="🚨 Findings"
        rightLabel={findings.length > topFindings.length ? `+${findings.length - topFindings.length}` : undefined}
        empty={topFindings.length === 0 ? "none yet" : undefined}
      />
      {topFindings.map((f) => <FindingRow key={f.id} finding={f} onPress={onFindingPress} />)}
    </ScrollView>
  );
}

function RunBtn({ label, onPress, tone }: { label: string; onPress?: () => void; tone: "go" | "stop" }) {
  const bg = tone === "stop" ? colors.error : colors.accent;
  const fg = tone === "stop" ? colors.gray[50] : colors.bg.base;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bg,
        borderRadius: radius.md,
        paddingVertical: spacing.sm + 4,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ color: fg, fontSize: fontSize.base, fontWeight: fontWeight.bold, letterSpacing: 0.3 }}>{label}</Text>
    </Pressable>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <View>
      <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs }}>{k}</Text>
      <Text style={{ color: colors.text.primary, fontSize: fontSize.base, fontWeight: fontWeight.semibold }}>{v}</Text>
    </View>
  );
}

function ActivityRow({ item, onPress }: { item: any; onPress: () => void }) {
  const failed = item.status === "failed";
  const running = item.status === "running";
  const statusColor = failed ? colors.error : running ? colors.success : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: spacing.sm,
        backgroundColor: colors.bg.elevated, borderRadius: radius.md,
        paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md,
        borderLeftWidth: 3, borderLeftColor: statusColor,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor }} />
      <Text style={{ color: failed ? colors.error : colors.text.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium, flex: 1 }} numberOfLines={1}>{item.title}</Text>
      {item.intent_class ? (
        <View style={{ backgroundColor: withAlpha(colors.text.tertiary, 0.12), borderRadius: radius.sm, paddingHorizontal: spacing.xs + 2, paddingVertical: 1 }}>
          <Text style={{ color: colors.text.disabled, fontSize: 9, fontFamily: "monospace" }}>{item.intent_class}</Text>
        </View>
      ) : null}
      <Text style={{ color: colors.text.disabled, fontSize: fontSize.sm }}>›</Text>
    </Pressable>
  );
}

function SectionTitle({ title, rightLabel, onRightPress, empty }: { title: string; rightLabel?: string; onRightPress?: () => void; empty?: string }) {
  return (
    <View style={{ marginTop: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ flex: 1, color: colors.text.secondary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, textTransform: "uppercase", letterSpacing: 0.5 }}>{title}</Text>
        {rightLabel ? (
          onRightPress ? (
            <Pressable onPress={onRightPress} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
              <Text style={{ color: colors.accent, fontSize: fontSize.xs }}>{rightLabel} →</Text>
            </Pressable>
          ) : (
            <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, fontFamily: "monospace" }}>{rightLabel}</Text>
          )
        ) : null}
      </View>
      {empty ? <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, marginTop: spacing.xs }}>{empty}</Text> : null}
    </View>
  );
}
