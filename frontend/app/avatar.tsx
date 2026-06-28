import { useState } from "react";
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
import { colors, fontSize, fontWeight, radius, spacing } from "../lib/design-tokens";
import { AvatarVideo } from "../components/AvatarVideo";
import { getBridgeUrl } from "../lib/bridge-api";

export default function AvatarScreen() {
  const [text, setText] = useState("");

  const handleSend = () => {
    if (!text.trim()) return;
    const url = getBridgeUrl() + "/avatar/speak";
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.trim() }),
    }).catch(() => {});
    setText("");
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.title}>June Avatar</Text>
        </View>

        <AvatarVideo active style={styles.video} />

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
    gap: spacing.lg,
  },
  header: {
    gap: spacing.xs,
  },
  title: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  video: {
    flex: 1,
    aspectRatio: undefined,
    borderRadius: radius.xl,
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
