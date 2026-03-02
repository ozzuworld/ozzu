import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Modal,
  ScrollView,
  Pressable,
  TextInput,
  Image,
  Alert,
  ActivityIndicator,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import {
  type BusinessTask,
  type BusinessAttachment,
  type TaskRequirement,
  type AttachmentVerification,
  fetchTaskAttachments,
  fetchTaskRequirements,
  reverifyAttachment,
  getAttachmentUrl,
  updateBusinessTask,
} from "../../lib/bridge-api";

const STATUS_CYCLE: Record<string, string> = {
  pending: "in_progress",
  in_progress: "done",
  done: "pending",
};
const STATUS_ICON: Record<string, string> = { pending: "○", in_progress: "◐", done: "●" };
const STATUS_COLOR: Record<string, string> = { pending: "#525252", in_progress: "#EAB308", done: "#22C55E" };
const STATUS_LABEL: Record<string, string> = { pending: "PENDING", in_progress: "IN PROGRESS", done: "DONE" };

const VERIFICATION_DOT_COLOR: Record<string, string> = {
  verified: "#22C55E",
  partial: "#EAB308",
  rejected: "#EF4444",
  unverified: "#525252",
};

const PRIORITIES = [
  { value: "low", label: "LOW", color: "#3B82F6" },
  { value: "medium", label: "MED", color: "#F97316" },
  { value: "high", label: "HIGH", color: "#EF4444" },
] as const;

interface TaskDetailSheetProps {
  task: BusinessTask | null;
  visible: boolean;
  onClose: () => void;
  onToggle: (taskId: number) => void;
  onEdit: (taskId: number, data: Partial<BusinessTask>) => void;
  onDelete: (task: BusinessTask) => void;
  onUpload: (taskId: number, base64: string, fileName: string, fileType?: string) => Promise<any>;
  onRemoveAttachment: (id: number) => void;
}

