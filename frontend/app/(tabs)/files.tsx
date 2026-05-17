// Personal file storage — iCloud-like private cloud
// Folder navigation, multi-file upload, download, preview, storage indicator

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
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  fetchFiles,
  uploadFile,
  deleteFile,
  getFileDataUrl,
  type StoredFile,
} from "../../lib/bridge-api";
import { getBridgeUrl, getAuthHeaders } from "../../lib/bridge-api";
import HamburgerMenu from "../../components/HamburgerMenu";
import { GroupNav } from "../../components/GroupNav";
import { formatBytes, formatRelativeOrShortDate } from "../../lib/format";

const ACCENT = "#06B6D4";
const DIM = "#525252";
const { width: SCREEN_W } = Dimensions.get("window");

// ── Types ──
interface Folder {
  id: number;
  name: string;
  parent_id: number | null;
  created_at: string;
}

interface BreadcrumbItem {
  id: number | null;
  name: string;
}

// ── Helpers ──

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

function fileIcon(mime: string): string {
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.includes("pdf")) return "📄";
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("gz")) return "🗜️";
  if (mime.includes("text")) return "📝";
  return "📎";
}

// ── API helpers ──
async function fetchFolders(parentId: number | null): Promise<Folder[]> {
  const bridgeUrl = getBridgeUrl();
  const qs = parentId !== null ? `?parent_id=${parentId}` : "";
  const res = await fetch(`${bridgeUrl}/files/folders${qs}`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.folders || [];
}

async function createFolder(name: string, parentId: number | null): Promise<Folder | null> {
  const bridgeUrl = getBridgeUrl();
  const res = await fetch(`${bridgeUrl}/files/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ name, parent_id: parentId }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.folder;
}

async function deleteFolder(folderId: number): Promise<void> {
  const bridgeUrl = getBridgeUrl();
  await fetch(`${bridgeUrl}/files/folders/${folderId}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });
}

async function downloadFile(file: StoredFile): Promise<void> {
  const url = getFileDataUrl(file.id);
  const localUri = FileSystem.cacheDirectory + file.filename;
  const dl = await FileSystem.downloadAsync(url, localUri);
  if (dl.status !== 200) throw new Error(`Download failed (${dl.status})`);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(dl.uri, {
      mimeType: file.mime_type,
      dialogTitle: "Save to Files",
    });
  }
  FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
}

// ── Folder Item ──
function FolderItem({ folder, onPress, onLongPress }: { folder: Folder; onPress: () => void; onLongPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: "#1A1A1A",
        borderRadius: 10,
        padding: 14,
        marginBottom: 6,
        borderWidth: 1,
        borderColor: "#2A2A2A",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 22, marginRight: 12 }}>📁</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: "#E5E5E5", fontSize: 13, fontFamily: "monospace", fontWeight: "600" }}>
          {folder.name}
        </Text>
        <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace", marginTop: 2 }}>
          {formatRelativeOrShortDate(folder.created_at)}
        </Text>
      </View>
      <Text style={{ color: DIM, fontSize: 16 }}>›</Text>
    </Pressable>
  );
}

// ── File Grid Item ──
function FileItem({ file, onPress, onLongPress }: { file: StoredFile; onPress: () => void; onLongPress: () => void }) {
  const thumbSize = (SCREEN_W - 48 - 16) / 3;
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
          <Text style={{ fontSize: 28 }}>{fileIcon(file.mime_type)}</Text>
        )}
      </View>
      <Text numberOfLines={1} style={{ color: "#ccc", fontSize: 10, fontFamily: "monospace", marginTop: 4 }}>
        {file.filename}
      </Text>
      <Text style={{ color: DIM, fontSize: 9, fontFamily: "monospace" }}>
        {formatBytes(file.size_bytes)} · {formatRelativeOrShortDate(file.created_at)}
      </Text>
    </Pressable>
  );
}

