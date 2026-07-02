import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Image,
  ScrollView,
  Pressable,
  RefreshControl,
  Animated,
  Platform,
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
} from "../../lib/design-tokens";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ozzuLogo = require("../../assets/ozzu-logo.png");

// True monospace on the iPhone. RN's "monospace" only resolves on Android; iOS
// needs a named face (Menlo ships with iOS). The whole screen reads as Cipher's
// telemetry, so the data face has to actually be fixed-width on-device.
const MONO = Platform.select({ ios: "Menlo", default: "monospace" }) as string;

type Flag = { id: string; title: string; status: string; emoji: string };

// ── Live system state: is Cipher OK, and what needs King Kazuma? ──
function useConsoleState() {
  const { directives, summary, buildStatus, error, refresh } = useDirectives();
  const { projects } = useBusiness();

  // Prefer the server-computed summary; derive from the list if it isn't loaded.
  const derivedFlags: Flag[] = directives
    .filter((d) => ["blocked", "deploy_failed", "failed"].includes(d.status))
    .map((d) => ({ id: d.id, title: d.title, status: d.status, emoji: d.emoji || "•" }));

  const flags: Flag[] =
    summary?.needsAttention && summary.needsAttention.length > 0
      ? summary.needsAttention
      : derivedFlags;

  const flagCount = summary?.needsAttentionCount ?? flags.length;

  const activeCount =
    summary?.activeCount ??
    directives.filter((d) =>
      ["in_progress", "planning", "planned", "approved", "pending"].includes(d.status),
    ).length;

  const completedToday = summary?.completedToday ?? 0;
  const ventureCount = (projects || []).filter((p: any) => p.status === "active").length;

  const inFlight: Flag[] = directives
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

  return {
    flags,
    flagCount,
    inFlight,
    activeCount,
    completedToday,
    ventureCount,
    building,
    severity,
    online: !error,
    refresh,
  };
}

