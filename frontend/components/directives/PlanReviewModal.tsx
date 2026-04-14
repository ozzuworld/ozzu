import { View, Text, Pressable, Modal, ScrollView, Platform } from "react-native";
import { MarkdownContent } from "../ContentPanel";
import { type Directive } from "../../lib/bridge-api";
import { TYPE_EMOJI } from "../../lib/directive-constants";
import { colors, spacing, radius, fontSize, fontWeight, withAlpha } from "../../lib/design-tokens";

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
            backgroundColor: colors.bg.elevated,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            maxHeight: "85%",
            overflow: "hidden",
          }}
          onPress={() => {}}
        >
          {/* Drag handle */}
          <View style={{ alignItems: "center", paddingTop: 10, paddingBottom: 6 }}>
            <View style={{ width: 36, height: 4, backgroundColor: colors.border.strong, borderRadius: 2 }} />
          </View>

          {/* Header */}
          <View style={{ paddingHorizontal: spacing.xl, paddingBottom: spacing.md }}>
            <Text style={{ color: colors.text.primary, fontSize: fontSize.xxl, fontWeight: fontWeight.bold, marginBottom: 4 }}>
              {directive.emoji || typeEmoji} {directive.title}
            </Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
              <View style={{
                paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full,
                backgroundColor: directive.type === "feature" ? withAlpha("#3B82F6", 0.12) : withAlpha("#22C55E", 0.12),
              }}>
                <Text style={{
                  color: directive.type === "feature" ? "#60A5FA" : "#4ADE80",
                  fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
                }}>
                  {directive.type === "feature" ? "Feature" : "Quick Fix"}
                </Text>
              </View>
              {directive.createdBy ? (
                <Text style={{ color: colors.text.tertiary, fontSize: fontSize.sm }}>by {directive.createdBy}</Text>
              ) : null}
            </View>
          </View>

          <View style={{ height: 1, backgroundColor: colors.border.subtle }} />

          {/* Plan content */}
          <ScrollView
            style={{ flex: 1, paddingHorizontal: spacing.xl, paddingVertical: spacing.lg }}
            showsVerticalScrollIndicator
          >
            <MarkdownContent content={planText} />
            <View style={{ height: 20 }} />
          </ScrollView>

          {/* Close */}
          <View style={{
            borderTopWidth: 1,
            borderTopColor: colors.border.subtle,
            padding: spacing.lg,
            paddingBottom: Platform.OS === "ios" ? 34 : spacing.lg,
            backgroundColor: colors.bg.base,
          }}>
            <Pressable
              onPress={onDismiss}
              style={{
                paddingVertical: 14,
                borderRadius: radius.lg,
                backgroundColor: colors.bg.surface,
                borderWidth: 1,
                borderColor: colors.border.default,
                alignItems: "center",
              }}
            >
              <Text style={{ color: colors.text.secondary, fontSize: fontSize.lg, fontWeight: fontWeight.semibold }}>Close</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
