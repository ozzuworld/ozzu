import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  Animated,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { getBridgeUrl } from "../lib/bridge-api";

const TOP_BAR_HEIGHT = 48;
const CYAN = "#06B6D4";
const GREEN = "#22C55E";
const AMBER = "#F59E0B";
const RED = "#EF4444";
const PURPLE = "#A855F7";
const CARD_BG = "#111111";
const BORDER = "#222";
const AUTO_REFRESH_MS = 15000;

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

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function PulsingDot({ color, active }: { color: string; active: boolean }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [active]);

  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        opacity: active ? pulse : 0.3,
      }}
    />
  );
}

function StatCard({
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
        borderColor: BORDER,
        borderRadius: 8,
        paddingVertical: large ? 16 : 12,
        paddingHorizontal: 12,
        alignItems: "center",
      }}
    >
      <Text
        style={{
          color,
          fontSize: large ? 28 : 22,
          fontFamily: "monospace",
          fontWeight: "bold",
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          color: "#737373",
          fontSize: 10,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 1,
          marginTop: 4,
        }}
      >
        {label}
      </Text>
      {sublabel ? (
        <Text
          style={{
            color: "#525252",
            fontSize: 9,
            fontFamily: "monospace",
            marginTop: 2,
          }}
        >
          {sublabel}
        </Text>
      ) : null}
    </View>
  );
}

function SectionHeader({ title, icon }: { title: string; icon: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginTop: 20,
        marginBottom: 10,
        paddingHorizontal: 4,
      }}
    >
      <Text style={{ fontSize: 14 }}>{icon}</Text>
      <Text
        style={{
          color: "#A3A3A3",
          fontSize: 11,
          fontFamily: "monospace",
          fontWeight: "bold",
          letterSpacing: 2,
        }}
      >
        {title}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: BORDER, marginLeft: 8 }} />
    </View>
  );
}

