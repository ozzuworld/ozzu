// SOC engagement detail screen — thin orchestrator over 4 tab components.
// dir_1780764341980: replaced the single-screen dump with Now / Queue / Findings / Detail.
// State lives here; tabs are presentational. Live updates via useBridgeStream
// (socQueueChanged, socStepDone, socFindingAdded, socExecOutput) — no polling.

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { getBridgeUrl } from "../../lib/bridge-api";
import { useBridgeStream } from "../../lib/useBridgeStream";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../lib/design-tokens";
import { PhasePill } from "../../components/soc/PhasePill";
import { NowTab, type ExecutorLite } from "../../components/soc/NowTab";
import { ReportTab } from "../../components/soc/ReportTab";
import { QueueTab } from "../../components/soc/QueueTab";
import { FindingsTab } from "../../components/soc/FindingsTab";
import { DetailTab, type EngagementMeta, type ReconHostRow, type AuditLogRow, type TaskGraphNode } from "../../components/soc/DetailTab";
import { LiveExecModal } from "../../components/soc/LiveExecModal";
import { SocErrorBoundary } from "../../components/soc/SocErrorBoundary";
import { safe } from "../../components/soc/safe";
import type { QueueItemRow } from "../../components/soc/QueueRow";
import type { FindingRowData } from "../../components/soc/FindingRow";
import type { RunningItem } from "../../components/soc/LiveExecBanner";

type Tab = "now" | "queue" | "findings" | "report" | "detail";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "now", label: "Now" },
  { key: "queue", label: "Queue" },
  { key: "findings", label: "Findings" },
  { key: "report", label: "Report" },
  { key: "detail", label: "Detail" },
];

const FALLBACK_POLL_MS = 60_000;

interface QueueItem extends QueueItemRow {
  engagement_id: string;
  command?: string;
  expected_artifact?: string | null;
  session_id?: string | null;
  output?: string | null;
  created_at?: string;
}

export default function EngagementDetailScreen() {
  const router = useRouter();
  const [resetKey, setResetKey] = useState(0);
  return (
    <SocErrorBoundary
      key={resetKey}
      onReset={() => setResetKey((k) => k + 1)}
      onBack={() => router.back()}
    >
      <EngagementDetailInner />
    </SocErrorBoundary>
  );
}

