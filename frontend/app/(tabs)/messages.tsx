import { useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
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
  fetchWhatsAppChats,
  fetchWhatsAppStatus,
  type WhatsAppChat,
} from "../../lib/bridge-api";

function relativeTime(iso: string): string {
  const now = Date.now();
  const ts = new Date(iso).getTime();
  const diff = now - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
}

function avatarColor(name: string): string {
  const hues = ["#3B82F6", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981", "#06B6D4", "#EF4444"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return hues[Math.abs(hash) % hues.length];
}

function ChatRow({ chat, onPress }: { chat: WhatsAppChat; onPress: () => void }) {
  const color = avatarColor(chat.display_name);
  const initials = chat.display_name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  const isFromMe = chat.last_is_from_me === 1;
  const preview = chat.last_message
    ? chat.last_message.length > 60
      ? chat.last_message.slice(0, 60) + "..."
      : chat.last_message
    : "(media)";

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.85 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 10,
          paddingHorizontal: spacing.lg,
          gap: spacing.md,
        }}
      >
        {/* Avatar */}
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: withAlpha(color, 0.15),
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color, fontSize: fontSize.lg, fontWeight: fontWeight.semibold }}>
            {initials}
          </Text>
        </View>

        {/* Name + preview */}
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text
              style={{
                color: colors.text.primary,
                fontSize: fontSize.lg,
                fontWeight: fontWeight.medium,
                flex: 1,
              }}
              numberOfLines={1}
            >
              {chat.display_name}
            </Text>
            <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs, marginLeft: spacing.sm }}>
              {relativeTime(chat.last_message_time)}
            </Text>
          </View>
          <Text
            style={{
              color: isFromMe ? colors.text.tertiary : colors.text.secondary,
              fontSize: fontSize.md,
              marginTop: 2,
            }}
            numberOfLines={1}
          >
            {isFromMe ? "You: " : ""}{preview}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function MessagesScreen() {
  const router = useRouter();
  const [chats, setChats] = useState<WhatsAppChat[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(true);

  const loadChats = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [statusRes, chatsRes] = await Promise.all([
        fetchWhatsAppStatus(),
        fetchWhatsAppChats(50),
      ]);
      setConnected(statusRes.status === "connected" || statusRes.status === "android_agent");
      setChats(chatsRes.chats);
    } catch (err) {
      console.warn("[messages] Load error:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadChats();
    }, [loadChats])
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg.base }} edges={["top"]}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          borderBottomWidth: 1,
          borderBottomColor: colors.border.subtle,
        }}
      >
        <Text
          style={{
            color: colors.text.primary,
            fontSize: fontSize.xxl,
            fontWeight: fontWeight.semibold,
          }}
        >
          Messages
        </Text>
        {!connected && (
          <View
            style={{
              backgroundColor: withAlpha(colors.error, 0.12),
              paddingHorizontal: spacing.sm,
              paddingVertical: 2,
              borderRadius: radius.xs,
            }}
          >
            <Text style={{ color: colors.error, fontSize: fontSize.xs, fontWeight: fontWeight.medium }}>
              Disconnected
            </Text>
          </View>
        )}
      </View>

      {loading && chats.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.accent} />
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.md, marginTop: spacing.sm }}>
            Loading chats...
          </Text>
        </View>
      ) : (
        <FlatList
          data={chats}
          keyExtractor={(c) => c.jid}
          renderItem={({ item }) => (
            <ChatRow
              chat={item}
              onPress={() =>
                router.push({
                  pathname: "/chat/[jid]",
                  params: { jid: item.jid, name: item.display_name },
                })
              }
            />
          )}
          ItemSeparatorComponent={() => (
            <View
              style={{
                height: 1,
                backgroundColor: colors.border.subtle,
                marginLeft: 44 + spacing.lg + spacing.md,
              }}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadChats(true)}
              tintColor={colors.accent}
            />
          }
          contentContainerStyle={{ paddingBottom: 100 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", justifyContent: "center", paddingTop: 80 }}>
              <Text style={{ color: colors.text.tertiary, fontSize: fontSize.lg }}>
                No conversations yet
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}
