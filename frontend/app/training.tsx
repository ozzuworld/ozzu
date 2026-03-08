import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  Dimensions,
  StyleSheet,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import {
  Canvas,
  Circle,
  Line as SkLine,
  LinearGradient as SkGrad,
  Path,
  Rect as SkRect,
  vec,
  Group,
  Blur,
  Paint,
  Skia,
  useClockValue,
  useDerivedValue,
  useComputedValue,
  RoundedRect,
  Text as SkText,
  useFont,
  Shadow,
} from "@shopify/react-native-skia";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  Easing as REasing,
  interpolate,
  withDelay,
  FadeIn,
  FadeInDown,
  SlideInRight,
  runOnJS,
} from "react-native-reanimated";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { getBridgeUrl } from "../lib/bridge-api";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const TOP_BAR_HEIGHT = 52;
const CYAN = "#06B6D4";
const GREEN = "#22C55E";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const PURPLE = "#A855F7";
const MAGENTA = "#EC4899";
const CARD_BG = "#0A0A0A";
const BORDER = "#151515";
const AUTO_REFRESH_MS = 10000;
const TARGET_FACES = 1_000_000;
const EPIC_TARGET = 100_000_000;

interface TrainingStats {
  qdrant: {
    status: string;
    points_count: number;
    indexed_vectors_count: number;
    segments_count: number;
  };
  vast: {
    id: number;
    status: string;
    gpu: string;
    cost_per_hr: number;
    uptime_hrs: string | null;
    est_cost: number | null;
    ssh: string;
  } | null;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SKIA PARTICLE FIELD — flowing data particles
// ═══════════════════════════════════════════════════════════════════════════════
function ParticleField({ width: w, height: h }: { width: number; height: number }) {
  const particles = useMemo(() => {
    const pts = [];
    for (let i = 0; i < 40; i++) {
      pts.push({
        x: Math.random() * w,
        y: Math.random() * h,
        speed: 0.2 + Math.random() * 0.6,
        size: 0.8 + Math.random() * 1.5,
        opacity: 0.1 + Math.random() * 0.3,
        drift: (Math.random() - 0.5) * 0.3,
      });
    }
    return pts;
  }, [w, h]);

  const clock = useClockValue();

  return (
    <Canvas style={{ width: w, height: h, position: "absolute", top: 0, left: 0 }}>
      {particles.map((p, i) => {
        const cy = useDerivedValue(() => {
          const t = clock.current / 16;
          return (p.y + t * p.speed) % h;
        }, [clock]);
        const cx = useDerivedValue(() => {
          const t = clock.current / 16;
          return p.x + Math.sin(t * 0.01 + i) * 20 * p.drift;
        }, [clock]);
        const opacity = useDerivedValue(() => {
          const y = (p.y + clock.current / 16 * p.speed) % h;
          const fade = y < 40 ? y / 40 : y > h - 40 ? (h - y) / 40 : 1;
          return p.opacity * fade;
        }, [clock]);

        return (
          <Circle key={i} cx={cx} cy={cy} r={p.size} opacity={opacity} color={CYAN} />
        );
      })}
    </Canvas>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SKIA SCANLINE — CRT sweep effect
// ═══════════════════════════════════════════════════════════════════════════════
function SkiaScanline({ width: w, height: h }: { width: number; height: number }) {
  const clock = useClockValue();

  const y = useDerivedValue(() => {
    return (clock.current / 8) % (h + 100) - 50;
  }, [clock]);

  return (
    <Canvas
      style={{ width: w, height: h, position: "absolute", top: 0, left: 0 }}
      pointerEvents="none"
    >
      <SkRect x={0} y={y} width={w} height={60} opacity={0.025}>
        <SkGrad start={vec(0, 0)} end={vec(0, 60)} colors={["transparent", CYAN, "transparent"]} />
      </SkRect>
    </Canvas>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SKIA SPARKLINE — smooth GPU-rendered chart
// ═══════════════════════════════════════════════════════════════════════════════
function SkiaSparkline({
  data,
  width: w,
  height: h,
  color = CYAN,
}: {
  data: number[];
  width: number;
  height: number;
  color?: string;
}) {
  const pathStr = useMemo(() => {
    if (data.length < 2) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 6;
    const cw = w - pad * 2;
    const ch = h - pad * 2;
    const step = cw / (data.length - 1);

    let d = "";
    data.forEach((v, i) => {
      const x = pad + i * step;
      const y = pad + ch - ((v - min) / range) * ch;
      d += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
    });
    return d;
  }, [data, w, h]);

  const fillPathStr = useMemo(() => {
    if (data.length < 2) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 6;
    const cw = w - pad * 2;
    const ch = h - pad * 2;
    const step = cw / (data.length - 1);

    let d = `M ${pad} ${pad + ch}`;
    data.forEach((v, i) => {
      const x = pad + i * step;
      const y = pad + ch - ((v - min) / range) * ch;
      d += ` L ${x} ${y}`;
    });
    d += ` L ${pad + cw} ${pad + ch} Z`;
    return d;
  }, [data, w, h]);

  const lastPoint = useMemo(() => {
    if (data.length < 2) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 6;
    const cw = w - pad * 2;
    const ch = h - pad * 2;
    const step = cw / (data.length - 1);
    const x = pad + (data.length - 1) * step;
    const y = pad + ch - ((data[data.length - 1] - min) / range) * ch;
    return { x, y };
  }, [data, w, h]);

  if (!pathStr || !fillPathStr) {
    return (
      <View style={{ width: w, height: h, justifyContent: "center", alignItems: "center" }}>
        <Text style={{ color: "#1A1A1A", fontSize: 10, fontFamily: "monospace" }}>
          Collecting telemetry...
        </Text>
      </View>
    );
  }

  // Grid
  const gridLines = [];
  const pad = 6;
  const ch = h - pad * 2;
  for (let i = 0; i <= 3; i++) {
    const gy = pad + (ch / 3) * i;
    gridLines.push(
      <SkLine key={i} p1={vec(pad, gy)} p2={vec(w - pad, gy)} color="#111" strokeWidth={0.5} />
    );
  }

  return (
    <Canvas style={{ width: w, height: h }}>
      {gridLines}
      {/* Fill gradient */}
      <Path path={fillPathStr} opacity={0.15}>
        <SkGrad start={vec(0, pad)} end={vec(0, h)} colors={[color, "transparent"]} />
      </Path>
      {/* Line */}
      <Path path={pathStr} style="stroke" strokeWidth={2} strokeCap="round" strokeJoin="round" color={color} />
      {/* Glow line */}
      <Path path={pathStr} style="stroke" strokeWidth={4} strokeCap="round" strokeJoin="round" color={color} opacity={0.2}>
        <Blur blur={4} />
      </Path>
      {/* Endpoint dot with glow */}
      {lastPoint && (
        <>
          <Circle cx={lastPoint.x} cy={lastPoint.y} r={6} color={color} opacity={0.2}>
            <Blur blur={4} />
          </Circle>
          <Circle cx={lastPoint.x} cy={lastPoint.y} r={3} color={color} />
        </>
      )}
    </Canvas>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// REANIMATED ODOMETER — silky smooth rolling digits
// ═══════════════════════════════════════════════════════════════════════════════
function ReanimatedDigit({ digit, color, size }: { digit: string; color: string; size: number }) {
  const translateY = useSharedValue(size * 0.5);
  const opacity = useSharedValue(0);

  useEffect(() => {
    translateY.value = size * 0.5;
    opacity.value = 0;
    translateY.value = withTiming(0, { duration: 600, easing: REasing.out(REasing.cubic) });
    opacity.value = withTiming(1, { duration: 400 });
  }, [digit]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  const isNum = /\d/.test(digit);
  if (!isNum) {
    return (
      <View style={{ height: size * 1.2, justifyContent: "center" }}>
        <Text style={{ color, fontSize: size, fontFamily: "monospace", fontWeight: "bold" }}>
          {digit}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ height: size * 1.2, overflow: "hidden", justifyContent: "center" }}>
      <Animated.Text
        style={[
          {
            color,
            fontSize: size,
            fontFamily: "monospace",
            fontWeight: "bold",
            includeFontPadding: false,
          },
          animStyle,
        ]}
      >
        {digit}
      </Animated.Text>
    </View>
  );
}

function OdometerNumber({ value, color = CYAN, size = 38 }: { value: string; color?: string; size?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {value.split("").map((ch, i) => (
        <ReanimatedDigit key={`${i}-${ch}`} digit={ch} color={color} size={size} />
      ))}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PULSING GLOW INDICATOR
// ═══════════════════════════════════════════════════════════════════════════════
function PulsingGlow({ active, color }: { active: boolean; color: string }) {
  const scale = useSharedValue(1);

  useEffect(() => {
    if (active) {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.4, { duration: 1000 }),
          withTiming(1, { duration: 1000 })
        ),
        -1,
        true
      );
    } else {
      scale.value = withTiming(1);
    }
  }, [active]);

  const outerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: interpolate(scale.value, [1, 1.4], [0.3, 0.8]),
  }));

  return (
    <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={[
          {
            position: "absolute",
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: active ? color + "40" : "transparent",
          },
          outerStyle,
        ]}
      />
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: active ? color : "#333",
        }}
      />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEON PROGRESS BAR
// ═══════════════════════════════════════════════════════════════════════════════
function NeonProgressBar({
  current,
  target,
  color = CYAN,
  label,
}: {
  current: number;
  target: number;
  color?: string;
  label?: string;
}) {
  const pct = Math.min((current / target) * 100, 100);
  const width = useSharedValue(0);

  useEffect(() => {
    width.value = withTiming(pct, { duration: 800, easing: REasing.out(REasing.cubic) });
  }, [pct]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${width.value}%`,
  }));

  return (
    <View style={{ marginVertical: 6 }}>
      {label && (
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
          <Text style={{ color: "#333", fontSize: 9, fontFamily: "monospace" }}>{label}</Text>
          <Text style={{ color: color + "80", fontSize: 9, fontFamily: "monospace", fontWeight: "bold" }}>
            {pct.toFixed(2)}%
          </Text>
        </View>
      )}
      <View style={{ height: 3, backgroundColor: "#0D0D0D", borderRadius: 2, overflow: "hidden" }}>
        <Animated.View
          style={[
            {
              height: "100%",
              backgroundColor: color,
              borderRadius: 2,
              shadowColor: color,
              shadowOpacity: 0.6,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 0 },
            },
            barStyle,
          ]}
        />
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVITY TICKER — scrolling intel feed
// ═══════════════════════════════════════════════════════════════════════════════
function ActivityTicker({ events }: { events: string[] }) {
  const [idx, setIdx] = useState(0);
  const translateY = useSharedValue(0);
  const opacityVal = useSharedValue(1);

  useEffect(() => {
    if (events.length === 0) return;
    const interval = setInterval(() => {
      translateY.value = withTiming(-18, { duration: 200 }, () => {
        runOnJS(setIdx)((idx + 1) % events.length);
        translateY.value = 18;
        translateY.value = withTiming(0, { duration: 200 });
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [events.length, idx]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  if (events.length === 0) return null;

  return (
    <View
      style={{
        height: 28,
        overflow: "hidden",
        backgroundColor: "#060606",
        borderWidth: 1,
        borderColor: BORDER,
        borderRadius: 6,
        paddingHorizontal: 12,
        justifyContent: "center",
        marginBottom: 8,
      }}
    >
      <Animated.Text
        style={[
          { color: "#333", fontSize: 9, fontFamily: "monospace" },
          animStyle,
        ]}
      >
        {">"} {events[idx]}
      </Animated.Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOW STAT CARD
// ═══════════════════════════════════════════════════════════════════════════════
function GlowCard({
  value,
  label,
  sublabel,
  color = CYAN,
  delay = 0,
}: {
  value: string;
  label: string;
  sublabel?: string;
  color?: string;
  delay?: number;
}) {
  return (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(500)}
      style={{
        flex: 1,
        backgroundColor: CARD_BG,
        borderWidth: 1,
        borderColor: color + "20",
        borderRadius: 10,
        paddingVertical: 14,
        paddingHorizontal: 8,
        alignItems: "center",
        shadowColor: color,
        shadowOpacity: 0.12,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 0 },
        elevation: 3,
      }}
    >
      <Text style={{ color, fontSize: 20, fontFamily: "monospace", fontWeight: "bold" }}>
        {value}
      </Text>
      <Text
        style={{
          color: "#404040",
          fontSize: 8,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 1.5,
          marginTop: 4,
        }}
      >
        {label}
      </Text>
      {sublabel ? (
        <Text style={{ color: "#262626", fontSize: 7, fontFamily: "monospace", marginTop: 2 }}>
          {sublabel}
        </Text>
      ) : null}
    </Animated.View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFO ROW + SECTION
// ═══════════════════════════════════════════════════════════════════════════════
function InfoRow({ label, value, color = "#737373" }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={[s.infoValue, { color }]}>{value}</Text>
    </View>
  );
}

function SectionDivider({ title, icon }: { title: string; icon: string }) {
  return (
    <View style={s.sectionDiv}>
      <Text style={{ fontSize: 12 }}>{icon}</Text>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.sectionLine} />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function formatFull(n: number): string {
  return n.toLocaleString("en-US");
}
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
export default function TrainingScreen() {
  const router = useRouter();
  const isPhone = usePhoneLayout();
  const [stats, setStats] = useState<TrainingStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [startPoints, setStartPoints] = useState<number | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [activityLog, setActivityLog] = useState<string[]>([]);

  // Header glow pulse
  const headerGlow = useSharedValue(0.5);
  useEffect(() => {
    headerGlow.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2500 }),
        withTiming(0.5, { duration: 2500 })
      ),
      -1,
      true
    );
  }, []);

  const headerStyle = useAnimatedStyle(() => ({
    opacity: headerGlow.value,
  }));

  const fetchStats = useCallback(async () => {
    try {
      const url = getBridgeUrl();
      const res = await fetch(`${url}/api/training-stats`, {
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data: TrainingStats = await res.json();
      setStats(data);
      setError(null);
      setLastRefresh(new Date());

      setHistory((prev) => [...prev, data.qdrant.points_count].slice(-30));

      if (startPoints === null) {
        setStartPoints(data.qdrant.points_count);
        setStartTime(Date.now());
      }

      const prev = history.length > 0 ? history[history.length - 1] : 0;
      const diff = data.qdrant.points_count - prev;
      if (diff > 0 && prev > 0) {
        setActivityLog((log) =>
          [`+${diff.toLocaleString()} faces indexed [${new Date().toLocaleTimeString()}]`, ...log].slice(0, 20)
        );
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [startPoints, history]);

  useFocusEffect(
    useCallback(() => {
      fetchStats();
      const interval = setInterval(fetchStats, AUTO_REFRESH_MS);
      return () => clearInterval(interval);
    }, [fetchStats])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStats();
    setRefreshing(false);
  }, [fetchStats]);

  // ── Computed ────────────────────────────────────────────────────────────
  const points = stats?.qdrant?.points_count || 0;
  const indexed = stats?.qdrant?.indexed_vectors_count || 0;

  const sessionRate =
    startPoints !== null && startTime !== null && stats
      ? (points - startPoints) / ((Date.now() - startTime) / 60000)
      : 0;

  const recentRate =
    history.length >= 2
      ? (history[history.length - 1] - history[history.length - 2]) / (AUTO_REFRESH_MS / 60000)
      : 0;

  const costPerHr = stats?.vast?.cost_per_hr || 0;
  const uptimeHrs = parseFloat(stats?.vast?.uptime_hrs || "0");
  const estCost = stats?.vast?.est_cost || costPerHr * uptimeHrs;

  const etaMinutes = sessionRate > 0 ? (TARGET_FACES - points) / sessionRate : 0;
  const etaStr =
    etaMinutes <= 0
      ? "—"
      : etaMinutes < 60
      ? `${Math.round(etaMinutes)}m`
      : etaMinutes < 1440
      ? `${Math.floor(etaMinutes / 60)}h ${Math.round(etaMinutes % 60)}m`
      : `${(etaMinutes / 1440).toFixed(1)}d`;

  const costPerFace =
    estCost > 0 && points > (startPoints || 0) && startPoints !== null
      ? estCost / (points - startPoints)
      : 0;

  const vastRunning = stats?.vast?.status === "running";
  const qdrantOnline = stats?.qdrant?.status === "green";
  const pad = isPhone ? 14 : 22;
  const chartW = SCREEN_W - pad * 2 - 2;

  const tickerEvents = activityLog.length > 0
    ? activityLog
    : [
        "Pipeline active — monitoring ingestion...",
        `Qdrant: ${formatCompact(points)} embeddings`,
        vastRunning ? `GPU: ${stats?.vast?.gpu} @ ${formatCost(costPerHr)}/hr` : "No GPU instance",
      ];

  const timeStr = lastRefresh
    ? `${lastRefresh.getHours().toString().padStart(2, "0")}:${lastRefresh.getMinutes().toString().padStart(2, "0")}:${lastRefresh.getSeconds().toString().padStart(2, "0")}`
    : "——:——:——";

  return (
    <View style={{ flex: 1, backgroundColor: "#030303" }}>
      <StatusBar style="light" />

      {/* ── Skia particle field ──────────────────────────────────── */}
      <ParticleField width={SCREEN_W} height={SCREEN_H} />

      {/* ── Skia scanline ────────────────────────────────────────── */}
      <SkiaScanline width={SCREEN_W} height={SCREEN_H} />

      {/* ── Top command bar ────────────────────────────────────────── */}
      <View style={[s.topBar, { paddingHorizontal: pad }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={{ color: "#333", fontSize: 18, fontFamily: "monospace" }}>{"◁"}</Text>
        </Pressable>

        <View style={{ flex: 1, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}>
          <PulsingGlow active={vastRunning} color={vastRunning ? GREEN : "#333"} />
          <Animated.Text
            style={[
              {
                color: CYAN,
                fontSize: 13,
                fontFamily: "monospace",
                fontWeight: "bold",
                letterSpacing: 5,
                textShadowColor: CYAN,
                textShadowRadius: 10,
              },
              headerStyle,
            ]}
          >
            OPS CENTER
          </Animated.Text>
          <PulsingGlow active={qdrantOnline} color={qdrantOnline ? CYAN : RED} />
        </View>

        <Text style={{ color: "#1A1A1A", fontSize: 9, fontFamily: "monospace" }}>{timeStr}</Text>
      </View>

      {/* ── Main content ───────────────────────────────────────────── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: pad, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={CYAN} />}
      >
        {/* Error */}
        {error && (
          <Animated.View entering={FadeIn.duration(300)} style={s.errorBanner}>
            <Text style={{ color: RED, fontSize: 10, fontFamily: "monospace" }}>
              ⚠ LINK DEGRADED: {error}
            </Text>
          </Animated.View>
        )}

        {/* ── HERO: Odometer ──────────────────────────────────────── */}
        <Animated.View entering={FadeInDown.duration(600)} style={s.heroCard}>
          <Text style={s.heroLabel}>FACE DATABASE</Text>
          <OdometerNumber value={formatFull(points)} color={CYAN} size={36} />
          <Text style={s.heroSub}>EMBEDDINGS IN QDRANT</Text>

          <NeonProgressBar
            current={points}
            target={TARGET_FACES}
            color={CYAN}
            label={`PHASE 1: ${formatCompact(points)} / ${formatCompact(TARGET_FACES)}`}
          />
          <NeonProgressBar
            current={points}
            target={EPIC_TARGET}
            color={PURPLE}
            label={`EPIC: ${formatCompact(points)} / ${formatCompact(EPIC_TARGET)}`}
          />
        </Animated.View>

        {/* ── Rate cards ──────────────────────────────────────────── */}
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
          <GlowCard
            value={recentRate > 0 ? `${Math.round(recentRate)}` : "—"}
            label="FACES/MIN"
            sublabel="current"
            color={GREEN}
            delay={100}
          />
          <GlowCard
            value={sessionRate > 0 ? `${Math.round(sessionRate)}` : "—"}
            label="AVG/MIN"
            sublabel="session"
            color={AMBER}
            delay={200}
          />
          <GlowCard
            value={etaStr}
            label="ETA 1M"
            sublabel="phase 1"
            color={PURPLE}
            delay={300}
          />
        </View>

        {/* ── Sparkline ───────────────────────────────────────────── */}
        <Animated.View entering={FadeInDown.delay(400).duration(500)} style={s.chartCard}>
          <Text style={s.chartLabel}>INGESTION TELEMETRY</Text>
          <SkiaSparkline data={history} width={chartW - 24} height={90} color={CYAN} />
        </Animated.View>

        {/* ── Ticker ──────────────────────────────────────────────── */}
        <ActivityTicker events={tickerEvents} />

        {/* ── GPU ─────────────────────────────────────────────────── */}
        <SectionDivider title="GPU COMPUTE" icon="⚡" />
        <View style={[s.panel, vastRunning && { borderColor: GREEN + "15" }]}>
          {stats?.vast ? (
            <>
              <View style={s.panelHeader}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <PulsingGlow active={vastRunning} color={vastRunning ? GREEN : AMBER} />
                  <Text
                    style={{
                      color: vastRunning ? GREEN : AMBER,
                      fontSize: 11,
                      fontFamily: "monospace",
                      fontWeight: "bold",
                      textTransform: "uppercase",
                      textShadowColor: vastRunning ? GREEN : "transparent",
                      textShadowRadius: 4,
                    }}
                  >
                    {stats.vast.status}
                  </Text>
                </View>
                <Text style={{ color: "#1A1A1A", fontSize: 9, fontFamily: "monospace" }}>
                  #{stats.vast.id}
                </Text>
              </View>
              <InfoRow label="GPU" value={stats.vast.gpu} color={CYAN} />
              <InfoRow label="Cost/hr" value={formatCost(costPerHr)} />
              <InfoRow label="Uptime" value={uptimeHrs > 0 ? `${uptimeHrs.toFixed(1)}h` : "—"} />
              <InfoRow
                label="Spent"
                value={formatCost(estCost)}
                color={estCost > 8 ? RED : estCost > 4 ? AMBER : GREEN}
              />
              {costPerFace > 0 && (
                <InfoRow label="Cost/Face" value={`$${costPerFace.toFixed(6)}`} />
              )}
            </>
          ) : (
            <View style={{ padding: 24, alignItems: "center" }}>
              <Text style={{ color: "#1A1A1A", fontSize: 10, fontFamily: "monospace" }}>
                NO ACTIVE GPU INSTANCE
              </Text>
            </View>
          )}
        </View>

        {/* ── Qdrant ──────────────────────────────────────────────── */}
        <SectionDivider title="VECTOR DATABASE" icon="◆" />
        <View style={[s.panel, qdrantOnline && { borderColor: CYAN + "10" }]}>
          <View style={s.panelHeader}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <PulsingGlow active={qdrantOnline} color={qdrantOnline ? CYAN : RED} />
              <Text
                style={{
                  color: qdrantOnline ? CYAN : RED,
                  fontSize: 11,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  textTransform: "uppercase",
                }}
              >
                {stats?.qdrant?.status || "OFFLINE"}
              </Text>
            </View>
            <Text style={{ color: "#1A1A1A", fontSize: 9, fontFamily: "monospace" }}>QDRANT</Text>
          </View>
          <InfoRow label="Total Vectors" value={formatFull(points)} color={CYAN} />
          <InfoRow label="Indexed" value={formatFull(indexed)} color={GREEN} />
          <InfoRow label="Segments" value={String(stats?.qdrant?.segments_count || 0)} />
          <InfoRow label="Dimensions" value="512" />
          <InfoRow label="Distance" value="Cosine" />
        </View>

        {/* ── Pipeline ────────────────────────────────────────────── */}
        <SectionDivider title="PIPELINE" icon="▶" />
        <View style={s.panel}>
          <InfoRow label="Source" value="LAION-Face (50M)" color={CYAN} />
          <InfoRow label="Extracted" value="2.4M (16/128)" />
          <InfoRow label="Yield" value="~29%" color={AMBER} />
          <InfoRow label="Model" value="ArcFace buffalo_l" />
          <InfoRow label="Embed" value="512-dim GPU" />
          <InfoRow label="Workers" value="128 parallel" />
          <InfoRow label="Refresh" value={`${AUTO_REFRESH_MS / 1000}s`} />
        </View>

        {/* ── Topology ────────────────────────────────────────────── */}
        <SectionDivider title="TOPOLOGY" icon="◎" />
        <View style={[s.panel, { padding: 14 }]}>
          <Text style={s.topoText}>
            {`┌─ Vast.ai RTX 3090 ───────┐    ┌─ GCP VM ──────┐\n`}
            {`│  Download LAION URLs      │───▶│  Qdrant :6333  │\n`}
            {`│  ArcFace GPU embed        │    │  (SSH tunnel)  │\n`}
            {`│  Batch insert to Qdrant   │    └────────────────┘\n`}
            {`└──────────────────────────-┘           ▲\n`}
            {`┌─ dev-01 (satellite) ─────┐           │\n`}
            {`│  4 crawlers × 5 engines  │───────────┘\n`}
            {`│  ArcFace CPU embed       │  (VPN direct)\n`}
            {`└──────────────────────────┘`}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════
const s = StyleSheet.create({
  topBar: {
    height: TOP_BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: CYAN + "15",
    backgroundColor: "#030303F0",
    zIndex: 10,
  },
  errorBanner: {
    backgroundColor: "#0D0505",
    borderWidth: 1,
    borderColor: RED + "30",
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  heroCard: {
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: CYAN + "18",
    borderRadius: 14,
    padding: 24,
    alignItems: "center",
    marginBottom: 14,
    shadowColor: CYAN,
    shadowOpacity: 0.08,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 5,
  },
  heroLabel: {
    color: "#1A1A1A",
    fontSize: 9,
    fontFamily: "monospace",
    letterSpacing: 4,
    marginBottom: 8,
  },
  heroSub: {
    color: "#111",
    fontSize: 9,
    fontFamily: "monospace",
    marginTop: 6,
    letterSpacing: 1,
  },
  chartCard: {
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  chartLabel: {
    color: "#1A1A1A",
    fontSize: 9,
    fontFamily: "monospace",
    letterSpacing: 2,
    marginBottom: 8,
  },
  panel: {
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    overflow: "hidden",
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#0D0D0D",
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#0A0A0A",
  },
  infoLabel: {
    color: "#333",
    fontSize: 10,
    fontFamily: "monospace",
  },
  infoValue: {
    fontSize: 10,
    fontFamily: "monospace",
    fontWeight: "bold",
  },
  sectionDiv: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 24,
    marginBottom: 12,
    paddingHorizontal: 2,
  },
  sectionTitle: {
    color: "#262626",
    fontSize: 10,
    fontFamily: "monospace",
    fontWeight: "bold",
    letterSpacing: 3,
  },
  sectionLine: {
    flex: 1,
    height: 1,
    backgroundColor: BORDER,
    marginLeft: 8,
  },
  topoText: {
    color: "#1A1A1A",
    fontSize: 9,
    fontFamily: "monospace",
    lineHeight: 15,
  },
});