function EngagementDetailInner() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [engagement, setEngagement] = useState<EngagementMeta | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [findings, setFindings] = useState<FindingRowData[]>([]);
  const [reconHosts, setReconHosts] = useState<ReconHostRow[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLogRow[]>([]);
  const [taskGraph, setTaskGraph] = useState<TaskGraphNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("now");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [execItem, setExecItem] = useState<RunningItem | null>(null);
  const [executor, setExecutor] = useState<ExecutorLite>(null);

  const mountedRef = useRef(true);

  // ── Fetchers ──

  const fetchQueue = useCallback(async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/engagements/${id}/queue`);
      const d = await r.json();
      if (!mountedRef.current) return;
      setQueue(d.queue || []);
    } catch {}
  }, [id]);

  const fetchFindings = useCallback(async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/engagements/${id}/findings`);
      const d = await r.json();
      if (!mountedRef.current) return;
      setFindings(d.findings || []);
    } catch {}
  }, [id]);

  const fetchRecon = useCallback(async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/${id}/recon`);
      if (!r.ok) return;
      const d = await r.json();
      if (!mountedRef.current) return;
      setReconHosts(d.hosts || []);
    } catch {}
  }, [id]);

  const fetchAuditLog = useCallback(async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/audit-log/${id}`);
      const d = await r.json();
      if (!mountedRef.current) return;
      setAuditLog(d.executions || []);
    } catch {}
  }, [id]);

  const fetchTaskGraph = useCallback(async () => {
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/engagements/${id}/task-graph`);
      if (!r.ok) return;
      const d = await r.json();
      if (!mountedRef.current) return;
      setTaskGraph(d.tasks || []);
    } catch {}
  }, [id]);

  const fetchAll = useCallback(async () => {
    try {
      const engRes = await fetch(`${getBridgeUrl()}/soc/engagements/${id}`);
      const engData = await engRes.json();
      if (!mountedRef.current) return;
      setEngagement(engData.engagement);
      // Executor health for the observer view — match the engagement's executor against live device_state.
      const execHost = engData.engagement?.executor_host;
      if (execHost) {
        try {
          const er = await fetch(`${getBridgeUrl()}/soc/executors`);
          const ed = await er.json();
          const match = (ed.executors || []).find((x: any) => x.device_id === execHost) || null;
          if (mountedRef.current) setExecutor(match);
        } catch {}
      }
      await Promise.all([fetchQueue(), fetchFindings(), fetchRecon(), fetchAuditLog(), fetchTaskGraph()]);
    } catch {
      Alert.alert("Error", "Failed to load engagement");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [id, fetchQueue, fetchFindings, fetchRecon, fetchAuditLog, fetchTaskGraph]);

  useEffect(() => {
    mountedRef.current = true;
    fetchAll();
    return () => { mountedRef.current = false; };
  }, [fetchAll]);

  // ── Live push subscriptions ──

  const forEngagement = useCallback((msg: any) => msg && msg.engagement_id === id, [id]);

  useBridgeStream(
    "socQueueChanged",
    () => { fetchQueue(); fetchTaskGraph(); },
    { filter: forEngagement, fallbackPollMs: FALLBACK_POLL_MS, onFallback: () => { fetchQueue(); fetchTaskGraph(); } },
  );
  useBridgeStream(
    "socStepDone",
    () => { fetchQueue(); fetchTaskGraph(); fetchAuditLog(); },
    { filter: forEngagement },
  );
  useBridgeStream(
    "socFindingAdded",
    () => { fetchFindings(); },
    { filter: forEngagement },
  );

  // ── Actions ──

  const runQueueItem = useCallback(async (item: QueueItemRow) => {
    if (busyId != null) return;
    setBusyId(item.id);
    try {
      const r = await fetch(`${getBridgeUrl()}/soc/queue/${item.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "running" } : q)));
    } catch (e: any) {
      Alert.alert("Run failed", e.message || "Could not start step");
    } finally {
      setBusyId(null);
    }
  }, [busyId]);

  const cancelQueueItem = useCallback((item: QueueItemRow) => {
    Alert.alert(
      "Cancel running step?",
      `Kill "${item.title}"? Partial output will be saved.`,
      [
        { text: "Keep running", style: "cancel" },
        {
          text: "Cancel",
          style: "destructive",
          onPress: async () => {
            try {
              const r = await fetch(`${getBridgeUrl()}/soc/queue/${item.id}/cancel`, { method: "POST" });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
            } catch (e: any) {
              Alert.alert("Cancel failed", e.message || "Could not cancel step");
            }
          },
        },
      ],
    );
  }, []);

  const skipQueueItem = useCallback((item: QueueItemRow) => {
    Alert.alert("Skip step?", `Mark "${item.title}" as skipped?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Skip",
        style: "destructive",
        onPress: async () => {
          try {
            await fetch(`${getBridgeUrl()}/soc/queue/${item.id}/skip`, { method: "POST" });
          } catch (e: any) {
            Alert.alert("Skip failed", e.message || "Could not skip step");
          }
        },
      },
    ]);
  }, []);

  const onOutputUpdate = useCallback((itemId: number, output: string) => {
    setQueue((prev) => prev.map((q) => (q.id === itemId ? { ...q, output } : q)));
    setExecItem((prev) => (prev && prev.id === itemId ? { ...prev, output } : prev));
  }, []);

  const onFindingPress = useCallback((f: FindingRowData) => {
    const desc = (f as any).description as string | undefined;
    const rem = (f as any).remediation as string | undefined;
    Alert.alert(
      f.title,
      [
        f.affected_asset ? `Asset: ${f.affected_asset}` : null,
        f.cvss_score != null ? `CVSS: ${f.cvss_score}` : null,
        desc ? `\n${desc}` : null,
        rem ? `\nFix: ${rem}` : null,
      ].filter(Boolean).join("\n"),
    );
  }, []);

  // Operator's run controls — the app's missing trigger (RULE 3). launch fires the autonomous
  // DeepSeek run via the bridge; stop sets the abort flag the loop honors after the current step.
  const launchRun = useCallback(() => {
    const targets = ((engagement as any)?.scope?.target_networks || []).map((t: any) => t.ssid).filter(Boolean).join(", ");
    const execName = (engagement as any)?.executor_host || "the executor";
    Alert.alert(
      "Launch run",
      `DeepSeek will autonomously run this engagement${targets ? ` against ${targets}` : ""} via ${execName}, up to 50 steps. You can stop it anytime. Launch?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Launch",
          onPress: async () => {
            try {
              const r = await fetch(`${getBridgeUrl()}/soc/engagements/${id}/run`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ max_iter: 50 }),
              });
              if (!r.ok) { const d = await r.json().catch(() => ({})); Alert.alert("Couldn't launch", d.error || `HTTP ${r.status}`); return; }
              setTimeout(fetchAll, 900);
            } catch (e: any) { Alert.alert("Couldn't launch", e?.message || "network error"); }
          },
        },
      ],
    );
  }, [id, engagement, fetchAll]);

  const stopRun = useCallback(async () => {
    try { await fetch(`${getBridgeUrl()}/soc/engagements/${id}/stop`, { method: "POST" }); setTimeout(fetchAll, 600); } catch {}
  }, [id, fetchAll]);

  // Operator's autonomy switch — flip the run between propose-and-approve and auto-execute (gated).
  const toggleAuto = useCallback(async (enabled: boolean) => {
    try {
      await fetch(`${getBridgeUrl()}/soc/engagements/${id}/autonomy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      setTimeout(fetchAll, 700);
    } catch (e: any) { Alert.alert("Couldn't change mode", e?.message || "network error"); }
  }, [id, fetchAll]);

  const running = useMemo(() => queue.find((q) => q.status === "running"), [queue]);

  // ── Loading / not-found gates ──

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!engagement) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
        <Text style={{ color: colors.text.disabled, textAlign: "center", marginTop: spacing.xl }}>
          Engagement not found
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />

      {/* Header */}
      <View
        style={{
          paddingHorizontal: spacing.md,
          paddingTop: spacing.sm,
          paddingBottom: spacing.md,
          backgroundColor: colors.bg.elevated,
          borderBottomWidth: 1,
          borderBottomColor: colors.border.subtle,
        }}
      >
        <Pressable onPress={() => router.back()} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, marginBottom: spacing.xs })}>
          <Text style={{ color: colors.accent, fontSize: fs.sm }}>← Back</Text>
        </Pressable>
        <Text
          style={{ color: colors.text.primary, fontSize: fs.xxl, fontWeight: fw.bold }}
          numberOfLines={1}
        >
          {safe(engagement.id, "—")}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.xs, gap: spacing.sm }}>
          <Text style={{ color: colors.text.secondary, fontSize: fs.md, flex: 1 }} numberOfLines={1}>
            {safe(engagement.client_name, "—")}
            {engagement.engagement_type ? ` · ${engagement.engagement_type}` : ""}
          </Text>
          <PhasePill phase={engagement.engagement_phase} size="sm" />
        </View>
      </View>

      {/* Tab nav */}
      <View
        style={{
          flexDirection: "row",
          backgroundColor: colors.bg.elevated,
          borderBottomWidth: 1,
          borderBottomColor: colors.border.subtle,
        }}
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          const badge = countForTab(t.key, queue, findings);
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              style={({ pressed }) => [
                styles.tab,
                active && styles.tabActive,
                pressed && { opacity: 0.8 },
              ]}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: active ? colors.accent : colors.text.secondary,
                  fontSize: fs.sm,
                  fontWeight: active ? fw.semibold : fw.medium,
                }}
              >
                {t.label}
              </Text>
              {badge != null && badge > 0 ? (
                <View
                  style={{
                    minWidth: 17,
                    paddingHorizontal: 5,
                    paddingVertical: 1,
                    borderRadius: 9,
                    backgroundColor: colors.gray[700],
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: active ? colors.accent : colors.text.secondary, fontSize: 10, fontFamily: "monospace", fontWeight: fw.semibold }}>
                    {badge}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {/* Active tab body */}
      {tab === "now" ? (
        <NowTab
          engagement={engagement}
          executor={executor}
          queue={queue}
          findings={findings}
          onFindingPress={onFindingPress}
          onLaunch={launchRun}
          onStop={stopRun}
          onToggleAuto={toggleAuto}
        />
      ) : null}
      {tab === "queue" ? (
        <QueueTab
          queue={queue}
          busyId={busyId}
          onRun={runQueueItem}
          onCancel={cancelQueueItem}
          onSkip={skipQueueItem}
        />
      ) : null}
      {tab === "findings" ? (
        <FindingsTab findings={findings} onFindingPress={onFindingPress} />
      ) : null}
      {tab === "report" ? <ReportTab engagementId={id!} /> : null}
      {tab === "detail" ? (
        <DetailTab
          engagement={engagement}
          reconHosts={reconHosts}
          auditLog={auditLog}
          taskGraph={taskGraph}
        />
      ) : null}

      {/* Full exec modal */}
      <LiveExecModal
        visible={execItem != null}
        item={execItem}
        onClose={() => setExecItem(null)}
        onCancel={running ? () => { cancelQueueItem(running); setExecItem(null); } : undefined}
      />
    </View>
  );
}

function countForTab(key: Tab, queue: QueueItem[], findings: FindingRowData[]): number | null {
  if (key === "queue") return queue.length;
  if (key === "findings") return findings.length;
  return null;
}

const styles = StyleSheet.create({
  tab: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: 2,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: colors.accent,
  },
});
