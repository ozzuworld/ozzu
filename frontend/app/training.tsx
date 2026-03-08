import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  Animated,
  Dimensions,
  Easing,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import Svg, { Polyline, Line, Circle, Rect, Defs, LinearGradient, Stop } from "react-native-svg";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { getBridgeUrl } from "../lib/bridge-api";

const { width: SCREEN_W } = Dimensions.get("window");
const TOP_BAR_HEIGHT = 52;
const CYAN = "#06B6D4";
const CYAN_DIM = "#06B6D420";
const CYAN_MED = "#06B6D460";
const GREEN = "#22C55E";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const PURPLE = "#A855F7";
const CARD_BG = "#0D0D0D";
const BORDER = "#1A1A1A";
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

// ── Animated rolling odometer digit ──────────────────────────────────────────
function OdometerDigit({ digit, color, size }: { digit: string; color: string; size: number }) {
  const animVal = useRef(new Animated.Value(0)).current;
  const prevDigit = useRef(digit);

  useEffect(() => {
    if (digit !== prevDigit.current) {
      animVal.setValue(0);
      Animated.timing(animVal, {
        toValue: 1,
        duration: 600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      prevDigit.current = digit;
    }
  }, [digit]);

  const isNum = /\d/.test(digit);

  if (!isNum) {
    return (
      <View style={{ height: size * 1.2, justifyContent: "center" }}>
        <Text
          style={{
            color,
            fontSize: size,
            fontFamily: "monospace",
            fontWeight: "bold",
            includeFontPadding: false,
          }}
        >
          {digit}
        </Text>
      </View>
    );
  }

  const translateY = animVal.interpolate({
    inputRange: [0, 1],
    outputRange: [size * 0.6, 0],
  });
  const opacity = animVal.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [0, 1, 1],
  });

  return (
    <View style={{ height: size * 1.2, overflow: "hidden", justifyContent: "center" }}>
      <Animated.Text
        style={{
          color,
          fontSize: size,
          fontFamily: "monospace",
          fontWeight: "bold",
          includeFontPadding: false,
          transform: [{ translateY }],
          opacity,
        }}
      >
        {digit}
      </Animated.Text>
    </View>
  );
}

function OdometerNumber({
  value,
  color = CYAN,
  size = 42,
}: {
  value: string;
  color?: string;
  size?: number;
}) {
  const chars = value.split("");
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {chars.map((ch, i) => (
        <OdometerDigit key={`${i}-${ch}`} digit={ch} color={color} size={size} />
      ))}
    </View>
  );
}

// ── Sparkline chart (SVG) ────────────────────────────────────────────────────
function SparklineChart({
  data,
  width,
  height,
  color = CYAN,
}: {
  data: number[];
  width: number;
  height: number;
  color?: string;
}) {
  if (data.length < 2) {
    return (
      <View style={{ width, height, justifyContent: "center", alignItems: "center" }}>
        <Text style={{ color: "#333", fontSize: 10, fontFamily: "monospace" }}>
          Collecting data...
        </Text>
      </View>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 4;
  const chartW = width - pad * 2;
  const chartH = height - pad * 2;
  const step = chartW / (data.length - 1);

  const points = data
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + chartH - ((v - min) / range) * chartH;
      return `${x},${y}`;
    })
    .join(" ");

  const lastX = pad + (data.length - 1) * step;
  const lastY = pad + chartH - ((data[data.length - 1] - min) / range) * chartH;

  // Grid lines
  const gridLines = [];
  for (let i = 0; i < 4; i++) {
    const y = pad + (chartH / 3) * i;
    gridLines.push(
      <Line
        key={`g${i}`}
        x1={pad}
        y1={y}
        x2={width - pad}
        y2={y}
        stroke="#1A1A1A"
        strokeWidth={0.5}
      />
    );
  }

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity="0.3" />
          <Stop offset="1" stopColor={color} stopOpacity="0" />
        </LinearGradient>
      </Defs>
      {gridLines}
      <Polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <Circle cx={lastX} cy={lastY} r={3} fill={color} />
    </Svg>
  );
}

// ── Animated scanline overlay ────────────────────────────────────────────────
function ScanlineOverlay() {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: 4000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [-100, 600],
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        height: 100,
        transform: [{ translateY }],
        opacity: 0.03,
        backgroundColor: CYAN,
      }}
    />
  );
}

// ── Pulsing glow ring ────────────────────────────────────────────────────────
function PulsingGlow({ active, color }: { active: boolean; color: string }) {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (!active) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 1200, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [active]);

  return (
    <Animated.View
      style={{
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: active ? color : "#333",
        opacity: active ? pulse : 0.3,
        shadowColor: color,
        shadowOpacity: active ? 0.8 : 0,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 0 },
        elevation: active ? 4 : 0,
      }}
    />
  );
}

