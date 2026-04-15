import { useCallback, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { useDirectives } from "../../lib/directive-hooks";
import { useBusiness } from "../../lib/business-hooks";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../lib/design-tokens";

// ── Tile config ──

type TileSize = "large" | "medium";

interface TileConfig {
  id: string;
  icon: string;
  label: string;
  route: string;
  tint: string;
  size: TileSize;
}

const TILES: TileConfig[] = [
  { id: "directives", icon: "📋", label: "Directives", route: "/directives", tint: "#5e6ad2", size: "large" },
  { id: "messages", icon: "💬", label: "Messages", route: "/messages", tint: "#06b6d4", size: "large" },
  { id: "ventures", icon: "🚀", label: "Ventures", route: "/business", tint: "#f59e0b", size: "medium" },
  { id: "finance", icon: "💰", label: "Finance", route: "/finance", tint: "#22c55e", size: "medium" },
  { id: "intel", icon: "🕵️", label: "Intel", route: "/osint", tint: "#a855f7", size: "medium" },
  { id: "influence", icon: "🔗", label: "Influence", route: "/influence", tint: "#ec4899", size: "medium" },
  { id: "ops", icon: "🖥️", label: "Ops", route: "/ops", tint: "#3b82f6", size: "medium" },
  { id: "files", icon: "📦", label: "Files", route: "/files", tint: "#6366f1", size: "medium" },
  { id: "identity", icon: "🪪", label: "Identity", route: "/identity", tint: "#14b8a6", size: "medium" },
  { id: "music", icon: "🎵", label: "Music", route: "/music", tint: "#f43f5e", size: "medium" },
];

// ── Live stats ──

function useTileStats() {
  const { directives } = useDirectives();
  const { projects } = useBusiness();

  const active = directives.filter((d: any) =>
    ["in_progress", "planning", "planned", "approved", "pending"].includes(d.status)
  ).length;
  const needsAttention = directives.filter((d: any) =>
    ["blocked", "deploy_failed", "failed"].includes(d.status)
  ).length;
  const activeVentures = (projects || []).filter((p: any) => p.status === "active").length;

  return {
    directives: needsAttention > 0 ? `${needsAttention} need attention` : `${active} active`,
    ventures: activeVentures > 0 ? `${activeVentures} active` : "",
  } as Record<string, string>;
}

// ── Greeting ──

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ── Tile renderer ──

function Tile({ tile, height, stat, onPress, flex }: {
  tile: TileConfig; width?: number; height: number; stat: string; onPress: () => void; flex?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: flex || undefined,
        height,
        borderRadius: radius.xl,
        overflow: "hidden",
        transform: [{ scale: pressed ? 0.97 : 1 }],
        opacity: pressed ? 0.88 : 1,
      })}
    >
      {/* Colored glow — top-left corner */}
      <View style={{
        position: "absolute", top: -20, left: -20, width: 120, height: 120, borderRadius: 60,
        backgroundColor: withAlpha(tile.tint, 0.12),
      }} />

      {/* Glass card */}
      <View style={{
        flex: 1,
        backgroundColor: withAlpha(colors.bg.surface, 0.7),
        borderWidth: 1,
        borderColor: withAlpha(tile.tint, 0.15),
        borderRadius: radius.xl,
        padding: spacing.lg,
        justifyContent: "space-between",
      }}>
        <Text style={{ fontSize: height > 120 ? 30 : 24 }}>
          {tile.icon}
        </Text>
        <View>
          <Text style={{
            color: colors.text.primary,
            fontSize: height > 120 ? fs.xl : fs.lg,
            fontWeight: fw.semibold,
            marginBottom: stat ? 3 : 0,
          }}>
            {tile.label}
          </Text>
          {stat ? (
            <Text style={{
              color: tile.tint,
              fontSize: fs.xs,
              fontWeight: fw.medium,
              opacity: 0.9,
            }}>
              {stat}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

// ── Component ──

export default function HomeScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();
  const stats = useTileStats();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  const GAP = spacing.md;
  const SIDE_PAD = spacing.lg;

  // Split tiles: large ones go full-width, medium ones pair up in rows
  const largeTiles = TILES.filter(t => t.size === "large");
  const mediumTiles = TILES.filter(t => t.size === "medium");
  const mediumRows: TileConfig[][] = [];
  for (let i = 0; i < mediumTiles.length; i += 2) {
    mediumRows.push(mediumTiles.slice(i, i + 2));
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <StatusBar style="light" />

      {/* Ambient blobs */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
        <View style={{
          position: "absolute", top: -100, left: -80, width: 360, height: 360, borderRadius: 180,
          backgroundColor: withAlpha("#5e6ad2", 0.07),
        }} />
        <View style={{
          position: "absolute", top: 280, right: -100, width: 320, height: 320, borderRadius: 160,
          backgroundColor: withAlpha("#a855f7", 0.05),
        }} />
        <View style={{
          position: "absolute", bottom: -60, left: 20, width: 280, height: 280, borderRadius: 140,
          backgroundColor: withAlpha("#06b6d4", 0.04),
        }} />
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + spacing.xl,
          paddingHorizontal: SIDE_PAD,
          paddingBottom: insets.bottom + 40,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.tertiary} />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={{ marginBottom: spacing.xxl + spacing.sm }}>
          <Text style={{
            color: colors.text.tertiary,
            fontSize: fs.base,
            fontWeight: fw.medium,
            marginBottom: spacing.xs,
          }}>
            {getGreeting()}, Kazuma
          </Text>
          <Text style={{
            color: colors.text.primary,
            fontSize: 28,
            fontWeight: fw.bold,
            letterSpacing: -0.5,
          }}>
            Ozzu
          </Text>
        </View>

        {/* Large tiles — full width */}
        {largeTiles.map((tile) => (
          <View key={tile.id} style={{ marginBottom: GAP }}>
            <Tile
              tile={tile}
              width={undefined as any}
              height={130}
              stat={stats[tile.id] || ""}
              onPress={() => router.push(tile.route as any)}
              flex={1}
            />
          </View>
        ))}

        {/* Medium tiles — 2-column grid */}
        {mediumRows.map((row, i) => (
          <View key={i} style={{ flexDirection: "row", gap: GAP, marginBottom: GAP }}>
            {row.map((tile) => (
              <View key={tile.id} style={{ flex: 1 }}>
                <Tile
                  tile={tile}
                  height={115}
                  stat={stats[tile.id] || ""}
                  onPress={() => router.push(tile.route as any)}
                />
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
