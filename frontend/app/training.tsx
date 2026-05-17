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
  Blur,
} from "@shopify/react-native-skia";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { getBridgeUrl } from "../lib/bridge-api";
import { GroupNav } from "../components/GroupNav";
import { layout } from "../lib/design-tokens";

import { colors } from "../lib/design-tokens";
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const CYAN = colors.accent;
const GREEN = colors.success;
const AMBER = colors.brand.amber;
const RED = colors.error;
const PURPLE = colors.brand.purple;
const MAGENTA = "#EC4899";
const CARD_BG = colors.bg.base;
const BORDER = "#151515";
const AUTO_REFRESH_MS = 10000;
const EPIC_TARGET = 100_000_000;

// Dataset metadata for labels and targets
const DATASET_INFO: Record<string, { label: string; total: number; color: string }> = {
  glint360k: { label: "Glint360K", total: 17_100_000, color: CYAN },
  webface4m: { label: "WebFace4M", total: 4_200_000, color: colors.brand.orange },
  satellite: { label: "Satellite Crawl", total: 50_000_000, color: AMBER },
  laion: { label: "LAION-Face", total: 50_000_000, color: PURPLE },
  ms1mv3: { label: "MS1MV3", total: 5_200_000, color: GREEN },
  ms1mv2: { label: "MS1MV2", total: 5_800_000, color: MAGENTA },
  vggface2: { label: "VGGFace2", total: 3_310_000, color: colors.brand.blue },
  vggface2_wds: { label: "VGGFace2-WDS", total: 3_310_000, color: colors.brand.blue },
  casia: { label: "CASIA-WebFace", total: 500_000, color: "#6366F1" },
  imdb_wiki: { label: "IMDB-Wiki", total: 512_000, color: "#8B5CF6" },
  celeba: { label: "CelebA", total: 200_000, color: "#EC4899" },
  wikidata: { label: "Wikidata", total: 1_000_000, color: "#8B5CF6" },
};

interface DatasetProgress {
  status: "pending" | "running" | "completed" | "failed";
  description?: string;
  indexed?: number;
  processed?: number;
  failed?: number;
  rate?: number;
  elapsedSec?: number;
  completedAt?: number;
  startedAt?: number;
  shards?: number;
  error?: string;
}

interface AgrovisionState {
  phase: string;
  epoch: number | null;
  totalEpochs: number | null;
  batch: number | null;
  totalBatches: number | null;
  loss: number | null;
  acc: number | null;
  valLoss: number | null;
  valAcc: number | null;
  bestAcc: number | null;
  rate: number | null;
  gpuUtil: number | null;
  gpuMemUsed: number | null;
  gpuMemTotal: number | null;
  gpuTemp: number | null;
  modelReady: boolean;
  stale: boolean;
  error?: string;
  timestamp: number;
}