// ── Preview Modal ──
function PreviewModal({ file, visible, onClose, onDelete, onDownload }: {
  file: StoredFile | null;
  visible: boolean;
  onClose: () => void;
  onDelete: () => void;
  onDownload: () => void;
}) {
  if (!file) return null;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.97)", justifyContent: "center", alignItems: "center" }}>
        <Pressable onPress={onClose} style={{ position: "absolute", top: 60, right: 20, width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.15)", justifyContent: "center", alignItems: "center", zIndex: 10 }}>
          <Text style={{ color: "#fff", fontSize: 18, fontWeight: "600" }}>✕</Text>
        </Pressable>
        {isImage(file.mime_type) ? (
          <Image source={{ uri: getFileDataUrl(file.id) }} style={{ width: SCREEN_W - 32, height: SCREEN_W - 32 }} resizeMode="contain" />
        ) : (
          <View style={{ alignItems: "center" }}>
            <Text style={{ fontSize: 60 }}>{fileIcon(file.mime_type)}</Text>
            <Text style={{ color: "#fff", fontSize: 14, fontFamily: "monospace", marginTop: 12 }}>{file.filename}</Text>
          </View>
        )}
        <View style={{ marginTop: 20, alignItems: "center" }}>
          <Text style={{ color: "#fff", fontSize: 13, fontFamily: "monospace", fontWeight: "600" }}>{file.filename}</Text>
          <Text style={{ color: DIM, fontSize: 11, fontFamily: "monospace", marginTop: 4 }}>
            {formatBytes(file.size_bytes)} · {file.mime_type}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 12, marginTop: 24 }}>
          <Pressable onPress={onDownload} style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, backgroundColor: "rgba(6,182,212,0.15)", borderWidth: 1, borderColor: ACCENT }}>
            <Text style={{ color: ACCENT, fontSize: 12, fontFamily: "monospace", fontWeight: "700" }}>DOWNLOAD</Text>
          </Pressable>
          <Pressable onPress={onDelete} style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, backgroundColor: "rgba(239,68,68,0.15)", borderWidth: 1, borderColor: "#EF4444" }}>
            <Text style={{ color: "#EF4444", fontSize: 12, fontFamily: "monospace", fontWeight: "700" }}>DELETE</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ── New Folder Modal ──
function NewFolderModal({ visible, onClose, onCreate }: { visible: boolean; onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "center", alignItems: "center", paddingHorizontal: 32 }}>
        <View style={{ backgroundColor: "#1A1A1A", borderRadius: 12, padding: 24, width: "100%", borderWidth: 1, borderColor: "#333" }}>
          <Text style={{ color: "#fff", fontFamily: "monospace", fontSize: 14, fontWeight: "700", marginBottom: 16, letterSpacing: 2 }}>NEW FOLDER</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Folder name"
            placeholderTextColor={DIM}
            autoFocus
            style={{ backgroundColor: "#111", color: "#fff", fontFamily: "monospace", fontSize: 14, borderRadius: 8, padding: 12, borderWidth: 1, borderColor: "#333", marginBottom: 16 }}
          />
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Pressable onPress={onClose} style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: "#2A2A2A", alignItems: "center" }}>
              <Text style={{ color: "#aaa", fontFamily: "monospace", fontSize: 12 }}>CANCEL</Text>
            </Pressable>
            <Pressable
              onPress={() => { if (name.trim()) { onCreate(name.trim()); setName(""); } }}
              style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: ACCENT + "22", borderWidth: 1, borderColor: ACCENT, alignItems: "center" }}
            >
              <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12, fontWeight: "700" }}>CREATE</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Main Screen ──
