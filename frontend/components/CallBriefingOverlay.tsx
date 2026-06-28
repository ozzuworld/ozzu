import { useEffect, useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  Text,
  View,
  StyleSheet,
  Dimensions,
} from "react-native";
import {
  colors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  withAlpha,
} from "../lib/design-tokens";
import type { CallBriefing, Voicemail } from "../lib/useVoipCall";

const { width: SCREEN_W } = Dimensions.get("window");

// ── Briefing Card (incoming call screening) ──

interface BriefingProps {
  briefing: CallBriefing;
  onAccept: () => void;
  onDecline: () => void;
}

function BriefingCard({ briefing, onAccept, onDecline }: BriefingProps) {
  const pulse = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.3, duration: 1200, useNativeDriver: true }),
      ])
    ).start();
  }, [pulse]);

  const urgencyColor =
    briefing.urgency === "high"
      ? colors.error
      : briefing.urgency === "normal"
        ? colors.brand.amber
        : colors.text.tertiary;

  return (
    <View style={styles.card}>
      {/* Header: live indicator + title */}
      <View style={styles.header}>
        <Animated.View style={[styles.liveDot, { backgroundColor: colors.success, opacity: pulse }]} />
        <Text style={styles.liveText}>JUNE IS SCREENING</Text>
      </View>

      {/* Caller info */}
      <View style={styles.callerSection}>
        <Text style={styles.callerName}>{briefing.caller_name}</Text>
        {briefing.caller_number ? (
          <Text style={styles.callerNumber}>{briefing.caller_number}</Text>
        ) : null}
      </View>

      {/* Reason */}
      <View style={styles.reasonSection}>
        <View style={styles.reasonRow}>
          <Text style={styles.reasonLabel}>Wants to reach</Text>
          <Text style={styles.reasonValue}>{briefing.wants_to_reach || "Anyone"}</Text>
        </View>
        <View style={styles.reasonRow}>
          <Text style={styles.reasonLabel}>Reason</Text>
          <Text style={styles.reasonValue}>{briefing.reason}</Text>
        </View>
        <View style={styles.reasonRow}>
          <Text style={styles.reasonLabel}>Urgency</Text>
          <View style={[styles.urgencyPill, { backgroundColor: withAlpha(urgencyColor, 0.15) }]}>
            <View style={[styles.urgencyDot, { backgroundColor: urgencyColor }]} />
            <Text style={[styles.urgencyText, { color: urgencyColor }]}>
              {briefing.urgency?.toUpperCase() || "NORMAL"}
            </Text>
          </View>
        </View>
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [
            styles.actionBtn,
            styles.declineBtn,
            pressed && styles.btnPressed,
          ]}
          onPress={onDecline}
        >
          <Text style={styles.declineBtnText}>Decline</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.actionBtn,
            styles.acceptBtn,
            pressed && styles.btnPressed,
          ]}
          onPress={onAccept}
        >
          <Text style={styles.acceptBtnText}>Accept Call</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Voicemail Card ──

interface VoicemailProps {
  voicemail: Voicemail;
  onDismiss: () => void;
}

function VoicemailCard({ voicemail, onDismiss }: VoicemailProps) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={[styles.liveDot, { backgroundColor: colors.brand.purple }]} />
        <Text style={[styles.liveText, { color: colors.brand.purple }]}>MESSAGE RECEIVED</Text>
      </View>

      <View style={styles.callerSection}>
        <Text style={styles.callerName}>{voicemail.caller_name}</Text>
        {voicemail.caller_number ? (
          <Text style={styles.callerNumber}>{voicemail.caller_number}</Text>
        ) : null}
      </View>

      <View style={styles.messageSection}>
        <Text style={styles.messageText}>{voicemail.message}</Text>
        {voicemail.callback_requested && (
          <View style={styles.callbackPill}>
            <Text style={styles.callbackText}>Callback requested</Text>
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [
            styles.actionBtn,
            styles.dismissBtn,
            pressed && styles.btnPressed,
          ]}
          onPress={onDismiss}
        >
          <Text style={styles.dismissBtnText}>Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Overlay (rendered in _layout.tsx) ──

interface OverlayProps {
  briefing: CallBriefing | null;
  voicemail: Voicemail | null;
  onAccept: () => void;
  onDecline: () => void;
  onDismissVoicemail: () => void;
}

export function CallBriefingOverlay({
  briefing,
  voicemail,
  onAccept,
  onDecline,
  onDismissVoicemail,
}: OverlayProps) {
  const visible = briefing !== null || voicemail !== null;

  const slideAnim = useRef(new Animated.Value(300)).current;

  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }).start();
    } else {
      slideAnim.setValue(300);
    }
  }, [visible, slideAnim]);

  if (!visible) return null;

  return (
    <Modal transparent animationType="fade" visible>
      <View style={styles.backdrop}>
        <Animated.View style={[styles.slideContainer, { transform: [{ translateY: slideAnim }] }]}>
          {briefing ? (
            <BriefingCard briefing={briefing} onAccept={onAccept} onDecline={onDecline} />
          ) : voicemail ? (
            <VoicemailCard voicemail={voicemail} onDismiss={onDismissVoicemail} />
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
    paddingBottom: 40,
  },
  slideContainer: {
    marginHorizontal: spacing.lg,
  },
  card: {
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border.strong,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  liveText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.success,
    letterSpacing: 1.5,
  },

  callerSection: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  callerName: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  callerNumber: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.normal,
    color: colors.text.tertiary,
    marginTop: 2,
  },

  reasonSection: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  reasonRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  reasonLabel: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.normal,
    color: colors.text.tertiary,
  },
  reasonValue: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text.secondary,
    maxWidth: SCREEN_W * 0.55,
    textAlign: "right",
  },

  urgencyPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    gap: 5,
  },
  urgencyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  urgencyText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.5,
  },

  actions: {
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    paddingTop: spacing.xs,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.97 }],
  },
  acceptBtn: {
    backgroundColor: colors.success,
  },
  acceptBtnText: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: "#000",
  },
  declineBtn: {
    backgroundColor: withAlpha(colors.error, 0.15),
    borderWidth: 1,
    borderColor: withAlpha(colors.error, 0.3),
  },
  declineBtnText: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.error,
  },
  dismissBtn: {
    backgroundColor: colors.bg.surface,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  dismissBtnText: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.medium,
    color: colors.text.secondary,
  },

  messageSection: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  messageText: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.normal,
    color: colors.text.primary,
    lineHeight: 20,
  },
  callbackPill: {
    marginTop: spacing.sm,
    alignSelf: "flex-start",
    backgroundColor: withAlpha(colors.brand.amber, 0.12),
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  callbackText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: colors.brand.amber,
  },
});