export function TaskDetailSheet({
  task,
  visible,
  onClose,
  onToggle,
  onEdit,
  onDelete,
  onUpload,
  onRemoveAttachment,
}: TaskDetailSheetProps) {
  const [notes, setNotes] = useState("");
  const [attachments, setAttachments] = useState<BusinessAttachment[]>([]);
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [viewImage, setViewImage] = useState<number | null>(null);
  const [requirements, setRequirements] = useState<TaskRequirement[]>([]);
  const [reqFulfilled, setReqFulfilled] = useState(0);
  const [verificationDetail, setVerificationDetail] = useState<AttachmentVerification | null>(null);

  useEffect(() => {
    if (task) {
      setNotes(task.notes || "");
      loadAttachments(task.id);
      loadRequirements(task.id);
    } else {
      setAttachments([]);
      setRequirements([]);
      setReqFulfilled(0);
    }
  }, [task?.id, task?.attachment_count]);

  const loadAttachments = async (taskId: number) => {
    setLoadingAttachments(true);
    try {
      const data = await fetchTaskAttachments(taskId);
      setAttachments(data);
    } catch {
      setAttachments([]);
    } finally {
      setLoadingAttachments(false);
    }
  };

  const loadRequirements = async (taskId: number) => {
    try {
      const data = await fetchTaskRequirements(taskId);
      setRequirements(data.requirements || []);
      setReqFulfilled(data.fulfilled || 0);
    } catch {
      setRequirements([]);
      setReqFulfilled(0);
    }
  };

  const handleNotesSave = useCallback(() => {
    if (!task || notes === (task.notes || "")) return;
    onEdit(task.id, { notes } as any);
  }, [task, notes, onEdit]);

  const handlePickImage = useCallback(async (source: "camera" | "library") => {
    if (!task) return;
    try {
      const opts: ImagePicker.ImagePickerOptions = {
        quality: 0.8,
        base64: true,
      };
      const result = source === "camera"
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
      if (result.canceled || !result.assets?.[0]?.base64) return;
      const asset = result.assets[0];
      const ext = asset.uri.split(".").pop() || "jpg";
      const fileName = `photo_${Date.now()}.${ext}`;
      setUploading(true);
      await onUpload(task.id, asset.base64, fileName, "image");
      await loadAttachments(task.id);
      await loadRequirements(task.id);
    } catch (err: any) {
      Alert.alert("Upload Failed", err?.message || "Could not upload the image");
    } finally {
      setUploading(false);
    }
  }, [task, onUpload]);

  const handlePickDocument = useCallback(async () => {
    if (!task) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.[0]) return;
      const doc = result.assets[0];
      setUploading(true);
      // Copy to local cache first — iOS sandboxing blocks direct reads from picker URIs
      const localUri = FileSystem.cacheDirectory + "upload_" + Date.now() + "_" + doc.name;
      await FileSystem.copyAsync({ from: doc.uri, to: localUri });
      const base64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
      const fileType = doc.mimeType?.includes("pdf") ? "document" : "image";
      await onUpload(task.id, base64, doc.name, fileType);
      await loadAttachments(task.id);
      await loadRequirements(task.id);
      // Clean up temp file
      FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
    } catch (err: any) {
      Alert.alert("Upload Failed", err?.message || "Could not read or upload the file");
    } finally {
      setUploading(false);
    }
  }, [task, onUpload]);

  const handleUploadMenu = useCallback(() => {
    Alert.alert("Add Attachment", "Choose source", [
      { text: "Camera", onPress: () => handlePickImage("camera") },
      { text: "Photo Library", onPress: () => handlePickImage("library") },
      { text: "Document", onPress: () => handlePickDocument() },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [handlePickImage, handlePickDocument]);

  const handleDeleteAttachment = useCallback((att: BusinessAttachment) => {
    Alert.alert("Delete Attachment", `Delete "${att.file_name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          onRemoveAttachment(att.id);
          setAttachments((prev) => prev.filter((a) => a.id !== att.id));
        },
      },
    ]);
  }, [onRemoveAttachment]);

  if (!task) return null;

  const formatDate = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const hasRequirements = requirements.length > 0;
  const verificationStatus = reqFulfilled === 0 ? "unverified" : reqFulfilled >= requirements.length ? "verified" : "partial";

  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
          <Pressable style={{ height: 100 }} onPress={onClose} />
          <View style={{ flex: 1, backgroundColor: "#111111", borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
            <Pressable onPress={onClose} style={{ alignItems: "center", paddingTop: 12, paddingBottom: 8 }}>
              <View style={{ width: 40, height: 4, backgroundColor: "#555", borderRadius: 2 }} />
            </Pressable>

            {/* Close button */}
            <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, marginBottom: 4 }}>
              <Pressable onPress={onClose} hitSlop={16} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
                <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 11 }}>CLOSE</Text>
              </Pressable>
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
              {/* Header: status toggle + title */}
              <View style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 12 }}>
                <Pressable onPress={() => onToggle(task.id)} hitSlop={12} style={{ marginRight: 12, marginTop: 2 }}>
                  <Text style={{ color: STATUS_COLOR[task.status], fontSize: 24 }}>
                    {STATUS_ICON[task.status]}
                  </Text>
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#E5E5E5", fontSize: 16, fontWeight: "bold" }}>
                    {task.title}
                  </Text>
                  <Text style={{ color: STATUS_COLOR[task.status], fontFamily: "monospace", fontSize: 10, marginTop: 2 }}>
                    {STATUS_LABEL[task.status]}
                  </Text>
                </View>
              </View>

              {/* Priority pills */}
              <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>PRIORITY</Text>
              <View style={{ flexDirection: "row", gap: 6, marginBottom: 16 }}>
                {PRIORITIES.map((p) => (
                  <Pressable
                    key={p.value}
                    onPress={() => onEdit(task.id, { priority: p.value } as any)}
                    style={{
                      flex: 1,
                      paddingVertical: 6,
                      borderRadius: 6,
                      alignItems: "center",
                      backgroundColor: task.priority === p.value ? p.color + "22" : "#1A1A1A",
                      borderWidth: 1,
                      borderColor: task.priority === p.value ? p.color : "#2A2A2A",
                    }}
                  >
                    <Text style={{
                      color: task.priority === p.value ? p.color : "#525252",
                      fontFamily: "monospace",
                      fontSize: 10,
                      fontWeight: "bold",
                    }}>
                      {p.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {/* Phase badge */}
              {task.phase ? (
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>PHASE</Text>
                  <View style={{ backgroundColor: "#06B6D422", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, alignSelf: "flex-start" }}>
                    <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 11 }}>{task.phase}</Text>
                  </View>
                </View>
              ) : null}

              {/* Description */}
              {task.description ? (
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>DESCRIPTION</Text>
                  <Text style={{ color: "#A3A3A3", fontSize: 13, lineHeight: 20 }}>{task.description}</Text>
                </View>
              ) : null}

              {/* Requirements checklist */}
              {hasRequirements ? (
                <View style={{ marginBottom: 16 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
                    <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, flex: 1 }}>
                      REQUIREMENTS ({reqFulfilled}/{requirements.length})
                    </Text>
                    <View style={{
                      backgroundColor: VERIFICATION_DOT_COLOR[verificationStatus] + "22",
                      paddingHorizontal: 8,
                      paddingVertical: 2,
                      borderRadius: 4,
                    }}>
                      <Text style={{
                        color: VERIFICATION_DOT_COLOR[verificationStatus],
                        fontFamily: "monospace",
                        fontSize: 9,
                        fontWeight: "bold",
                      }}>
                        {verificationStatus === "verified" ? "VERIFIED" : verificationStatus === "partial" ? "PARTIAL" : "UNVERIFIED"}
                      </Text>
                    </View>
                  </View>
                  {requirements.map((req) => (
                    <View key={req.id} style={{
                      flexDirection: "row",
                      alignItems: "flex-start",
                      paddingVertical: 6,
                      paddingLeft: 8,
                      borderLeftWidth: 2,
                      borderLeftColor: req.fulfilled ? "#22C55E" : "#333",
                      marginBottom: 4,
                    }}>
                      <Text style={{ color: req.fulfilled ? "#22C55E" : "#525252", fontSize: 12, marginRight: 8, marginTop: 1 }}>
                        {req.fulfilled ? "●" : "○"}
                      </Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: req.fulfilled ? "#A3A3A3" : "#E5E5E5", fontSize: 12, fontWeight: "600" }}>
                          {req.label}
                        </Text>
                        {req.description ? (
                          <Text style={{ color: "#525252", fontSize: 10, marginTop: 2 }}>{req.description}</Text>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* Notes */}
              <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>NOTES</Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                onBlur={handleNotesSave}
                placeholder="Add notes..."
                placeholderTextColor="#525252"
                multiline
                style={{
                  backgroundColor: "#1A1A1A",
                  color: "#E5E5E5",
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 13,
                  minHeight: 80,
                  borderWidth: 1,
                  borderColor: "#2A2A2A",
                  textAlignVertical: "top",
                  marginBottom: 16,
                }}
              />

              {/* Attachments */}
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10 }}>
                  ATTACHMENTS ({attachments.length})
                </Text>
                <Pressable onPress={handleUploadMenu} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  {uploading ? (
                    <>
                      <ActivityIndicator size="small" color="#06B6D4" />
                      <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 10 }}>VERIFYING...</Text>
                    </>
                  ) : (
                    <>
                      <Text style={{ color: "#06B6D4", fontSize: 16 }}>+</Text>
                      <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 10 }}>ADD</Text>
                    </>
                  )}
                </Pressable>
              </View>

              {loadingAttachments ? (
                <ActivityIndicator size="small" color="#525252" style={{ marginVertical: 12 }} />
              ) : attachments.length > 0 ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                  {attachments.map((att) => {
                    const vStatus = att.verification?.status;
                    const dotColor = vStatus ? VERIFICATION_DOT_COLOR[vStatus] : undefined;
                    return (
                      <Pressable
                        key={att.id}
                        onPress={() => {
                          if (att.verification) {
                            setVerificationDetail(att.verification);
                          } else if (att.file_type === "image") {
                            setViewImage(att.id);
                          }
                        }}
                        onLongPress={() => handleDeleteAttachment(att)}
                      >
                        <View>
                          {att.file_type === "image" ? (
                            <Image
                              source={{ uri: getAttachmentUrl(att.id, true) }}
                              style={{ width: 80, height: 80, borderRadius: 8, backgroundColor: "#1A1A1A" }}
                            />
                          ) : (
                            <View style={{
                              width: 80,
                              height: 80,
                              borderRadius: 8,
                              backgroundColor: "#1A1A1A",
                              alignItems: "center",
                              justifyContent: "center",
                            }}>
                              <Text style={{ fontSize: 24 }}>📄</Text>
                              <Text style={{ color: "#525252", fontSize: 8, fontFamily: "monospace", marginTop: 2 }} numberOfLines={1}>
                                {att.file_name}
                              </Text>
                            </View>
                          )}
                          {/* Verification dot overlay */}
                          {dotColor ? (
                            <View style={{
                              position: "absolute",
                              top: 4,
                              right: 4,
                              width: 10,
                              height: 10,
                              borderRadius: 5,
                              backgroundColor: dotColor,
                              borderWidth: 1.5,
                              borderColor: "#111111",
                            }} />
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 11, marginBottom: 16 }}>
                  No attachments yet
                </Text>
              )}

              {/* Timestamps */}
              <View style={{ marginBottom: 16 }}>
                <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>
                  Created {formatDate(task.created_at)}
                </Text>
                {task.completed_at ? (
                  <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9 }}>
                    Completed {formatDate(task.completed_at)}
                  </Text>
                ) : null}
              </View>

              {/* Delete task */}
              <Pressable onPress={() => onDelete(task)} style={{ alignItems: "center", paddingVertical: 10 }}>
                <Text style={{ color: "#EF4444", fontFamily: "monospace", fontSize: 11 }}>DELETE TASK</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Full-size image viewer */}
      <Modal visible={viewImage !== null} transparent animationType="fade" onRequestClose={() => setViewImage(null)}>
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.9)", alignItems: "center", justifyContent: "center" }}
          onPress={() => setViewImage(null)}
        >
          {viewImage !== null && (
            <Image
              source={{ uri: getAttachmentUrl(viewImage, false) }}
              style={{ width: "90%", height: "70%", borderRadius: 12 }}
              resizeMode="contain"
            />
          )}
        </Pressable>
      </Modal>

      {/* Verification detail panel */}
      <Modal visible={verificationDetail !== null} transparent animationType="slide" onRequestClose={() => setVerificationDetail(null)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
          <Pressable style={{ flex: 0.3 }} onPress={() => setVerificationDetail(null)} />
          <View style={{ flex: 0.7, backgroundColor: "#111111", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16 }}>
            <View style={{ alignItems: "center", paddingBottom: 12 }}>
              <View style={{ width: 40, height: 4, backgroundColor: "#333", borderRadius: 2 }} />
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {verificationDetail && (
                <>
                  {/* Status badge */}
                  <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
                    <View style={{
                      width: 10, height: 10, borderRadius: 5, marginRight: 8,
                      backgroundColor: VERIFICATION_DOT_COLOR[verificationDetail.status],
                    }} />
                    <Text style={{
                      color: VERIFICATION_DOT_COLOR[verificationDetail.status],
                      fontFamily: "monospace", fontSize: 12, fontWeight: "bold",
                    }}>
                      {verificationDetail.status.toUpperCase()}
                    </Text>
                    <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 9, marginLeft: 8 }}>
                      {verificationDetail.documentType}
                    </Text>
                  </View>

                  {/* Summary */}
                  <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>AI ANALYSIS</Text>
                  <Text style={{ color: "#A3A3A3", fontSize: 13, lineHeight: 20, marginBottom: 16 }}>
                    {verificationDetail.summary}
                  </Text>

                  {/* Matched requirements */}
                  {verificationDetail.details.length > 0 ? (
                    <View style={{ marginBottom: 16 }}>
                      <Text style={{ color: "#737373", fontFamily: "monospace", fontSize: 10, marginBottom: 8 }}>REQUIREMENTS CHECK</Text>
                      {verificationDetail.details.map((d, i) => (
                        <View key={i} style={{
                          flexDirection: "row", alignItems: "flex-start",
                          paddingVertical: 6, paddingLeft: 8,
                          borderLeftWidth: 2, borderLeftColor: d.met ? "#22C55E" : "#EF4444",
                          marginBottom: 4,
                        }}>
                          <Text style={{ color: d.met ? "#22C55E" : "#EF4444", fontSize: 12, marginRight: 8 }}>
                            {d.met ? "✓" : "✗"}
                          </Text>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: "#E5E5E5", fontSize: 11 }}>{d.requirementId}</Text>
                            <Text style={{ color: "#737373", fontSize: 10, marginTop: 2 }}>{d.explanation}</Text>
                            <Text style={{ color: "#525252", fontSize: 9, marginTop: 2 }}>
                              Confidence: {Math.round(d.confidence * 100)}%
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  ) : null}

                  {/* Issues */}
                  {verificationDetail.issues.length > 0 ? (
                    <View style={{ marginBottom: 16 }}>
                      <Text style={{ color: "#EF4444", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>ISSUES</Text>
                      {verificationDetail.issues.map((issue, i) => (
                        <Text key={i} style={{ color: "#A3A3A3", fontSize: 12, marginBottom: 2 }}>• {issue}</Text>
                      ))}
                    </View>
                  ) : null}

                  {/* Suggestions */}
                  {verificationDetail.suggestions.length > 0 ? (
                    <View style={{ marginBottom: 16 }}>
                      <Text style={{ color: "#06B6D4", fontFamily: "monospace", fontSize: 10, marginBottom: 4 }}>SUGGESTIONS</Text>
                      {verificationDetail.suggestions.map((s, i) => (
                        <Text key={i} style={{ color: "#A3A3A3", fontSize: 12, marginBottom: 2 }}>• {s}</Text>
                      ))}
                    </View>
                  ) : null}

                  <Pressable onPress={() => setVerificationDetail(null)} style={{ alignItems: "center", paddingVertical: 12 }}>
                    <Text style={{ color: "#525252", fontFamily: "monospace", fontSize: 11 }}>CLOSE</Text>
                  </Pressable>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}