export default function FilesScreen() {
  const insets = useSafeAreaInsets();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [storageTotalBytes, setStorageTotalBytes] = useState(0);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([{ id: null, name: "FILES" }]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewFile, setPreviewFile] = useState<StoredFile | null>(null);
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;

  const loadContents = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [foldersData, filesResult] = await Promise.all([
        fetchFolders(currentFolderId),
        fetchFiles({ folder_id: currentFolderId === null ? "null" : String(currentFolderId), limit: 200 }),
      ]);
      setFolders(foldersData);
      setFiles(filesResult.files);
      if (filesResult.storageTotalBytes !== undefined) setStorageTotalBytes(filesResult.storageTotalBytes);
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, [currentFolderId]);

  useEffect(() => {
    loadContents();
  }, [loadContents]);

  const navigateIntoFolder = (folder: Folder) => {
    setBreadcrumbs(prev => [...prev, { id: folder.id, name: folder.name }]);
  };

  const navigateToBreadcrumb = (index: number) => {
    setBreadcrumbs(prev => prev.slice(0, index + 1));
  };

  const handleCreateFolder = async (name: string) => {
    setNewFolderVisible(false);
    const folder = await createFolder(name, currentFolderId);
    if (folder) loadContents();
  };

  const handleDeleteFolder = (folder: Folder) => {
    Alert.alert("Delete Folder", `Delete "${folder.name}"?\n\nFiles inside will be moved to root.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { await deleteFolder(folder.id); loadContents(); } },
    ]);
  };

  const handleUploadPhoto = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        quality: 0.85,
        allowsMultipleSelection: true,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) return;
      setUploading(true);
      for (const asset of result.assets) {
        let b64 = asset.base64;
        if (!b64) {
          b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
        }
        const fname = asset.fileName || `photo_${Date.now()}.jpg`;
        const mime = asset.mimeType || "image/jpeg";
        await uploadFile(b64, { filename: fname, mime_type: mime, source: "upload", category: "photos" });
      }
      await loadContents();
    } catch (e: any) {
      Alert.alert("Upload failed", e.message || "Unknown error");
    } finally {
      setUploading(false);
    }
  };

  const handleUploadFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.length) return;
      setUploading(true);
      for (const asset of result.assets) {
        const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
        const mime = asset.mimeType || "application/octet-stream";
        await uploadFile(b64, { filename: asset.name, mime_type: mime, source: "upload", category: "documents" });
      }
      await loadContents();
    } catch (e: any) {
      Alert.alert("Upload failed", e.message || "Unknown error");
    } finally {
      setUploading(false);
    }
  };

  const handleUpload = () => {
    Alert.alert("Upload", "What would you like to upload?", [
      { text: "Photos & Videos", onPress: handleUploadPhoto },
      { text: "Files & Documents", onPress: handleUploadFile },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const handleDelete = (file: StoredFile) => {
    Alert.alert("Delete file?", file.filename, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { await deleteFile(file.id); setPreviewFile(null); await loadContents(); } },
    ]);
  };

  const handleDownload = async (file: StoredFile) => {
    setDownloading(true);
    try {
      await downloadFile(file);
    } catch (e: any) {
      Alert.alert("Download Error", e.message);
    } finally {
      setDownloading(false);
    }
  };

  const imageFiles = files.filter(f => isImage(f.mime_type));
  const otherFiles = files.filter(f => !isImage(f.mime_type));
  const isEmpty = folders.length === 0 && files.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: "#111", paddingTop: insets.top }}>
      <HamburgerMenu />
      <GroupNav group="me" />
      {/* Header */}
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
        {/* Breadcrumbs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {breadcrumbs.map((crumb, index) => (
              <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                {index > 0 && <Text style={{ color: DIM, fontSize: 12 }}>/</Text>}
                <Pressable onPress={() => navigateToBreadcrumb(index)}>
                  <Text style={{
                    color: index === breadcrumbs.length - 1 ? "#fff" : ACCENT,
                    fontFamily: "monospace",
                    fontSize: 13,
                    fontWeight: index === breadcrumbs.length - 1 ? "700" : "400",
                    letterSpacing: index === 0 ? 2 : 0,
                  }}>
                    {crumb.name}
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        </ScrollView>

        {/* Actions row */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace" }}>
            {formatBytes(storageTotalBytes)} used · {files.length + folders.length} items
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              onPress={() => setNewFolderVisible(true)}
              style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.07)", borderWidth: 1, borderColor: "#333" }}
            >
              <Text style={{ color: "#aaa", fontSize: 11, fontFamily: "monospace", fontWeight: "700" }}>📁 NEW</Text>
            </Pressable>
            <Pressable
              onPress={handleUpload}
              disabled={uploading}
              style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, backgroundColor: "rgba(6,182,212,0.15)", borderWidth: 1, borderColor: ACCENT, opacity: uploading ? 0.5 : 1 }}
            >
              {uploading
                ? <ActivityIndicator size="small" color={ACCENT} />
                : <Text style={{ color: ACCENT, fontSize: 11, fontFamily: "monospace", fontWeight: "700" }}>+ UPLOAD</Text>}
            </Pressable>
          </View>
        </View>
      </View>

      {/* Content */}
      <ScrollView
        style={{ flex: 1, marginTop: 8 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadContents(true)} tintColor={ACCENT} />}
      >
        {loading && !refreshing ? (
          <View style={{ paddingTop: 60, alignItems: "center" }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : isEmpty ? (
          <View style={{ paddingTop: 60, alignItems: "center" }}>
            <Text style={{ fontSize: 48, marginBottom: 12 }}>☁️</Text>
            <Text style={{ color: DIM, fontSize: 14, fontFamily: "monospace", textAlign: "center" }}>
              {breadcrumbs.length > 1 ? "Empty folder" : "Your private cloud is empty"}
            </Text>
            <Text style={{ color: "#333", fontSize: 11, fontFamily: "monospace", marginTop: 8, textAlign: "center" }}>
              Create folders or upload files above
            </Text>
          </View>
        ) : (
          <>
            {/* Folders */}
            {folders.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                {folders.length > 0 && otherFiles.length + imageFiles.length > 0 && (
                  <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace", letterSpacing: 1, marginBottom: 8 }}>FOLDERS</Text>
                )}
                {folders.map(folder => (
                  <FolderItem
                    key={folder.id}
                    folder={folder}
                    onPress={() => navigateIntoFolder(folder)}
                    onLongPress={() => handleDeleteFolder(folder)}
                  />
                ))}
              </View>
            )}

            {/* Images grid */}
            {imageFiles.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                {(folders.length > 0 || otherFiles.length > 0) && (
                  <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace", letterSpacing: 1, marginBottom: 8 }}>IMAGES ({imageFiles.length})</Text>
                )}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {imageFiles.map(f => (
                    <FileItem
                      key={f.id}
                      file={f}
                      onPress={() => setPreviewFile(f)}
                      onLongPress={() => handleDelete(f)}
                    />
                  ))}
                </View>
              </View>
            )}

            {/* Other files */}
            {otherFiles.length > 0 && (
              <View>
                {(folders.length > 0 || imageFiles.length > 0) && (
                  <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace", letterSpacing: 1, marginBottom: 8 }}>FILES ({otherFiles.length})</Text>
                )}
                {otherFiles.map(f => (
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
                    <Text style={{ fontSize: 22, marginRight: 12 }}>{fileIcon(f.mime_type)}</Text>
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ color: "#ccc", fontSize: 12, fontFamily: "monospace" }}>{f.filename}</Text>
                      <Text style={{ color: DIM, fontSize: 10, fontFamily: "monospace" }}>
                        {formatBytes(f.size_bytes)} · {formatRelativeOrShortDate(f.created_at)}
                      </Text>
                    </View>
                    <Text style={{ color: DIM, fontSize: 16 }}>›</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Modals */}
      <PreviewModal
        file={previewFile}
        visible={!!previewFile}
        onClose={() => setPreviewFile(null)}
        onDelete={() => previewFile && handleDelete(previewFile)}
        onDownload={() => previewFile && handleDownload(previewFile)}
      />
      <NewFolderModal
        visible={newFolderVisible}
        onClose={() => setNewFolderVisible(false)}
        onCreate={handleCreateFolder}
      />
    </View>
  );
}
