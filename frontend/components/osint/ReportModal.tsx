import { View, Text, Modal, Pressable, ScrollView, Share, ActivityIndicator, TouchableWithoutFeedback } from "react-native";

interface Props {
  visible: boolean;
  onClose: () => void;
  report: { markdown: string } | null;
  loading: boolean;
}

export function ReportModal({ visible, onClose, report, loading }: Props) {
  const handleShare = async () => {
    if (!report?.markdown) return;
    try {
      await Share.share({
        message: report.markdown,
        title: "OSINT Report",
      });
    } catch (_) {
      // User cancelled share
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.9)", justifyContent: "center", alignItems: "center" }}>
          <TouchableWithoutFeedback>
            <View style={{ width: "92%", maxHeight: "85%", backgroundColor: "#111111", borderRadius: 12, borderWidth: 1, borderColor: "#333" }}>
              {/* Header */}
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "#222" }}>
                <Text style={{ color: "#06B6D4", fontSize: 13, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>
                  OSINT REPORT
                </Text>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <Pressable onPress={handleShare} disabled={!report}>
                    <Text style={{ color: report ? "#22C55E" : "#525252", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>SHARE</Text>
                  </Pressable>
                  <Pressable onPress={onClose}>
                    <Text style={{ color: "#525252", fontSize: 16, fontFamily: "monospace" }}>X</Text>
                  </Pressable>
                </View>
              </View>

              {/* Content */}
              <ScrollView style={{ flex: 1, padding: 16 }} contentContainerStyle={{ paddingBottom: 20 }}>
                {loading && (
                  <View style={{ padding: 40, alignItems: "center" }}>
                    <ActivityIndicator color="#06B6D4" />
                    <Text style={{ color: "#737373", fontSize: 11, fontFamily: "monospace", marginTop: 8 }}>Generating report...</Text>
                  </View>
                )}
                {!loading && report && (
                  <MarkdownRenderer markdown={report.markdown} />
                )}
                {!loading && !report && (
                  <View style={{ padding: 40, alignItems: "center" }}>
                    <Text style={{ color: "#525252", fontSize: 12, fontFamily: "monospace" }}>No report data available.</Text>
                  </View>
                )}
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

// Simple markdown renderer for monospace report display
function MarkdownRenderer({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");

  return (
    <View style={{ gap: 2 }}>
      {lines.map((line, i) => {
        // H1
        if (line.startsWith("# ")) {
          return <Text key={i} style={{ color: "#06B6D4", fontSize: 16, fontFamily: "monospace", fontWeight: "bold", marginTop: 8, marginBottom: 4 }}>{line.replace("# ", "")}</Text>;
        }
        // H2
        if (line.startsWith("## ")) {
          return <Text key={i} style={{ color: "#A855F7", fontSize: 14, fontFamily: "monospace", fontWeight: "bold", marginTop: 12, marginBottom: 4 }}>{line.replace("## ", "")}</Text>;
        }
        // H3
        if (line.startsWith("### ")) {
          return <Text key={i} style={{ color: "#F59E0B", fontSize: 12, fontFamily: "monospace", fontWeight: "bold", marginTop: 8, marginBottom: 2 }}>{line.replace("### ", "")}</Text>;
        }
        // Table header
        if (line.startsWith("|") && line.includes("---|")) {
          return null; // Skip separator rows
        }
        // Table row
        if (line.startsWith("|")) {
          const cells = line.split("|").filter((c) => c.trim());
          return (
            <View key={i} style={{ flexDirection: "row", gap: 8, paddingVertical: 2 }}>
              {cells.map((cell, ci) => (
                <Text key={ci} style={{
                  color: ci === 0 ? "#737373" : "#E5E5E5",
                  fontSize: 11,
                  fontFamily: "monospace",
                  flex: ci === 0 ? 2 : 1,
                  fontWeight: cell.includes("**") ? "bold" : "normal",
                }}>
                  {cell.trim().replace(/\*\*/g, "")}
                </Text>
              ))}
            </View>
          );
        }
        // Blockquote
        if (line.startsWith("> ")) {
          const isAlert = line.includes("CRITICAL") || line.includes("HIGH");
          return (
            <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: isAlert ? "#EF4444" : "#3B82F6", paddingLeft: 10, paddingVertical: 4, marginVertical: 4, backgroundColor: isAlert ? "#1A0A0A" : "#0A0A1A" }}>
              <Text style={{ color: isAlert ? "#F87171" : "#93C5FD", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                {line.replace("> ", "").replace(/\*\*/g, "")}
              </Text>
            </View>
          );
        }
        // Checklist item
        if (line.startsWith("- [ ] ")) {
          return (
            <View key={i} style={{ flexDirection: "row", gap: 6, paddingVertical: 2, paddingLeft: 4 }}>
              <Text style={{ color: "#525252", fontSize: 11 }}>☐</Text>
              <Text style={{ color: "#E5E5E5", fontSize: 11, fontFamily: "monospace", flex: 1 }}>{line.replace("- [ ] ", "")}</Text>
            </View>
          );
        }
        // List item with severity emoji
        if (line.startsWith("- ")) {
          const content = line.replace("- ", "");
          const hasBold = content.includes("**");
          return (
            <Text key={i} style={{ color: hasBold ? "#E5E5E5" : "#A3A3A3", fontSize: 11, fontFamily: "monospace", paddingLeft: 4, paddingVertical: 1 }}>
              {"  "}{content.replace(/\*\*/g, "")}
            </Text>
          );
        }
        // Italic (date lines)
        if (line.startsWith("*") && line.endsWith("*")) {
          return <Text key={i} style={{ color: "#525252", fontSize: 10, fontFamily: "monospace", fontStyle: "italic" }}>{line.replace(/\*/g, "")}</Text>;
        }
        // HR
        if (line === "---") {
          return <View key={i} style={{ height: 1, backgroundColor: "#333", marginVertical: 8 }} />;
        }
        // Empty line
        if (line.trim() === "") {
          return <View key={i} style={{ height: 4 }} />;
        }
        // Regular text
        return <Text key={i} style={{ color: "#A3A3A3", fontSize: 11, fontFamily: "monospace" }}>{line}</Text>;
      })}
    </View>
  );
}
