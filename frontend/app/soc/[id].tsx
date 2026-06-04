import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Alert,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { getBridgeUrl } from "../../lib/bridge-api";
import { colors, spacing, radius, fontSize as fs, fontWeight as fw, withAlpha } from "../../lib/design-tokens";

type EngagementDetail = {
  id: string;
  client_name: string;
  engagement_type: string;
  status: string;
  scope: any;
  roe: any;
  start_date: string;
  end_date: string;
  // Step 5+8 agent loop columns (dir_1780589262481 + dir_1780594102051)
  engagement_phase?: "recon" | "enumeration" | "foothold" | "exploitation" | "post_exploit" | "reporting" | string;
  agent_status?: "idle" | "running" | "completed" | "error" | string;
};

type TaskOutcomeSummary = {
  success?: boolean;
  key_signals?: string[];
  new_findings?: any[];
  new_hosts?: any[];
  followup?: string[];
  error_category?: string | null;
};

type EngagementTask = {
  id: number;
  engagement_id: string;
  parent_ids: number[];
  directive: string;
  phase: string | null;
  prerequisites: string | null;
  status: "pending" | "in_flight" | "done" | "failed" | "skipped";
  queue_item_id: number | null;
  outcome_summary: TaskOutcomeSummary | null;
  iteration: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type TaskGraph = {
  tasks: EngagementTask[];
  unblocked: number[];
  total: number;
};

type Script = {
  id: string;
  phase: string;
  name: string;
  description: string;
  command: string;
  status: "ready" | "completed" | "manual";
};

type Execution = {
  session_id: string;
  agent_name: string;
  task: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at: string | null;
  output: string | null;
};

type QueueItem = {
  id: number;
  engagement_id: string;
  seq: number;
  title: string;
  description: string | null;
  command: string;
  expected_artifact: string | null;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  session_id: string | null;
  output: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

// Polling interval while screen is mounted. Server side is cheap (<50ms per query)
// and one engaged user generates ~30 req/min — well within bridge capacity.
const POLL_INTERVAL_MS = 2000;

export default function EngagementDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [engagement, setEngagement] = useState<EngagementDetail | null>(null);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [taskGraph, setTaskGraph] = useState<TaskGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningQueueItem, setRunningQueueItem] = useState<number | null>(null);
  const [executing, setExecuting] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number>(Date.now());
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    completed: false,
    failed: true,   // shown by default IF any failures (we hide section entirely if 0)
    scripts: false,
    history: false,
    taskGraph: true,  // open by default — operator should see the agent's plan
  });
  const [showHeroOutput, setShowHeroOutput] = useState(true);

  const heroOutputScrollRef = useRef<ScrollView | null>(null);

  // ===== Data fetching =====
  const fetchQueue = useCallback(async () => {
    try {
      const response = await fetch(`${getBridgeUrl()}/soc/engagements/${id}/queue`);
      const data = await response.json();
      setQueue(data.queue || []);
      setLastSyncAt(Date.now());
    } catch (error) {
      console.error("Error fetching queue:", error);
    }
  }, [id]);

  // Step 6: pull the L3 agent's task graph (DAG). Cheap query; safe to include
  // in the same poll interval as the queue.
  const fetchTaskGraph = useCallback(async () => {
    try {
      const response = await fetch(`${getBridgeUrl()}/soc/engagements/${id}/task-graph`);
      if (!response.ok) return;
      const data = await response.json();
      setTaskGraph(data as TaskGraph);
    } catch (error) {
      // Task graph is informational; don't surface fetch errors as alerts.
      console.error("Error fetching task graph:", error);
    }
  }, [id]);

  const fetchExecutions = useCallback(async () => {
    try {
      const response = await fetch(`${getBridgeUrl()}/soc/audit-log/${id}`);
      const data = await response.json();
      setExecutions(data.executions || []);
    } catch (error) {
      console.error("Error fetching executions:", error);
    }
  }, [id]);

  const fetchAll = useCallback(async () => {
    try {
      const [engRes, scriptsRes, execRes, queueRes, taskGraphRes] = await Promise.all([
        fetch(`${getBridgeUrl()}/soc/engagements/${id}`),
        fetch(`${getBridgeUrl()}/soc/engagements/${id}/scripts`),
        fetch(`${getBridgeUrl()}/soc/audit-log/${id}`),
        fetch(`${getBridgeUrl()}/soc/engagements/${id}/queue`),
        fetch(`${getBridgeUrl()}/soc/engagements/${id}/task-graph`),
      ]);

      const engData = await engRes.json();
      const scriptsData = await scriptsRes.json();
      const execData = await execRes.json();
      const queueData = await queueRes.json();
      const taskGraphData = taskGraphRes.ok ? await taskGraphRes.json() : null;

      setEngagement(engData.engagement);
      setScripts(scriptsData.scripts || []);
      setExecutions(execData.executions || []);
      setQueue(queueData.queue || []);
      setTaskGraph(taskGraphData);
      setLastSyncAt(Date.now());
    } catch (error) {
      console.error("Error fetching engagement:", error);
      Alert.alert("Error", "Failed to load engagement");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Always-on polling while screen is mounted — gives "webhook-like" auto-updates
  // for Cipher-queued items and live output without manual refresh.
  // Native RN pauses setInterval when app backgrounded, so it's cheap when not in use.
  useEffect(() => {
    const t = setInterval(() => { fetchQueue(); fetchTaskGraph(); }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [fetchQueue]);

  // ===== Actions =====
  const runQueueItem = useCallback(async (item: QueueItem) => {
    if (runningQueueItem != null) return;
    setRunningQueueItem(item.id);
    try {
      const response = await fetch(`${getBridgeUrl()}/soc/queue/${item.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "running" } : q)));
      setTimeout(() => fetchQueue(), 800);
    } catch (error: any) {
      Alert.alert("Run failed", error.message || "Could not start step");
    } finally {
      setRunningQueueItem(null);
    }
  }, [runningQueueItem, fetchQueue]);

  const cancelQueueItem = useCallback(async (item: QueueItem) => {
    Alert.alert(
      "Cancel running step?",
      `Kill "${item.title}" on dev-01? Any partial output will be saved.`,
      [
        { text: "Keep running", style: "cancel" },
        {
          text: "Cancel step",
          style: "destructive",
          onPress: async () => {
            try {
              const response = await fetch(`${getBridgeUrl()}/soc/queue/${item.id}/cancel`, { method: "POST" });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "failed" } : q)));
              setTimeout(() => fetchQueue(), 500);
            } catch (error: any) {
              Alert.alert("Cancel failed", error.message || "Could not cancel step");
            }
          },
        },
      ]
    );
  }, [fetchQueue]);

  const skipQueueItem = useCallback(async (item: QueueItem) => {
    Alert.alert("Skip step?", `Mark "${item.title}" as skipped?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Skip",
        style: "destructive",
        onPress: async () => {
          try {
            await fetch(`${getBridgeUrl()}/soc/queue/${item.id}/skip`, { method: "POST" });
            fetchQueue();
          } catch (error: any) {
            Alert.alert("Skip failed", error.message || "Could not skip step");
          }
        },
      },
    ]);
  }, [fetchQueue]);

  const executeScript = useCallback(async (script: Script) => {
    if (executing) return;
    Alert.alert("Execute Script", `This will run:\n\n${script.command}\n\non dev-01 via SSH.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Execute",
          onPress: async () => {
            setExecuting(true);
            try {
              const response = await fetch(`${getBridgeUrl()}/soc/execute`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ engagement_id: id, script_id: script.id, command: script.command }),
              });
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const data = await response.json();
              Alert.alert("Execution Started", `Session: ${data.session_id}`, [
                { text: "OK", onPress: () => setTimeout(() => fetchExecutions(), 1500) },
              ]);
            } catch (error: any) {
              Alert.alert("Error", error.message || "Failed to execute script");
            } finally {
              setExecuting(false);
            }
          },
        },
      ]
    );
  }, [id, executing, fetchExecutions]);

  // ===== Derived state =====
  const buckets = useMemo(() => {
    const running = queue.filter((q) => q.status === "running");
    const pending = queue.filter((q) => q.status === "pending");
    const done = queue.filter((q) => q.status === "done");
    const failed = queue.filter((q) => q.status === "failed" || q.status === "skipped");
    return { running, pending, done, failed };
  }, [queue]);

  // Hero = currently running, or next pending. Drives the big "now what" card at top.
  const heroItem: QueueItem | null = buckets.running[0] || buckets.pending[0] || null;
  const otherPending = buckets.pending.filter((p) => p.id !== heroItem?.id);

  // Auto-scroll hero output to bottom as new output streams in
  useEffect(() => {
    if (heroItem?.status === "running" && heroOutputScrollRef.current) {
      heroOutputScrollRef.current.scrollToEnd({ animated: false });
    }
  }, [heroItem?.output, heroItem?.status]);

  const toggleSection = useCallback((key: string) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const lastSyncLabel = useMemo(() => {
    const sec = Math.floor((Date.now() - lastSyncAt) / 1000);
    if (sec < 3) return "just now";
    if (sec < 60) return `${sec}s ago`;
    return `${Math.floor(sec / 60)}m ago`;
  }, [lastSyncAt]);

  // ===== Loading / not-found gates =====
  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.primary, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent.blue} />
      </View>
    );
  }

  if (!engagement) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.primary, paddingTop: insets.top }}>
        <Text style={{ color: colors.text.disabled, textAlign: "center", marginTop: spacing.xl }}>
          Engagement not found
        </Text>
      </View>
    );
  }

  const engStatusColor = engagement.status === "in_progress" ? colors.status.working
    : engagement.status === "completed" ? colors.status.success
    : engagement.status === "scoping" ? colors.accent.blue
    : colors.text.disabled;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.primary, paddingTop: insets.top }}>
      <StatusBar style="light" />

      {/* === Compact header === */}
      <View style={{
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        backgroundColor: colors.bg.secondary,
        borderBottomWidth: 1,
        borderBottomColor: colors.border.subtle,
      }}>
        <Pressable onPress={() => router.back()} style={{ marginBottom: spacing.xs }}>
          <Text style={{ color: colors.accent.blue, fontSize: fs.sm }}>← Back</Text>
        </Pressable>

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: fs.md, fontWeight: fw.semibold, color: colors.text.primary }} numberOfLines={1}>
              {engagement.id}
            </Text>
            <Text style={{ fontSize: fs.xs, color: colors.text.secondary, marginTop: 2 }} numberOfLines={1}>
              {engagement.client_name} · {engagement.engagement_type}
            </Text>
          </View>
          <View style={{
            paddingHorizontal: spacing.sm,
            paddingVertical: 3,
            backgroundColor: withAlpha(engStatusColor, 0.15),
            borderRadius: radius.sm,
            marginLeft: spacing.sm,
          }}>
            <Text style={{ fontSize: fs.xs, color: engStatusColor, fontWeight: fw.medium }}>
              {engagement.status.toUpperCase()}
            </Text>
          </View>
        </View>

        {/* Step 6: agent phase + status pills (only when the agent has run) */}
        {(engagement.engagement_phase || engagement.agent_status) && (
          <View style={{ flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs, flexWrap: "wrap" }}>
            {engagement.engagement_phase && (
              <View style={{
                paddingHorizontal: spacing.sm, paddingVertical: 2,
                backgroundColor: withAlpha(colors.brand.purple, 0.15),
                borderRadius: radius.sm,
              }}>
                <Text style={{ fontSize: 10, color: colors.brand.purple, fontWeight: fw.medium }}>
                  phase: {engagement.engagement_phase}
                </Text>
              </View>
            )}
            {engagement.agent_status && (
              <View style={{
                paddingHorizontal: spacing.sm, paddingVertical: 2,
                backgroundColor: withAlpha(
                  engagement.agent_status === "running" ? colors.status.in_progress
                  : engagement.agent_status === "completed" ? colors.status.completed
                  : engagement.agent_status === "error" ? colors.status.failed
                  : colors.text.disabled, 0.15
                ),
                borderRadius: radius.sm,
              }}>
                <Text style={{
                  fontSize: 10,
                  color: engagement.agent_status === "running" ? colors.status.in_progress
                       : engagement.agent_status === "completed" ? colors.status.completed
                       : engagement.agent_status === "error" ? colors.status.failed
                       : colors.text.disabled,
                  fontWeight: fw.medium,
                }}>
                  agent: {engagement.agent_status}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Live-sync indicator */}
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.xs }}>
          <View style={{
            width: 6, height: 6, borderRadius: 3,
            backgroundColor: colors.status.success,
            marginRight: 6,
          }} />
          <Text style={{ fontSize: 10, color: colors.text.disabled }}>
            Live · last sync {lastSyncLabel}
          </Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl * 2 }}>

        {/* === HERO CARD: most-immediate item === */}
        {heroItem && (
          <View style={{
            marginBottom: spacing.lg,
            backgroundColor: colors.bg.secondary,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: heroItem.status === "running" ? colors.status.working : colors.accent.blue,
            borderLeftWidth: 4,
            overflow: "hidden",
          }}>
            <View style={{ padding: spacing.md }}>
              {/* Eyebrow label */}
              <Text style={{
                fontSize: 10,
                fontWeight: fw.medium,
                color: heroItem.status === "running" ? colors.status.working : colors.accent.blue,
                marginBottom: spacing.xs,
                letterSpacing: 1.5,
              }}>
                {heroItem.status === "running" ? "🔴 RUNNING NOW" : "⏵ NEXT — TAP TO RUN"}
              </Text>

              {/* Title row */}
              <View style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: spacing.sm }}>
                <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontWeight: fw.medium, marginRight: spacing.sm, marginTop: 2 }}>
                  #{heroItem.seq}
                </Text>
                <Text style={{ flex: 1, fontSize: fs.md, fontWeight: fw.semibold, color: colors.text.primary }}>
                  {heroItem.title}
                </Text>
              </View>

              {/* Description (always shown in hero) */}
              {heroItem.description && (
                <Text style={{ fontSize: fs.sm, color: colors.text.secondary, marginBottom: spacing.md, lineHeight: 18 }}>
                  {heroItem.description}
                </Text>
              )}

              {/* Streaming output (running only) */}
              {heroItem.status === "running" && heroItem.output && showHeroOutput && (
                <View style={[styles.outputContainer, { marginBottom: spacing.md, maxHeight: 220 }]}>
                  <ScrollView ref={heroOutputScrollRef} nestedScrollEnabled>
                    <Text style={styles.outputText}>{heroItem.output}</Text>
                  </ScrollView>
                </View>
              )}

              {/* Action row */}
              {heroItem.status === "pending" && (
                <View style={{ flexDirection: "row", gap: spacing.sm }}>
                  <Pressable
                    onPress={() => runQueueItem(heroItem)}
                    disabled={runningQueueItem != null}
                    style={({ pressed }) => [{
                      flex: 1,
                      backgroundColor: colors.accent.blue,
                      paddingVertical: spacing.md,
                      borderRadius: radius.md,
                      alignItems: "center",
                      opacity: runningQueueItem != null ? 0.5 : pressed ? 0.9 : 1,
                    }]}
                  >
                    <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.semibold }}>
                      ▶  RUN ON DEV-01
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => skipQueueItem(heroItem)}
                    style={({ pressed }) => [{
                      backgroundColor: colors.bg.tertiary,
                      paddingVertical: spacing.md,
                      paddingHorizontal: spacing.md,
                      borderRadius: radius.md,
                      opacity: pressed ? 0.9 : 1,
                    }]}
                  >
                    <Text style={{ color: colors.text.secondary, fontSize: fs.sm }}>Skip</Text>
                  </Pressable>
                </View>
              )}

              {heroItem.status === "running" && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <ActivityIndicator size="small" color={colors.status.working} />
                  <Text style={{ flex: 1, marginLeft: spacing.sm, color: colors.text.secondary, fontSize: fs.sm }}>
                    Running on dev-01 · streaming output
                  </Text>
                  <Pressable
                    onPress={() => setShowHeroOutput((v) => !v)}
                    style={({ pressed }) => [{
                      paddingVertical: spacing.xs,
                      paddingHorizontal: spacing.sm,
                      opacity: pressed ? 0.7 : 1,
                    }]}
                  >
                    <Text style={{ color: colors.accent.blue, fontSize: fs.xs }}>
                      {showHeroOutput ? "Hide" : "Show"} output
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => cancelQueueItem(heroItem)}
                    style={({ pressed }) => [{
                      backgroundColor: withAlpha(colors.status.error, 0.15),
                      borderWidth: 1,
                      borderColor: colors.status.error,
                      paddingVertical: spacing.xs,
                      paddingHorizontal: spacing.md,
                      borderRadius: radius.md,
                      opacity: pressed ? 0.8 : 1,
                    }]}
                  >
                    <Text style={{ color: colors.status.error, fontSize: fs.sm, fontWeight: fw.medium }}>
                      Cancel
                    </Text>
                  </Pressable>
                </View>
              )}
            </View>
          </View>
        )}

        {/* === Empty queue message === */}
        {queue.length === 0 && (
          <View style={{
            padding: spacing.lg,
            alignItems: "center",
            backgroundColor: colors.bg.secondary,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.border.subtle,
            marginBottom: spacing.lg,
          }}>
            <Text style={{ color: colors.text.secondary, fontSize: fs.sm, textAlign: "center" }}>
              No queue items yet
            </Text>
            <Text style={{ color: colors.text.disabled, fontSize: fs.xs, marginTop: spacing.xs, textAlign: "center" }}>
              Cipher will push steps here as the engagement progresses
            </Text>
          </View>
        )}

        {/* === Other pending (besides hero) === */}
        {otherPending.length > 0 && (
          <View style={{ marginBottom: spacing.lg }}>
            <SectionHeader label="Also pending" count={otherPending.length} accent={colors.accent.blue} alwaysOpen />
            <View style={{ gap: spacing.sm }}>
              {otherPending.map((item) => (
                <CompactQueueRow
                  key={item.id}
                  item={item}
                  onTap={() => runQueueItem(item)}
                  onSkip={() => skipQueueItem(item)}
                  runDisabled={runningQueueItem != null}
                />
              ))}
            </View>
          </View>
        )}

        {/* === Completed === */}
        {buckets.done.length > 0 && (
          <CollapsibleSection
            label="Completed"
            count={buckets.done.length}
            accent={colors.status.success}
            isOpen={openSections.completed}
            onToggle={() => toggleSection("completed")}
          >
            <View style={{ gap: spacing.sm }}>
              {buckets.done.map((item) => <ResultRow key={item.id} item={item} />)}
            </View>
          </CollapsibleSection>
        )}

        {/* === Failed / Skipped === */}
        {buckets.failed.length > 0 && (
          <CollapsibleSection
            label="Failed / Skipped"
            count={buckets.failed.length}
            accent={colors.status.error}
            isOpen={openSections.failed}
            onToggle={() => toggleSection("failed")}
          >
            <View style={{ gap: spacing.sm }}>
              {buckets.failed.map((item) => <ResultRow key={item.id} item={item} />)}
            </View>
          </CollapsibleSection>
        )}

        {/* === Agent Plan (Step 6) — Task Coordination Graph from the L3 multi-agent loop === */}
        {taskGraph && taskGraph.tasks.length > 0 && (
          <CollapsibleSection
            label="Agent plan"
            count={taskGraph.tasks.length}
            accent={colors.brand.purple}
            isOpen={openSections.taskGraph}
            onToggle={() => toggleSection("taskGraph")}
          >
            <View style={{ gap: spacing.sm }}>
              {taskGraph.tasks.map((task) => {
                const statusColor =
                  task.status === "done"     ? colors.status.completed
                : task.status === "failed"   ? colors.status.failed
                : task.status === "in_flight" ? colors.status.in_progress
                : task.status === "skipped"  ? colors.text.disabled
                : taskGraph.unblocked.includes(task.id) ? colors.brand.blue
                : colors.text.disabled;
                const signals = (task.outcome_summary && Array.isArray(task.outcome_summary.key_signals))
                  ? task.outcome_summary.key_signals : [];
                return (
                  <View key={task.id} style={styles.executionCard}>
                    <View style={{
                      position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
                      backgroundColor: statusColor,
                      borderTopLeftRadius: radius.md, borderBottomLeftRadius: radius.md,
                    }} />
                    <View style={{ paddingLeft: spacing.sm }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                        <Text style={{ fontSize: fs.xs, color: colors.text.secondary, fontFamily: "monospace" }}>
                          task #{task.id}{task.phase ? ` · ${task.phase}` : ""}
                        </Text>
                        <Text style={{ fontSize: 10, color: statusColor, fontWeight: fw.medium }}>
                          {task.status.toUpperCase()}
                        </Text>
                      </View>
                      <Text style={{ fontSize: fs.sm, color: colors.text.primary, marginTop: 2 }}>
                        {task.directive}
                      </Text>
                      {signals.length > 0 && (
                        <View style={{ marginTop: spacing.xs, paddingTop: spacing.xs, borderTopWidth: 1, borderTopColor: colors.border.subtle }}>
                          {signals.slice(0, 3).map((sig, i) => (
                            <Text key={i} style={{ fontSize: 11, color: colors.text.secondary, marginTop: 2 }}>
                              · {sig}
                            </Text>
                          ))}
                        </View>
                      )}
                      {task.outcome_summary && task.outcome_summary.error_category && (
                        <Text style={{ fontSize: 10, color: colors.status.failed, marginTop: 2, fontFamily: "monospace" }}>
                          ⚠ {task.outcome_summary.error_category}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
              {taskGraph.unblocked.length > 0 && (
                <Text style={{ fontSize: 10, color: colors.text.disabled, marginTop: spacing.xs, fontStyle: "italic" }}>
                  Unblocked pending: {taskGraph.unblocked.join(", ")}
                </Text>
              )}
            </View>
          </CollapsibleSection>
        )}

        {/* === Scripts (legacy, collapsed) === */}
        {scripts.length > 0 && (
          <CollapsibleSection
            label="Available scripts"
            count={scripts.length}
            accent={colors.text.disabled}
            isOpen={openSections.scripts}
            onToggle={() => toggleSection("scripts")}
          >
            <View style={{ gap: spacing.sm }}>
              {scripts.map((script) => (
                <View key={script.id} style={styles.scriptCard}>
                  <Text style={{ fontSize: fs.sm, fontWeight: fw.medium, color: colors.text.primary }}>
                    {script.phase}
                  </Text>
                  <Text style={{ fontSize: fs.xs, color: colors.text.secondary, marginTop: 2, marginBottom: spacing.sm }}>
                    {script.description}
                  </Text>
                  <Pressable
                    onPress={() => executeScript(script)}
                    disabled={executing || script.status === "manual"}
                    style={({ pressed }) => [{
                      backgroundColor: colors.accent.blue,
                      paddingVertical: spacing.sm,
                      borderRadius: radius.sm,
                      alignItems: "center",
                      opacity: executing || script.status === "manual" ? 0.5 : pressed ? 0.9 : 1,
                    }]}
                  >
                    <Text style={{ color: colors.text.primary, fontSize: fs.sm, fontWeight: fw.medium }}>▶ Run</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </CollapsibleSection>
        )}

        {/* === Execution History === */}
        {executions.length > 0 && (
          <CollapsibleSection
            label="Execution history"
            count={executions.length}
            accent={colors.text.disabled}
            isOpen={openSections.history}
            onToggle={() => toggleSection("history")}
          >
            <View style={{ gap: spacing.sm }}>
              {executions.slice(0, 20).map((exec) => (
                <View key={exec.session_id} style={styles.executionCard}>
                  <View style={{
                    position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
                    backgroundColor: exec.status === "completed" ? colors.status.success
                      : exec.status === "failed" ? colors.status.error : colors.status.working,
                    borderTopLeftRadius: radius.md, borderBottomLeftRadius: radius.md,
                  }} />
                  <View style={{ paddingLeft: spacing.sm }}>
                    <Text style={{ fontSize: fs.xs, color: colors.text.secondary, fontFamily: "monospace" }} numberOfLines={1}>
                      {exec.session_id}
                    </Text>
                    <Text style={{ fontSize: 10, color: colors.text.disabled, marginTop: 2 }}>
                      {new Date(exec.started_at).toLocaleTimeString()} · {exec.status}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </CollapsibleSection>
        )}
      </ScrollView>
    </View>
  );
}

// ===== Helper components =====

function SectionHeader({
  label, count, accent, alwaysOpen, isOpen, onToggle,
}: {
  label: string;
  count: number;
  accent: string;
  alwaysOpen?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <View style={{
      flexDirection: "row", alignItems: "center",
      paddingVertical: spacing.sm,
      borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
      marginBottom: spacing.sm,
    }}>
      <View style={{
        width: 4, height: 16, backgroundColor: accent, marginRight: spacing.sm, borderRadius: 2,
      }} />
      <Text style={{ flex: 1, fontSize: fs.sm, fontWeight: fw.semibold, color: colors.text.secondary, letterSpacing: 0.5 }}>
        {label.toUpperCase()}
      </Text>
      <View style={{
        paddingHorizontal: spacing.sm, paddingVertical: 2,
        backgroundColor: withAlpha(accent, 0.15), borderRadius: radius.sm,
        minWidth: 24, alignItems: "center",
      }}>
        <Text style={{ fontSize: fs.xs, color: accent, fontWeight: fw.medium }}>{count}</Text>
      </View>
      {!alwaysOpen && (
        <Text style={{ marginLeft: spacing.sm, color: colors.text.disabled, fontSize: fs.sm }}>
          {isOpen ? "▾" : "▸"}
        </Text>
      )}
    </View>
  );
  if (alwaysOpen) return content;
  return <Pressable onPress={onToggle}>{content}</Pressable>;
}

function CollapsibleSection({
  label, count, accent, isOpen, onToggle, children,
}: {
  label: string;
  count: number;
  accent: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <SectionHeader label={label} count={count} accent={accent} isOpen={isOpen} onToggle={onToggle} />
      {isOpen && children}
    </View>
  );
}

function CompactQueueRow({
  item, onTap, onSkip, runDisabled,
}: {
  item: QueueItem;
  onTap: () => void;
  onSkip: () => void;
  runDisabled: boolean;
}) {
  return (
    <View style={[styles.queueCard, { borderLeftColor: colors.accent.blue, borderLeftWidth: 3 }]}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontWeight: fw.medium, marginRight: spacing.sm }}>
          #{item.seq}
        </Text>
        <Text style={{ flex: 1, fontSize: fs.sm, fontWeight: fw.medium, color: colors.text.primary }} numberOfLines={1}>
          {item.title}
        </Text>
        <Pressable
          onPress={onTap}
          disabled={runDisabled}
          style={({ pressed }) => [{
            backgroundColor: colors.accent.blue,
            paddingVertical: spacing.xs,
            paddingHorizontal: spacing.md,
            borderRadius: radius.sm,
            opacity: runDisabled ? 0.5 : pressed ? 0.9 : 1,
          }]}
        >
          <Text style={{ color: colors.text.primary, fontSize: fs.xs, fontWeight: fw.medium }}>▶ Run</Text>
        </Pressable>
        <Pressable
          onPress={onSkip}
          style={({ pressed }) => [{
            marginLeft: spacing.xs,
            paddingVertical: spacing.xs,
            paddingHorizontal: spacing.sm,
            opacity: pressed ? 0.7 : 1,
          }]}
        >
          <Text style={{ color: colors.text.disabled, fontSize: fs.xs }}>Skip</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ResultRow({ item }: { item: QueueItem }) {
  const [open, setOpen] = useState(false);
  const accent = item.status === "done" ? colors.status.success
    : item.status === "failed" ? colors.status.error
    : colors.text.disabled;
  const icon = item.status === "done" ? "✓" : item.status === "failed" ? "✗" : "⊘";
  return (
    <Pressable onPress={() => setOpen((v) => !v)}>
      <View style={[styles.queueCard, { borderLeftColor: accent, borderLeftWidth: 3 }]}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={{ color: accent, fontSize: fs.md, fontWeight: fw.semibold, marginRight: spacing.sm, width: 16 }}>
            {icon}
          </Text>
          <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontWeight: fw.medium, marginRight: spacing.sm }}>
            #{item.seq}
          </Text>
          <Text style={{ flex: 1, fontSize: fs.sm, color: colors.text.primary }} numberOfLines={open ? undefined : 1}>
            {item.title}
          </Text>
          {item.completed_at && (
            <Text style={{ color: colors.text.disabled, fontSize: fs.xs, marginLeft: spacing.sm }}>
              {new Date(item.completed_at).toLocaleTimeString()}
            </Text>
          )}
          <Text style={{ marginLeft: spacing.sm, color: colors.text.disabled, fontSize: fs.sm }}>
            {open ? "▾" : "▸"}
          </Text>
        </View>
        {open && item.output && (
          <View style={[styles.outputContainer, { marginTop: spacing.sm, maxHeight: 320 }]}>
            <ScrollView nestedScrollEnabled>
              <Text style={styles.outputText}>{item.output}</Text>
            </ScrollView>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scriptCard: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  queueCard: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  executionCard: {
    backgroundColor: colors.bg.secondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    position: "relative",
  },
  outputContainer: {
    backgroundColor: colors.bg.tertiary,
    borderRadius: radius.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  outputText: {
    fontFamily: "monospace",
    fontSize: fs.xs,
    color: colors.text.secondary,
    lineHeight: 16,
  },
});
