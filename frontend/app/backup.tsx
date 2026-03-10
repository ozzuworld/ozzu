import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  Alert,
  ActivityIndicator,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import {
  fetchBackups,
  triggerBackup,
  deleteBackup,
  getBackupDownloadUrl,
  type BackupInfo,
} from "../lib/bridge-api";

export default function BackupScreen() {
  const router = useRouter();
  const { insets, isPhone } = usePhoneLayout();

  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [cronEnabled, setCronEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBackups = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchBackups();
      setBackups(data.backups);
      setCronEnabled(data.cronEnabled);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadBackups();
  }, [loadBackups]);

  const handleCreateBackup = useCallback(async () => {
    setCreating(true);
    try {
      const result = await triggerBackup();
      if (result.ok) {
        Alert.alert("Backup Created", `${result.size} encrypted backup saved.\n\nChecksum: ${result.checksum?.slice(0, 16)}...`);
        loadBackups();
      }
    } catch (e: any) {
      Alert.alert("Backup Failed", e.message);
    } finally {
      setCreating(false);
    }
  }, [loadBackups]);

  const [downloading, setDownloading] = useState<string | null>(null);

  const handleDownload = useCallback(async (backup: BackupInfo) => {
    const url = getBackupDownloadUrl(backup.filename);
    const localUri = FileSystem.cacheDirectory + backup.filename;
    setDownloading(backup.filename);
    try {
      const dl = await FileSystem.downloadAsync(url, localUri);
      if (dl.status !== 200) throw new Error(`Download failed (${dl.status})`);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dl.uri, {
          mimeType: "application/octet-stream",
          dialogTitle: "Save backup to Files (iCloud)",
          UTI: "public.data",
        });
      } else {
        Alert.alert("Downloaded", `Saved to: ${dl.uri}`);
      }
    } catch (e: any) {
      Alert.alert("Download Error", e.message);
    } finally {
      setDownloading(null);
      // Clean up cache
      FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
    }
  }, []);

  const handleDelete = useCallback((backup: BackupInfo) => {
    Alert.alert(
      "Delete Backup",
      `Delete ${backup.filename}?\n\nThis cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteBackup(backup.filename);
              loadBackups();
            } catch (e: any) {
              Alert.alert("Error", e.message);
            }
          },
        },
      ]
    );
  }, [loadBackups]);

  const formatDate = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return ts;
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#111111", paddingTop: insets.top }}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, height: 48 }}>
        <Pressable onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Text style={{ color: "#888", fontFamily: "monospace", fontSize: 14 }}>{"< BACK"}</Text>
        </Pressable>
        <Text style={{ color: "#E5E5E5", fontFamily: "monospace", fontSize: 16, fontWeight: "700", flex: 1 }}>
          BACKUPS
        </Text>
        <View style={{
          backgroundColor: cronEnabled ? "#064E3B" : "#7F1D1D",
          paddingHorizontal: 8,
          paddingVertical: 2,
          borderRadius: 4,
        }}>
          <Text style={{ color: cronEnabled ? "#34D399" : "#F87171", fontFamily: "monospace", fontSize: 10 }}>
            {cronEnabled ? "AUTO ON" : "AUTO OFF"}
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1, paddingHorizontal: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#888" />}
      >
        {/* Create Backup Button */}
        <Pressable
          onPress={handleCreateBackup}
          disabled={creating}
          style={{
            backgroundColor: creating ? "#1A1A1A" : "#1E3A5F",
            borderRadius: 8,
            padding: 16,
            marginBottom: 16,
            alignItems: "center",
            flexDirection: "row",
            justifyContent: "center",
            gap: 8,
            opacity: creating ? 0.6 : 1,
          }}
        >
          {creating ? (
            <ActivityIndicator size="small" color="#60A5FA" />
          ) : null}
          <Text style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 14, fontWeight: "600" }}>
            {creating ? "CREATING BACKUP..." : "CREATE BACKUP NOW"}
          </Text>
        </Pressable>

        {/* Info */}
        <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 11, marginBottom: 16 }}>
          Backups include: PostgreSQL, OSINT images, business attachments, HA config, env secrets, Redis.
          {"\n"}Encrypted with AES-256-CBC. Download saves to Files for iCloud sync.
        </Text>

        {error && (
          <Text style={{ color: "#EF4444", fontFamily: "monospace", fontSize: 12, marginBottom: 12 }}>
            {error}
          </Text>
        )}

        {loading ? (
          <ActivityIndicator size="large" color="#888" style={{ marginTop: 40 }} />
        ) : backups.length === 0 ? (
          <Text style={{ color: "#6B7280", fontFamily: "monospace", fontSize: 13, textAlign: "center", marginTop: 40 }}>
            No backups yet. Create one above.
          </Text>
        ) : (
          backups.map((b) => (
            <View
              key={b.filename}
              style={{
                backgroundColor: "#1A1A1A",
                borderRadius: 8,
                padding: 12,
                marginBottom: 8,
                borderWidth: 1,
                borderColor: "#262626",
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#D4D4D4", fontFamily: "monospace", fontSize: 12, fontWeight: "600" }}>
                    {formatDate(b.timestamp)}
                  </Text>
                  <Text style={{ color: "#6B7280", fontFamily: "monospace", fontSize: 10, marginTop: 2 }}>
                    {b.sizeHuman} {b.encrypted ? "| encrypted" : "| unencrypted"}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    onPress={() => handleDownload(b)}
                    disabled={downloading === b.filename}
                    style={{
                      backgroundColor: downloading === b.filename ? "#1A1A1A" : "#064E3B",
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 4,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {downloading === b.filename && <ActivityIndicator size={10} color="#34D399" />}
                    <Text style={{ color: "#34D399", fontFamily: "monospace", fontSize: 11 }}>
                      {downloading === b.filename ? "SAVING..." : "SAVE TO ICLOUD"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleDelete(b)}
                    style={{
                      backgroundColor: "#7F1D1D",
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 4,
                    }}
                  >
                    <Text style={{ color: "#F87171", fontFamily: "monospace", fontSize: 11 }}>DELETE</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ))
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}
