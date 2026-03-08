// Personal file storage — Dropbox-style browsing
// Browse by category, upload from phone, preview images, delete

import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Image,
  Alert,
  RefreshControl,
  ActivityIndicator,
  Modal,
  Dimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import {
  fetchFiles,
  uploadFile,
  deleteFile,
  getFileDataUrl,
  type StoredFile,
} from "../../lib/bridge-api";

const ACCENT = "#06B6D4";
const DIM = "#525252";
const { width: SCREEN_W } = Dimensions.get("window");

const CATEGORIES = [
  { key: "all", label: "ALL", icon: "\u{1F4C1}" },
  { key: "photos", label: "PHOTOS", icon: "\u{1F4F7}" },
  { key: "intel", label: "INTEL", icon: "\u{1F50D}" },
  { key: "documents", label: "DOCS", icon: "\u{1F4C4}" },
  { key: "temp", label: "TEMP", icon: "\u23F3" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

// ── File Grid Item ──
function FileItem({
  file,
  onPress,
  onLongPress,
}: {
  file: StoredFile;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const thumbSize = (SCREEN_W - 48 - 16) / 3; // 3 columns with gaps

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        width: thumbSize,
        marginBottom: 8,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {/* Thumbnail */}
      <View
        style={{
          width: thumbSize,
          height: thumbSize,
          borderRadius: 8,
          backgroundColor: "#1A1A1A",
          borderWidth: 1,
          borderColor: "#2A2A2A",
          overflow: "hidden",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {isImage(file.mime_type) ? (
          <Image
            source={{ uri: getFileDataUrl(file.id) }}
            style={{ width: thumbSize, height: thumbSize }}
            resizeMode="cover"
          />
        ) : (
          <Text style={{ fontSize: 28 }}>{"\u{1F4C4}"}</Text>
        )}
        {/* Source badge */}
        {file.source !== "upload" && (
          <View
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              backgroundColor: "rgba(0,0,0,0.7)",
              borderRadius: 4,
              paddingHorizontal: 4,
              paddingVertical: 1,
            }}
          >
            <Text style={{ color: ACCENT, fontSize: 8, fontFamily: "monospace", fontWeight: "700" }}>
              {file.source === "glasses" ? "\u{1F453}" : file.source.toUpperCase()}
            </Text>
          </View>
        )}
      </View>
      {/* File info */}
      <Text
        numberOfLines={1}
        style={{
          color: "#ccc",
          fontSize: 10,
          fontFamily: "monospace",
          marginTop: 4,
        }}
      >
        {file.filename}
      </Text>
      <Text style={{ color: DIM, fontSize: 9, fontFamily: "monospace" }}>
        {formatBytes(file.size_bytes)} · {formatDate(file.created_at)}
      </Text>
    </Pressable>
  );
}

// ── Image Preview Modal ──
function PreviewModal({
  file,
  visible,
  onClose,
  onDelete,
}: {
  file: StoredFile | null;
  visible: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  if (!file) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.95)",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {/* Close button */}
        <Pressable
          onPress={onClose}
          style={{
            position: "absolute",
            top: 60,
            right: 20,
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: "rgba(255,255,255,0.15)",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 10,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 18, fontWeight: "600" }}>X</Text>
        </Pressable>

        {/* Image */}
        {isImage(file.mime_type) ? (
          <Image
            source={{ uri: getFileDataUrl(file.id) }}
            style={{ width: SCREEN_W - 32, height: SCREEN_W - 32 }}
            resizeMode="contain"
          />
        ) : (
          <View style={{ alignItems: "center" }}>
            <Text style={{ fontSize: 60 }}>{"\u{1F4C4}"}</Text>
            <Text style={{ color: "#fff", fontSize: 14, fontFamily: "monospace", marginTop: 12 }}>
              {file.filename}
            </Text>
          </View>
        )}

        {/* File info */}
        <View style={{ marginTop: 20, alignItems: "center" }}>
          <Text style={{ color: "#fff", fontSize: 13, fontFamily: "monospace", fontWeight: "600" }}>
            {file.filename}
          </Text>
          <Text style={{ color: DIM, fontSize: 11, fontFamily: "monospace", marginTop: 4 }}>
            {formatBytes(file.size_bytes)} · {file.mime_type} · {file.source}
          </Text>
          <Text style={{ color: DIM, fontSize: 11, fontFamily: "monospace" }}>
            {new Date(file.created_at).toLocaleString()}
          </Text>
        </View>

        {/* Delete button */}
        <Pressable
          onPress={onDelete}
          style={{
            marginTop: 24,
            paddingHorizontal: 24,
            paddingVertical: 10,
            borderRadius: 20,
            backgroundColor: "rgba(239,68,68,0.15)",
            borderWidth: 1,
            borderColor: "#EF4444",
          }}
        >
          <Text style={{ color: "#EF4444", fontSize: 12, fontFamily: "monospace", fontWeight: "700" }}>
            DELETE
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

// ── Main Screen ──
export default function FilesScreen() {
  const insets = useSafeAreaInsets();
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewFile, setPreviewFile] = useState<StoredFile | null>(null);

  const loadFiles = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const filters: any = { limit: 100 };
        if (category !== "all") filters.category = category;
        const result = await fetchFiles(filters);
        setFiles(result.files);
        setTotal(result.total);
      } catch {}
      setLoading(false);
      setRefreshing(false);
    },
    [category]
  );

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleUpload = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        quality: 0.8,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      if (!asset.base64) {
        // Read file manually if base64 not provided
        const b64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        asset.base64 = b64;
      }

      setUploading(true);
      const fname = asset.fileName || `upload_${Date.now()}.jpg`;
      const mime = asset.mimeType || "image/jpeg";
      await uploadFile(asset.base64, {
        filename: fname,
        mime_type: mime,
        source: "upload",
        category: "photos",
      });
      await loadFiles();
    } catch (e: any) {
      Alert.alert("Upload failed", e.message || "Unknown error");
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (file: StoredFile) => {
    Alert.alert("Delete file?", file.filename, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteFile(file.id);
            setPreviewFile(null);
            await loadFiles();
          } catch {}
        },
      },
    ]);
  };

  const imageFiles = files.filter((f) => isImage(f.mime_type));
  const otherFiles = files.filter((f) => !isImage(f.mime_type));

  return (
    <View style={{ flex: 1, backgroundColor: "#111", paddingTop: insets.top }}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
          height: 48,
        }}
      >
        <Text
          style={{
            color: "#fff",
            fontSize: 16,
            fontFamily: "monospace",
            fontWeight: "700",
            letterSpacing: 2,
          }}
        >
          FILES
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: DIM, fontSize: 11, fontFamily: "monospace" }}>
            {total} files
          </Text>
          <Pressable
            onPress={handleUpload}
            disabled={uploading}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 6,
              borderRadius: 16,
              backgroundColor: "rgba(6,182,212,0.15)",
              borderWidth: 1,
              borderColor: ACCENT,
              opacity: uploading ? 0.5 : 1,
            }}
          >
            {uploading ? (
              <ActivityIndicator size="small" color={ACCENT} />
            ) : (
              <Text style={{ color: ACCENT, fontSize: 11, fontFamily: "monospace", fontWeight: "700" }}>
                + UPLOAD
              </Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* Category pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ maxHeight: 40, paddingHorizontal: 16 }}
        contentContainerStyle={{ gap: 8, alignItems: "center" }}
      >
        {CATEGORIES.map((cat) => {
          const active = category === cat.key;
          return (
            <Pressable
              key={cat.key}
              onPress={() => setCategory(cat.key)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 16,
                backgroundColor: active ? "rgba(6,182,212,0.2)" : "rgba(255,255,255,0.05)",
                borderWidth: 1,
                borderColor: active ? ACCENT : "#2A2A2A",
              }}
            >
              <Text
                style={{
                  color: active ? ACCENT : DIM,
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "700",
                  letterSpacing: 1,
                }}
              >
                {cat.icon} {cat.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* File grid */}
      <ScrollView
        style={{ flex: 1, marginTop: 12 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => loadFiles(true)} tintColor={ACCENT} />
        }
      >
        {loading && !refreshing ? (
          <View style={{ paddingTop: 60, alignItems: "center" }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : files.length === 0 ? (
          <View style={{ paddingTop: 60, alignItems: "center" }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>{"\u{1F4C2}"}</Text>
            <Text style={{ color: DIM, fontSize: 13, fontFamily: "monospace", textAlign: "center" }}>
              No files{category !== "all" ? ` in ${category}` : ""}
            </Text>
            <Text style={{ color: "#333", fontSize: 11, fontFamily: "monospace", marginTop: 8, textAlign: "center" }}>
              Upload from your phone or capture{"\n"}photos with your glasses
            </Text>
          </View>
        ) : (
          <>
            {/* Image grid */}
            {imageFiles.length > 0 && (
              <>
                {otherFiles.length > 0 && (
                  <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace", letterSpacing: 1, marginBottom: 8 }}>
                    IMAGES ({imageFiles.length})
                  </Text>
                )}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {imageFiles.map((f) => (
                    <FileItem
                      key={f.id}
                      file={f}
                      onPress={() => setPreviewFile(f)}
                      onLongPress={() => handleDelete(f)}
                    />
                  ))}
                </View>
              </>
            )}

            {/* Other files list */}
            {otherFiles.length > 0 && (
              <>
                {imageFiles.length > 0 && (
                  <Text
                    style={{
                      color: DIM,
                      fontSize: 10,
                      fontFamily: "monospace",
                      letterSpacing: 1,
                      marginTop: 16,
                      marginBottom: 8,
                    }}
                  >
                    DOCUMENTS ({otherFiles.length})
                  </Text>
                )}
                {otherFiles.map((f) => (
                  <Pressable
                    key={f.id}
                    onPress={() => setPreviewFile(f)}
                    onLongPress={() => handleDelete(f)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      backgroundColor: "#1A1A1A",
                      borderRadius: 8,
                      padding: 12,
                      marginBottom: 6,
                      borderWidth: 1,
                      borderColor: "#2A2A2A",
                      opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={{ fontSize: 22, marginRight: 12 }}>{"\u{1F4C4}"}</Text>
                    <View style={{ flex: 1 }}>
                      <Text
                        numberOfLines={1}
                        style={{ color: "#ccc", fontSize: 12, fontFamily: "monospace" }}
                      >
                        {f.filename}
                      </Text>
                      <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace" }}>
                        {formatBytes(f.size_bytes)} · {f.source} · {formatDate(f.created_at)}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </>
            )}
          </>
        )}
      </ScrollView>

      {/* Preview Modal */}
      <PreviewModal
        file={previewFile}
        visible={!!previewFile}
        onClose={() => setPreviewFile(null)}
        onDelete={() => previewFile && handleDelete(previewFile)}
      />
    </View>
  );
}
