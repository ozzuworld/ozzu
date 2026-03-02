import { View, Text, ScrollView, Modal } from "react-native";
import { TVPressable } from "../TVPressable";
import type { VisionMode } from "./VisionOverlay";

type Quality = "low" | "medium" | "high";

type Props = {
  visible: boolean;
  onClose: () => void;
  quality: Quality;
  onQualityChange: (q: Quality) => void;
  visionMode: VisionMode;
  onVisionModeChange: (m: VisionMode) => void;
  onAnalyze: () => void;
  visionLoading: boolean;
  onDiagnostics: () => void;
  onLogs: () => void;
  diagnostics: Record<string, any> | null;
  logs: Array<{ ts: string; msg: string }> | null;
  onClearDiagnostics: () => void;
  onClearLogs: () => void;
  onRefreshLogs: () => void;
  urlEvents: string[];
  isStreaming: boolean;
  osintMode?: boolean;
  onToggleOsint?: () => void;
};

const QUALITY_LABELS: Record<Quality, string> = {
  low: "LOW",
  medium: "MED",
  high: "HIGH",
};

const VISION_COLORS: Record<VisionMode, string> = {
  describe: "#06B6D4",
  ocr: "#A855F7",
  identify: "#10B981",
  translate: "#F59E0B",
};

