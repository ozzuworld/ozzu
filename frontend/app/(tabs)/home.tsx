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
  const W = Math.min(dims.width, dims.height); // always portrait width
  const logoSize = W * 0.52;
  const gridGap = 12;
  const cardWidth = (W - SIDE * 2 - gridGap) / 2;
  const tileSize = cardWidth;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <StatusBar style="light" />

      {/* Ambient glow behind logo */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
        <View style={{
          position: "absolute",
          top: W * 0.05,
          left: W * 0.1,
          width: W * 0.8,
          height: W * 0.8,
          borderRadius: W * 0.4,
          backgroundColor: withAlpha("#1a1a2e", 0.8),
        }} />
        <View style={{
          position: "absolute",
          top: W * 0.15,
          left: W * 0.2,
          width: W * 0.6,
          height: W * 0.6,
          borderRadius: W * 0.3,
          backgroundColor: withAlpha("#1e1f30", 0.5),
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
          paddingVertical: W * 0.04,
          minHeight: W * 0.62,
        }}>
          <View style={{
            width: logoSize,
            height: logoSize,
            borderRadius: logoSize / 2,
            backgroundColor: withAlpha("#ffffff", 0.03),
            alignItems: "center",
            justifyContent: "center",
          }}>
            <Image
              source={ozzuLogo}
              style={{
                width: logoSize * 0.85,
                height: logoSize * 0.85,
                borderRadius: (logoSize * 0.85) / 2,
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
          marginBottom: 16,
        }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{
                color: colors.text.primary,
                fontSize: 24,
                fontWeight: fw.bold,
                letterSpacing: -0.5,
              }}>
                Ozzu
              </Text>
              <Text style={{ fontSize: 13, opacity: 0.25 }}>{"✎"}</Text>
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

          {/* GO button */}
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
              marginTop: 2,
            })}
          >
            <Text style={{
              color: colors.text.primary,
              fontSize: fs.lg,
              fontWeight: fw.semibold,
            }}>
              GO
            </Text>
            <Text style={{ color: colors.text.secondary, fontSize: fs.md }}>
              {">"}
            </Text>
          </Pressable>
        </View>

        {/* ── Action cards (Dreame-style: tall, solid surface) ── */}
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
                backgroundColor: colors.bg.surface,
                borderRadius: radius.xl,
                padding: 16,
                justifyContent: "space-between",
                minHeight: 120,
                transform: [{ scale: pressed ? 0.97 : 1 }],
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontSize: 26 }}>{"▶"}</Text>
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
              onPress={() => router.push("/messages" as any)}
              style={({ pressed }) => ({
                flex: 1,
                backgroundColor: colors.bg.surface,
                borderRadius: radius.xl,
                padding: 16,
                justifyContent: "space-between",
                minHeight: 120,
                transform: [{ scale: pressed ? 0.97 : 1 }],
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ fontSize: 26 }}>{"💬"}</Text>
              <Text style={{
                color: colors.text.primary,
                fontSize: 15,
                fontWeight: fw.medium,
              }}>
                Messages
              </Text>
            </Pressable>
          </View>
        </View>

        {/* ── Page dots ── */}
        <View style={{
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          gap: 6,
          marginTop: 16,
          marginBottom: 20,
        }}>
          <View style={{
            width: 18, height: 5, borderRadius: 3,
            backgroundColor: withAlpha(colors.text.primary, 0.35),
          }} />
          <View style={{
            width: 5, height: 5, borderRadius: 3,
            backgroundColor: withAlpha(colors.text.primary, 0.1),
          }} />
        </View>

        {/* ── Shortcut grid (2×2) ── */}
        <View style={{ paddingHorizontal: SIDE, width: "100%" }}>
          {[
            [
              { id: "ventures", icon: "🚀", label: "Ventures", route: "/business", badge: stats.ventureCount > 0 ? `${stats.ventureCount}` : "" },
              { id: "intel", icon: "🕵️", label: "Intel", route: "/osint", badge: "" },
            ],
            [
              { id: "ops", icon: "🖥️", label: "Ops", route: "/ops", badge: "" },
              { id: "influence", icon: "🔗", label: "Influence", route: "/influence", badge: "" },
            ],
          ].map((row, ri) => (
            <View key={ri} style={{ flexDirection: "row", gap: gridGap, marginBottom: gridGap }}>
              {row.map((tile) => (
                <View key={tile.id} style={{ width: tileSize, height: tileSize * 0.5 }}>
                <Pressable
                  onPress={() => router.push(tile.route as any)}
                  style={({ pressed }) => ({
                    flex: 1,
                    backgroundColor: colors.bg.elevated,
                    borderRadius: radius.xl,
                    padding: 14,
                    justifyContent: "space-between",
                    transform: [{ scale: pressed ? 0.96 : 1 }],
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <Text style={{ fontSize: 28 }}>{tile.icon}</Text>
                    {tile.badge !== "" && (
                      <View style={{
                        backgroundColor: withAlpha(colors.accent, 0.15),
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                        borderRadius: radius.full,
                      }}>
                        <Text style={{ color: colors.accentLight, fontSize: fs.xs, fontWeight: fw.medium }}>
                          {tile.badge}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={{
                    color: colors.text.secondary,
                    fontSize: fs.lg,
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
          { icon: "▶", label: "Directives", route: "/directives" },
          { icon: "◎", label: "Finance", route: "/finance" },
          { icon: "✉", label: "Inbox", route: "/messages" },
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
