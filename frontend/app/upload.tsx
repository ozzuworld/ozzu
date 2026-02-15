import { useState, useRef, useEffect, useCallback } from "react";
import { View, Text, TextInput, Image, ScrollView } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { BridgeSession, type BridgeCallbacks } from "../lib/bridge-session";
import { usePhoneLayout } from "../lib/usePhoneLayout";

const TOP_BAR_HEIGHT = 48;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const ALLOWED_MIME_PREFIXES = ["image/", "text/", "application/pdf", "application/json"];
const ALLOWED_EXTENSIONS = [".txt", ".pdf", ".md", ".json", ".csv", ".log"];

type Mode = "FILE" | "TEXT";
type ContentType = "image" | "document" | "text";

interface SelectedFile {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
  contentType: ContentType;
  previewUri?: string;
}

function detectContentType(mimeType: string): ContentType {
  if (mimeType.startsWith("image/")) return "image";
  return "document";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isAllowedFile(mimeType: string, name: string): boolean {
  if (ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) return true;
  const ext = name.substring(name.lastIndexOf(".")).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

export default function UploadScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();
  const [mode, setMode] = useState<Mode>("FILE");
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [textContent, setTextContent] = useState("");
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridgeRef = useRef<BridgeSession>(new BridgeSession());
  const connectedRef = useRef(false);

  useEffect(() => {
    const noop = () => {};
    const callbacks: BridgeCallbacks = {
      onReady: () => { connectedRef.current = true; },
      onAudioChunk: noop,
      onTranscript: noop,
      onInputTranscript: noop,
      onTurnComplete: noop,
      onInterrupted: noop,
      onPinRequest: noop,
      onPinResolved: noop,
      onShowCamera: noop,
      onHideCamera: noop,
      onShowContent: noop,
      onHideContent: noop,
      onConnected: noop,
      onListeningReady: noop,
      onError: (msg) => setError(msg),
    };
    bridgeRef.current.connect(callbacks);
    return () => bridgeRef.current.close();
  }, []);

  const pickDocument = useCallback(async () => {
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["text/*", "application/pdf", "application/json", "image/*"],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const newFiles: SelectedFile[] = [];
      let skipped = 0;
      for (const asset of result.assets) {
        if (!isAllowedFile(asset.mimeType || "", asset.name)) { skipped++; continue; }
        if (asset.size && asset.size > MAX_FILE_SIZE) { skipped++; continue; }
        const contentType = detectContentType(asset.mimeType || "application/octet-stream");
        newFiles.push({
          uri: asset.uri,
          name: asset.name,
          size: asset.size || 0,
          mimeType: asset.mimeType || "application/octet-stream",
          contentType,
          previewUri: contentType === "image" ? asset.uri : undefined,
        });
      }
      if (skipped > 0) setError(`${skipped} file(s) skipped (unsupported or >5MB)`);
      if (newFiles.length > 0) setFiles((prev) => [...prev, ...newFiles]);
    } catch (e: any) {
      setError(e.message || "Failed to pick document");
    }
  }, []);

  const pickImage = useCallback(async () => {
    setError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.7,
        base64: false,
        allowsEditing: false,
        allowsMultipleSelection: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const newFiles: SelectedFile[] = [];
      let skipped = 0;
      for (const asset of result.assets) {
        const info = await FileSystem.getInfoAsync(asset.uri);
        if (info.exists && info.size > MAX_FILE_SIZE) { skipped++; continue; }
        const ext = asset.uri.split(".").pop() || "jpg";
        const name = `image-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        newFiles.push({
          uri: asset.uri,
          name,
          size: info.exists ? info.size : 0,
          mimeType: asset.mimeType || `image/${ext}`,
          contentType: "image",
          previewUri: asset.uri,
        });
      }
      if (skipped > 0) setError(`${skipped} image(s) skipped (>5MB)`);
      if (newFiles.length > 0) setFiles((prev) => [...prev, ...newFiles]);
    } catch (e: any) {
      setError(e.message || "Failed to pick image");
    }
  }, []);

  const send = useCallback(
    async (target: "cipher" | "june") => {
      setError(null);
      setSending(true);
      try {
        if (mode === "TEXT") {
          bridgeRef.current.sendUpload(target, "text", textContent);
        } else if (files.length > 0) {
          for (const f of files) {
            const data = await FileSystem.readAsStringAsync(f.uri, {
              encoding: f.contentType === "image"
                ? FileSystem.EncodingType.Base64
                : FileSystem.EncodingType.UTF8,
            });
            bridgeRef.current.sendUpload(target, f.contentType, data, f.name);
          }
        } else {
          setSending(false);
          return;
        }

        const label = target === "cipher" ? "CIPHER" : "JUNE";
        const count = mode === "TEXT" ? 1 : files.length;
        setFlash(`Sent ${count} item${count > 1 ? "s" : ""} to ${label}`);
        setTimeout(() => {
          setFlash(null);
          router.back();
        }, 1200);
      } catch (e: any) {
        setError(e.message || "Failed to send");
      } finally {
        setSending(false);
      }
    },
    [mode, files, textContent, router]
  );

  const hasContent = mode === "TEXT" ? textContent.trim().length > 0 : files.length > 0;
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#111111" }}>
      {/* Top Bar */}
      <View
        style={{
          paddingTop: insets.top,
          height: TOP_BAR_HEIGHT + insets.top,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: Math.max(16, insets.left, insets.right),
        }}
      >
        <Text style={{ color: "#F59E0B", fontSize: 24, fontWeight: "bold" }}>
          ozzu
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <TVPressable
            onPress={() => router.back()}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 6,
            }}
          >
            <Text
              style={{
                color: "#A3A3A3",
                fontSize: 12,
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              {"◀ BACK"}
            </Text>
          </TVPressable>
          <StatusBadge />
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: Math.max(24, insets.left, insets.right), paddingBottom: Math.max(24, insets.bottom), gap: 20 }}
      >
        {/* Title */}
        <Text
          style={{
            color: "#06B6D4",
            fontSize: 16,
            fontFamily: "monospace",
            fontWeight: "bold",
            letterSpacing: 4,
          }}
        >
          UPLOAD
        </Text>

        {/* Mode Tabs */}
        <View style={{ flexDirection: "row", gap: 8 }}>
          {(["FILE", "TEXT"] as Mode[]).map((m) => (
            <TVPressable
              key={m}
              onPress={() => setMode(m)}
              style={{
                paddingHorizontal: 20,
                paddingVertical: 8,
                borderRadius: 6,
                backgroundColor: mode === m ? "#06B6D4" : "#1A1A1A",
                borderWidth: 1,
                borderColor: mode === m ? "#06B6D4" : "#333",
              }}
            >
              <Text
                style={{
                  color: mode === m ? "#000" : "#737373",
                  fontSize: 12,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  letterSpacing: 2,
                }}
              >
                {m}
              </Text>
            </TVPressable>
          ))}
        </View>

        {/* File Mode */}
        {mode === "FILE" && (
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <TVPressable
                onPress={pickDocument}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 8,
                  backgroundColor: "#1A1A1A",
                  borderWidth: 1,
                  borderColor: "#333",
                  alignItems: "center",
                }}
              >
                <Text
                  style={{
                    color: "#A3A3A3",
                    fontSize: 12,
                    fontFamily: "monospace",
                    fontWeight: "bold",
                    letterSpacing: 1,
                  }}
                >
                  SELECT FILE
                </Text>
              </TVPressable>
              <TVPressable
                onPress={pickImage}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 8,
                  backgroundColor: "#1A1A1A",
                  borderWidth: 1,
                  borderColor: "#333",
                  alignItems: "center",
                }}
              >
                <Text
                  style={{
                    color: "#A3A3A3",
                    fontSize: 12,
                    fontFamily: "monospace",
                    fontWeight: "bold",
                    letterSpacing: 1,
                  }}
                >
                  SELECT IMAGE
                </Text>
              </TVPressable>
            </View>

            {/* File List */}
            {files.length > 0 && (
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ color: "#737373", fontSize: 11, fontFamily: "monospace" }}>
                    {files.length} file{files.length > 1 ? "s" : ""} · {formatSize(totalSize)}
                  </Text>
                  <TVPressable onPress={() => setFiles([])} style={{ padding: 4 }}>
                    <Text style={{ color: "#EF4444", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                      CLEAR ALL
                    </Text>
                  </TVPressable>
                </View>
                {files.map((f, i) => (
                  <View
                    key={`${f.name}-${i}`}
                    style={{
                      backgroundColor: "#1A1A1A",
                      borderWidth: 1,
                      borderColor: "#333",
                      borderRadius: 8,
                      padding: 10,
                      gap: 6,
                    }}
                  >
                    {f.previewUri && (
                      <Image
                        source={{ uri: f.previewUri }}
                        style={{ width: "100%", height: 120, borderRadius: 6, backgroundColor: "#222" }}
                        resizeMode="contain"
                      />
                    )}
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ fontSize: 14 }}>
                        {f.contentType === "image" ? "🖼️" : "📄"}
                      </Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: "#E5E5E5", fontSize: 12, fontFamily: "monospace" }} numberOfLines={1}>
                          {f.name}
                        </Text>
                        <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
                          {formatSize(f.size)} · {f.contentType.toUpperCase()}
                        </Text>
                      </View>
                      <TVPressable onPress={() => removeFile(i)} style={{ padding: 6 }}>
                        <Text style={{ color: "#EF4444", fontSize: 14 }}>✕</Text>
                      </TVPressable>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Text Mode */}
        {mode === "TEXT" && (
          <View style={{ gap: 8 }}>
            <TextInput
              value={textContent}
              onChangeText={setTextContent}
              placeholder="Paste or type content..."
              placeholderTextColor="#525252"
              multiline
              style={{
                backgroundColor: "#1A1A1A",
                borderWidth: 1,
                borderColor: "#333",
                borderRadius: 8,
                padding: 12,
                color: "#E5E5E5",
                fontSize: 13,
                fontFamily: "monospace",
                minHeight: 160,
                textAlignVertical: "top",
              }}
            />
            <Text
              style={{
                color: "#525252",
                fontSize: 11,
                fontFamily: "monospace",
                alignSelf: "flex-end",
              }}
            >
              {textContent.length} chars
            </Text>
          </View>
        )}

        {/* Error */}
        {error && (
          <Text
            style={{
              color: "#EF4444",
              fontSize: 12,
              fontFamily: "monospace",
            }}
          >
            {error}
          </Text>
        )}

        {/* Success Flash */}
        {flash && (
          <View
            style={{
              backgroundColor: "#064E3B",
              borderRadius: 8,
              padding: 12,
              alignItems: "center",
            }}
          >
            <Text
              style={{
                color: "#34D399",
                fontSize: 14,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 2,
              }}
            >
              {flash}
            </Text>
          </View>
        )}

        {/* Send Buttons */}
        <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
          <TVPressable
            onPress={() => send("cipher")}
            disabled={!hasContent || sending}
            style={{
              flex: 1,
              paddingVertical: 14,
              borderRadius: 8,
              backgroundColor: hasContent && !sending ? "#06B6D4" : "#1A1A1A",
              borderWidth: 1,
              borderColor: hasContent && !sending ? "#06B6D4" : "#333",
              alignItems: "center",
              opacity: hasContent && !sending ? 1 : 0.4,
            }}
          >
            <Text
              style={{
                color: hasContent && !sending ? "#000" : "#525252",
                fontSize: 12,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              {sending ? "SENDING..." : files.length > 1 ? `SEND ${files.length} TO CIPHER` : "SEND TO CIPHER"}
            </Text>
          </TVPressable>
          <TVPressable
            onPress={() => send("june")}
            disabled={!hasContent || sending}
            style={{
              flex: 1,
              paddingVertical: 14,
              borderRadius: 8,
              backgroundColor: hasContent && !sending ? "#F59E0B" : "#1A1A1A",
              borderWidth: 1,
              borderColor: hasContent && !sending ? "#F59E0B" : "#333",
              alignItems: "center",
              opacity: hasContent && !sending ? 1 : 0.4,
            }}
          >
            <Text
              style={{
                color: hasContent && !sending ? "#000" : "#525252",
                fontSize: 12,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 1,
              }}
            >
              {sending ? "SENDING..." : files.length > 1 ? `SEND ${files.length} TO JUNE` : "SEND TO JUNE"}
            </Text>
          </TVPressable>
        </View>
      </ScrollView>

      <StatusBar style="light" />
    </View>
  );
}