function InfoRow({
  label,
  value,
  color = "#D4D4D4",
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
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A1A",
      }}
    >
      <Text
        style={{
          color: "#737373",
          fontSize: 11,
          fontFamily: "monospace",
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color,
          fontSize: 11,
          fontFamily: "monospace",
          fontWeight: "bold",
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function ProgressBar({
  current,
  target,
  color = CYAN,
}: {
  current: number;
  target: number;
  color?: string;
}) {
  const pct = Math.min((current / target) * 100, 100);
  return (
    <View style={{ marginVertical: 8 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <Text
          style={{
            color: "#737373",
            fontSize: 10,
            fontFamily: "monospace",
          }}
        >
          {formatNumber(current)} / {formatNumber(target)}
        </Text>
        <Text
          style={{
            color,
            fontSize: 10,
            fontFamily: "monospace",
            fontWeight: "bold",
          }}
        >
          {pct.toFixed(1)}%
        </Text>
      </View>
      <View
        style={{
          height: 6,
          backgroundColor: "#1A1A1A",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: "100%",
            width: `${pct}%`,
            backgroundColor: color,
            borderRadius: 3,
          }}
        />
      </View>
    </View>
  );
}

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

  const fetchStats = useCallback(async () => {
    try {
      const url = getBridgeUrl();
      const res = await fetch(`${url}/api/training-stats`, {
        headers: { "Content-Type": "application/json" }
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data: TrainingStats = await res.json();
      setStats(data);
      setError(null);
      setLastRefresh(new Date());

      // Track history for rate calculation
      setHistory((prev) => {
        const next = [...prev, data.qdrant.points_count].slice(-20);
        return next;
      });

      // Track starting point for session rate
      if (startPoints === null) {
        setStartPoints(data.qdrant.points_count);
        setStartTime(Date.now());
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [startPoints]);

  // Auto-refresh
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

  // Calculate rates
  const sessionRate =
    startPoints !== null && startTime !== null && stats
      ? ((stats.qdrant.points_count - startPoints) /
          ((Date.now() - startTime) / 60000))
      : 0;

  const recentRate =
    history.length >= 2
      ? ((history[history.length - 1] - history[history.length - 2]) /
          (AUTO_REFRESH_MS / 60000))
      : 0;

  const TARGET_FACES = 1_000_000; // Phase 1 target
  const EPIC_TARGET = 100_000_000; // Epic target
  const points = stats?.qdrant?.points_count || 0;
  const costPerHr = stats?.vast?.cost_per_hr || 0;
  const uptimeHrs = parseFloat(stats?.vast?.uptime_hrs || "0");
  const estCost = stats?.vast?.est_cost || costPerHr * uptimeHrs;

  // ETA calculation
  const etaMinutes = sessionRate > 0 ? (TARGET_FACES - points) / sessionRate : 0;
  const etaStr =
    etaMinutes <= 0
      ? "--"
      : etaMinutes < 60
      ? `${Math.round(etaMinutes)}m`
      : etaMinutes < 1440
      ? `${Math.floor(etaMinutes / 60)}h ${Math.round(etaMinutes % 60)}m`
      : `${(etaMinutes / 1440).toFixed(1)}d`;

  const pad = isPhone ? 16 : 24;

  return (
    <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      <StatusBar style="light" />

      {/* Top bar */}
      <View
        style={{
          height: TOP_BAR_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: pad,
          borderBottomWidth: 1,
          borderBottomColor: BORDER,
        }}
      >
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text
            style={{
              color: "#525252",
              fontSize: 18,
              fontFamily: "monospace",
            }}
          >
            {"<"}
          </Text>
        </Pressable>
        <View style={{ flex: 1, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}>
          <Text style={{ fontSize: 14 }}>🧠</Text>
          <Text
            style={{
              color: CYAN,
              fontSize: 12,
              fontFamily: "monospace",
              fontWeight: "bold",
              letterSpacing: 3,
            }}
          >
            TRAINING
          </Text>
          <PulsingDot
            color={stats?.vast?.status === "running" ? GREEN : "#525252"}
            active={stats?.vast?.status === "running"}
          />
        </View>
        <Text
          style={{
            color: "#404040",
            fontSize: 9,
            fontFamily: "monospace",
          }}
        >
          {lastRefresh
            ? `${lastRefresh.getHours().toString().padStart(2, "0")}:${lastRefresh.getMinutes().toString().padStart(2, "0")}:${lastRefresh.getSeconds().toString().padStart(2, "0")}`
            : "--:--:--"}
        </Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: pad, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={CYAN}
          />
        }
      >
        {error && (
          <View
            style={{
              backgroundColor: "#1C0A0A",
              borderWidth: 1,
              borderColor: "#7F1D1D",
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
            }}
          >
            <Text
              style={{
                color: RED,
                fontSize: 11,
                fontFamily: "monospace",
              }}
            >
              Connection error: {error}
            </Text>
          </View>
        )}

        {/* Hero: Total faces */}
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: CYAN + "40",
            borderRadius: 12,
            padding: 20,
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <Text
            style={{
              color: "#525252",
              fontSize: 10,
              fontFamily: "monospace",
              letterSpacing: 2,
              marginBottom: 4,
            }}
          >
            FACE DATABASE
          </Text>
          <Text
            style={{
              color: CYAN,
              fontSize: 42,
              fontFamily: "monospace",
              fontWeight: "bold",
            }}
          >
            {formatNumber(points)}
          </Text>
          <Text
            style={{
              color: "#525252",
              fontSize: 10,
              fontFamily: "monospace",
              marginTop: 2,
            }}
          >
            embeddings in Qdrant
          </Text>
          <ProgressBar
            current={points}
            target={TARGET_FACES}
            color={CYAN}
          />
          <Text
            style={{
              color: "#404040",
              fontSize: 9,
              fontFamily: "monospace",
            }}
          >
            Phase 1 target: {formatNumber(TARGET_FACES)} | Epic: {formatNumber(EPIC_TARGET)}
          </Text>
        </View>

        {/* Rate cards */}
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
          <StatCard
            value={recentRate > 0 ? `${Math.round(recentRate)}` : "--"}
            label="FACES/MIN"
            sublabel="current rate"
            color={GREEN}
          />
          <StatCard
            value={sessionRate > 0 ? `${Math.round(sessionRate)}` : "--"}
            label="AVG/MIN"
            sublabel="session avg"
            color={AMBER}
          />
          <StatCard
            value={etaStr}
            label="ETA 1M"
            sublabel="to Phase 1"
            color={PURPLE}
          />
        </View>

        {/* GPU Instance */}
        <SectionHeader title="GPU INSTANCE" icon="🖥️" />
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: BORDER,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {stats?.vast ? (
            <>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: "#1A1A1A",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <PulsingDot
                    color={stats.vast.status === "running" ? GREEN : AMBER}
                    active={stats.vast.status === "running"}
                  />
                  <Text
                    style={{
                      color: stats.vast.status === "running" ? GREEN : AMBER,
                      fontSize: 11,
                      fontFamily: "monospace",
                      fontWeight: "bold",
                      textTransform: "uppercase",
                    }}
                  >
                    {stats.vast.status}
                  </Text>
                </View>
                <Text
                  style={{
                    color: "#737373",
                    fontSize: 10,
                    fontFamily: "monospace",
                  }}
                >
                  Vast.ai #{stats.vast.id}
                </Text>
              </View>
              <InfoRow label="GPU" value={stats.vast.gpu} color={CYAN} />
              <InfoRow label="Cost/hr" value={formatCost(stats.vast.cost_per_hr)} />
              <InfoRow
                label="Uptime"
                value={stats.vast.uptime_hrs ? `${stats.vast.uptime_hrs}h` : "--"}
              />
              <InfoRow
                label="Est. Cost"
                value={formatCost(estCost)}
                color={estCost > 8 ? AMBER : GREEN}
              />
            </>
          ) : (
            <View style={{ padding: 20, alignItems: "center" }}>
              <Text
                style={{
                  color: "#525252",
                  fontSize: 11,
                  fontFamily: "monospace",
                }}
              >
                No GPU instance active
              </Text>
            </View>
          )}
        </View>

        {/* Qdrant */}
        <SectionHeader title="VECTOR DATABASE" icon="🔷" />
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: BORDER,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: "#1A1A1A",
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <PulsingDot
                color={stats?.qdrant?.status === "green" ? GREEN : RED}
                active={stats?.qdrant?.status === "green"}
              />
              <Text
                style={{
                  color: stats?.qdrant?.status === "green" ? GREEN : RED,
                  fontSize: 11,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  textTransform: "uppercase",
                }}
              >
                {stats?.qdrant?.status || "OFFLINE"}
              </Text>
            </View>
            <Text
              style={{
                color: "#737373",
                fontSize: 10,
                fontFamily: "monospace",
              }}
            >
              Qdrant
            </Text>
          </View>
          <InfoRow
            label="Total Points"
            value={formatNumber(stats?.qdrant?.points_count || 0)}
            color={CYAN}
          />
          <InfoRow
            label="Indexed"
            value={formatNumber(stats?.qdrant?.indexed_vectors_count || 0)}
            color={GREEN}
          />
          <InfoRow
            label="Segments"
            value={String(stats?.qdrant?.segments_count || 0)}
          />
          <InfoRow label="Dimensions" value="512" />
          <InfoRow label="Distance" value="Cosine" />
        </View>

        {/* Pipeline Info */}
        <SectionHeader title="PIPELINE" icon="⚡" />
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: BORDER,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <InfoRow label="Source" value="LAION-Face (50M)" />
          <InfoRow label="Extracted URLs" value="2.4M (16/128 parts)" />
          <InfoRow label="URL Hit Rate" value="~29%" color={AMBER} />
          <InfoRow label="Model" value="ArcFace buffalo_l" />
          <InfoRow label="Embedding" value="512-dim on GPU" />
          <InfoRow label="Workers" value="128 downloaders" />
          <InfoRow label="Auto-refresh" value={`${AUTO_REFRESH_MS / 1000}s`} />
        </View>

        {/* Architecture */}
        <SectionHeader title="ARCHITECTURE" icon="🏗️" />
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: BORDER,
            borderRadius: 8,
            padding: 12,
          }}
        >
          <Text
            style={{
              color: "#525252",
              fontSize: 10,
              fontFamily: "monospace",
              lineHeight: 16,
            }}
          >
            {`Vast.ai (RTX 3090)         GCP VM\n`}
            {`  Download URLs ---------> Qdrant :6333\n`}
            {`  ArcFace GPU embed       (SSH tunnel)\n`}
            {`  Batch insert              |\n`}
            {`                            v\n`}
            {`dev-01 (satellite)     Face Search API\n`}
            {`  4 crawlers -----------> Same Qdrant\n`}
            {`  ArcFace CPU embed       (VPN direct)`}
          </Text>
        </View>

        {/* Insights */}
        <SectionHeader title="INSIGHTS" icon="💡" />
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: 1,
            borderColor: BORDER,
            borderRadius: 8,
            padding: 12,
            gap: 8,
          }}
        >
          {[
            {
              title: "GPU vs CPU",
              body: "RTX 3090: 473 emb/sec. dev-01 i5 CPU: 17 emb/sec. GPU is 28x faster but download speed is the real bottleneck.",
            },
            {
              title: "Dead URLs",
              body: "LAION dataset is from 2022. ~25% of URLs are dead, ~40% have no detectable face. Only ~29% yield an indexed face.",
            },
            {
              title: "Cost Efficiency",
              body: "RTX 3090 at $0.10-0.24/hr is the sweet spot. Higher GPUs (A100, H100) waste money — download speed caps throughput at ~38K faces/min regardless.",
            },
            {
              title: "Scale Path",
              body: "Phase 1: LAION 2.4M URLs -> ~700K faces. Extracting 112 more parquet parts for ~15M URLs -> ~4.5M faces. Epic target: 100M via Common Crawl.",
            },
          ].map((insight) => (
            <View key={insight.title}>
              <Text
                style={{
                  color: CYAN,
                  fontSize: 11,
                  fontFamily: "monospace",
                  fontWeight: "bold",
                  marginBottom: 2,
                }}
              >
                {insight.title}
              </Text>
              <Text
                style={{
                  color: "#737373",
                  fontSize: 10,
                  fontFamily: "monospace",
                  lineHeight: 15,
                }}
              >
                {insight.body}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
