import { View, Text, Pressable, Modal } from "react-native";
import { updateDirective, type Directive } from "../../lib/bridge-api";
import {
  STATUS_EMOJI,
  STATUS_COLORS,
  VALID_TRANSITIONS,
  TRANSITION_LABELS,
  HUMAN_STATUS,
} from "../../lib/directive-constants";
import { colors, spacing, radius, fontSize, fontWeight, withAlpha, statusPillStyle } from "../../lib/design-tokens";

interface StatusChangeSheetProps {
  visible: boolean;
  directive: Directive | null;
  onDismiss: () => void;
  onStatusChanged: () => void;
}

export function StatusChangeSheet({ visible, directive, onDismiss, onStatusChanged }: StatusChangeSheetProps) {
  if (!directive) return null;

  const transitions = VALID_TRANSITIONS[directive.status] || [];
  const currentPill = statusPillStyle(directive.status);

  const handleChange = async (newStatus: string) => {
    try {
      await updateDirective(directive.id, { status: newStatus, actor: "King Kazuma" });
      onStatusChanged();
      onDismiss();
    } catch (err: any) {
      // Alert handled by caller
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.8)",
          justifyContent: "flex-end",
        }}
        onPress={onDismiss}
      >
        <Pressable
          style={{
            backgroundColor: colors.bg.elevated,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            borderWidth: 1,
            borderColor: colors.border.default,
            padding: spacing.xl,
            paddingBottom: 40,
          }}
          onPress={() => {}}
        >
          <Text style={{ color: colors.text.primary, fontSize: fontSize.lg, fontWeight: fontWeight.semibold, marginBottom: spacing.xs }}>
            Change Status
          </Text>

          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.lg, paddingVertical: spacing.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: currentPill.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: currentPill.dot }} />
              <Text style={{ color: currentPill.text, fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>
                {HUMAN_STATUS[directive.status] || directive.status}
              </Text>
            </View>
          </View>

          <View style={{ height: 1, backgroundColor: colors.border.subtle, marginBottom: spacing.md }} />

          {transitions.map((status) => {
            const pill = statusPillStyle(status);
            const label = TRANSITION_LABELS[status] || `${STATUS_EMOJI[status] || ""} ${HUMAN_STATUS[status] || status}`;
            return (
              <Pressable
                key={status}
                onPress={() => handleChange(status)}
                style={({ pressed }) => ({
                  paddingVertical: spacing.md,
                  paddingHorizontal: spacing.lg,
                  borderRadius: radius.md,
                  marginBottom: spacing.sm,
                  backgroundColor: pressed ? withAlpha(pill.text, 0.15) : withAlpha(pill.text, 0.08),
                })}
              >
                <Text style={{ color: pill.text, fontSize: fontSize.base, fontWeight: fontWeight.semibold }}>
                  {label}
                </Text>
              </Pressable>
            );
          })}

          <Pressable
            onPress={onDismiss}
            style={{
              paddingVertical: spacing.md,
              alignItems: "center",
              marginTop: spacing.sm,
              borderRadius: radius.md,
              backgroundColor: colors.bg.surface,
            }}
          >
            <Text style={{ color: colors.text.tertiary, fontSize: fontSize.base, fontWeight: fontWeight.semibold }}>
              Dismiss
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
