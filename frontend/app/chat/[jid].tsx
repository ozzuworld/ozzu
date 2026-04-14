import { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  withAlpha,
} from "../../lib/design-tokens";
import {
  fetchWhatsAppMessages,
  apiFetch,
  type WhatsAppMessage,
} from "../../lib/bridge-api";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDateHeader(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86_400_000 && d.getDate() === now.getDate()) return "Today";
  if (diff < 172_800_000) return "Yesterday";
  return d.toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" });
}

function MessageBubble({ msg, showDate }: { msg: WhatsAppMessage; showDate: string | null }) {
  const isMe = msg.is_from_me === 1;

  return (
    <View>
      {showDate && (
        <View style={{ alignItems: "center", paddingVertical: spacing.md }}>
          <Text
            style={{
              color: colors.text.disabled,
              fontSize: fontSize.xs,
              fontWeight: fontWeight.medium,
              backgroundColor: colors.bg.surface,
              paddingHorizontal: spacing.md,
              paddingVertical: 3,
              borderRadius: radius.full,
              overflow: "hidden",
            }}
          >
            {showDate}
          </Text>
        </View>
      )}
      <View
        style={{
          alignSelf: isMe ? "flex-end" : "flex-start",
          maxWidth: "78%",
          marginBottom: 3,
          paddingHorizontal: spacing.lg,
        }}
      >
        <View
          style={{
            backgroundColor: isMe ? withAlpha(colors.accent, 0.18) : colors.bg.elevated,
            borderRadius: radius.lg,
            borderTopRightRadius: isMe ? radius.xs : radius.lg,
            borderTopLeftRadius: isMe ? radius.lg : radius.xs,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
          }}
        >
          <Text
            style={{
              color: colors.text.primary,
              fontSize: fontSize.base,
              lineHeight: 20,
            }}
          >
            {msg.content || (msg.media_type ? `[${msg.media_type}]` : "[media]")}
          </Text>
          <Text
            style={{
              color: colors.text.disabled,
              fontSize: 9,
              alignSelf: "flex-end",
              marginTop: 2,
            }}
          >
            {formatTime(msg.timestamp)}
          </Text>
        </View>
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const { jid, name } = useLocalSearchParams<{ jid: string; name: string }>();
  const router = useRouter();
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const loadMessages = useCallback(async () => {
    if (!jid) return;
    try {
      const res = await fetchWhatsAppMessages(jid, 100);
      setMessages(res.messages);
    } catch (err) {
      console.warn("[chat] Load error:", err);
    } finally {
      setLoading(false);
    }
  }, [jid]);

  useEffect(() => {
    loadMessages();
    // Poll for new messages every 10s
    const interval = setInterval(loadMessages, 10000);
    return () => clearInterval(interval);
  }, [loadMessages]);

  const handleSend = useCallback(async () => {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      // Send via bridge REST endpoint (goes through approval gate)
      const res = await apiFetch("/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: jid.split("@")[0],
          message: reply.trim(),
        }),
      });
      if (res) {
        setReply("");
        // Refresh messages after short delay
        setTimeout(loadMessages, 1000);
      }
    } catch (err) {
      console.warn("[chat] Send error:", err);
    } finally {
      setSending(false);
    }
  }, [reply, jid, sending, loadMessages]);

  // Group messages by date for date headers
  const messagesWithDates = messages.map((msg, i) => {
    const prev = i > 0 ? messages[i - 1] : null;
    const msgDate = new Date(msg.timestamp).toDateString();
    const prevDate = prev ? new Date(prev.timestamp).toDateString() : null;
    return {
      ...msg,
      showDate: msgDate !== prevDate ? formatDateHeader(msg.timestamp) : null,
    };
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg.base }} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.subtle,
            gap: spacing.sm,
          }}
        >
          <Pressable
            onPress={() => router.back()}
            style={{ padding: spacing.xs }}
          >
            <Text style={{ color: colors.accent, fontSize: fontSize.xxl }}>
              {"<"}
            </Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text
              style={{
                color: colors.text.primary,
                fontSize: fontSize.xl,
                fontWeight: fontWeight.semibold,
              }}
              numberOfLines={1}
            >
              {name || jid?.split("@")[0] || "Chat"}
            </Text>
            <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs }}>
              WhatsApp
            </Text>
          </View>
        </View>

        {/* Messages */}
        {loading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messagesWithDates}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => (
              <MessageBubble msg={item} showDate={item.showDate} />
            )}
            contentContainerStyle={{ paddingVertical: spacing.sm }}
            onContentSizeChange={() => {
              flatListRef.current?.scrollToEnd({ animated: false });
            }}
            ListEmptyComponent={
              <View style={{ alignItems: "center", paddingTop: 80 }}>
                <Text style={{ color: colors.text.tertiary, fontSize: fontSize.lg }}>
                  No messages
                </Text>
              </View>
            }
          />
        )}

        {/* Reply bar */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-end",
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            borderTopWidth: 1,
            borderTopColor: colors.border.subtle,
            backgroundColor: colors.bg.elevated,
            gap: spacing.sm,
          }}
        >
          <TextInput
            style={{
              flex: 1,
              backgroundColor: colors.bg.surface,
              borderRadius: radius.xl,
              paddingHorizontal: spacing.lg,
              paddingVertical: Platform.OS === "ios" ? spacing.sm : spacing.xs,
              color: colors.text.primary,
              fontSize: fontSize.base,
              maxHeight: 100,
            }}
            placeholder="Message..."
            placeholderTextColor={colors.text.disabled}
            value={reply}
            onChangeText={setReply}
            multiline
          />
          {reply.trim() ? (
            <Pressable
              onPress={handleSend}
              disabled={sending}
              style={{
                backgroundColor: colors.accent,
                borderRadius: radius.full,
                width: 36,
                height: 36,
                alignItems: "center",
                justifyContent: "center",
                opacity: sending ? 0.5 : 1,
              }}
            >
              <Text style={{ color: "#fff", fontSize: fontSize.xl, fontWeight: fontWeight.bold }}>
                {sending ? "..." : "\u2191"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
