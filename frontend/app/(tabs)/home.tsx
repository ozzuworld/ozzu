import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Image,
  ScrollView,
  Pressable,
  RefreshControl,
  Animated,
  AccessibilityInfo,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { useDirectives } from "../../lib/directive-hooks";
import { useBusiness } from "../../lib/business-hooks";
import { HUMAN_STATUS } from "../../lib/directive-constants";
import {
  colors,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
  statusPillStyle,
} from "../../lib/design-tokens";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ozzuLogo = require("../../assets/ozzu-logo.png");

type Item = { id: string; title: string; status: string; emoji: string };

// ── Live state: is everything running, and what needs King Kazuma? ──
function useHomeData() {
  const { directives, summary, buildStatus, error, refresh } = useDirectives();
  const { projects } = useBusiness();

  const derived: Item[] = directives
    .filter((d) => ["blocked", "deploy_failed", "failed"].includes(d.status))
    .map((d) => ({ id: d.id, title: d.title, status: d.status, emoji: d.emoji || "•" }));

  const flags: Item[] =
    summary?.needsAttention && summary.needsAttention.length > 0 ? summary.needsAttention : derived;

  const flagCount = summary?.needsAttentionCount ?? flags.length;
  const activeCount =
    summary?.activeCount ??
    directives.filter((d) =>
      ["in_progress", "planning", "planned", "approved", "pending"].includes(d.status),
    ).length;
  const completedToday = summary?.completedToday ?? 0;
  const ventureCount = (projects || []).filter((p: any) => p.status === "active").length;

  const inFlight: Item[] = directives
    .filter((d) => d.status === "in_progress")
    .slice(0, 3)
    .map((d) => ({ id: d.id, title: d.title, status: d.status, emoji: d.emoji || "▶" }));

  const building =
    !!(buildStatus &&
      [...(buildStatus.android || []), ...(buildStatus.ios || [])].some(
        (r: any) => r.status === "in_progress" || r.status === "queued",
      )) ||
    directives.some((d) => d.buildRuns?.some((r) => r.status === "in_progress" || r.status === "queued"));

  const severity: "error" | "warn" | "clear" = flags.some(
    (f) => f.status === "deploy_failed" || f.status === "failed",
  )
    ? "error"
    : flagCount > 0
      ? "warn"
      : "clear";

  return { flags, flagCount, inFlight, activeCount, completedToday, ventureCount, building, severity, online: !error, refresh };
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function today(): string {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getDay()]}, ${mons[d.getMonth()]} ${d.getDate()}`;
}

export default function HomeScreen() {
  const router = useRouter();
  const { insets, screenWidth } = usePhoneLayout();
  const st = useHomeData();
  const [refreshing, setRefreshing] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduceMotion(v); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await st.refresh(); } catch {}
    setRefreshing(false);
  }, [st]);

  const W = screenWidth;
  const SIDE = 20;
  const GAP = 12;
  const colW = (W - SIDE * 2 - GAP) / 2;

  const flagged = st.flagCount > 0;
  const tone = st.severity === "error" ? colors.error : st.severity === "warn" ? colors.warning : colors.success;
  const rows = flagged ? st.flags.slice(0, 3) : st.inFlight;
  const overflow = flagged ? st.flagCount - Math.min(3, st.flags.length) : 0;

  const shortcuts: Array<{ id: string; icon: string; label: string; route: string; color: string; count?: number }> = [
    { id: "directives", icon: "⚡", label: "Directives", route: "/directives", color: colors.accent, count: st.activeCount },
    { id: "soc", icon: "🔐", label: "SOC", route: "/soc", color: colors.error },
    { id: "ventures", icon: "🚀", label: "Ventures", route: "/business", color: colors.brand.amber, count: st.ventureCount },
    { id: "june", icon: "👩", label: "June", route: "/avatar", color: colors.brand.purple },
    { id: "files", icon: "📦", label: "Files", route: "/files", color: colors.brand.blue },
    { id: "voice", icon: "🎙️", label: "Voice", route: "/cipher", color: colors.brand.cyanLight },
  ];

  // One gentle entrance for the card stack.
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) { enter.setValue(1); return; }
    Animated.timing(enter, { toValue: 1, duration: 380, useNativeDriver: true }).start();
  }, [reduceMotion, enter]);
  const rise = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  };

  const StatusRow = ({ item }: { item: Item }) => {
    const pill = statusPillStyle(item.status);
    return (
      <Pressable
        onPress={() => router.push(`/directive/${item.id}` as any)}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9, opacity: pressed ? 0.55 : 1 })}
      >
        <Text style={{ fontSize: 20 }}>{item.emoji}</Text>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.text.primary, fontSize: fs.lg }}>
          {item.title}
        </Text>
        <View style={{ backgroundColor: pill.bg, paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.full }}>
          <Text style={{ color: pill.text, fontSize: fs.sm, fontWeight: fw.medium }}>
            {HUMAN_STATUS[item.status] || item.status}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <StatusBar style="light" />

      {/* Soft ambient warmth at the top — subtle, not alarming */}
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 260, overflow: "hidden" }}>
        <View style={{
          position: "absolute", top: -120, alignSelf: "center",
          width: W * 0.9, height: 240, borderRadius: 999,
          backgroundColor: withAlpha(colors.accent, 0.07),
        }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 14, paddingBottom: insets.bottom + 96 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.tertiary} />}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ── */}
        <View style={{ paddingHorizontal: SIDE, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text.primary, fontSize: 26, fontWeight: fw.bold, letterSpacing: -0.6 }}>
              {greeting()}
            </Text>
            <Text style={{ color: colors.text.tertiary, fontSize: fs.base, marginTop: 4 }}>
              {today()} · {st.activeCount} active
            </Text>
          </View>
          <Image source={ozzuLogo} style={{ width: 42, height: 42, borderRadius: 21 }} resizeMode="contain" />
        </View>

        {/* ── Status card ── */}
        <Animated.View style={[{ marginHorizontal: SIDE }, rise]}>
          <Pressable
            onPress={() => router.push("/directives" as any)}
            style={({ pressed }) => ({
              backgroundColor: colors.bg.elevated,
              borderRadius: radius.xl,
              borderWidth: 1,
              borderColor: colors.border.default,
              borderLeftWidth: 3,
              borderLeftColor: tone,
              padding: 18,
              shadowColor: "#000",
              shadowOpacity: 0.35,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 10 },
              transform: [{ scale: pressed ? 0.99 : 1 }],
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 11 }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: tone }} />
              <Text style={{ color: colors.text.primary, fontSize: fs.xxl, fontWeight: fw.semibold, letterSpacing: -0.3, flex: 1 }}>
                {flagged ? "Needs your attention" : "All caught up"}
              </Text>
              {flagged && (
                <View style={{ backgroundColor: withAlpha(tone, 0.16), borderRadius: radius.full, paddingHorizontal: 11, paddingVertical: 3 }}>
                  <Text style={{ color: tone, fontSize: fs.lg, fontWeight: fw.bold }}>{st.flagCount}</Text>
                </View>
              )}
            </View>

            <Text style={{ color: colors.text.secondary, fontSize: fs.base, marginTop: 6, lineHeight: 19 }}>
              {flagged
                ? `${st.activeCount} directives active`
                : st.completedToday > 0
                  ? `${st.completedToday} shipped today · ${st.activeCount} in progress`
                  : `${st.activeCount} in progress`}
              {st.building ? " · building now" : ""}
            </Text>

            {rows.length > 0 && (
              <View style={{ marginTop: 14, borderTopWidth: 1, borderTopColor: colors.border.subtle, paddingTop: 6 }}>
                {rows.map((item) => (
                  <StatusRow key={item.id} item={item} />
                ))}
                {overflow > 0 && (
                  <Pressable onPress={() => router.push("/directives" as any)} style={({ pressed }) => ({ paddingTop: 8, opacity: pressed ? 0.5 : 1 })}>
                    <Text style={{ color: colors.accent, fontSize: fs.base, fontWeight: fw.medium }}>
                      View {overflow} more →
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </Pressable>
        </Animated.View>

        {/* ── Shortcuts ── */}
        <Text style={{ color: colors.text.secondary, fontSize: fs.lg, fontWeight: fw.semibold, marginTop: 28, marginBottom: 12, paddingHorizontal: SIDE }}>
          Shortcuts
        </Text>
        <View style={{ paddingHorizontal: SIDE, flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
          {shortcuts.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => router.push(s.route as any)}
              style={({ pressed }) => ({
                width: colW,
                backgroundColor: colors.bg.elevated,
                borderRadius: radius.xl,
                borderWidth: 1,
                borderColor: colors.border.subtle,
                padding: 14,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                transform: [{ scale: pressed ? 0.97 : 1 }],
                opacity: pressed ? 0.9 : 1,
              })}
            >
              <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: withAlpha(s.color, 0.16), alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 20 }}>{s.icon}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text.primary, fontSize: fs.lg, fontWeight: fw.semibold }} numberOfLines={1}>
                  {s.label}
                </Text>
                {typeof s.count === "number" && s.count > 0 && (
                  <Text style={{ color: colors.text.tertiary, fontSize: fs.md, marginTop: 2 }}>{s.count} active</Text>
                )}
              </View>
            </Pressable>
          ))}
        </View>

        {/* ── Upload ── */}
        <Pressable
          onPress={() => router.push("/upload" as any)}
          style={({ pressed }) => ({
            marginHorizontal: SIDE,
            marginTop: GAP,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            backgroundColor: colors.bg.elevated,
            borderRadius: radius.xl,
            borderWidth: 1,
            borderColor: colors.border.subtle,
            padding: 14,
            opacity: pressed ? 0.9 : 1,
            transform: [{ scale: pressed ? 0.99 : 1 }],
          })}
        >
          <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: withAlpha(colors.accent, 0.16), alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 20 }}>📤</Text>
          </View>
          <Text style={{ flex: 1, color: colors.text.primary, fontSize: fs.lg, fontWeight: fw.semibold }}>Upload to Cipher</Text>
          <Text style={{ color: colors.text.disabled, fontSize: fs.xxl }}>›</Text>
        </Pressable>
      </ScrollView>

      {/* ── Bottom nav (Expo tab bar is display:none; this is the real nav) ── */}
      <View style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        paddingBottom: insets.bottom + 6, paddingTop: 10,
        backgroundColor: withAlpha(colors.bg.base, 0.97),
        borderTopWidth: 1, borderTopColor: colors.border.subtle,
        flexDirection: "row", justifyContent: "space-around", alignItems: "center",
      }}>
        {[
          { icon: "⌂", label: "Home", route: null, active: true },
          { icon: "⚡", label: "Cipher", route: "/directives" },
          { icon: "💼", label: "Work", route: "/business" },
          { icon: "🪪", label: "Me", route: "/identity" },
          { icon: "🖥", label: "Ops", route: "/ops" },
        ].map((tab, i) => (
          <Pressable
            key={i}
            onPress={() => (tab.route ? router.push(tab.route as any) : null)}
            style={({ pressed }) => ({ alignItems: "center", paddingHorizontal: 12, paddingVertical: 4, opacity: pressed ? 0.6 : 1, transform: [{ scale: pressed ? 0.95 : 1 }] })}
          >
            <Text style={{ fontSize: 21, color: tab.active ? colors.accent : colors.text.disabled, marginBottom: 3 }}>{tab.icon}</Text>
            <Text style={{ fontSize: 10, fontWeight: tab.active ? fw.semibold : fw.normal, color: tab.active ? colors.accent : colors.text.disabled }}>
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