// ── Hex grid background ──────────────────────────────────────────────────────
function HexGridBG({ width: w, height: h }: { width: number; height: number }) {
  const dots = useMemo(() => {
    const result = [];
    const spacing = 32;
    for (let y = 0; y < h; y += spacing) {
      const offset = Math.floor(y / spacing) % 2 === 0 ? 0 : spacing / 2;
      for (let x = offset; x < w; x += spacing) {
        result.push(
          <Circle key={`${x}-${y}`} cx={x} cy={y} r={0.6} fill="#1A1A1A" opacity={0.5} />
        );
      }
    }
    return result;
  }, [w, h]);

  return (
    <Svg
      width={w}
      height={h}
      style={{ position: "absolute", top: 0, left: 0 }}
    >
      {dots}
    </Svg>
  );
}

// ── Activity ticker ──────────────────────────────────────────────────────────
function ActivityTicker({ events }: { events: string[] }) {
  const scrollAnim = useRef(new Animated.Value(0)).current;
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (events.length === 0) return;
    const interval = setInterval(() => {
      Animated.sequence([
        Animated.timing(scrollAnim, {
          toValue: -20,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(scrollAnim, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]).start();
      setIdx((prev) => (prev + 1) % events.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [events.length]);

  if (events.length === 0) return null;

  return (
    <View
      style={{
        height: 28,
        overflow: "hidden",
        backgroundColor: "#0A0A0A",
        borderWidth: 1,
        borderColor: BORDER,
        borderRadius: 6,
        paddingHorizontal: 10,
        justifyContent: "center",
      }}
    >
      <Animated.Text
        style={{
          color: "#525252",
          fontSize: 9,
          fontFamily: "monospace",
          transform: [{ translateY: scrollAnim }],
        }}
      >
        {">"} {events[idx]}
      </Animated.Text>
    </View>
  );
}

// ── Neon stat card with glow border ──────────────────────────────────────────
function GlowCard({
  value,
  label,
  sublabel,
  color = CYAN,
  large,
}: {
  value: string;
  label: string;
  sublabel?: string;
  color?: string;
  large?: boolean;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: CARD_BG,
        borderWidth: 1,
        borderColor: color + "30",
        borderRadius: 10,
        paddingVertical: large ? 18 : 14,
        paddingHorizontal: 10,
        alignItems: "center",
        shadowColor: color,
        shadowOpacity: 0.15,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 0 },
        elevation: 3,
      }}
    >
      <Text
        style={{
          color,
          fontSize: large ? 26 : 20,
          fontFamily: "monospace",
          fontWeight: "bold",
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          color: "#525252",
          fontSize: 9,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 1.5,
          marginTop: 4,
        }}
      >
        {label}
      </Text>
      {sublabel ? (
        <Text style={{ color: "#333", fontSize: 8, fontFamily: "monospace", marginTop: 2 }}>
          {sublabel}
        </Text>
      ) : null}
    </View>
  );
}

// ── Progress arc (horizontal bar with animated fill) ─────────────────────────
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
  const fillAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fillAnim, {
      toValue: pct,
      duration: 800,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [pct]);

  const widthInterp = fillAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ["0%", "100%"],
  });

  return (
    <View style={{ marginVertical: 6 }}>
      {label && (
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
          <Text style={{ color: "#404040", fontSize: 9, fontFamily: "monospace" }}>{label}</Text>
          <Text style={{ color: color + "80", fontSize: 9, fontFamily: "monospace", fontWeight: "bold" }}>
            {pct.toFixed(2)}%
          </Text>
        </View>
      )}
      <View
        style={{
          height: 4,
          backgroundColor: "#111",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <Animated.View
          style={{
            height: "100%",
            width: widthInterp,
            backgroundColor: color,
            borderRadius: 2,
            shadowColor: color,
            shadowOpacity: 0.5,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 0 },
          }}
        />
      </View>
    </View>
  );
}

// ── Info row with separator ──────────────────────────────────────────────────
function InfoRow({
  label,
  value,
  color = "#A3A3A3",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: 7,
        paddingHorizontal: 14,
        borderBottomWidth: 1,
        borderBottomColor: "#111",
      }}
    >
      <Text style={{ color: "#404040", fontSize: 10, fontFamily: "monospace" }}>{label}</Text>
      <Text style={{ color, fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
        {value}
      </Text>
    </View>
  );
}

// ── Section divider ──────────────────────────────────────────────────────────
function SectionDivider({ title, icon }: { title: string; icon: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginTop: 24,
        marginBottom: 12,
        paddingHorizontal: 2,
      }}
    >
      <Text style={{ fontSize: 12 }}>{icon}</Text>
      <Text
        style={{
          color: "#333",
          fontSize: 10,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 3,
        }}
      >
        {title}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: BORDER, marginLeft: 8 }} />
    </View>
  );
}

