import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { StatusBadge } from "../components/StatusBadge";
import { TVPressable } from "../components/TVPressable";
import { usePhoneLayout } from "../lib/usePhoneLayout";
import { fetchUsageMetrics, fetchAnthropicUsage, type UsageMetrics, type AnthropicUsageData } from "../lib/bridge-api";
import { GroupNav } from "../components/GroupNav";
import { layout } from "../lib/design-tokens";
import { formatLongDuration } from "../lib/format";
const CYAN = "#06B6D4";
const CARD_BG = "#111111";
const BORDER = "#222";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}


// Stat card component
function StatCard({
  value,
  label,
  color = CYAN,
}: {
  value: string;
  label: string;
  color?: string;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: CARD_BG,
        borderWidth: 1,
        borderColor: BORDER,
        borderRadius: 8,
        paddingVertical: 12,
        paddingHorizontal: 8,
        alignItems: "center",
        minWidth: 80,
      }}
    >
      <Text
        style={{
          color,
          fontSize: 24,
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
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// Section header
function SectionHeader({ title }: { title: string }) {
  return (
    <Text
      style={{
        color: CYAN,
        fontSize: 11,
        fontFamily: "monospace",
        fontWeight: "bold",
        letterSpacing: 2,
        marginTop: 20,
        marginBottom: 8,
      }}
    >
      {title}
    </Text>
  );
}

// Metric row
function MetricRow({
  label,
  value,
  valueColor = "#E5E5E5",
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: "#1A1A1A",
      }}
    >
      <Text
        style={{
          color: "#737373",
          fontSize: 12,
          fontFamily: "monospace",
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: valueColor,
          fontSize: 12,
          fontFamily: "monospace",
          fontWeight: "bold",
        }}
      >
        {value}
      </Text>
    </View>
  );
}

// Simple horizontal bar
function Bar({
  value,
  max,
  color = CYAN,
  height = 6,
}: {
  value: number;
  max: number;
  color?: string;
  height?: number;
}) {
  const pct = max > 0 ? Math.min(value / max, 1) : 0;
  return (
    <View
      style={{
        height,
        backgroundColor: "#1A1A1A",
        borderRadius: height / 2,
        overflow: "hidden",
        flex: 1,
      }}
    >
      <View
        style={{
          height,
          width: `${Math.round(pct * 100)}%`,
          backgroundColor: color,
          borderRadius: height / 2,
        }}
      />
    </View>
  );
}

// Device row
function DeviceRow({
  deviceId,
  deviceType,
  isOnline,
}: {
  deviceId: string;
  deviceType: string;
  isOnline: boolean;
}) {
  const shortName = deviceId.replace("ozzu-", "");
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 6,
        gap: 8,
      }}
    >
      <Text style={{ fontSize: 8, color: isOnline ? "#22C55E" : "#EF4444" }}>
        {isOnline ? "\u25CF" : "\u25CF"}
      </Text>
      <Text
        style={{
          color: "#A3A3A3",
          fontSize: 12,
          fontFamily: "monospace",
          flex: 1,
        }}
      >
        {shortName}
      </Text>
      <Text
        style={{
          color: "#525252",
          fontSize: 10,
          fontFamily: "monospace",
        }}
      >
        {deviceType}
      </Text>
    </View>
  );
}

