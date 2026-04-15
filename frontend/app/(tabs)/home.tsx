import { useCallback, useState } from "react";
import {
  View,
  Text,
  Image,
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ozzuLogo = require("../../assets/ozzu-logo.png");

// ── Live stats ──

function useHomeStats() {
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
    directiveCount: active,
    attentionCount: needsAttention,
    ventureCount: activeVentures,
    statusText: needsAttention > 0
      ? `${needsAttention} need attention`
      : `${active} active, all clear`,
  };
}

// ── Greeting ──

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ── Component ──

export default function HomeScreen() {
  const router = useRouter();
  const { insets, screenWidth } = usePhoneLayout();
  const stats = useHomeStats();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  const SIDE = 20;
  const logoSize = screenWidth * 0.58;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <StatusBar style="light" />

      {/* Ambient glow behind logo area */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
        <View style={{
          position: "absolute",
          top: screenWidth * 0.08,
          left: screenWidth * 0.1,
          width: screenWidth * 0.8,
          height: screenWidth * 0.8,
          borderRadius: screenWidth * 0.4,
          backgroundColor: withAlpha("#1a1a2e", 0.9),
        }} />
        <View style={{
          position: "absolute",
          top: screenWidth * 0.18,
          left: screenWidth * 0.2,
          width: screenWidth * 0.6,
          height: screenWidth * 0.6,
          borderRadius: screenWidth * 0.3,
          backgroundColor: withAlpha("#1e1f30", 0.6),
        }} />
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 40,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.tertiary} />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* ── Top bar ── */}
        <View style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: SIDE,
          marginBottom: 8,
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{
              color: colors.text.primary,
              fontSize: fs.xl,
              fontWeight: fw.semibold,
              letterSpacing: -0.3,
            }}>
              {getGreeting()}
            </Text>
            <Text style={{
              color: colors.text.disabled,
              fontSize: fs.md,
              marginTop: 2,
            }}>
              {"▾"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>
            <Pressable onPress={() => router.push("/messages" as any)}>
              <Text style={{ fontSize: 20, opacity: 0.5 }}>{"🔔"}</Text>
              {stats.attentionCount > 0 && (
                <View style={{
                  position: "absolute", top: -2, right: -4,
                  width: 8, height: 8, borderRadius: 4,
                  backgroundColor: colors.error,
                }} />
              )}
            </Pressable>
            <Pressable onPress={() => router.push("/ops" as any)}>
              <Text style={{ fontSize: 18, opacity: 0.4 }}>{"⋮"}</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Hero logo ── */}
        <View style={{
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: screenWidth * 0.06,
          minHeight: screenWidth * 0.75,
        }}>
          <View style={{
            width: logoSize,
            height: logoSize,
            borderRadius: logoSize / 2,
            backgroundColor: withAlpha("#ffffff", 0.04),
            alignItems: "center",
            justifyContent: "center",
          }}>
            <Image
              source={ozzuLogo}
              style={{
                width: logoSize * 0.82,
                height: logoSize * 0.82,
                borderRadius: (logoSize * 0.82) / 2,
              }}
              resizeMode="contain"
            />
          </View>
        </View>

        {/* ── Name + Status row ── */}
        <View style={{
          paddingHorizontal: SIDE,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 6,
        }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{
                color: colors.text.primary,
                fontSize: 26,
                fontWeight: fw.bold,
                letterSpacing: -0.5,
              }}>
                Ozzu
              </Text>
              <Text style={{ fontSize: 14, opacity: 0.3 }}>{"✎"}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
              <View style={{
                width: 7, height: 7, borderRadius: 4,
                backgroundColor: stats.attentionCount > 0 ? colors.warning : colors.success,
              }} />
              <Text style={{
                color: colors.text.secondary,
                fontSize: fs.md,
                fontWeight: fw.normal,
              }}>
                {stats.statusText}
              </Text>
            </View>
          </View>

          {/* GO button — navigates to directives */}
          <Pressable
            onPress={() => router.push("/directives" as any)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: withAlpha(colors.text.primary, pressed ? 0.15 : 0.08),
              paddingHorizontal: 18,
              paddingVertical: 10,
              borderRadius: radius.full,
              gap: 4,
              marginTop: 4,
            })}
          >
            <Text style={{
              color: colors.text.primary,
              fontSize: fs.lg,
              fontWeight: fw.semibold,
            }}>
              GO
            </Text>
            <Text style={{
              color: colors.text.secondary,
              fontSize: fs.md,
            }}>
              {">"}
            </Text>
          </Pressable>
        </View>

        {/* ── Action cards ── */}
        <View style={{
          flexDirection: "row",
          paddingHorizontal: SIDE,
          gap: 12,
          marginTop: 20,
        }}>
          {/* Directives card */}
          <Pressable
            onPress={() => router.push("/directives" as any)}
            style={({ pressed }) => ({
              flex: 1,
              backgroundColor: withAlpha(colors.bg.surface, 0.8),
              borderRadius: radius.xl,
              padding: 18,
              paddingBottom: 20,
              justifyContent: "space-between",
              minHeight: 100,
              borderWidth: 1,
              borderColor: withAlpha(colors.border.default, 0.5),
              transform: [{ scale: pressed ? 0.97 : 1 }],
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ fontSize: 22, marginBottom: 16 }}>{"▶"}</Text>
            <Text style={{
              color: colors.text.primary,
              fontSize: fs.lg,
              fontWeight: fw.medium,
            }}>
              Directives
            </Text>
            {stats.directiveCount > 0 && (
              <Text style={{
                color: colors.text.tertiary,
                fontSize: fs.xs,
                marginTop: 3,
              }}>
                {stats.directiveCount} active
              </Text>
            )}
          </Pressable>

          {/* Messages card */}
          <Pressable
            onPress={() => router.push("/messages" as any)}
            style={({ pressed }) => ({
              flex: 1,
              backgroundColor: withAlpha(colors.bg.surface, 0.8),
              borderRadius: radius.xl,
              padding: 18,
              paddingBottom: 20,
              justifyContent: "space-between",
              minHeight: 100,
              borderWidth: 1,
              borderColor: withAlpha(colors.border.default, 0.5),
              transform: [{ scale: pressed ? 0.97 : 1 }],
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ fontSize: 22, marginBottom: 16 }}>{"⌂"}</Text>
            <Text style={{
              color: colors.text.primary,
              fontSize: fs.lg,
              fontWeight: fw.medium,
            }}>
              Messages
            </Text>
          </Pressable>
        </View>

        {/* ── Page dots ── */}
        <View style={{
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          gap: 6,
          marginTop: 20,
          marginBottom: 24,
        }}>
          <View style={{
            width: 20, height: 5, borderRadius: 3,
            backgroundColor: withAlpha(colors.text.primary, 0.4),
          }} />
          <View style={{
            width: 5, height: 5, borderRadius: 3,
            backgroundColor: withAlpha(colors.text.primary, 0.12),
          }} />
        </View>

        {/* ── Quick access grid ── */}
        <View style={{ paddingHorizontal: SIDE }}>
          {[
            [
              { id: "ventures", icon: "🚀", label: "Ventures", route: "/business", stat: stats.ventureCount > 0 ? `${stats.ventureCount} active` : "" },
              { id: "finance", icon: "💰", label: "Finance", route: "/finance", stat: "" },
            ],
            [
              { id: "intel", icon: "🕵️", label: "Intel", route: "/osint", stat: "" },
              { id: "influence", icon: "🔗", label: "Influence", route: "/influence", stat: "" },
            ],
            [
              { id: "ops", icon: "🖥️", label: "Ops", route: "/ops", stat: "" },
              { id: "files", icon: "📦", label: "Files", route: "/files", stat: "" },
            ],
            [
              { id: "identity", icon: "🪪", label: "Identity", route: "/identity", stat: "" },
              { id: "music", icon: "🎵", label: "Music", route: "/music", stat: "" },
            ],
          ].map((row, ri) => (
            <View key={ri} style={{ flexDirection: "row", gap: 12, marginBottom: 12 }}>
              {row.map((tile) => (
                <Pressable
                  key={tile.id}
                  onPress={() => router.push(tile.route as any)}
                  style={({ pressed }) => ({
                    flex: 1,
                    height: 72,
                    backgroundColor: withAlpha(colors.bg.surface, 0.6),
                    borderRadius: radius.lg,
                    padding: 14,
                    justifyContent: "space-between",
                    borderWidth: 1,
                    borderColor: withAlpha(colors.border.default, 0.3),
                    transform: [{ scale: pressed ? 0.96 : 1 }],
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <Text style={{ fontSize: 18 }}>{tile.icon}</Text>
                  <Text style={{
                    color: colors.text.secondary,
                    fontSize: fs.sm,
                    fontWeight: fw.medium,
                  }}>
                    {tile.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>

      {/* ── Bottom tab bar (mimics Dreame) ── */}
      <View style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        paddingBottom: insets.bottom + 4,
        paddingTop: 10,
        backgroundColor: withAlpha(colors.bg.base, 0.95),
        borderTopWidth: 1,
        borderTopColor: withAlpha(colors.border.subtle, 0.5),
        flexDirection: "row",
        justifyContent: "space-around",
        alignItems: "center",
      }}>
        {[
          { icon: "⌂", label: "Home", route: null, active: true },
          { icon: "⊞", label: "Modules", route: "/directives" },
          { icon: "◎", label: "Cipher", route: "/cipher" },
          { icon: "◫", label: "Intel", route: "/osint" },
          { icon: "◉", label: "Me", route: "/identity" },
        ].map((tab, i) => (
          <Pressable
            key={i}
            onPress={() => tab.route ? router.push(tab.route as any) : null}
            style={{ alignItems: "center", paddingHorizontal: 12, paddingVertical: 4 }}
          >
            <Text style={{
              fontSize: 20,
              color: tab.active ? "#c9a84c" : colors.text.disabled,
              marginBottom: 3,
            }}>
              {tab.icon}
            </Text>
            <Text style={{
              fontSize: 9,
              fontWeight: tab.active ? fw.semibold : fw.normal,
              color: tab.active ? "#c9a84c" : colors.text.disabled,
              letterSpacing: 0.3,
            }}>
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
