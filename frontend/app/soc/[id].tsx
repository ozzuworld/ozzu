import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
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

export default function EngagementDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [engagement, setEngagement] = useState<EngagementDetail | null>(null);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingExecutions, setLoadingExecutions] = useState(false);
  const [runningQueueItem, setRunningQueueItem] = useState<number | null>(null);
  const [expandedQueueItem, setExpandedQueueItem] = useState<number | null>(null);

  const [executing, setExecuting] = useState(false);

  const fetchQueue = useCallback(async () => {
    try {
      const response = await fetch(`${getBridgeUrl()}/soc/engagements/${id}/queue`);
      const data = await response.json();
      setQueue(data.queue || []);
    } catch (error) {
      console.error("Error fetching queue:", error);
    }
  }, [id]);

  const fetchExecutions = useCallback(async () => {
    setLoadingExecutions(true);
    try {
      const response = await fetch(`${getBridgeUrl()}/soc/audit-log/${id}`);
      const data = await response.json();
      setExecutions(data.executions || []);
    } catch (error) {
      console.error("Error fetching executions:", error);
    } finally {
      setLoadingExecutions(false);
    }
  }, [id]);

  const fetchEngagement = useCallback(async () => {
    try {
      const [engRes, scriptsRes, execRes, queueRes] = await Promise.all([
        fetch(`${getBridgeUrl()}/soc/engagements/${id}`),
        fetch(`${getBridgeUrl()}/soc/engagements/${id}/scripts`),
        fetch(`${getBridgeUrl()}/soc/audit-log/${id}`),
        fetch(`${getBridgeUrl()}/soc/engagements/${id}/queue`),
      ]);

      const engData = await engRes.json();
      const scriptsData = await scriptsRes.json();
      const execData = await execRes.json();
      const queueData = await queueRes.json();

      setEngagement(engData.engagement);
      setScripts(scriptsData.scripts || []);
      setExecutions(execData.executions || []);
      setQueue(queueData.queue || []);
    } catch (error) {
      console.error("Error fetching engagement:", error);
      Alert.alert("Error", "Failed to load engagement");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchEngagement();
  }, [fetchEngagement]);

  // Auto-refresh queue while anything is running
  useEffect(() => {
    const anyRunning = queue.some((q) => q.status === "running");
    if (!anyRunning) return;
    const t = setInterval(() => {
      fetchQueue();
    }, 3000);
    return () => clearInterval(t);
  }, [queue, fetchQueue]);

  const runQueueItem = useCallback(async (item: QueueItem) => {
    if (runningQueueItem != null) return;
    setRunningQueueItem(item.id);
    try {
      const response = await fetch(`${getBridgeUrl()}/soc/queue/${item.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Optimistically mark running, then refresh
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: "running" } : q)));
      setTimeout(() => fetchQueue(), 1500);
    } catch (error: any) {
      Alert.alert("Run failed", error.message || "Could not start step");
    } finally {
      setRunningQueueItem(null);
    }
  }, [runningQueueItem, fetchQueue]);

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

    Alert.alert(
      "Execute Script",
      `This will run:\n\n${script.command}\n\non dev-01 via SSH.`,
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
                body: JSON.stringify({
                  engagement_id: id,
                  script_id: script.id,
                  command: script.command,
                }),
              });

              if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
              }

              const data = await response.json();

              Alert.alert(
                "Execution Started",
                `Session: ${data.session_id}\n\nScript is running on dev-01. Refresh the execution history below to see results.`,
                [
                  {
                    text: "Refresh Now",
                    onPress: () => {
                      // Wait 2 seconds for script to complete
                      setTimeout(() => fetchExecutions(), 2000);
                    },
                  },
                  { text: "OK" },
                ]
              );
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.primary, paddingTop: insets.top }}>
      <StatusBar style="light" />

      {/* Header */}
      <View
        style={{
          padding: spacing.md,
          backgroundColor: colors.bg.secondary,
          borderBottomWidth: 1,
          borderBottomColor: colors.border.subtle,
        }}
      >
        <Pressable onPress={() => router.back()} style={{ marginBottom: spacing.sm }}>
          <Text style={{ color: colors.accent.blue, fontSize: fs.md }}>← Back</Text>
        </Pressable>

        <Text style={{ fontSize: fs.lg, fontWeight: fw.semibold, color: colors.text.primary }}>
          {engagement.id}
        </Text>
        <Text style={{ fontSize: fs.sm, color: colors.text.secondary, marginTop: spacing.xs }}>
          {engagement.client_name} • {engagement.engagement_type}
        </Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md }}>
        {/* Queued Steps Section (Cipher-driven) */}
        {queue.length > 0 && (
          <View style={{ marginBottom: spacing.xl }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md }}>
              <Text style={{ fontSize: fs.md, fontWeight: fw.semibold, color: colors.text.primary }}>
                Queued Steps
              </Text>
              <Pressable
                onPress={fetchQueue}
                style={({ pressed }) => [{
                  backgroundColor: colors.bg.secondary,
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.sm,
                  borderRadius: radius.md,
                  opacity: pressed ? 0.9 : 1,
                }]}
              >
                <Text style={{ color: colors.accent.blue, fontSize: fs.sm, fontWeight: fw.medium }}>↻ Refresh</Text>
              </Pressable>
            </View>

            <View style={{ gap: spacing.md }}>
              {queue.map((item) => {
                const statusColor =
                  item.status === "done" ? colors.status.success :
                  item.status === "failed" ? colors.status.error :
                  item.status === "running" ? colors.status.working :
                  item.status === "skipped" ? colors.text.disabled :
                  colors.accent.blue;
                const expanded = expandedQueueItem === item.id;
                return (
                  <View key={item.id} style={[styles.queueCard, { borderLeftColor: statusColor, borderLeftWidth: 3 }]}>
                    <View style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: spacing.xs }}>
                      <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontWeight: fw.medium, marginRight: spacing.sm, marginTop: 2 }}>
                        #{item.seq}
                      </Text>
                      <Text style={{ flex: 1, fontSize: fs.md, fontWeight: fw.medium, color: colors.text.primary }}>
                        {item.title}
                      </Text>
                      <View style={{
                        paddingHorizontal: spacing.sm,
                        paddingVertical: 3,
                        backgroundColor: withAlpha(statusColor, 0.15),
                        borderRadius: radius.sm,
                      }}>
                        <Text style={{ fontSize: fs.xs, color: statusColor, fontWeight: fw.medium }}>
                          {item.status.toUpperCase()}
                        </Text>
                      </View>
                    </View>

                    {item.description && (
                      <Text style={{ fontSize: fs.sm, color: colors.text.secondary, marginBottom: spacing.sm }}>
                        {item.description}
                      </Text>
                    )}

                    <Pressable onPress={() => setExpandedQueueItem(expanded ? null : item.id)}>
                      <Text style={{ fontSize: fs.xs, color: colors.accent.blue, marginBottom: spacing.sm }}>
                        {expanded ? "▾ Hide command" : "▸ Show command"}
                      </Text>
                    </Pressable>
                    {expanded && (
                      <View style={styles.outputContainer}>
                        <Text style={[styles.outputText, { color: colors.text.secondary }]}>{item.command}</Text>
                      </View>
                    )}

                    {item.expected_artifact && (
                      <Text style={{ fontSize: fs.xs, color: colors.text.disabled, marginBottom: spacing.sm }}>
                        Expected: {item.expected_artifact}
                      </Text>
                    )}

                    {item.output && (
                      <View style={[styles.outputContainer, { marginTop: spacing.sm }]}>
                        <ScrollView style={{ maxHeight: 220 }}>
                          <Text style={styles.outputText}>{item.output}</Text>
                        </ScrollView>
                      </View>
                    )}

                    {item.status === "pending" && (
                      <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
                        <Pressable
                          onPress={() => runQueueItem(item)}
                          disabled={runningQueueItem != null}
                          style={({ pressed }) => [{
                            flex: 1,
                            backgroundColor: colors.accent.blue,
                            paddingVertical: spacing.sm,
                            borderRadius: radius.md,
                            alignItems: "center",
                            opacity: runningQueueItem != null ? 0.5 : pressed ? 0.9 : 1,
                          }]}
                        >
                          <Text style={{ color: colors.text.primary, fontSize: fs.sm, fontWeight: fw.medium }}>▶ Run</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => skipQueueItem(item)}
                          style={({ pressed }) => [{
                            backgroundColor: colors.bg.tertiary,
                            paddingVertical: spacing.sm,
                            paddingHorizontal: spacing.md,
                            borderRadius: radius.md,
                            opacity: pressed ? 0.9 : 1,
                          }]}
                        >
                          <Text style={{ color: colors.text.secondary, fontSize: fs.sm }}>Skip</Text>
                        </Pressable>
                      </View>
                    )}
                    {item.status === "running" && (
                      <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.sm }}>
                        <ActivityIndicator size="small" color={colors.status.working} />
                        <Text style={{ marginLeft: spacing.sm, color: colors.text.secondary, fontSize: fs.sm }}>
                          Running on dev-01…
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* Scripts Section */}
        <Text style={{ fontSize: fs.md, fontWeight: fw.semibold, color: colors.text.primary, marginBottom: spacing.md }}>
          Available Scripts
        </Text>

        <View style={{ gap: spacing.md, marginBottom: spacing.xl }}>
          {scripts.map((script) => (
            <View key={script.id} style={styles.scriptCard}>
              <View style={{ marginBottom: spacing.sm }}>
                <Text style={{ fontSize: fs.md, fontWeight: fw.medium, color: colors.text.primary }}>
                  {script.phase}
                </Text>
                <Text style={{ fontSize: fs.sm, color: colors.text.secondary, marginTop: spacing.xs }}>
                  {script.description}
                </Text>
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View
                  style={{
                    paddingHorizontal: spacing.sm,
                    paddingVertical: 4,
                    backgroundColor: withAlpha(
                      script.status === "completed" ? colors.status.success : colors.accent.blue,
                      0.15
                    ),
                    borderRadius: radius.sm,
                  }}
                >
                  <Text
                    style={{
                      fontSize: fs.xs,
                      color: script.status === "completed" ? colors.status.success : colors.accent.blue,
                      fontWeight: fw.medium,
                    }}
                  >
                    {script.status.toUpperCase()}
                  </Text>
                </View>

                <Pressable
                  onPress={() => executeScript(script)}
                  disabled={executing || script.status === "manual"}
                  style={({ pressed }) => [
                    {
                      backgroundColor: colors.accent.blue,
                      paddingHorizontal: spacing.md,
                      paddingVertical: spacing.sm,
                      borderRadius: radius.md,
                      opacity: executing || script.status === "manual" ? 0.5 : pressed ? 0.9 : 1,
                    },
                  ]}
                >
                  <Text style={{ color: colors.text.primary, fontSize: fs.sm, fontWeight: fw.medium }}>
                    ▶ Run
                  </Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>

        {/* Execution History Section */}
        <View style={{ marginTop: spacing.xl }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md }}>
            <Text style={{ fontSize: fs.md, fontWeight: fw.semibold, color: colors.text.primary }}>
              Execution History
            </Text>
            <Pressable
              onPress={fetchExecutions}
              disabled={loadingExecutions}
              style={({ pressed }) => [
                {
                  backgroundColor: colors.bg.secondary,
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.sm,
                  borderRadius: radius.md,
                  opacity: loadingExecutions ? 0.5 : pressed ? 0.9 : 1,
                },
              ]}
            >
              <Text style={{ color: colors.accent.blue, fontSize: fs.sm, fontWeight: fw.medium }}>
                {loadingExecutions ? "⟳ Refreshing..." : "↻ Refresh"}
              </Text>
            </Pressable>
          </View>

          {executions.length === 0 ? (
            <View style={{ padding: spacing.lg, alignItems: "center" }}>
              <Text style={{ color: colors.text.disabled, fontSize: fs.sm }}>
                No executions yet. Run a script above to get started.
              </Text>
            </View>
          ) : (
            <View style={{ gap: spacing.md }}>
              {executions.map((exec) => (
                <View key={exec.session_id} style={styles.executionCard}>
                  {/* Status indicator */}
                  <View
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: 4,
                      backgroundColor:
                        exec.status === "completed"
                          ? colors.status.success
                          : exec.status === "failed"
                          ? colors.status.error
                          : colors.status.working,
                      borderTopLeftRadius: radius.md,
                      borderBottomLeftRadius: radius.md,
                    }}
                  />

                  <View style={{ paddingLeft: spacing.md }}>
                    {/* Header */}
                    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: spacing.xs }}>
                      <Text style={{ fontSize: 16, marginRight: spacing.xs }}>
                        {exec.status === "completed" ? "✅" : exec.status === "failed" ? "❌" : "⏳"}
                      </Text>
                      <Text style={{ fontSize: fs.sm, fontWeight: fw.medium, color: colors.text.primary, flex: 1 }}>
                        {exec.session_id}
                      </Text>
                      <View
                        style={{
                          paddingHorizontal: spacing.sm,
                          paddingVertical: 3,
                          backgroundColor: withAlpha(
                            exec.status === "completed"
                              ? colors.status.success
                              : exec.status === "failed"
                              ? colors.status.error
                              : colors.status.working,
                            0.15
                          ),
                          borderRadius: radius.sm,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: fs.xs,
                            color:
                              exec.status === "completed"
                                ? colors.status.success
                                : exec.status === "failed"
                                ? colors.status.error
                                : colors.status.working,
                            fontWeight: fw.medium,
                          }}
                        >
                          {exec.status.toUpperCase()}
                        </Text>
                      </View>
                    </View>

                    {/* Command */}
                    <Text style={{ fontSize: fs.xs, color: colors.text.disabled, marginBottom: spacing.sm, fontFamily: "monospace" }}>
                      {exec.task.length > 80 ? exec.task.substring(0, 80) + "..." : exec.task}
                    </Text>

                    {/* Timestamps */}
                    <Text style={{ fontSize: fs.xs, color: colors.text.disabled }}>
                      Started: {new Date(exec.started_at).toLocaleTimeString()}
                      {exec.completed_at && ` • Completed: ${new Date(exec.completed_at).toLocaleTimeString()}`}
                    </Text>

                    {/* Output (if available) */}
                    {exec.output && (
                      <View style={styles.outputContainer}>
                        <ScrollView style={{ maxHeight: 200 }}>
                          <Text style={styles.outputText}>{exec.output}</Text>
                        </ScrollView>
                      </View>
                    )}
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
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
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    marginTop: spacing.sm,
  },
  outputText: {
    fontFamily: "monospace",
    fontSize: fs.xs,
    color: colors.text.secondary,
    lineHeight: 18,
  },
});
