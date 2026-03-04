import { useState, useCallback } from "react";
import { View, Text, Pressable, Alert, Linking } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { fetchDirectiveArtifacts, deployArtifact, getBridgeUrl, getAuthHeaders } from "../../lib/bridge-api";
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
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const isActive = run.status === "in_progress" || run.status === "queued";
  const succeeded = run.status === "completed" && run.conclusion === "success";
  const failed = run.status === "completed" && (run.conclusion === "failure" || run.conclusion === "cancelled");

  const platformEmoji = run.platform === "ios" ? "\u{1F34E}" : "\u{1F4F1}";
  const statusEmoji = isActive ? "\u{1F504}" : succeeded ? "\u2705" : failed ? "\u274C" : "\u23F3";
  const badgeColor = isActive ? "#3B82F6" : succeeded ? "#10B981" : failed ? "#EF4444" : "#6B7280";
  const statusText = isActive
    ? run.status === "in_progress" ? "building" : "queued"
    : run.conclusion || run.status;

  const isDownloading = downloadProgress !== null;

  const downloadInApp = useCallback(async (url: string, fileName: string) => {
    const fileUri = FileSystem.documentDirectory + fileName;
    setDownloadProgress(0);
    try {
      const downloadResumable = FileSystem.createDownloadResumable(
        url,
        fileUri,
        { headers: getAuthHeaders() },
        (progress) => {
          const pct = progress.totalBytesWritten / progress.totalBytesExpectedToWrite;
          setDownloadProgress(pct);
        }
      );
      const result = await downloadResumable.downloadAsync();
      if (!result) {
        Alert.alert("Error", "Download returned no result");
        return;
      }

      setDownloadProgress(1);

      // Try share sheet (expo-sharing) — dynamic import so old builds without native module don't crash
      try {
        const Sharing = await import("expo-sharing");
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(result.uri, {
            mimeType: fileName.endsWith(".ipa")
              ? "application/octet-stream"
              : "application/vnd.android.package-archive",
            dialogTitle: `Save ${fileName}`,
          });
          return;
        }
      } catch {
        // expo-sharing native module not available — fall through to Linking fallback
      }

      // Fallback: open URL in browser so user can download from Safari
      Alert.alert(
        "Download Complete",
        `${fileName} downloaded.\n\nShare sheet unavailable — opening in browser instead. Save the file to Files, then install via AltStore.`,
        [
          { text: "OK", style: "cancel" },
          { text: "Open in Browser", onPress: () => Linking.openURL(url) },
        ]
      );
    } catch (err: any) {
      Alert.alert("Download Failed", err.message);
    } finally {
      setDownloadProgress(null);
    }
  }, []);

  const handleDownload = async () => {
    if (isDownloading) return;
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

      if (run.platform === "ios") {
        Alert.alert(
          "\u{1F34E} Download IPA",
          `${artifact.name}\n${sizeMB} MB\n\nDownload to this device? After download, save to Files and install via AltStore.`,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Download",
              onPress: () => {
                const url = `${getBridgeUrl()}/api/artifacts/${artifact.artifactId}/download`;
                downloadInApp(url, "ozzu-latest.ipa");
              },
            },
          ]
        );
      } else {
        // Android: deploy to devices via server-side ADB
        Alert.alert(
          "\u{1F4F1} Deploy Android",
          `${artifact.name}\n${sizeMB} MB\n\nDeploy to all Android devices?`,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Deploy",
              onPress: async () => {
                try {
                  const result = await deployArtifact(artifact.artifactId);
                  if (result.ok) {
                    Alert.alert("Deployed", result.message || "Artifact deployed to devices");
                  } else {
                    Alert.alert("Failed", result.error || "Deploy failed");
                  }
                } catch (err: any) {
                  Alert.alert("Error", err.message);
                }
              },
            },
          ]
        );
      }
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
        <Pressable onPress={handleDownload} disabled={loadingArtifacts || isDownloading}>
          {isDownloading ? (
            <Text style={{ fontSize: 9, color: "#3B82F6", fontFamily: "monospace", fontWeight: "bold" }}>
              {Math.round((downloadProgress || 0) * 100)}%
            </Text>
          ) : (
            <Text style={{ fontSize: 12, opacity: loadingArtifacts ? 0.4 : 1 }}>{"\u{1F4E5}"}</Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