interface TrainingStats {
  qdrant: {
    status: string;
    points_count: number;
    indexed_vectors_count: number;
    segments_count: number;
  };
  sources?: Record<string, number>;
  datasetProgress?: Record<string, DatasetProgress>;
  agrovision?: AgrovisionState | null;
  pipeline?: {
    activeDataset: string | null;
    model: string;
    dimensions: number;
    gpuBatch: number;
    workers: number;
    qdrantBatch: number;
    qdrantWorkers?: number;
    shardProgress: number | null;
    shardsCompleted: number | null;
    totalShards: number | null;
    startShard: number | null;
    endShard: number | null;
    rate: number | null;
    indexed: number | null;
    processed: number | null;
    failed: number | null;
    skipped: number | null;
    elapsedSec: number | null;
    tensorQueueSize: number | null;
    embedQueueSize: number | null;
    errors: Array<{ time: number; msg: string }>;
    heartbeatAge: number | null;
    heartbeatAlive: boolean;
    datasetLabel?: string;
  };
  gpu?: {
    gpu_util: number;
    gpu_mem_used: number;
    gpu_mem_total: number;
    gpu_temp: number;
  } | null;
  vast: {
    id: number;
    status: string;
    gpu: string;
    gpu_util: number;
    gpu_temp: number;
    cost_per_hr: number;
    uptime_hrs: string | null;
    est_cost: number | null;
    ssh: string;
    mem_usage_gb: string | null;
    disk_usage_gb: number | null;
    disk_space_gb: number | null;
    geolocation: string | null;
  } | null;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SKIA PARTICLE FIELD — flowing data particles
// ═══════════════════════════════════════════════════════════════════════════════
interface ParticleData {
  x: number;
  y: number;
  speed: number;
  size: number;
  opacity: number;
  drift: number;
}

function Particle({
  p,
  i,
  clock,
  h,
}: {
  p: ParticleData;
  i: number;
  clock: Animated.SharedValue<number>;
  h: number;
}) {
  const cy = useDerivedValue(() => {
    const t = clock.value / 16;
    return (p.y + t * p.speed) % h;
  });
  const cx = useDerivedValue(() => {
    const t = clock.value / 16;
    return p.x + Math.sin(t * 0.01 + i) * 20 * p.drift;
  });
  const opacity = useDerivedValue(() => {
    const y = (p.y + (clock.value / 16) * p.speed) % h;
    const fade = y < 40 ? y / 40 : y > h - 40 ? (h - y) / 40 : 1;
    return p.opacity * fade;
  });

  return <Circle cx={cx} cy={cy} r={p.size} opacity={opacity} color={CYAN} />;
}

function ParticleField({ width: w, height: h }: { width: number; height: number }) {
  const particles = useMemo(() => {
    const pts: ParticleData[] = [];
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

  const clock = useSharedValue(0);
  useFrameCallback((info) => {
    clock.value = info.timeSinceFirstFrame;
  });

  return (
    <Canvas style={{ width: w, height: h, position: "absolute", top: 0, left: 0 }}>
      {particles.map((p, i) => (
        <Particle key={i} p={p} i={i} clock={clock} h={h} />
      ))}
    </Canvas>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SKIA SCANLINE — CRT sweep effect
// ═══════════════════════════════════════════════════════════════════════════════
function SkiaScanline({ width: w, height: h }: { width: number; height: number }) {
  const clock = useSharedValue(0);
  useFrameCallback((info) => {
    clock.value = info.timeSinceFirstFrame;
  });

  const y = useDerivedValue(() => {
    return (clock.value / 8) % (h + 100) - 50;
  });

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
        <Text style={{ color: colors.gray[800], fontSize: 10, fontFamily: "monospace" }}>
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
      <SkLine key={i} p1={vec(pad, gy)} p2={vec(w - pad, gy)} color=colors.gray[850] strokeWidth={0.5} />
    );
  }

  return (
    <Canvas style={{ width: w, height: h }}>
      {gridLines}
      <Path path={fillPathStr} opacity={0.15}>
        <SkGrad start={vec(0, pad)} end={vec(0, h)} colors={[color, "transparent"]} />
      </Path>
      <Path path={pathStr} style="stroke" strokeWidth={2} strokeCap="round" strokeJoin="round" color={color} />
      <Path path={pathStr} style="stroke" strokeWidth={4} strokeCap="round" strokeJoin="round" color={color} opacity={0.2}>
        <Blur blur={4} />
      </Path>
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
          backgroundColor: active ? color : colors.gray[600],
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
          <Text style={{ color: colors.gray[600], fontSize: 9, fontFamily: "monospace" }}>{label}</Text>
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
          { color: colors.gray[600], fontSize: 9, fontFamily: "monospace" },
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
          color: colors.gray[500],
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
// SOURCE BAR — mini horizontal bar for per-source breakdown
// ═══════════════════════════════════════════════════════════════════════════════
function SourceBar({
  label,
  count,
  total,
  color,
  active,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
  active: boolean;
}) {
  const pct = total > 0 ? Math.min((count / total) * 100, 100) : 0;
  return (
    <View style={{ marginVertical: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {active && <PulsingGlow active={true} color={color} />}
          <Text style={{ color: active ? color : colors.gray[500], fontSize: 9, fontFamily: "monospace", fontWeight: active ? "bold" : "normal" }}>
            {label}
          </Text>
        </View>
        <Text style={{ color: active ? color : colors.gray[600], fontSize: 9, fontFamily: "monospace" }}>
          {formatCompact(count)}
        </Text>
      </View>
      <View style={{ height: 2, backgroundColor: "#0D0D0D", borderRadius: 1, overflow: "hidden" }}>
        <View
          style={{
            height: "100%",
            width: `${pct}%`,
            backgroundColor: color,
            borderRadius: 1,
            opacity: active ? 1 : 0.4,
          }}
        />
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFO ROW + SECTION
// ═══════════════════════════════════════════════════════════════════════════════
function InfoRow({ label, value, color = colors.gray[300] }: { label: string; value: string; color?: string }) {
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
  const insets = useSafeAreaInsets();
  const [stats, setStats] = useState<TrainingStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [startPoints, setStartPoints] = useState<number | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const prevIndexedRef = useRef<number | null>(null);
  const [deltaRate, setDeltaRate] = useState<number>(0);

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

      // Compute delta rate from pipeline indexed count (smoother than Qdrant point deltas)
      const pipelineIndexed = data.pipeline?.indexed || 0;
      if (pipelineIndexed > 0 && prevIndexedRef.current !== null && prevIndexedRef.current > 0) {
        const idxDiff = pipelineIndexed - prevIndexedRef.current;
        if (idxDiff > 0) {
          setDeltaRate(idxDiff / (AUTO_REFRESH_MS / 60000));
        }
      }
      prevIndexedRef.current = pipelineIndexed;
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
  const sources = stats?.sources || {};
  const pipeline = stats?.pipeline;
  const activeDataset = pipeline?.activeDataset || null;
  const activeInfo = activeDataset ? DATASET_INFO[activeDataset] : null;

  // Pipeline rate: only show if heartbeat is alive (not stale)
  const heartbeatAlive = pipeline?.heartbeatAlive ?? false;
  const serverRate = heartbeatAlive ? (pipeline?.rate || 0) : 0;

  const sessionRate =
    startPoints !== null && startTime !== null && stats
      ? (points - startPoints) / ((Date.now() - startTime) / 60000)
      : 0;

  const displayRate = serverRate > 0 ? serverRate : (heartbeatAlive ? sessionRate : 0);

  const recentRate =
    history.length >= 2
      ? (history[history.length - 1] - history[history.length - 2]) / (AUTO_REFRESH_MS / 60000)
      : 0;

  const costPerHr = stats?.vast?.cost_per_hr || 0;
  const uptimeHrs = parseFloat(stats?.vast?.uptime_hrs || "0");
  const estCost = stats?.vast?.est_cost || costPerHr * uptimeHrs;

  // ETA: remaining faces in active dataset / current rate
  const activeTotal = activeInfo?.total || EPIC_TARGET;
  const activeCount = activeDataset ? (sources[activeDataset] || 0) : points;
  const remaining = activeTotal - activeCount;
  const etaMinutes = displayRate > 0 && remaining > 0 ? remaining / displayRate : 0;
  const etaStr =
    !activeDataset && !heartbeatAlive
      ? "—"
      : etaMinutes <= 0
      ? "DONE"
      : etaMinutes < 60
      ? `${Math.round(etaMinutes)}m`
      : etaMinutes < 1440
      ? `${Math.floor(etaMinutes / 60)}h ${Math.round(etaMinutes % 60)}m`
      : `${(etaMinutes / 1440).toFixed(1)}d`;

  const costPerFace =
    estCost > 0 && points > (startPoints || 0) && startPoints !== null
      ? estCost / (points - startPoints)
      : 0;

  // GPU stats from heartbeat (real-time from nvidia-smi on the instance)
  const gpuUtil = stats?.gpu?.gpu_util ?? null;
  const gpuTemp = stats?.gpu?.gpu_temp ?? null;
  const gpuMemUsed = stats?.gpu?.gpu_mem_used ?? null;
  const gpuMemTotal = stats?.gpu?.gpu_mem_total ?? null;

  // Heartbeat status
  const heartbeatAge = pipeline?.heartbeatAge ?? null;

  // Pipeline errors
  const pipelineErrors = pipeline?.errors ?? [];

  const vastRunning = stats?.vast?.status === "running";
  // Qdrant is operational when green OR yellow (yellow = HNSW indexing disabled during bulk upload)
  const qdrantOnline = stats?.qdrant?.status === "green" || stats?.qdrant?.status === "yellow";
  const qdrantColor = stats?.qdrant?.status === "green" ? GREEN : stats?.qdrant?.status === "yellow" ? AMBER : RED;
  const pad = isPhone ? 14 : 22;
  const chartW = SCREEN_W - pad * 2 - 2;

  const tickerEvents = activityLog.length > 0
    ? activityLog
    : [
        activeDataset
          ? `Embedding ${activeInfo?.label || activeDataset} @ ${formatCompact(displayRate)}/min`
          : "Pipeline idle — no active dataset",
        `Qdrant: ${formatCompact(points)} total embeddings`,
        vastRunning ? `GPU: ${stats?.vast?.gpu} @ ${formatCost(costPerHr)}/hr` : "No GPU instance",
      ];

  const timeStr = lastRefresh
    ? `${lastRefresh.getHours().toString().padStart(2, "0")}:${lastRefresh.getMinutes().toString().padStart(2, "0")}:${lastRefresh.getSeconds().toString().padStart(2, "0")}`
    : "——:——:——";

  // Shard progress text — show current shard number
  const shardText = pipeline?.shardProgress != null
    ? pipeline?.startShard != null && pipeline?.endShard != null
      ? `${pipeline.shardProgress} (${pipeline.startShard}→${pipeline.endShard - 1})`
      : `${pipeline.shardProgress}`
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: "#030303" }}>
      <StatusBar style="light" />

      {/* ── Skia particle field ──────────────────────────────────── */}
      <ParticleField width={SCREEN_W} height={SCREEN_H} />

      {/* ── Skia scanline ────────────────────────────────────────── */}
      <SkiaScanline width={SCREEN_W} height={SCREEN_H} />

      {/* ── Top command bar ────────────────────────────────────────── */}
      <View style={[s.topBar, { paddingTop: insets.top, paddingHorizontal: pad }]}>
        <Pressable onPress={() => router.back()} hitSlop={20} style={{ padding: 8 }}>
          <Text style={{ color: colors.gray[400], fontSize: 22, fontFamily: "monospace" }}>{"◁"}</Text>
        </Pressable>

        <View style={{ flex: 1, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}>
          <PulsingGlow active={vastRunning} color={vastRunning ? GREEN : colors.gray[600]} />
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
          <PulsingGlow active={qdrantOnline} color={qdrantColor} />
        </View>

        <Text style={{ color: colors.gray[800], fontSize: 9, fontFamily: "monospace" }}>{timeStr}</Text>
      </View>

      <GroupNav group="cipher" />

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
              LINK DEGRADED: {error}
            </Text>
          </Animated.View>
        )}

        {/* ── HERO: Odometer ──────────────────────────────────────── */}
        <Animated.View entering={FadeInDown.duration(600)} style={s.heroCard}>
          <Text style={s.heroLabel}>FACE DATABASE</Text>
          <OdometerNumber value={formatFull(points)} color={CYAN} size={36} />
          <Text style={s.heroSub}>EMBEDDINGS IN QDRANT</Text>

          {/* Active dataset progress */}
          {activeDataset && activeInfo && (
            <NeonProgressBar
              current={activeCount}
              target={activeTotal}
              color={activeInfo.color}
              label={`ACTIVE: ${activeInfo.label} — ${formatCompact(activeCount)} / ${formatCompact(activeTotal)}`}
            />
          )}
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
            value={displayRate > 0 ? `${Math.round(displayRate).toLocaleString()}` : "—"}
            label="FACES/MIN"
            sublabel={serverRate > 0 ? "gpu pipeline" : "client est."}
            color={GREEN}
            delay={100}
          />
          <GlowCard
            value={deltaRate > 0 ? `${Math.round(deltaRate).toLocaleString()}` : recentRate > 0 ? `${Math.round(recentRate).toLocaleString()}` : "—"}
            label="DELTA/MIN"
            sublabel={deltaRate > 0 ? "gpu indexed" : "last interval"}
            color={AMBER}
            delay={200}
          />
          <GlowCard
            value={etaStr}
            label={activeInfo ? `ETA ${activeInfo.label.split(" ")[0].toUpperCase()}` : "ETA"}
            sublabel={shardText ? `shard ${shardText}` : activeDataset || "epic"}
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

        {/* ── Dataset Progress ─────────────────────────────────────── */}
        <SectionDivider title="DATASETS" icon="◈" />
        <View style={[s.panel, { padding: 14 }]}>
          {(() => {
            const dp = stats?.datasetProgress || {};
            // Build combined list: known datasets from DATASET_INFO + any extras from progress
            const allKeys = new Set([
              ...Object.keys(DATASET_INFO).filter(k => k !== "satellite" && k !== "laion" && k !== "wikidata"),
              ...Object.keys(dp),
            ]);
            const entries = Array.from(allKeys).map(key => {
              const info = DATASET_INFO[key] || { label: key, total: 0, color: "#666" };
              const prog = dp[key];
              const count = sources[key] || prog?.indexed || 0;
              const status = prog?.status || (count > 0 ? "completed" : "pending");
              return { key, info, prog, count, status };
            });
            // Sort: running first, then completed (by count desc), then failed, then pending
            const order: Record<string, number> = { running: 0, completed: 1, failed: 2, pending: 3 };
            entries.sort((a, b) => {
              const oa = order[a.status] ?? 4, ob = order[b.status] ?? 4;
              if (oa !== ob) return oa - ob;
              return b.count - a.count;
            });

            return entries.map(({ key, info, prog, count, status }) => {
              const statusIcon = status === "completed" ? "✓" : status === "running" ? "▶" : status === "failed" ? "✗" : "·";
              const statusColor = status === "completed" ? GREEN : status === "running" ? CYAN : status === "failed" ? RED : colors.gray[600];
              const pct = info.total > 0 ? Math.min(100, (count / info.total) * 100) : 0;
              const rateStr = prog?.rate ? `${prog.rate.toLocaleString()}/min` : "";
              const timeStr = prog?.elapsedSec ? (prog.elapsedSec > 3600 ? `${(prog.elapsedSec / 3600).toFixed(1)}h` : `${Math.round(prog.elapsedSec / 60)}m`) : "";

              return (
                <View key={key} style={{ marginBottom: 10 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
                      <Text style={{ color: statusColor, fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>{statusIcon}</Text>
                      <Text style={{ color: "#999", fontSize: 10, fontFamily: "monospace" }} numberOfLines={1}>{info.label}</Text>
                      {status === "running" && key === activeDataset && (
                        <PulsingGlow active={true} color={CYAN} />
                      )}
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      {rateStr ? <Text style={{ color: colors.gray[600], fontSize: 8, fontFamily: "monospace" }}>{rateStr}</Text> : null}
                      {timeStr ? <Text style={{ color: colors.gray[600], fontSize: 8, fontFamily: "monospace" }}>{timeStr}</Text> : null}
                      <Text style={{ color: statusColor, fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
                        {count > 0 ? formatCompact(count) : "—"}
                      </Text>
                    </View>
                  </View>
                  {/* Progress bar */}
                  <View style={{ height: 3, backgroundColor: colors.gray[850], borderRadius: 2 }}>
                    <View
                      style={{
                        height: 3,
                        width: `${pct}%`,
                        backgroundColor: status === "completed" ? GREEN : status === "running" ? info.color : status === "failed" ? RED : "#222",
                        borderRadius: 2,
                      }}
                    />
                  </View>
                  {prog?.error && (
                    <Text style={{ color: RED, fontSize: 8, fontFamily: "monospace", marginTop: 2 }}>{prog.error}</Text>
                  )}
                </View>
              );
            });
          })()}
          {/* Satellite / untracked remainder */}
          {(sources["satellite"] || 0) > 0 && (
            <View style={{ marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.gray[850] }}>
              <SourceBar
                label="Satellite + Legacy"
                count={sources["satellite"]}
                total={50_000_000}
                color={AMBER}
                active={false}
              />
            </View>
          )}
        </View>

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
                <Text style={{ color: colors.gray[800], fontSize: 9, fontFamily: "monospace" }}>
                  #{stats.vast.id}
                </Text>
              </View>
              <InfoRow label="GPU" value={stats.vast.gpu} color={CYAN} />
              {gpuUtil !== null && (
                <InfoRow
                  label="GPU Util"
                  value={`${gpuUtil}%`}
                  color={gpuUtil > 80 ? GREEN : gpuUtil > 0 ? AMBER : RED}
                />
              )}
              {gpuTemp !== null && (
                <InfoRow
                  label="GPU Temp"
                  value={`${gpuTemp}°C`}
                  color={gpuTemp > 80 ? RED : gpuTemp > 65 ? AMBER : GREEN}
                />
              )}
              {gpuMemUsed !== null && gpuMemTotal !== null && (
                <InfoRow
                  label="VRAM"
                  value={`${(gpuMemUsed / 1024).toFixed(1)}G / ${(gpuMemTotal / 1024).toFixed(0)}G`}
                  color={CYAN}
                />
              )}
              {stats.vast.geolocation && (
                <InfoRow label="Location" value={stats.vast.geolocation} />
              )}
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
              <Text style={{ color: colors.gray[800], fontSize: 10, fontFamily: "monospace" }}>
                NO ACTIVE GPU INSTANCE
              </Text>
            </View>
          )}
        </View>

        {/* ── AgroVisión Training ─────────────────────────────────── */}
        {stats?.agrovision && (
          <>
            <SectionDivider title="AGROVISION TRAINING" icon="🌿" />
            <View style={[s.panel, stats.agrovision.phase === "training" && { borderColor: GREEN + "15" }]}>
              <View style={s.panelHeader}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <PulsingGlow
                    active={stats.agrovision.phase === "training"}
                    color={
                      stats.agrovision.phase === "complete" ? GREEN
                      : stats.agrovision.phase === "training" ? CYAN
                      : stats.agrovision.phase === "unreachable" ? RED
                      : AMBER
                    }
                  />
                  <Text
                    style={{
                      color:
                        stats.agrovision.phase === "complete" ? GREEN
                        : stats.agrovision.phase === "training" ? CYAN
                        : stats.agrovision.phase === "unreachable" ? RED
                        : AMBER,
                      fontSize: 11,
                      fontFamily: "monospace",
                      fontWeight: "bold",
                      textTransform: "uppercase",
                    }}
                  >
                    {stats.agrovision.phase === "training"
                      ? `EPOCH ${stats.agrovision.epoch}/${stats.agrovision.totalEpochs}`
                      : stats.agrovision.phase}
                  </Text>
                </View>
                {stats.agrovision.bestAcc !== null && (
                  <Text style={{ color: GREEN + "80", fontSize: 9, fontFamily: "monospace" }}>
                    BEST: {stats.agrovision.bestAcc.toFixed(1)}%
                  </Text>
                )}
              </View>

              {/* Epoch progress bar */}
              {stats.agrovision.epoch !== null && stats.agrovision.totalEpochs !== null && (
                <View style={{ paddingHorizontal: 14, paddingTop: 10 }}>
                  <NeonProgressBar
                    current={
                      stats.agrovision.batch && stats.agrovision.totalBatches
                        ? (stats.agrovision.epoch - 1) + (stats.agrovision.batch / stats.agrovision.totalBatches)
                        : stats.agrovision.epoch
                    }
                    target={stats.agrovision.totalEpochs}
                    color={CYAN}
                    label={
                      stats.agrovision.batch
                        ? `BATCH ${stats.agrovision.batch}/${stats.agrovision.totalBatches}`
                        : `EPOCH ${stats.agrovision.epoch}/${stats.agrovision.totalEpochs}`
                    }
                  />
                </View>
              )}

              <InfoRow label="Model" value="DINOv2-Small + ArcFace" color={CYAN} />
              <InfoRow label="Task" value="Plant Disease Detection (46 classes)" />
              {stats.agrovision.acc !== null && (
                <InfoRow
                  label="Train Acc"
                  value={`${stats.agrovision.acc.toFixed(1)}%`}
                  color={stats.agrovision.acc > 90 ? GREEN : stats.agrovision.acc > 70 ? AMBER : RED}
                />
              )}
              {stats.agrovision.valAcc !== null && (
                <InfoRow
                  label="Val Acc"
                  value={`${stats.agrovision.valAcc.toFixed(1)}%`}
                  color={stats.agrovision.valAcc > 90 ? GREEN : stats.agrovision.valAcc > 70 ? AMBER : RED}
                />
              )}
              {stats.agrovision.loss !== null && (
                <InfoRow label="Loss" value={stats.agrovision.loss.toFixed(4)} />
              )}
              {stats.agrovision.rate !== null && (
                <InfoRow label="Speed" value={`${stats.agrovision.rate} img/s`} color={CYAN} />
              )}
              {stats.agrovision.gpuUtil !== null && (
                <InfoRow
                  label="GPU Util"
                  value={`${stats.agrovision.gpuUtil}%`}
                  color={stats.agrovision.gpuUtil > 50 ? GREEN : stats.agrovision.gpuUtil > 0 ? AMBER : RED}
                />
              )}
              {stats.agrovision.gpuTemp !== null && (
                <InfoRow
                  label="GPU Temp"
                  value={`${stats.agrovision.gpuTemp}°C`}
                  color={stats.agrovision.gpuTemp > 80 ? RED : stats.agrovision.gpuTemp > 65 ? AMBER : GREEN}
                />
              )}
              {stats.agrovision.gpuMemUsed !== null && stats.agrovision.gpuMemTotal !== null && (
                <InfoRow
                  label="VRAM"
                  value={`${(stats.agrovision.gpuMemUsed / 1024).toFixed(1)}G / ${(stats.agrovision.gpuMemTotal / 1024).toFixed(0)}G`}
                  color={CYAN}
                />
              )}
              {stats.agrovision.modelReady && (
                <InfoRow label="ONNX Model" value="READY" color={GREEN} />
              )}
              {stats.agrovision.error && (
                <InfoRow label="Error" value={stats.agrovision.error} color={RED} />
              )}
            </View>
          </>
        )}

        {/* ── Qdrant ──────────────────────────────────────────────── */}
        <SectionDivider title="VECTOR DATABASE" icon="◆" />
        <View style={[s.panel, qdrantOnline && { borderColor: qdrantColor + "10" }]}>
          <View style={s.panelHeader}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <PulsingGlow active={qdrantOnline} color={qdrantColor} />
              <Text
                style={{
                  color: qdrantColor,
                  fontSize: 11,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  textTransform: "uppercase",
                }}
              >
                {stats?.qdrant?.status || "OFFLINE"}
              </Text>
              {stats?.qdrant?.status === "yellow" && (
                <Text style={{ color: colors.gray[600], fontSize: 8, fontFamily: "monospace" }}>
                  (HNSW disabled)
                </Text>
              )}
            </View>
            <Text style={{ color: colors.gray[800], fontSize: 9, fontFamily: "monospace" }}>QDRANT</Text>
          </View>
          <InfoRow label="Total Vectors" value={formatFull(points)} color={CYAN} />
          <InfoRow label="Indexed (HNSW)" value={indexed > 0 ? formatFull(indexed) : "disabled"} color={indexed > 0 ? GREEN : colors.gray[600]} />
          <InfoRow label="Segments" value={String(stats?.qdrant?.segments_count || 0)} />
          <InfoRow label="Dimensions" value={String(pipeline?.dimensions || 512)} />
          <InfoRow label="Distance" value="Cosine" />
        </View>

        {/* ── Pipeline ────────────────────────────────────────────── */}
        <SectionDivider title="PIPELINE" icon="▶" />
        <View style={[s.panel, heartbeatAlive && { borderColor: GREEN + "10" }]}>
          <View style={s.panelHeader}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <PulsingGlow active={heartbeatAlive} color={heartbeatAlive ? GREEN : RED} />
              <Text
                style={{
                  color: heartbeatAlive ? GREEN : heartbeatAge !== null ? RED : colors.gray[600],
                  fontSize: 10,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                }}
              >
                {heartbeatAlive ? "HEARTBEAT LIVE" : heartbeatAge !== null ? `STALE (${heartbeatAge}s ago)` : "NO HEARTBEAT"}
              </Text>
            </View>
            {pipeline?.elapsedSec ? (
              <Text style={{ color: colors.gray[800], fontSize: 9, fontFamily: "monospace" }}>
                {pipeline.elapsedSec > 3600 ? `${(pipeline.elapsedSec / 3600).toFixed(1)}h` : `${Math.round(pipeline.elapsedSec / 60)}m`} elapsed
              </Text>
            ) : null}
          </View>
          <InfoRow
            label="Active Source"
            value={activeInfo?.label || pipeline?.datasetLabel || (activeDataset || "None")}
            color={activeInfo?.color || CYAN}
          />
          <InfoRow label="Model" value={pipeline?.model || "ArcFace w600k_r50"} />
          <InfoRow label="GPU Batch" value={String(pipeline?.gpuBatch || 256)} />
          <InfoRow label="Decode Workers" value={String(pipeline?.workers || "—")} />
          <InfoRow label="Qdrant Batch" value={String(pipeline?.qdrantBatch || 2000)} />
          <InfoRow label="Qdrant Workers" value={String(pipeline?.qdrantWorkers || 4)} />
          {shardText && <InfoRow label="Current Shard" value={shardText} color={AMBER} />}
          {pipeline?.shardsCompleted != null && pipeline?.totalShards != null && (
            <InfoRow
              label="Shards Done"
              value={`${pipeline.shardsCompleted} / ${pipeline.totalShards}`}
              color={pipeline.shardsCompleted === pipeline.totalShards ? GREEN : CYAN}
            />
          )}
          {(pipeline?.tensorQueueSize != null || pipeline?.embedQueueSize != null) && (
            <InfoRow
              label="Queues"
              value={`T:${pipeline?.tensorQueueSize ?? 0} E:${pipeline?.embedQueueSize ?? 0}`}
              color={AMBER}
            />
          )}
          {pipeline?.failed != null && pipeline.failed > 0 && (
            <InfoRow label="Failed" value={String(pipeline.failed)} color={RED} />
          )}
          {pipeline?.skipped != null && pipeline.skipped > 0 && (
            <InfoRow label="Shards Skipped" value={String(pipeline.skipped)} color={AMBER} />
          )}
          <InfoRow label="Refresh" value={`${AUTO_REFRESH_MS / 1000}s`} />
        </View>

        {/* ── Errors ──────────────────────────────────────────────── */}
        {pipelineErrors.length > 0 && (
          <>
            <SectionDivider title="ERRORS" icon="⚠" />
            <View style={[s.panel, { borderColor: RED + "20", padding: 12 }]}>
              {pipelineErrors.map((err, i) => (
                <Text
                  key={i}
                  style={{ color: RED + "90", fontSize: 8, fontFamily: "monospace", marginBottom: 4 }}
                  numberOfLines={2}
                >
                  {new Date(err.time * 1000).toLocaleTimeString()} — {err.msg}
                </Text>
              ))}
            </View>
          </>
        )}

        {/* ── Topology ────────────────────────────────────────────── */}
        <SectionDivider title="TOPOLOGY" icon="◎" />
        <View style={[s.panel, { padding: 14 }]}>
          <Text style={s.topoText}>
            {`┌─ Vast.ai RTX 3090 ───────┐    ┌─ GCP VM ──────┐\n`}
            {`│  Stream Glint360K shards  │───▶│  Qdrant :6333  │\n`}
            {`│  Decompress + Decode (8T) │    │  512-dim HNSW  │\n`}
            {`│  ArcFace GPU (batch 256)  │    └────────────────┘\n`}
            {`│  4x Qdrant insert pool    │           ▲\n`}
            {`└──────────────────────────-┘           │\n`}
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
    minHeight: layout.topBarHeight,
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: 8,
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
    color: colors.gray[800],
    fontSize: 9,
    fontFamily: "monospace",
    letterSpacing: 4,
    marginBottom: 8,
  },
  heroSub: {
    color: colors.gray[850],
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
    color: colors.gray[800],
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
    borderBottomColor: colors.bg.base,
  },
  infoLabel: {
    color: colors.gray[600],
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
    color: colors.gray[800],
    fontSize: 9,
    fontFamily: "monospace",
    lineHeight: 15,
  },
});
