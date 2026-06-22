import { useCallback, useState } from "react";
import {
  View,
  Text,
  Image,
  ScrollView,
  Pressable,
  RefreshControl,
  Dimensions,
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

// Surface colors — high contrast against #0a0a0a base
const CARD_BG = "#252729";
const CARD_BORDER = "#3a3c40";
const TILE_BG = "#252729";
const TILE_BORDER = "#3a3c40";
const GO_BG = "#3a3c40";
const ICON_BOX_BG = "#37393d";

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
  const dims = Dimensions.get("window");
  const W = Math.min(dims.width, dims.height);
  const logoSize = W * 0.42;
  const gridGap = 10;
  const cardWidth = (W - SIDE * 2 - gridGap) / 2;
  const tileSize = cardWidth;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <StatusBar style="light" />

      {/* ── BUILD TRACER (dir_1782156946277) — diagnostic, remove after confirming deploy reaches device ── */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: insets.top,
          left: 0,
          right: 0,
          zIndex: 9999,
          backgroundColor: colors.accent,
          paddingVertical: 16,
          paddingHorizontal: 16,
          alignItems: "center",
          borderBottomWidth: 3,
          borderBottomColor: colors.bg.base,
        }}
      >
        <Text style={{ color: colors.bg.base, fontSize: 24, fontWeight: "800", letterSpacing: 1 }}>
          🟢 NEW BUILD LIVE — TRACER #1
        </Text>
        <Text style={{ color: colors.bg.base, fontSize: 13, fontWeight: "600", marginTop: 4 }}>
          If you can read this, new code reached your phone.
        </Text>
      </View>

      {/* Ambient glow behind logo */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
        <View style={{
          position: "absolute",
          top: -W * 0.1,
          left: -W * 0.1,
          width: W * 1.2,
          height: W * 0.85,
          borderRadius: W * 0.42,
          backgroundColor: withAlpha("#1a1520", 0.9),
        }} />
        <View style={{
          position: "absolute",
          top: W * 0.02,
          left: W * 0.12,
          width: W * 0.76,
          height: W * 0.6,
          borderRadius: W * 0.3,
          backgroundColor: withAlpha("#1e1828", 0.55),
        }} />
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 80,
          width: W,
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
          marginBottom: 4,
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
            <Pressable
              onPress={() => router.push("/directives" as any)}
              style={({ pressed }) => ({ opacity: pressed ? 0.4 : 1 })}
            >
              <Text style={{ fontSize: 20, opacity: 0.5 }}>{"🔔"}</Text>
              {stats.attentionCount > 0 && (
                <View style={{
                  position: "absolute", top: -2, right: -4,
                  width: 8, height: 8, borderRadius: 4,
                  backgroundColor: colors.error,
                }} />
              )}
            </Pressable>
            <Pressable
              onPress={() => router.push("/upload" as any)}
              style={({ pressed }) => ({ opacity: pressed ? 0.4 : 1 })}
            >
              <Text style={{ fontSize: 19, opacity: 0.55 }}>{"📤"}</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Hero logo ── */}
        <View style={{
          alignItems: "center",
          justifyContent: "center",
          paddingVertical: W * 0.03,
          minHeight: W * 0.46,
        }}>
          <Image
            source={ozzuLogo}
            style={{
              width: logoSize,
              height: logoSize,
              borderRadius: logoSize / 2,
            }}
            resizeMode="contain"
          />
        </View>

        {/* ── Name + Status row ── */}
        <View style={{
          paddingHorizontal: SIDE,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{
                color: colors.text.primary,
                fontSize: 22,
                fontWeight: fw.bold,
                letterSpacing: -0.4,
              }}>
                Ozzu
              </Text>
              <Text style={{ fontSize: 11, color: colors.text.disabled }}>{"✎"}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 }}>
              <View style={{
                width: 6, height: 6, borderRadius: 3,
                backgroundColor: stats.attentionCount > 0 ? colors.warning : colors.success,
              }} />
              <Text style={{
                color: colors.text.secondary,
                fontSize: fs.md,
              }}>
                {stats.statusText}
              </Text>
            </View>
          </View>

          {/* GO pill */}
          <Pressable
            onPress={() => router.push("/directives" as any)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              backgroundColor: pressed ? "#383a3d" : GO_BG,
              paddingHorizontal: 22,
              paddingVertical: 10,
              borderRadius: radius.full,
              gap: 6,
            })}
          >
            <Text style={{
              color: colors.text.primary,
              fontSize: fs.lg,
              fontWeight: fw.semibold,
            }}>
              GO
            </Text>
            <Text style={{ color: colors.text.tertiary, fontSize: fs.base }}>
              {">"}
            </Text>
          </Pressable>
        </View>

        {/* ── Action cards ── */}
        <View style={{
          flexDirection: "row",
          paddingHorizontal: SIDE,
          gap: gridGap,
          width: "100%",
        }}>
          <View style={{ width: cardWidth }}>
            <Pressable
              onPress={() => router.push("/directives" as any)}
              style={({ pressed }) => ({
                flex: 1,
                backgroundColor: CARD_BG,
                borderRadius: radius.xl,
                borderWidth: 1,
                borderColor: CARD_BORDER,
                borderLeftWidth: 3,
                borderLeftColor: colors.accent,
                padding: 16,
                justifyContent: "space-between",
                minHeight: 126,
                transform: [{ scale: pressed ? 0.97 : 1 }],
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <View style={{
                width: 42, height: 42, borderRadius: 12,
                backgroundColor: ICON_BOX_BG,
                alignItems: "center", justifyContent: "center",
              }}>
                <Text style={{ fontSize: 20 }}>{"▶"}</Text>
              </View>
              <View>
                <Text style={{
                  color: colors.text.primary,
                  fontSize: 15,
                  fontWeight: fw.medium,
                }}>
                  Directives
                </Text>
                {stats.directiveCount > 0 && (
                  <Text style={{
                    color: colors.text.tertiary,
                    fontSize: fs.sm,
                    marginTop: 2,
                  }}>
                    {stats.directiveCount} active
                  </Text>
                )}
              </View>
            </Pressable>
          </View>

          <View style={{ width: cardWidth }}>
            <Pressable
              onPress={() => router.push("/cipher" as any)}
              style={({ pressed }) => ({
                flex: 1,
                backgroundColor: CARD_BG,
                borderRadius: radius.xl,
                borderWidth: 1,
                borderColor: CARD_BORDER,
                borderLeftWidth: 3,
                borderLeftColor: colors.brand.purple,
                padding: 16,
                justifyContent: "space-between",
                minHeight: 126,
                transform: [{ scale: pressed ? 0.97 : 1 }],
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <View style={{
                width: 42, height: 42, borderRadius: 12,
                backgroundColor: ICON_BOX_BG,
                alignItems: "center", justifyContent: "center",
              }}>
                <Text style={{ fontSize: 20 }}>{"🎙️"}</Text>
              </View>
              <Text style={{
                color: colors.text.primary,
                fontSize: 15,
                fontWeight: fw.medium,
              }}>
                Voice
              </Text>
            </Pressable>
          </View>
        </View>

        {/* ── Page dots ── */}
        <View style={{
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          gap: 5,
          marginTop: 12,
          marginBottom: 12,
        }}>
          <View style={{
            width: 16, height: 4, borderRadius: 2,
            backgroundColor: withAlpha(colors.text.primary, 0.3),
          }} />
          <View style={{
            width: 4, height: 4, borderRadius: 2,
            backgroundColor: withAlpha(colors.text.primary, 0.1),
          }} />
        </View>

        {/* ── Shortcut grid (2×2) ── */}
        <View style={{ paddingHorizontal: SIDE, width: "100%" }}>
          {[
            [
              { id: "ventures", icon: "🚀", label: "Ventures", route: "/business", accent: colors.accent, badge: stats.ventureCount > 0 ? `${stats.ventureCount}` : "" },
              { id: "soc", icon: "🔐", label: "SOC", route: "/soc", accent: colors.error, badge: "" },
            ],
            [
              { id: "files", icon: "📦", label: "Files", route: "/files", accent: colors.brand.amber, badge: "" },
              { id: "music", icon: "🎵", label: "Music", route: "/music", accent: colors.brand.spotify, badge: "" },
            ],
          ].map((row, ri) => (
            <View key={ri} style={{ flexDirection: "row", gap: gridGap, marginBottom: gridGap }}>
              {row.map((tile) => (
                <View key={tile.id} style={{ width: tileSize, height: tileSize * 0.58 }}>
                <Pressable
                  onPress={() => router.push(tile.route as any)}
                  style={({ pressed }) => ({
                    flex: 1,
                    backgroundColor: TILE_BG,
                    borderRadius: radius.xl,
                    borderWidth: 1,
                    borderColor: TILE_BORDER,
                    borderLeftWidth: 3,
                    borderLeftColor: tile.accent,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    justifyContent: "space-between",
                    transform: [{ scale: pressed ? 0.96 : 1 }],
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <Text style={{ fontSize: 22 }}>{tile.icon}</Text>
                    {tile.badge !== "" && (
                      <View style={{
                        backgroundColor: withAlpha(tile.accent, 0.15),
                        paddingHorizontal: 7,
                        paddingVertical: 2,
                        borderRadius: radius.full,
                      }}>
                        <Text style={{ color: tile.accent, fontSize: fs.xs, fontWeight: fw.medium }}>
                          {tile.badge}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={{
                    color: colors.text.secondary,
                    fontSize: fs.base,
                    fontWeight: fw.medium,
                  }}>
                    {tile.label}
                  </Text>
                </Pressable>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>

      {/* ── Bottom tab bar ── */}
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
          { icon: "⚡", label: "Cipher", route: "/directives" },
          { icon: "💼", label: "Work", route: "/business" },
          { icon: "🪪", label: "Me", route: "/identity" },
          { icon: "🖥️", label: "Ops", route: "/ops" },
        ].map((tab, i) => (
          <Pressable
            key={i}
            onPress={() => tab.route ? router.push(tab.route as any) : null}
            style={({ pressed }) => ({
              alignItems: "center",
              paddingHorizontal: 12,
              paddingVertical: 4,
              opacity: pressed ? 0.6 : 1,
              transform: [{ scale: pressed ? 0.95 : 1 }],
            })}
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
