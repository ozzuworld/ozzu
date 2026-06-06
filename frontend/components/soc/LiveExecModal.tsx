// LiveExecModal — full-screen modal showing the streaming output of one
// running queue item. Terminal-style scrollback, copy-to-clipboard,
// swipe-down dismiss via Modal's animationType="slide".

import { useEffect, useRef } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  colors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  withAlpha,
} from "../../lib/design-tokens";
import type { RunningItem } from "./LiveExecBanner";

interface LiveExecModalProps {
  visible: boolean;
  item: RunningItem | null;
  onClose: () => void;
  onCancel?: () => void;
}

export function LiveExecModal({ visible, item, onClose, onCancel }: LiveExecModalProps) {
  const scrollRef = useRef<ScrollView | null>(null);

  // Auto-stick-to-bottom while output streams in.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
    return () => clearTimeout(t);
  }, [visible, item?.output]);

  if (!item) return null;

  const copyAll = async () => {
    try {
      await Share.share({ message: item.output || "" });
    } catch { /* ignore */ }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.md,
            backgroundColor: colors.bg.elevated,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.subtle,
          }}
        >
          <Pressable onPress={onClose} hitSlop={12} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <Text style={{ color: colors.accent, fontSize: fontSize.lg }}>✕</Text>
          </Pressable>
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text
              style={{ color: colors.text.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}
              numberOfLines={1}
            >
              #{item.seq} {item.title}
            </Text>
            <Text style={{ color: colors.success, fontSize: fontSize.xs, marginTop: 2 }}>● running</Text>
          </View>
          <Pressable onPress={copyAll} hitSlop={8} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
            <Text style={{ color: colors.accent, fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
              share
            </Text>
          </Pressable>
        </View>

        {/* Output */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: spacing.md }}
        >
          <Text
            selectable
            style={{
              color: colors.text.secondary,
              fontFamily: "monospace",
              fontSize: fontSize.xs,
              lineHeight: 16,
            }}
          >
            {item.output || "(no output yet)"}
          </Text>
        </ScrollView>

        {/* Cancel action */}
        {onCancel ? (
          <Pressable
            onPress={onCancel}
            style={({ pressed }) => [
              styles.cancelBtn,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={{ color: colors.error, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>
              Cancel step
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  cancelBtn: {
    margin: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: withAlpha(colors.error, 0.18),
    alignItems: "center",
  },
});
