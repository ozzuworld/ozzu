import { useState } from "react";
import { View, Text, Pressable, Alert } from "react-native";
import { fetchDirectiveArtifacts, deployArtifact } from "../../lib/bridge-api";
import { relativeTime } from "../../lib/directive-constants";

interface BuildRun {
  platform: string;
  runId: number;
  triggeredAt: number;
  status: string;
  conclusion: string | null;
  url: string;
  lastChecked: number | null;
}

interface BuildRunBadgeProps {
  run: BuildRun;
  directiveId: string;
}

export function BuildRunBadge({ run, directiveId }: BuildRunBadgeProps) {
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);

  const isActive = run.status === "in_progress" || run.status === "queued";
  const succeeded = run.status === "completed" && run.conclusion === "success";
  const failed = run.status === "completed" && (run.conclusion === "failure" || run.conclusion === "cancelled");

  const platformEmoji = run.platform === "ios" ? "🍎" : "📱";
  const statusEmoji = isActive ? "🔄" : succeeded ? "✅" : failed ? "❌" : "⏳";
  const badgeColor = isActive ? "#3B82F6" : succeeded ? "#10B981" : failed ? "#EF4444" : "#6B7280";
  const statusText = isActive
    ? run.status === "in_progress" ? "building" : "queued"
    : run.conclusion || run.status;

  const handleDownload = async () => {
    setLoadingArtifacts(true);
    try {
      const { artifacts } = await fetchDirectiveArtifacts(directiveId);
      const matching = artifacts.filter((a) => a.runId === run.runId);
      if (matching.length === 0) {
        Alert.alert("No Artifacts", "No downloadable artifacts found for this build.");
        return;
      }
      const artifact = matching[0];
      const sizeMB = (artifact.sizeBytes / 1048576).toFixed(1);
      Alert.alert(
        "📥 Deploy Artifact",
        `${artifact.name}\n${sizeMB} MB\n\nDeploy to devices?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Deploy",
            onPress: async () => {
              try {
                const result = await deployArtifact(artifact.artifactId);
                if (result.ok) {
                  Alert.alert("✅ Deployed", result.message || "Artifact deployed to devices");
                } else {
                  Alert.alert("❌ Failed", result.error || "Deploy failed");
                }
              } catch (err: any) {
                Alert.alert("Error", err.message);
              }
            },
          },
        ]
      );
    } catch (err: any) {
      Alert.alert("Error", err.message);
    } finally {
      setLoadingArtifacts(false);
    }
  };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: `${badgeColor}40`,
        backgroundColor: `${badgeColor}15`,
      }}
    >
      <Text style={{ fontSize: 11 }}>{platformEmoji}</Text>
      <Text
        style={{
          color: "#A3A3A3",
          fontSize: 10,
          fontFamily: "monospace",
          fontWeight: "bold",
        }}
      >
        {run.platform === "android" ? "Android" : run.platform === "ios" ? "iOS" : run.platform}:
      </Text>
      <Text style={{ fontSize: 10 }}>{statusEmoji}</Text>
      <Text
        style={{
          color: badgeColor,
          fontSize: 10,
          fontFamily: "monospace",
        }}
      >
        {statusText}
      </Text>
      <Text
        style={{
          color: "#525252",
          fontSize: 9,
          fontFamily: "monospace",
        }}
      >
        {relativeTime(run.triggeredAt)}
      </Text>
      {succeeded ? (
        <Pressable onPress={handleDownload} disabled={loadingArtifacts}>
          <Text style={{ fontSize: 12, opacity: loadingArtifacts ? 0.4 : 1 }}>📥</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