// History bar chart for 7-day view
function HistoryChart({
  history,
  metricKey,
  label,
}: {
  history: Array<{ date: string; metrics: Record<string, number> }>;
  metricKey: string;
  label: string;
}) {
  if (!history.length) return null;

  const values = history.map((h) => h.metrics[metricKey] || 0);
  const max = Math.max(...values, 1);
  const days = history.slice(0, 7).reverse();

  return (
    <View style={{ marginTop: 8 }}>
      <Text
        style={{
          color: "#525252",
          fontSize: 10,
          fontFamily: "monospace",
          marginBottom: 6,
        }}
      >
        {label}
      </Text>
      {days.map((d) => {
        const val = d.metrics[metricKey] || 0;
        const dayLabel = new Date(d.date + "T12:00:00").toLocaleDateString(
          "en-US",
          { weekday: "short" }
        );
        return (
          <View
            key={d.date}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginBottom: 3,
            }}
          >
            <Text
              style={{
                color: "#525252",
                fontSize: 10,
                fontFamily: "monospace",
                width: 30,
              }}
            >
              {dayLabel}
            </Text>
            <Bar value={val} max={max} />
            <Text
              style={{
                color: "#737373",
                fontSize: 10,
                fontFamily: "monospace",
                width: 40,
                textAlign: "right",
              }}
            >
              {formatNumber(val)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export default function MetricsScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();
  const [data, setData] = useState<UsageMetrics | null>(null);
  const [anthropicData, setAnthropicData] = useState<AnthropicUsageData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [metricsResult, anthropicResult] = await Promise.all([
        fetchUsageMetrics(),
        fetchAnthropicUsage(),
      ]);
      setData(metricsResult);
      setAnthropicData(anthropicResult);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to fetch metrics");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
      const interval = setInterval(loadData, 15000);
      return () => clearInterval(interval);
    }, [loadData])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const today = data?.today;
  const live = data?.live;
  const history = data?.history || [];

  return (
    <View style={{ flex: 1, backgroundColor: "#0A0A0A" }}>
      <StatusBar style="light" />

      {/* Top bar */}
      <View
        style={{
          height: layout.topBarHeight + insets.top,
          paddingTop: insets.top,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: "#1A1A1A",
        }}
      >
        <TVPressable
          onPress={() => router.back()}
          style={{ padding: 8, marginRight: 8 }}
        >
          <Text
            style={{
              color: "#525252",
              fontSize: 18,
              fontFamily: "monospace",
            }}
          >
            {"\u2190"}
          </Text>
        </TVPressable>
        <Text
          style={{
            color: CYAN,
            fontSize: 14,
            fontFamily: "monospace",
            fontWeight: "bold",
            letterSpacing: 3,
          }}
        >
          METRICS
        </Text>
        <View style={{ flex: 1 }} />
        <StatusBadge />
      </View>

      <GroupNav group="cipher" />

      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingBottom: 40 + insets.bottom,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={CYAN}
          />
        }
      >
        {error && !data && (
          <Text
            style={{
              color: "#EF4444",
              fontSize: 12,
              fontFamily: "monospace",
              textAlign: "center",
              marginTop: 40,
            }}
          >
            {error}
          </Text>
        )}

        {!data && !error && (
          <Text
            style={{
              color: "#525252",
              fontSize: 12,
              fontFamily: "monospace",
              textAlign: "center",
              marginTop: 40,
            }}
          >
            Loading metrics...
          </Text>
        )}

        {data && (
          <>
            {/* Today's Usage */}
            <SectionHeader title="TODAY'S USAGE" />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <StatCard
                value={String(today?.gemini?.sessions || 0)}
                label="GEMINI SESS"
              />
              <StatCard
                value={String(today?.cipher?.agentSpawns || 0)}
                label="CIPHER AGENTS"
              />
              <StatCard
                value={String(today?.spotify?.apiCalls || 0)}
                label="SPOTIFY CALLS"
              />
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <StatCard
                value={formatNumber(today?.gemini?.audioChunksSent || 0)}
                label="AUDIO SENT"
                color="#A78BFA"
              />
              <StatCard
                value={String(today?.gemini?.toolCalls || 0)}
                label="TOOL CALLS"
                color="#FBBF24"
              />
              <StatCard
                value={formatNumber(today?.bridge?.httpRequests || 0)}
                label="HTTP REQS"
                color="#6EE7B7"
              />
            </View>

            {/* Voice Latency */}
            {live?.voiceLatency && live.voiceLatency.count > 0 && (
              <>
                <SectionHeader title="VOICE LATENCY" />
                <View
                  style={{
                    backgroundColor: CARD_BG,
                    borderWidth: 1,
                    borderColor: BORDER,
                    borderRadius: 8,
                    padding: 12,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-around",
                      marginBottom: 8,
                    }}
                  >
                    <View style={{ alignItems: "center" }}>
                      <Text
                        style={{
                          color: "#E5E5E5",
                          fontSize: 18,
                          fontFamily: "monospace",
                          fontWeight: "bold",
                        }}
                      >
                        {Math.round(live.voiceLatency.avgTotal)}ms
                      </Text>
                      <Text
                        style={{
                          color: "#525252",
                          fontSize: 10,
                          fontFamily: "monospace",
                        }}
                      >
                        AVG
                      </Text>
                    </View>
                    <View style={{ alignItems: "center" }}>
                      <Text
                        style={{
                          color:
                            live.voiceLatency.p95Total > 2000
                              ? "#EF4444"
                              : "#FBBF24",
                          fontSize: 18,
                          fontFamily: "monospace",
                          fontWeight: "bold",
                        }}
                      >
                        {Math.round(live.voiceLatency.p95Total)}ms
                      </Text>
                      <Text
                        style={{
                          color: "#525252",
                          fontSize: 10,
                          fontFamily: "monospace",
                        }}
                      >
                        P95
                      </Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text
                      style={{
                        color: "#525252",
                        fontSize: 10,
                        fontFamily: "monospace",
                        width: 24,
                      }}
                    >
                      AVG
                    </Text>
                    <Bar
                      value={live.voiceLatency.avgTotal}
                      max={live.voiceLatency.p95Total || 2000}
                      color={CYAN}
                    />
                  </View>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      marginTop: 4,
                    }}
                  >
                    <Text
                      style={{
                        color: "#525252",
                        fontSize: 10,
                        fontFamily: "monospace",
                        width: 24,
                      }}
                    >
                      P95
                    </Text>
                    <Bar
                      value={live.voiceLatency.p95Total}
                      max={live.voiceLatency.p95Total || 2000}
                      color="#FBBF24"
                    />
                  </View>
                </View>
              </>
            )}

            {/* Directives */}
            <SectionHeader title="DIRECTIVES" />
            <View
              style={{
                backgroundColor: CARD_BG,
                borderWidth: 1,
                borderColor: BORDER,
                borderRadius: 8,
                padding: 12,
              }}
            >
              <MetricRow
                label="Success Rate"
                value={
                  live?.directives?.successRate != null
                    ? `${live.directives.successRate}%`
                    : "N/A"
                }
                valueColor={
                  (live?.directives?.successRate ?? 100) >= 80
                    ? "#22C55E"
                    : "#EF4444"
                }
              />
              <MetricRow
                label="Avg Duration"
                value={
                  live?.directives?.avgDurationMs
                    ? formatLongDuration(live.directives.avgDurationMs)
                    : "N/A"
                }
              />
              <MetricRow
                label="Today Completed"
                value={String(live?.directives?.today?.completed || 0)}
                valueColor="#22C55E"
              />
              <MetricRow
                label="Today Failed"
                value={String(live?.directives?.today?.failed || 0)}
                valueColor={
                  (live?.directives?.today?.failed || 0) > 0
                    ? "#EF4444"
                    : "#737373"
                }
              />
              <MetricRow
                label="Active Agents"
                value={`${live?.agents?.active || 0} / ${live?.agents?.max || 2}`}
              />
            </View>

            {/* Bridge */}
            <SectionHeader title="BRIDGE" />
            <View
              style={{
                backgroundColor: CARD_BG,
                borderWidth: 1,
                borderColor: BORDER,
                borderRadius: 8,
                padding: 12,
              }}
            >
              <MetricRow
                label="Uptime"
                value={formatUptime(live?.uptimeSeconds || 0)}
                valueColor="#22C55E"
              />
              <MetricRow
                label="WS Connections"
                value={`${live?.activeDevices?.length || 0} active`}
              />
              <MetricRow
                label="HTTP Requests"
                value={formatNumber(today?.bridge?.httpRequests || 0)}
              />
              <MetricRow
                label="Memory (Heap)"
                value={`${live?.memoryMB?.heap || 0} MB`}
                valueColor={
                  (live?.memoryMB?.heap || 0) > 300 ? "#EF4444" : "#E5E5E5"
                }
              />
              <MetricRow
                label="Memory (RSS)"
                value={`${live?.memoryMB?.rss || 0} MB`}
              />
              <MetricRow
                label="Persona"
                value={`${live?.persona || "?"} ${live?.cipherMode ? `(${live.cipherMode})` : ""}`}
              />
            </View>

            {/* Devices */}
            <SectionHeader title="DEVICES" />
            <View
              style={{
                backgroundColor: CARD_BG,
                borderWidth: 1,
                borderColor: BORDER,
                borderRadius: 8,
                padding: 12,
              }}
            >
              {live?.activeDevices && live.activeDevices.length > 0 ? (
                live.activeDevices.map((d) => (
                  <DeviceRow
                    key={d.deviceId}
                    deviceId={d.deviceId}
                    deviceType={d.deviceType}
                    isOnline={true}
                  />
                ))
              ) : (
                <Text
                  style={{
                    color: "#525252",
                    fontSize: 12,
                    fontFamily: "monospace",
                    textAlign: "center",
                    paddingVertical: 8,
                  }}
                >
                  No devices connected
                </Text>
              )}
            </View>

            {/* Recent Connection Events */}
            {today?.connectionHistory && today.connectionHistory.length > 0 && (
              <>
                <SectionHeader title="RECENT CONNECTIONS" />
                <View
                  style={{
                    backgroundColor: CARD_BG,
                    borderWidth: 1,
                    borderColor: BORDER,
                    borderRadius: 8,
                    padding: 12,
                  }}
                >
                  {today.connectionHistory.slice(-10).reverse().map((evt, i) => (
                    <View
                      key={`${evt.timestamp}-${i}`}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        paddingVertical: 3,
                        gap: 6,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 8,
                          color:
                            evt.event === "connect" ? "#22C55E" : "#EF4444",
                        }}
                      >
                        {evt.event === "connect" ? "\u25B2" : "\u25BC"}
                      </Text>
                      <Text
                        style={{
                          color: "#737373",
                          fontSize: 10,
                          fontFamily: "monospace",
                          flex: 1,
                        }}
                      >
                        {(evt.deviceId || "unknown").replace("ozzu-", "")}
                      </Text>
                      <Text
                        style={{
                          color: "#525252",
                          fontSize: 10,
                          fontFamily: "monospace",
                        }}
                      >
                        {new Date(evt.timestamp).toLocaleTimeString("en-US", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Text>
                    </View>
                  ))}
                </View>
              </>
            )}

            {/* 7-Day History */}
            {history.length > 0 && (
              <>
                <SectionHeader title="7-DAY HISTORY" />
                <View
                  style={{
                    backgroundColor: CARD_BG,
                    borderWidth: 1,
                    borderColor: BORDER,
                    borderRadius: 8,
                    padding: 12,
                  }}
                >
                  <HistoryChart
                    history={history}
                    metricKey="gemini_sessions"
                    label="Gemini Sessions"
                  />
                  <HistoryChart
                    history={history}
                    metricKey="cipher_agent_spawns"
                    label="Cipher Agents"
                  />
                  <HistoryChart
                    history={history}
                    metricKey="spotify_api_calls"
                    label="Spotify API Calls"
                  />
                  <HistoryChart
                    history={history}
                    metricKey="bridge_http_requests"
                    label="HTTP Requests"
                  />
                </View>
              </>
            )}

            {/* Gemini Details */}
            <SectionHeader title="GEMINI DETAILS" />
            <View
              style={{
                backgroundColor: CARD_BG,
                borderWidth: 1,
                borderColor: BORDER,
                borderRadius: 8,
                padding: 12,
              }}
            >
              <MetricRow
                label="Sessions"
                value={String(today?.gemini?.sessions || 0)}
              />
              <MetricRow
                label="Session Time"
                value={formatLongDuration(today?.gemini?.sessionDurationMs || 0)}
              />
              <MetricRow
                label="Audio Sent"
                value={formatNumber(today?.gemini?.audioChunksSent || 0)}
              />
              <MetricRow
                label="Audio Received"
                value={formatNumber(today?.gemini?.audioChunksReceived || 0)}
              />
              <MetricRow
                label="Tool Calls"
                value={String(today?.gemini?.toolCalls || 0)}
              />
              <MetricRow
                label="Turns Completed"
                value={String(today?.gemini?.turnsCompleted || 0)}
              />
              <MetricRow
                label="Reconnects"
                value={String(today?.gemini?.reconnects || 0)}
                valueColor={
                  (today?.gemini?.reconnects || 0) > 10 ? "#FBBF24" : "#E5E5E5"
                }
              />
            </View>

            {/* Spotify Details */}
            <SectionHeader title="SPOTIFY DETAILS" />
            <View
              style={{
                backgroundColor: CARD_BG,
                borderWidth: 1,
                borderColor: BORDER,
                borderRadius: 8,
                padding: 12,
              }}
            >
              <MetricRow
                label="API Calls"
                value={String(today?.spotify?.apiCalls || 0)}
              />
              <MetricRow
                label="Token Refreshes"
                value={String(today?.spotify?.tokenRefreshes || 0)}
              />
              <MetricRow
                label="Cache Hits"
                value={String(today?.spotify?.cacheHits || 0)}
                valueColor="#22C55E"
              />
            </View>

            {/* Anthropic Usage */}
            <SectionHeader title="ANTHROPIC USAGE" />
            {!anthropicData?.isConfigured ? (
              <View
                style={{
                  backgroundColor: CARD_BG,
                  borderWidth: 1,
                  borderColor: BORDER,
                  borderRadius: 8,
                  padding: 16,
                }}
              >
                <Text
                  style={{
                    color: "#737373",
                    fontSize: 12,
                    fontFamily: "monospace",
                    textAlign: "center",
                  }}
                >
                  Admin API not configured
                </Text>
                <Text
                  style={{
                    color: "#525252",
                    fontSize: 10,
                    fontFamily: "monospace",
                    textAlign: "center",
                    marginTop: 4,
                  }}
                >
                  Set ANTHROPIC_ADMIN_KEY to view usage
                </Text>
              </View>
            ) : (
              <>
                {/* Rate Limits */}
                {anthropicData?.rateLimits && (
                  <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                    <View style={{ flex: 1 }}>
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
                            marginBottom: 6,
                          }}
                        >
                          REQUESTS
                        </Text>
                        <Text
                          style={{
                            color: CYAN,
                            fontSize: 18,
                            fontFamily: "monospace",
                            fontWeight: "bold",
                          }}
                        >
                          {formatNumber(anthropicData.rateLimits.requestsRemaining)}
                        </Text>
                        <Text
                          style={{
                            color: "#525252",
                            fontSize: 10,
                            fontFamily: "monospace",
                            marginTop: 2,
                          }}
                        >
                          / {formatNumber(anthropicData.rateLimits.requestsLimit)} remaining
                        </Text>
                        <View style={{ marginTop: 8 }}>
                          <Bar
                            value={anthropicData.rateLimits.requestsLimit - anthropicData.rateLimits.requestsRemaining}
                            max={anthropicData.rateLimits.requestsLimit}
                            color={
                              (anthropicData.rateLimits.requestsRemaining / anthropicData.rateLimits.requestsLimit) < 0.2
                                ? "#EF4444"
                                : CYAN
                            }
                          />
                        </View>
                      </View>
                    </View>
                    <View style={{ flex: 1 }}>
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
                            marginBottom: 6,
                          }}
                        >
                          TOKENS
                        </Text>
                        <Text
                          style={{
                            color: CYAN,
                            fontSize: 18,
                            fontFamily: "monospace",
                            fontWeight: "bold",
                          }}
                        >
                          {formatNumber(anthropicData.rateLimits.tokensRemaining)}
                        </Text>
                        <Text
                          style={{
                            color: "#525252",
                            fontSize: 10,
                            fontFamily: "monospace",
                            marginTop: 2,
                          }}
                        >
                          / {formatNumber(anthropicData.rateLimits.tokensLimit)} remaining
                        </Text>
                        <View style={{ marginTop: 8 }}>
                          <Bar
                            value={anthropicData.rateLimits.tokensLimit - anthropicData.rateLimits.tokensRemaining}
                            max={anthropicData.rateLimits.tokensLimit}
                            color={
                              (anthropicData.rateLimits.tokensRemaining / anthropicData.rateLimits.tokensLimit) < 0.2
                                ? "#EF4444"
                                : CYAN
                            }
                          />
                        </View>
                      </View>
                    </View>
                  </View>
                )}

                {/* Today's Token Usage & Cost */}
                {anthropicData?.daily && anthropicData.daily.length > 0 && (
                  <View
                    style={{
                      backgroundColor: CARD_BG,
                      borderWidth: 1,
                      borderColor: BORDER,
                      borderRadius: 8,
                      padding: 12,
                      marginBottom: 8,
                    }}
                  >
                    <Text
                      style={{
                        color: "#525252",
                        fontSize: 10,
                        fontFamily: "monospace",
                        marginBottom: 8,
                      }}
                    >
                      TODAY'S TOKENS
                    </Text>
                    {(() => {
                      const todayStr = new Date().toISOString().slice(0, 10);
                      const todayBuckets = anthropicData.daily.filter(b => b.date === todayStr);
                      const totals = todayBuckets.reduce(
                        (acc, b) => ({
                          input: acc.input + b.inputTokens,
                          output: acc.output + b.outputTokens,
                          cacheRead: acc.cacheRead + b.cacheReadTokens,
                          cacheCreation: acc.cacheCreation + b.cacheCreationTokens,
                        }),
                        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
                      );
                      return (
                        <>
                          <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                            <StatCard
                              value={formatNumber(totals.input)}
                              label="INPUT"
                              color="#A78BFA"
                            />
                            <StatCard
                              value={formatNumber(totals.output)}
                              label="OUTPUT"
                              color="#FBBF24"
                            />
                          </View>
                          <View style={{ flexDirection: "row", gap: 8 }}>
                            <StatCard
                              value={formatNumber(totals.cacheRead)}
                              label="CACHE READ"
                              color="#22C55E"
                            />
                            <StatCard
                              value={formatNumber(totals.cacheCreation)}
                              label="CACHE CREATE"
                              color="#6EE7B7"
                            />
                          </View>
                        </>
                      );
                    })()}
                  </View>
                )}

                {/* 7-Day Cost History */}
                {anthropicData?.costs && anthropicData.costs.length > 0 && (
                  <View
                    style={{
                      backgroundColor: CARD_BG,
                      borderWidth: 1,
                      borderColor: BORDER,
                      borderRadius: 8,
                      padding: 12,
                      marginBottom: 8,
                    }}
                  >
                    <Text
                      style={{
                        color: "#525252",
                        fontSize: 10,
                        fontFamily: "monospace",
                        marginBottom: 8,
                      }}
                    >
                      COST BREAKDOWN
                    </Text>
                    {(() => {
                      const todayStr = new Date().toISOString().slice(0, 10);
                      const todayCost = anthropicData.costs
                        .filter(c => c.date === todayStr)
                        .reduce((sum, c) => sum + c.amountCents, 0);
                      const weekCost = anthropicData.costs.reduce((sum, c) => sum + c.amountCents, 0);
                      return (
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          <StatCard
                            value={`$${(todayCost / 100).toFixed(2)}`}
                            label="TODAY"
                            color="#FBBF24"
                          />
                          <StatCard
                            value={`$${(weekCost / 100).toFixed(2)}`}
                            label="7-DAY TOTAL"
                            color={CYAN}
                          />
                        </View>
                      );
                    })()}
                  </View>
                )}

                {/* Per-Model Breakdown */}
                {anthropicData?.daily && anthropicData.daily.length > 0 && (
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
                        marginBottom: 8,
                      }}
                    >
                      MODEL BREAKDOWN (7-DAY)
                    </Text>
                    {(() => {
                      const modelTotals: Record<string, { input: number; output: number }> = {};
                      anthropicData.daily.forEach(b => {
                        if (!modelTotals[b.model]) {
                          modelTotals[b.model] = { input: 0, output: 0 };
                        }
                        modelTotals[b.model].input += b.inputTokens;
                        modelTotals[b.model].output += b.outputTokens;
                      });
                      return Object.entries(modelTotals).map(([model, tokens]) => (
                        <View
                          key={model}
                          style={{
                            paddingVertical: 6,
                            borderBottomWidth: 1,
                            borderBottomColor: "#1A1A1A",
                          }}
                        >
                          <Text
                            style={{
                              color: "#A3A3A3",
                              fontSize: 11,
                              fontFamily: "monospace",
                              marginBottom: 4,
                            }}
                          >
                            {model}
                          </Text>
                          <View style={{ flexDirection: "row", gap: 12 }}>
                            <Text
                              style={{
                                color: "#525252",
                                fontSize: 10,
                                fontFamily: "monospace",
                              }}
                            >
                              In: {formatNumber(tokens.input)}
                            </Text>
                            <Text
                              style={{
                                color: "#525252",
                                fontSize: 10,
                                fontFamily: "monospace",
                              }}
                            >
                              Out: {formatNumber(tokens.output)}
                            </Text>
                          </View>
                        </View>
                      ));
                    })()}
                  </View>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
