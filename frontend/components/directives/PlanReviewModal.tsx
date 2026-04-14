import { View, Text, Pressable, Modal, ScrollView, Platform } from "react-native";
import { MarkdownContent } from "../ContentPanel";
import { type Directive } from "../../lib/bridge-api";
import { TYPE_EMOJI } from "../../lib/directive-constants";

interface PlanReviewModalProps {
  visible: boolean;
  directive: Directive | null;
  onDismiss: () => void;
  onResolved?: () => void;
}

export function PlanReviewModal({
  visible,
  directive,
  onDismiss,
}: PlanReviewModalProps) {
  if (!directive) return null;

  const typeEmoji = TYPE_EMOJI[directive.type] || "";
  const planText = directive.plan || directive.description || "No plan details available.";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.85)",
          justifyContent: "flex-end",
          padding: 0,
        }}
        onPress={onDismiss}
      >
        <Pressable
          style={{
            backgroundColor: "#111111",
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: "85%",
            overflow: "hidden",
          }}
          onPress={() => {}}
        >
          {/* Drag handle */}
          <View style={{ alignItems: "center", paddingTop: 10, paddingBottom: 6 }}>
            <View style={{ width: 36, height: 4, backgroundColor: "#333", borderRadius: 2 }} />
          </View>

          {/* Header */}
          <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
            <Text style={{ color: "#E5E5E5", fontSize: 18, fontWeight: "700", marginBottom: 4 }}>
              {directive.emoji || typeEmoji} {directive.title}
            </Text>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <View style={{
                paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12,
                backgroundColor: directive.type === "feature" ? "#3B82F620" : "#22C55E20",
              }}>
                <Text style={{
                  color: directive.type === "feature" ? "#60A5FA" : "#4ADE80",
                  fontSize: 11, fontWeight: "600",
                }}>
                  {directive.type === "feature" ? "Feature" : "Quick Fix"}
                </Text>
              </View>
              {directive.createdBy ? (
                <Text style={{ color: "#737373", fontSize: 11 }}>by {directive.createdBy}</Text>
              ) : null}
            </View>
          </View>

          <View style={{ height: 1, backgroundColor: "#222" }} />

          {/* Plan content */}
          <ScrollView
            style={{ flex: 1, paddingHorizontal: 20, paddingVertical: 14 }}
            showsVerticalScrollIndicator
          >
            <MarkdownContent content={planText} />
            <View style={{ height: 20 }} />
          </ScrollView>

          {/* Close */}
          <View style={{
            borderTopWidth: 1,
            borderTopColor: "#222",
            padding: 16,
            paddingBottom: Platform.OS === "ios" ? 34 : 16,
            backgroundColor: "#0D0D0D",
          }}>
            <Pressable
              onPress={onDismiss}
              style={{
                paddingVertical: 14,
                borderRadius: 12,
                backgroundColor: "#1A1A1A",
                borderWidth: 1,
                borderColor: "#333",
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#A3A3A3", fontSize: 15, fontWeight: "600" }}>Close</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