// ── Number formatting ────────────────────────────────────────────────────────
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
  const headerPulse = useRef(new Animated.Value(0.6)).current;

  // Header title glow pulse
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(headerPulse, { toValue: 1, duration: 2000, useNativeDriver: true }),
        Animated.timing(headerPulse, { toValue: 0.6, duration: 2000, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

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

      setHistory((prev) => {
        const next = [...prev, data.qdrant.points_count].slice(-30);
        return next;
      });

      if (startPoints === null) {
        setStartPoints(data.qdrant.points_count);
        setStartTime(Date.now());
      }

      // Generate activity events
      const prev = history.length > 0 ? history[history.length - 1] : 0;
      const diff = data.qdrant.points_count - prev;
      if (diff > 0 && prev > 0) {
        setActivityLog((log) =>
          [
            `+${diff.toLocaleString()} faces indexed [${new Date().toLocaleTimeString()}]`,
            ...log,
          ].slice(0, 20)
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

  // ── Computed values ──────────────────────────────────────────────────────
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

  // Activity feed with defaults
  const tickerEvents = activityLog.length > 0
    ? activityLog
    : [
        "Pipeline active — monitoring face ingestion...",
        `Qdrant: ${formatCompact(points)} embeddings indexed`,
        vastRunning ? `GPU: ${stats?.vast?.gpu} @ ${formatCost(costPerHr)}/hr` : "No GPU instance",
      ];

  const timeStr = lastRefresh
    ? `${lastRefresh.getHours().toString().padStart(2, "0")}:${lastRefresh.getMinutes().toString().padStart(2, "0")}:${lastRefresh.getSeconds().toString().padStart(2, "0")}`
    : "——:——:——";

  return (
    <View style={{ flex: 1, backgroundColor: "#050505" }}>
      <StatusBar style="light" />

      {/* ── Hex grid background ────────────────────────────────────── */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0.4 }}>
        <HexGridBG width={SCREEN_W} height={900} />
      </View>

      {/* ── Scanline effect ────────────────────────────────────────── */}
      <ScanlineOverlay />

      {/* ── Top command bar ────────────────────────────────────────── */}
      <View
        style={{
          height: TOP_BAR_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: pad,
          borderBottomWidth: 1,
          borderBottomColor: CYAN_DIM,
          backgroundColor: "#080808F0",
          zIndex: 10,
        }}
      >
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={{ color: "#404040", fontSize: 18, fontFamily: "monospace" }}>{"◁"}</Text>
        </Pressable>

        <View style={{ flex: 1, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}>
          <PulsingGlow active={vastRunning} color={vastRunning ? GREEN : "#525252"} />
          <Animated.Text
            style={{
              color: CYAN,
              fontSize: 13,
              fontFamily: "monospace",
              fontWeight: "bold",
              letterSpacing: 4,
              opacity: headerPulse,
              textShadowColor: CYAN,
              textShadowRadius: 8,
            }}
          >
            OPS CENTER
          </Animated.Text>
          <PulsingGlow active={qdrantOnline} color={qdrantOnline ? CYAN : RED} />
        </View>

        <Text style={{ color: "#262626", fontSize: 9, fontFamily: "monospace" }}>{timeStr}</Text>
      </View>

      {/* ── Main content ───────────────────────────────────────────── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: pad, paddingBottom: 60 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={CYAN} />
        }
      >
        {/* Error banner */}
        {error && (
          <View
            style={{
              backgroundColor: "#1A0505",
              borderWidth: 1,
              borderColor: RED + "40",
              borderRadius: 8,
              padding: 10,
              marginBottom: 12,
            }}
          >
            <Text style={{ color: RED, fontSize: 10, fontFamily: "monospace" }}>
              ⚠ LINK DEGRADED: {error}
            </Text>
          </View>
        )}

        {/* ── HERO: Face count odometer ────────────────────────────── */}
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: CYAN + "25",
            borderRadius: 14,
            padding: 24,
            alignItems: "center",
            marginBottom: 14,
            shadowColor: CYAN,
            shadowOpacity: 0.1,
            shadowRadius: 20,
            shadowOffset: { width: 0, height: 0 },
            elevation: 5,
          }}
        >
          <Text
            style={{
              color: "#262626",
              fontSize: 9,
              fontFamily: "monospace",
              letterSpacing: 4,
              marginBottom: 8,
            }}
          >
            FACE DATABASE
          </Text>

          <OdometerNumber value={formatFull(points)} color={CYAN} size={38} />

          <Text
            style={{
              color: "#1A1A1A",
              fontSize: 9,
              fontFamily: "monospace",
              marginTop: 6,
              letterSpacing: 1,
            }}
          >
            EMBEDDINGS IN QDRANT
          </Text>

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
        </View>

        {/* ── Live rate cards ──────────────────────────────────────── */}
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
          <GlowCard
            value={recentRate > 0 ? `${Math.round(recentRate)}` : "—"}
            label="FACES/MIN"
            sublabel="current"
            color={GREEN}
          />
          <GlowCard
            value={sessionRate > 0 ? `${Math.round(sessionRate)}` : "—"}
            label="AVG/MIN"
            sublabel="session"
            color={AMBER}
          />
          <GlowCard
            value={etaStr}
            label="ETA 1M"
            sublabel="phase 1"
            color={PURPLE}
          />
        </View>

        {/* ── Sparkline chart ──────────────────────────────────────── */}
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: BORDER,
            borderRadius: 10,
            padding: 12,
            marginBottom: 10,
          }}
        >
          <Text
            style={{
              color: "#262626",
              fontSize: 9,
              fontFamily: "monospace",
              letterSpacing: 2,
              marginBottom: 8,
            }}
          >
            INGESTION RATE
          </Text>
          <SparklineChart data={history} width={chartW - 24} height={80} color={CYAN} />
        </View>

        {/* ── Activity ticker ──────────────────────────────────────── */}
        <ActivityTicker events={tickerEvents} />

        {/* ── GPU Instance ─────────────────────────────────────────── */}
        <SectionDivider title="GPU COMPUTE" icon="⚡" />
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: vastRunning ? GREEN + "20" : BORDER,
            borderRadius: 10,
            overflow: "hidden",
            shadowColor: vastRunning ? GREEN : "transparent",
            shadowOpacity: 0.08,
            shadowRadius: 12,
            elevation: 2,
          }}
        >
          {stats?.vast ? (
            <>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: "#111",
                }}
              >
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
                <Text style={{ color: "#262626", fontSize: 9, fontFamily: "monospace" }}>
                  #{stats.vast.id}
                </Text>
              </View>
              <InfoRow label="GPU" value={stats.vast.gpu} color={CYAN} />
              <InfoRow label="Cost/hr" value={formatCost(costPerHr)} />
              <InfoRow
                label="Uptime"
                value={uptimeHrs > 0 ? `${uptimeHrs.toFixed(1)}h` : "—"}
              />
              <InfoRow
                label="Spent"
                value={formatCost(estCost)}
                color={estCost > 8 ? RED : estCost > 4 ? AMBER : GREEN}
              />
              {costPerFace > 0 && (
                <InfoRow
                  label="Cost/Face"
                  value={`$${costPerFace.toFixed(6)}`}
                  color="#737373"
                />
              )}
            </>
          ) : (
            <View style={{ padding: 24, alignItems: "center" }}>
              <Text style={{ color: "#262626", fontSize: 10, fontFamily: "monospace" }}>
                NO ACTIVE GPU INSTANCE
              </Text>
            </View>
          )}
        </View>

        {/* ── Vector Database ──────────────────────────────────────── */}
        <SectionDivider title="VECTOR DATABASE" icon="◆" />
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: qdrantOnline ? CYAN + "15" : RED + "20",
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: "#111",
            }}
          >
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
            <Text style={{ color: "#262626", fontSize: 9, fontFamily: "monospace" }}>
              QDRANT
            </Text>
          </View>
          <InfoRow label="Total Vectors" value={formatFull(points)} color={CYAN} />
          <InfoRow label="Indexed" value={formatFull(indexed)} color={GREEN} />
          <InfoRow label="Segments" value={String(stats?.qdrant?.segments_count || 0)} />
          <InfoRow label="Dimensions" value="512" />
          <InfoRow label="Distance" value="Cosine" />
        </View>

        {/* ── Pipeline Specs ───────────────────────────────────────── */}
        <SectionDivider title="PIPELINE" icon="▶" />
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: BORDER,
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <InfoRow label="Source" value="LAION-Face (50M)" color={CYAN} />
          <InfoRow label="Extracted URLs" value="2.4M (16/128)" />
          <InfoRow label="URL Yield" value="~29%" color={AMBER} />
          <InfoRow label="Model" value="ArcFace buffalo_l" />
          <InfoRow label="Embedding" value="512-dim GPU" />
          <InfoRow label="Downloaders" value="128 parallel" />
          <InfoRow label="Refresh" value={`${AUTO_REFRESH_MS / 1000}s`} />
        </View>

        {/* ── Architecture diagram ─────────────────────────────────── */}
        <SectionDivider title="TOPOLOGY" icon="◎" />
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: BORDER,
            borderRadius: 10,
            padding: 14,
          }}
        >
          <Text
            style={{
              color: "#262626",
              fontSize: 9,
              fontFamily: "monospace",
              lineHeight: 15,
            }}
          >
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
