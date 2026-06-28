import { useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  colors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  withAlpha,
} from "../lib/design-tokens";
import { JuneAvatarLive2D } from "../components/JuneAvatarLive2D";
import { getBridgeUrl } from "../lib/bridge-api";

export default function AvatarScreen() {
  const [text, setText] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSend = () => {
    if (!text.trim()) return;
    const msg = text.trim();
    setText("");

    setSpeaking(true);
    if (speakTimer.current) clearTimeout(speakTimer.current);
    // Approximate speaking duration: ~80ms per character
    const duration = Math.max(1500, Math.min(msg.length * 80, 8000));
    speakTimer.current = setTimeout(() => setSpeaking(false), duration);

    const url = getBridgeUrl() + "/avatar/speak";
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg }),
    }).catch(() => {});
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.title}>June</Text>
          <Text style={styles.subtitle}>
            {speaking ? "Speaking..." : "Listening"}
          </Text>
        </View>

        <View style={styles.avatarWrap}>
          <JuneAvatarLive2D speaking={speaking} />
        </View>

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Type something for June to say..."
            placeholderTextColor={colors.text.disabled}
            onSubmitEditing={handleSend}
            returnKeyType="send"
          />
          <Pressable
            style={({ pressed }) => [
              styles.sendBtn,
              pressed && { opacity: 0.7, transform: [{ scale: 0.95 }] },
              !text.trim() && { opacity: 0.4 },
            ]}
            onPress={handleSend}
            disabled={!text.trim()}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg.base,
  },
  container: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.md,
  },
  header: {
    alignItems: "center",
    gap: 2,
  },
  title: {
    fontSize: 28,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  subtitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text.tertiary,
  },
  avatarWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  inputRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border.default,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: fontSize.base,
    color: colors.text.primary,
  },
  sendBtn: {
    backgroundColor: colors.brand.cyan,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    justifyContent: "center",
    alignItems: "center",
  },
  sendText: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.bg.base,
  },
});