export default function SettingsSheet({
  visible,
  onClose,
  quality,
  onQualityChange,
  visionMode,
  onVisionModeChange,
  onAnalyze,
  visionLoading,
  onDiagnostics,
  onLogs,
  diagnostics,
  logs,
  onClearDiagnostics,
  onClearLogs,
  onRefreshLogs,
  urlEvents,
  isStreaming,
  osintMode,
  onToggleOsint,
}: Props) {
  if (!visible) return null;

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        {/* Backdrop */}
        <TVPressable onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)" }}>
          <View />
        </TVPressable>

        {/* Sheet */}
        <View
          style={{
            backgroundColor: "#1A1A1A",
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 12,
            paddingBottom: 32,
            paddingHorizontal: 20,
            maxHeight: "70%",
          }}
        >
          {/* Handle */}
          <View style={{ alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: "#444", marginBottom: 16 }} />

          <ScrollView showsVerticalScrollIndicator={false} style={{ gap: 16 }}>
            {/* Quality */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ color: "#737373", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2, marginBottom: 8 }}>
                QUALITY
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {(["low", "medium", "high"] as Quality[]).map((q) => (
                  <TVPressable
                    key={q}
                    onPress={() => onQualityChange(q)}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 8,
                      backgroundColor: quality === q ? "#06B6D4" : "#111",
                      borderWidth: 1,
                      borderColor: quality === q ? "#06B6D4" : "#333",
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: quality === q ? "#000" : "#737373", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
                      {QUALITY_LABELS[q]}
                    </Text>
                  </TVPressable>
                ))}
              </View>
            </View>

            {/* Vision Mode */}
            {isStreaming && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ color: "#737373", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2, marginBottom: 8 }}>
                  VISION MODE
                </Text>
                <View style={{ flexDirection: "row", gap: 6, marginBottom: 8 }}>
                  {(["describe", "ocr", "identify", "translate"] as VisionMode[]).map((m) => {
                    const c = VISION_COLORS[m];
                    const active = visionMode === m;
                    return (
                      <TVPressable
                        key={m}
                        onPress={() => onVisionModeChange(m)}
                        style={{
                          flex: 1,
                          paddingVertical: 10,
                          borderRadius: 8,
                          backgroundColor: active ? `${c}22` : "#111",
                          borderWidth: 1,
                          borderColor: active ? c : "#333",
                          alignItems: "center",
                        }}
                      >
                        <Text style={{ color: active ? c : "#737373", fontSize: 9, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
                          {m.toUpperCase()}
                        </Text>
                      </TVPressable>
                    );
                  })}
                </View>
                <TVPressable
                  onPress={onAnalyze}
                  style={{
                    paddingVertical: 10,
                    borderRadius: 8,
                    backgroundColor: "rgba(6,182,212,0.1)",
                    borderWidth: 1,
                    borderColor: "#164E63",
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>
                    {visionLoading ? "ANALYZING..." : `ANALYZE (${visionMode.toUpperCase()})`}
                  </Text>
                </TVPressable>
              </View>
            )}

            {/* OSINT Scan Mode */}
            {isStreaming && onToggleOsint && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ color: "#737373", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2, marginBottom: 8 }}>
                  OSINT SCAN MODE
                </Text>
                <TVPressable
                  onPress={onToggleOsint}
                  style={{
                    paddingVertical: 12,
                    borderRadius: 8,
                    backgroundColor: osintMode ? "rgba(6,182,212,0.15)" : "#111",
                    borderWidth: 1,
                    borderColor: osintMode ? "#06B6D4" : "#333",
                    alignItems: "center",
                  }}
                >
                  <Text style={{ color: osintMode ? "#06B6D4" : "#737373", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
                    {osintMode ? "OSINT ACTIVE — TAP TO DISABLE" : "ENABLE FACE SCANNING"}
                  </Text>
                </TVPressable>
                {osintMode && (
                  <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace", marginTop: 4 }}>
                    Scanning faces against local DB every 5s
                  </Text>
                )}
              </View>
            )}

            {/* Debug Tools */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ color: "#737373", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2, marginBottom: 8 }}>
                DEBUG
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <TVPressable
                  onPress={onDiagnostics}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: "#164E63", alignItems: "center" }}
                >
                  <Text style={{ color: "#06B6D4", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
                    DIAGNOSTICS
                  </Text>
                </TVPressable>
                <TVPressable
                  onPress={onLogs}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: "#164E63", alignItems: "center" }}
                >
                  <Text style={{ color: "#06B6D4", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
                    SHOW LOGS
                  </Text>
                </TVPressable>
              </View>
              {urlEvents.length > 0 && (
                <Text style={{ color: "#F59E0B", fontSize: 9, fontFamily: "monospace", marginTop: 6 }}>
                  {urlEvents.length} URL event(s) received
                </Text>
              )}
            </View>

            {/* Diagnostics Panel */}
            {diagnostics && (
              <View style={{ backgroundColor: "rgba(6,182,212,0.05)", borderWidth: 1, borderColor: "#164E63", borderRadius: 8, padding: 10, gap: 4, marginBottom: 16 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ color: "#06B6D4", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
                    DIAGNOSTICS
                  </Text>
                  <TVPressable onPress={onClearDiagnostics} style={{ padding: 4 }}>
                    <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>CLOSE</Text>
                  </TVPressable>
                </View>
                {Object.entries(diagnostics).filter(([k]) => k !== "recentLogs").map(([key, val]) => (
                  <Text key={key} style={{ color: "#737373", fontSize: 9, fontFamily: "monospace" }}>
                    {key}: {typeof val === "object" ? JSON.stringify(val) : String(val)}
                  </Text>
                ))}
              </View>
            )}

            {/* Logs Panel */}
            {logs && (
              <View style={{ backgroundColor: "rgba(6,182,212,0.05)", borderWidth: 1, borderColor: "#164E63", borderRadius: 8, padding: 10, gap: 2, maxHeight: 200, marginBottom: 16 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <Text style={{ color: "#06B6D4", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
                    SDK LOGS ({logs.length})
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TVPressable onPress={onRefreshLogs} style={{ padding: 4 }}>
                      <Text style={{ color: "#06B6D4", fontSize: 9, fontFamily: "monospace" }}>REFRESH</Text>
                    </TVPressable>
                    <TVPressable onPress={onClearLogs} style={{ padding: 4 }}>
                      <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>CLOSE</Text>
                    </TVPressable>
                  </View>
                </View>
                <ScrollView style={{ maxHeight: 150 }} nestedScrollEnabled>
                  {logs.map((entry, i) => (
                    <Text key={i} style={{ color: "#737373", fontSize: 8, fontFamily: "monospace", lineHeight: 12 }}>
                      {entry.ts?.slice(11, 19) || "?"} {entry.msg}
                    </Text>
                  ))}
                  {logs.length === 0 && (
                    <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>
                      No logs yet
                    </Text>
                  )}
                  {urlEvents.length > 0 && (
                    <>
                      <Text style={{ color: "#F59E0B", fontSize: 9, fontFamily: "monospace", fontWeight: "bold", marginTop: 6 }}>
                        URL EVENTS ({urlEvents.length}):
                      </Text>
                      {urlEvents.map((u, i) => (
                        <Text key={`url-${i}`} style={{ color: "#F59E0B", fontSize: 8, fontFamily: "monospace", lineHeight: 12 }}>
                          {u}
                        </Text>
                      ))}
                    </>
                  )}
                </ScrollView>
              </View>
            )}

            {/* Close button */}
            <TVPressable
              onPress={onClose}
              style={{
                paddingVertical: 12,
                borderRadius: 8,
                backgroundColor: "#111",
                borderWidth: 1,
                borderColor: "#333",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <Text style={{ color: "#A3A3A3", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>
                CLOSE
              </Text>
            </TVPressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