function clock(): string {
  const d = new Date();
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}`;
}

export default function HomeScreen() {
  const router = useRouter();
  const { insets, screenWidth } = usePhoneLayout();
  const st = useConsoleState();
  const [refreshing, setRefreshing] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [now, setNow] = useState(clock());

  useEffect(() => {
    const t = setInterval(() => setNow(clock()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setReduceMotion(v); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await st.refresh(); } catch {}
    setRefreshing(false);
  }, [st]);

  const W = screenWidth;
  const SIDE = 20;
  const GAP = 10;
  const tileW = (W - SIDE * 2 - GAP * 2) / 3;

  const toneColor =
    st.severity === "error" ? colors.error : st.severity === "warn" ? colors.warning : colors.accent;

  const flagged = st.flagCount > 0;
  const verdict = flagged ? "NEEDS YOU" : "ALL CLEAR";
  const rows = flagged ? st.flags.slice(0, 3) : st.inFlight;
  const eyebrow = flagged ? "FLAGGED" : "IN FLIGHT";
  const overflow = flagged ? st.flagCount - Math.min(3, st.flags.length) : 0;
  const telemetry = flagged
    ? `${st.activeCount} ACTIVE · ${st.flagCount} FLAGGED`
    : st.completedToday > 0
      ? `${st.activeCount} ACTIVE · ${st.completedToday} SHIPPED TODAY`
      : `${st.activeCount} ACTIVE`;

  // Destinations Cipher doesn't already put in the bottom bar (each carries its
  // own identity color + a live count where one exists).
  const DESTS: Array<{ id: string; icon: string; label: string; route: string; color: string; count?: number }> = [
    { id: "directives", icon: "⚡", label: "Directives", route: "/directives", color: colors.accent, count: st.activeCount },
    { id: "soc", icon: "🔐", label: "SOC", route: "/soc", color: colors.error },
    { id: "ventures", icon: "🚀", label: "Ventures", route: "/business", color: colors.brand.amber, count: st.ventureCount },
    { id: "june", icon: "👩", label: "June", route: "/avatar", color: colors.brand.purple },
    { id: "files", icon: "📦", label: "Files", route: "/files", color: colors.brand.blue },
    { id: "voice", icon: "🎙️", label: "Voice", route: "/cipher", color: colors.brand.cyanLight },
  ];

  // Motion: one entrance for the console, one heartbeat on the online dot.
  const enter = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) { enter.setValue(1); return; }
    Animated.timing(enter, { toValue: 1, duration: 420, useNativeDriver: true }).start();
  }, [reduceMotion, enter]);

  useEffect(() => {
    if (reduceMotion || !st.online) { pulse.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, st.online, pulse]);

  const enterStyle = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <StatusBar style="light" />

      {/* Ambient wash — the screen's temperature tracks system state */}
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: W * 0.9, overflow: "hidden" }}>
        <View style={{
          position: "absolute",
          top: -W * 0.28,
          left: W * 0.08,
          width: W * 0.84,
          height: W * 0.84,
          borderRadius: W * 0.42,
          backgroundColor: withAlpha(toneColor, 0.1),
        }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 10, paddingBottom: insets.bottom + 92 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.tertiary} />}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Identity bar ── */}
        <View style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: SIDE,
          height: 44,
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Image source={ozzuLogo} style={{ width: 30, height: 30, borderRadius: 15 }} resizeMode="contain" />
            <Text style={{ color: colors.text.primary, fontFamily: MONO, fontSize: fs.lg, fontWeight: fw.semibold, letterSpacing: 3 }}>
              CIPHER
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Animated.View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: st.online ? colors.success : colors.text.disabled, opacity: pulse }} />
            <Text style={{ color: colors.text.tertiary, fontFamily: MONO, fontSize: fs.sm, letterSpacing: 1 }}>
              {st.online ? "ONLINE" : "OFFLINE"}
            </Text>
            <Text style={{ color: colors.text.disabled, fontFamily: MONO, fontSize: fs.sm }}>{now}</Text>
          </View>
        </View>

        {/* ── Status console — the hero / signature ── */}
        <Animated.View style={[{ marginHorizontal: SIDE, marginTop: 14 }, enterStyle]}>
          <Pressable
            onPress={() => router.push("/directives" as any)}
            style={({ pressed }) => ({
              backgroundColor: colors.bg.elevated,
              borderRadius: radius.xl,
              borderWidth: 1,
              borderColor: colors.border.default,
              borderLeftWidth: 3,
              borderLeftColor: toneColor,
              paddingVertical: 20,
              paddingHorizontal: 20,
              opacity: pressed ? 0.94 : 1,
            })}
          >
            {/* verdict */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: toneColor }} />
              <Text style={{ color: toneColor, fontFamily: MONO, fontSize: fs.display, fontWeight: fw.bold, letterSpacing: -0.5 }}>
                {verdict}
              </Text>
            </View>

            {/* telemetry */}
            <Text style={{ color: colors.text.secondary, fontFamily: MONO, fontSize: fs.md, letterSpacing: 0.6, marginTop: 8 }}>
              {telemetry}{st.building ? "  ·  BUILDING" : ""}
            </Text>

            {/* live rows: what's flagged, or what's in flight */}
            {rows.length > 0 && (
              <View style={{ marginTop: 16, borderTopWidth: 1, borderTopColor: withAlpha(colors.border.default, 0.6), paddingTop: 12, gap: 10 }}>
                <Text style={{ color: colors.text.tertiary, fontFamily: MONO, fontSize: fs.xs, letterSpacing: 1.5 }}>
                  {eyebrow}
                </Text>
                {rows.map((r) => (
                  <Pressable
                    key={r.id}
                    onPress={() => router.push(`/directive/${r.id}` as any)}
                    style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, opacity: pressed ? 0.5 : 1 })}
                  >
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.status[r.status] || colors.text.tertiary }} />
                    <Text style={{ fontSize: fs.lg }}>{r.emoji}</Text>
                    <Text numberOfLines={1} style={{ flex: 1, color: colors.text.primary, fontSize: fs.lg }}>
                      {r.title}
                    </Text>
                    <Text style={{ color: colors.status[r.status] || colors.text.tertiary, fontFamily: MONO, fontSize: fs.xs, letterSpacing: 0.5 }}>
                      {(HUMAN_STATUS[r.status] || r.status).toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
                {overflow > 0 && (
                  <Pressable onPress={() => router.push("/directives" as any)} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
                    <Text style={{ color: toneColor, fontFamily: MONO, fontSize: fs.sm, letterSpacing: 0.5 }}>
                      +{overflow} more →
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            {/* calm empty state — an invitation, not a void */}
            {rows.length === 0 && (
              <Text style={{ color: colors.text.tertiary, fontSize: fs.base, marginTop: 12 }}>
                Nothing in flight. Tap to queue Cipher's next directive.
              </Text>
            )}
          </Pressable>
        </Animated.View>

        {/* ── Launcher ── */}
        <Text style={{ color: colors.text.tertiary, fontFamily: MONO, fontSize: fs.xs, letterSpacing: 1.5, marginTop: 26, marginBottom: 12, paddingHorizontal: SIDE }}>
          JUMP TO
        </Text>
        <View style={{ paddingHorizontal: SIDE }}>
          {[DESTS.slice(0, 3), DESTS.slice(3, 6)].map((row, ri) => (
            <View key={ri} style={{ flexDirection: "row", gap: GAP, marginBottom: GAP }}>
              {row.map((d) => (
                <Pressable
                  key={d.id}
                  onPress={() => router.push(d.route as any)}
                  style={({ pressed }) => ({
                    width: tileW,
                    height: tileW * 0.82,
                    backgroundColor: colors.bg.elevated,
                    borderRadius: radius.lg,
                    borderWidth: 1,
                    borderColor: colors.border.default,
                    padding: 12,
                    justifyContent: "space-between",
                    transform: [{ scale: pressed ? 0.96 : 1 }],
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: d.color, marginTop: 4 }} />
                    {typeof d.count === "number" && d.count > 0 && (
                      <Text style={{ color: d.color, fontFamily: MONO, fontSize: fs.sm, fontWeight: fw.semibold }}>{d.count}</Text>
                    )}
                  </View>
                  <View>
                    <Text style={{ fontSize: fs.xxl }}>{d.icon}</Text>
                    <Text style={{ color: colors.text.secondary, fontSize: fs.md, fontWeight: fw.medium, marginTop: 4 }}>{d.label}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ))}
        </View>

        {/* ── Upload action ── */}
        <Pressable
          onPress={() => router.push("/upload" as any)}
          style={({ pressed }) => ({
            marginHorizontal: SIDE,
            marginTop: 4,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            backgroundColor: colors.bg.elevated,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border.default,
            paddingVertical: 14,
            paddingHorizontal: 16,
            opacity: pressed ? 0.85 : 1,
            transform: [{ scale: pressed ? 0.99 : 1 }],
          })}
        >
          <Text style={{ fontSize: fs.xl }}>📤</Text>
          <Text style={{ flex: 1, color: colors.text.secondary, fontSize: fs.lg, fontWeight: fw.medium }}>Upload to Cipher</Text>
          <Text style={{ color: colors.text.disabled, fontFamily: MONO, fontSize: fs.base }}>›</Text>
        </Pressable>
      </ScrollView>

      {/* ── Bottom nav (Expo tab bar is display:none; this is the real nav) ── */}
      <View style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        paddingBottom: insets.bottom + 4,
        paddingTop: 10,
        backgroundColor: withAlpha(colors.bg.base, 0.96),
        borderTopWidth: 1,
        borderTopColor: withAlpha(colors.border.default, 0.6),
        flexDirection: "row",
        justifyContent: "space-around",
        alignItems: "center",
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
            style={({ pressed }) => ({
              alignItems: "center",
              paddingHorizontal: 12,
              paddingVertical: 4,
              opacity: pressed ? 0.6 : 1,
              transform: [{ scale: pressed ? 0.95 : 1 }],
            })}
          >
            <Text style={{ fontSize: 20, color: tab.active ? colors.accent : colors.text.disabled, marginBottom: 3 }}>
              {tab.icon}
            </Text>
            <Text style={{
              fontSize: 9,
              fontWeight: tab.active ? fw.semibold : fw.normal,
              color: tab.active ? colors.accent : colors.text.disabled,
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
