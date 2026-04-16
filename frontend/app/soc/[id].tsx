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

export default function EngagementDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [engagement, setEngagement] = useState<EngagementDetail | null>(null);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(true);

  const [executing, setExecuting] = useState(false);
  const [currentScript, setCurrentScript] = useState<Script | null>(null);
  const [output, setOutput] = useState("");
  const [sessionId, setSessionId] = useState("");

  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchEngagement = useCallback(async () => {
    try {
      const [engRes, scriptsRes] = await Promise.all([
        fetch(`http://localhost:3030/soc/engagements/${id}`),
        fetch(`http://localhost:3030/soc/engagements/${id}/scripts`),
      ]);

      const engData = await engRes.json();
      const scriptsData = await scriptsRes.json();

      setEngagement(engData.engagement);
      setScripts(scriptsData.scripts || []);
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

  const executeScript = useCallback(async (script: Script) => {
    if (executing) return;

    setCurrentScript(script);
    setOutput("");
    setExecuting(true);

    try {
      // Start SSE connection to stream output
      const eventSource = new EventSource(
        `http://localhost:3030/soc/execute?engagement_id=${id}&script_id=${script.id}&command=${encodeURIComponent(script.command)}`
      );

      eventSourceRef.current = eventSource;

      eventSource.addEventListener('message', (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') {
          setSessionId(data.session_id);
        } else if (data.type === 'stdout' || data.type === 'stderr') {
          setOutput((prev) => prev + data.data);
        } else if (data.type === 'exit') {
          setExecuting(false);
          eventSource.close();
          eventSourceRef.current = null;

          if (data.code === 0) {
            Alert.alert(
              "Execution Complete",
              "Script finished successfully. Submit results to update engagement?",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Submit Results", onPress: () => showSubmitForm() },
              ]
            );
          } else {
            Alert.alert("Execution Failed", `Script exited with code ${data.code}`);
          }
        }
      });

      eventSource.onerror = () => {
        setExecuting(false);
        eventSource.close();
        eventSourceRef.current = null;
        Alert.alert("Error", "Lost connection to server");
      };

    } catch (error: any) {
      setExecuting(false);
      Alert.alert("Error", error.message || "Failed to execute script");
    }
  }, [id, executing]);

  const showSubmitForm = useCallback(() => {
    Alert.prompt(
      "Submit Results",
      "Describe the findings from this execution:",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Submit",
          onPress: async (findings: string = "") => {
            try {
              await fetch(`http://localhost:3030/soc/submit-results`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  engagement_id: id,
                  session_id: sessionId,
                  findings: [
                    {
                      title: currentScript?.name || "Finding",
                      description: findings || output.substring(0, 500),
                      severity: "info",
                      affected_asset: engagement?.scope?.targets?.[0] || "Unknown",
                    },
                  ],
                }),
              });

              Alert.alert(
                "Results Submitted",
                "Results saved. Notify Cipher in the active session to analyze."
              );

              // Reset state
              setCurrentScript(null);
              setOutput("");
              setSessionId("");

              // Refresh scripts to update status
              fetchEngagement();
            } catch (error: any) {
              Alert.alert("Error", error.message || "Failed to submit results");
            }
          },
        },
      ],
      "plain-text"
    );
  }, [id, sessionId, output, currentScript, engagement, fetchEngagement]);

  const stopExecution = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setExecuting(false);
    Alert.alert("Stopped", "Script execution cancelled");
  }, []);

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

        {/* Output Section */}
        {currentScript && (
          <View style={{ marginTop: spacing.lg }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md }}>
              <Text style={{ fontSize: fs.md, fontWeight: fw.semibold, color: colors.text.primary }}>
                Output: {currentScript.name}
              </Text>

              {executing && (
                <Pressable onPress={stopExecution} style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
                  <Text style={{ color: colors.status.error, fontSize: fs.sm, fontWeight: fw.medium }}>
                    ⏹ Stop
                  </Text>
                </Pressable>
              )}
            </View>

            <View style={styles.outputContainer}>
              <ScrollView style={{ maxHeight: 400 }}>
                <Text style={styles.outputText}>{output || "No output yet..."}</Text>
              </ScrollView>
            </View>

            {executing && (
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.sm }}>
                <ActivityIndicator size="small" color={colors.accent.blue} />
                <Text style={{ color: colors.text.disabled, fontSize: fs.sm, marginLeft: spacing.sm }}>
                  Executing on dev-01...
                </Text>
              </View>
            )}

            {!executing && output && (
              <Pressable
                onPress={showSubmitForm}
                style={({ pressed }) => [
                  {
                    backgroundColor: colors.status.success,
                    padding: spacing.md,
                    borderRadius: radius.md,
                    marginTop: spacing.md,
                    opacity: pressed ? 0.9 : 1,
                  },
                ]}
              >
                <Text style={{ color: colors.bg.primary, fontSize: fs.md, fontWeight: fw.semibold, textAlign: "center" }}>
                  Submit Results to Cipher
                </Text>
              </Pressable>
            )}
          </View>
        )}
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
  outputContainer: {
    backgroundColor: colors.bg.tertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  outputText: {
    fontFamily: "monospace",
    fontSize: fs.xs,
    color: colors.text.secondary,
    lineHeight: 18,
  },
});
