import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  TextInput,
  StyleSheet,
  Alert,
  Animated,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { TopBar } from "../../components/TopBar";
import { getBridgeUrl } from "../../lib/bridge-api";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../lib/design-tokens";

interface CallNumber {
  phone_number: string;
  direction: string;
  call_count: number;
  first_call: string;
  last_call: string;
  answered_count: number;
  carrier: string | null;
  line_type: string | null;
  country: string | null;
  is_voip: boolean | null;
  spam_score: number | null;
  spam_reports: number | null;
  international_format: string | null;
  last_scanned: string | null;
}

interface Analysis {
  summary: {
    unique_numbers: number;
    total_calls: number;
    active_days: number;
    first_call: string;
    last_call: string;
  };
  by_type: Array<{ line_type: string; is_voip: boolean; number_count: number; call_count: number }>;
  by_country: Array<{ country: string; number_count: number; call_count: number }>;
  by_hour: Array<{ hour: number; call_count: number }>;
  by_carrier: Array<{ carrier: string; is_voip: boolean; number_count: number }>;
  prefix_clusters: Array<{ prefix: string; number_count: number; call_count: number }>;
}

export default function CallInvestigationScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();
  const [numbers, setNumbers] = useState<CallNumber[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [inputNumber, setInputNumber] = useState("");
  const [tab, setTab] = useState<"numbers" | "analysis">("numbers");

  const fetchData = useCallback(async () => {
    try {
      const [numRes, anaRes] = await Promise.all([
        fetch(`${getBridgeUrl()}/soc/calls`, {
          headers: { Authorization: `Bearer ${process.env.EXPO_PUBLIC_BRIDGE_TOKEN || ""}` },
        }),
        fetch(`${getBridgeUrl()}/soc/calls/analysis`, {
          headers: { Authorization: `Bearer ${process.env.EXPO_PUBLIC_BRIDGE_TOKEN || ""}` },
        }),
      ]);
      if (numRes.ok) {
        const d = await numRes.json();
        setNumbers(d.numbers || []);
      }
      if (anaRes.ok) {
        const d = await anaRes.json();
        setAnalysis(d);
      }
    } catch (err) {
      console.warn("[calls] fetch error:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const addNumber = useCallback(async () => {
    const num = inputNumber.replace(/[^\d+]/g, "");
    if (!num || num.length < 7) {
      Alert.alert("Invalid", "Enter a valid phone number");
      return;
    }
    try {
      await fetch(`${getBridgeUrl()}/soc/calls/number`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.EXPO_PUBLIC_BRIDGE_TOKEN || ""}`,
        },
        body: JSON.stringify({ phone_number: num }),
      });
      setInputNumber("");
      fetchData();
    } catch (err) {
      Alert.alert("Error", String(err));
    }
  }, [inputNumber, fetchData]);

  const rescanAll = useCallback(async () => {
    try {
      await fetch(`${getBridgeUrl()}/soc/calls/rescan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.EXPO_PUBLIC_BRIDGE_TOKEN || ""}`,
        },
        body: JSON.stringify({}),
      });
      Alert.alert("Rescanning", "OSINT rescan queued for all numbers");
    } catch (err) {
      Alert.alert("Error", String(err));
    }
  }, []);

  const voipCount = numbers.filter((n) => n.is_voip).length;
  const totalCalls = numbers.reduce((s, n) => s + n.call_count, 0);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <TopBar title="Call Investigation" onBack={() => router.back()} />

      {/* Summary banner */}
      <View style={styles.banner}>
        <View style={styles.bannerRow}>
          <StatBox label="Numbers" value={String(numbers.length)} color={colors.accent} />
          <StatBox label="Calls" value={String(totalCalls)} color={colors.brand.blue} />
          <StatBox label="VoIP" value={String(voipCount)} color={colors.error} />
        </View>
      </View>

      {/* Add number input */}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="+57 300 123 4567"
          placeholderTextColor={colors.text.disabled}
          value={inputNumber}
          onChangeText={setInputNumber}
          keyboardType="phone-pad"
          returnKeyType="send"
          onSubmitEditing={addNumber}
        />
        <Pressable
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]}
          onPress={addNumber}
        >
          <Text style={styles.addBtnText}>+ Add</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.rescanBtn, pressed && { opacity: 0.7 }]}
          onPress={rescanAll}
        >
          <Text style={styles.rescanBtnText}>Rescan</Text>
        </Pressable>
      </View>

      {/* Tab pills */}
      <View style={styles.tabRow}>
        {(["numbers", "analysis"] as const).map((t) => (
          <Pressable
            key={t}
            style={[styles.tabPill, tab === t && styles.tabPillActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabPillText, tab === t && styles.tabPillTextActive]}>
              {t === "numbers" ? "Numbers" : "Analysis"}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        style={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchData(); }}
            tintColor={colors.accent}
          />
        }
      >
        {tab === "numbers" ? (
          numbers.length === 0 && !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No numbers yet</Text>
              <Text style={styles.emptySubtext}>Add phone numbers above to start investigating</Text>
            </View>
          ) : (
            numbers.map((n) => <NumberCard key={n.phone_number} item={n} />)
          )
        ) : (
          analysis && <AnalysisView data={analysis} />
        )}
        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function NumberCard({ item }: { item: CallNumber }) {
  const isVoip = item.is_voip;
  const borderColor = isVoip ? colors.error : item.carrier ? colors.success : colors.text.disabled;

  return (
    <View style={[styles.card, { borderLeftColor: borderColor }]}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardPhone}>
          {item.international_format || item.phone_number}
        </Text>
        {isVoip && (
          <View style={styles.voipBadge}>
            <Text style={styles.voipBadgeText}>VoIP</Text>
          </View>
        )}
        {item.is_voip === false && (
          <View style={styles.mobileBadge}>
            <Text style={styles.mobileBadgeText}>Mobile</Text>
          </View>
        )}
      </View>

      <View style={styles.cardMeta}>
        {item.carrier && (
          <Text style={styles.metaText}>
            {item.carrier} {item.country ? `· ${item.country}` : ""}
          </Text>
        )}
        {!item.carrier && !item.last_scanned && (
          <Text style={[styles.metaText, { color: colors.warning }]}>OSINT pending...</Text>
        )}
        {!item.carrier && item.last_scanned && (
          <Text style={styles.metaText}>No carrier data</Text>
        )}
      </View>

      <View style={styles.cardStats}>
        <Text style={styles.statsText}>{item.call_count} calls</Text>
        <Text style={styles.statsText}>{item.answered_count} answered</Text>
        {item.last_call && (
          <Text style={styles.statsText}>
            Last: {new Date(item.last_call).toLocaleDateString()}
          </Text>
        )}
      </View>
    </View>
  );
}

function AnalysisView({ data }: { data: Analysis }) {
  return (
    <View style={styles.analysisContainer}>
      {/* Summary */}
      <View style={styles.analysisSection}>
        <Text style={styles.sectionTitle}>Summary</Text>
        <View style={styles.analysisSummary}>
          <Text style={styles.analysisMeta}>
            {data.summary.unique_numbers} unique numbers · {data.summary.total_calls} total calls · {data.summary.active_days} active days
          </Text>
        </View>
      </View>

      {/* By Type */}
      {data.by_type.length > 0 && (
        <View style={styles.analysisSection}>
          <Text style={styles.sectionTitle}>By Type</Text>
          {data.by_type.map((t, i) => (
            <View key={i} style={styles.analysisRow}>
              <View style={styles.analysisRowLeft}>
                <View
                  style={[
                    styles.typeDot,
                    { backgroundColor: t.is_voip ? colors.error : colors.success },
                  ]}
                />
                <Text style={styles.analysisRowText}>
                  {t.line_type || "unknown"} {t.is_voip ? "(VoIP)" : ""}
                </Text>
              </View>
              <Text style={styles.analysisRowValue}>
                {t.number_count} numbers · {t.call_count} calls
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* By Country */}
      {data.by_country.length > 0 && (
        <View style={styles.analysisSection}>
          <Text style={styles.sectionTitle}>By Country</Text>
          {data.by_country.map((c, i) => (
            <View key={i} style={styles.analysisRow}>
              <Text style={styles.analysisRowText}>{c.country}</Text>
              <Text style={styles.analysisRowValue}>
                {c.number_count} numbers · {c.call_count} calls
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* By Carrier */}
      {data.by_carrier.length > 0 && (
        <View style={styles.analysisSection}>
          <Text style={styles.sectionTitle}>Top Carriers</Text>
          {data.by_carrier.map((c, i) => (
            <View key={i} style={styles.analysisRow}>
              <View style={styles.analysisRowLeft}>
                <View
                  style={[
                    styles.typeDot,
                    { backgroundColor: c.is_voip ? colors.error : colors.brand.blue },
                  ]}
                />
                <Text style={styles.analysisRowText}>{c.carrier}</Text>
              </View>
              <Text style={styles.analysisRowValue}>{c.number_count} numbers</Text>
            </View>
          ))}
        </View>
      )}

      {/* Prefix Clusters */}
      {data.prefix_clusters.length > 0 && (
        <View style={styles.analysisSection}>
          <Text style={styles.sectionTitle}>Number Prefix Clusters</Text>
          <Text style={styles.sectionSubtitle}>Groups of numbers sharing the same prefix (auto-dialer signal)</Text>
          {data.prefix_clusters.map((p, i) => (
            <View key={i} style={styles.analysisRow}>
              <Text style={styles.analysisRowText}>{p.prefix}xxx</Text>
              <Text style={styles.analysisRowValue}>
                {p.number_count} numbers · {p.call_count} calls
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Hourly Distribution */}
      {data.by_hour.length > 0 && (
        <View style={styles.analysisSection}>
          <Text style={styles.sectionTitle}>Hourly Pattern</Text>
          <Text style={styles.sectionSubtitle}>When calls arrive (reveals caller timezone)</Text>
          <View style={styles.hourChart}>
            {Array.from({ length: 24 }, (_, h) => {
              const entry = data.by_hour.find((e) => e.hour === h);
              const count = entry?.call_count || 0;
              const max = Math.max(...data.by_hour.map((e) => e.call_count), 1);
              const height = Math.max(2, (count / max) * 60);
              return (
                <View key={h} style={styles.hourBar}>
                  <View
                    style={[
                      styles.hourBarFill,
                      {
                        height,
                        backgroundColor: count > 0 ? colors.accent : colors.border.subtle,
                      },
                    ]}
                  />
                  {h % 6 === 0 && <Text style={styles.hourLabel}>{h}</Text>}
                </View>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.base },
  banner: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.bg.elevated,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  bannerRow: { flexDirection: "row", justifyContent: "space-around" },
  statBox: { alignItems: "center" },
  statValue: { fontSize: 24, fontWeight: fw.bold as any },
  statLabel: { fontSize: fs.xs, color: colors.text.tertiary, marginTop: 2 },
  inputRow: {
    flexDirection: "row",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    alignItems: "center",
  },
  input: {
    flex: 1,
    backgroundColor: colors.bg.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.text.primary,
    fontSize: fs.sm,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  addBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  addBtnText: { color: colors.bg.base, fontSize: fs.sm, fontWeight: fw.semibold as any },
  rescanBtn: {
    backgroundColor: colors.bg.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  rescanBtnText: { color: colors.text.secondary, fontSize: fs.xs },
  tabRow: {
    flexDirection: "row",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  tabPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.bg.surface,
  },
  tabPillActive: { backgroundColor: withAlpha(colors.accent, 0.15) },
  tabPillText: { fontSize: fs.xs, color: colors.text.tertiary },
  tabPillTextActive: { color: colors.accent },
  scroll: { flex: 1 },
  empty: { alignItems: "center", paddingTop: 60 },
  emptyText: { fontSize: fs.md, color: colors.text.secondary },
  emptySubtext: { fontSize: fs.xs, color: colors.text.disabled, marginTop: spacing.xs },
  card: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.lg,
    borderLeftWidth: 3,
    padding: 14,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardPhone: {
    fontSize: fs.md,
    fontWeight: fw.semibold as any,
    color: colors.text.primary,
    fontVariant: ["tabular-nums"],
  },
  voipBadge: {
    backgroundColor: withAlpha(colors.error, 0.15),
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  voipBadgeText: { fontSize: 10, color: colors.error, fontWeight: fw.semibold as any },
  mobileBadge: {
    backgroundColor: withAlpha(colors.success, 0.15),
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  mobileBadgeText: { fontSize: 10, color: colors.success, fontWeight: fw.semibold as any },
  cardMeta: { marginTop: 6 },
  metaText: { fontSize: fs.xs, color: colors.text.tertiary },
  cardStats: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border.subtle,
  },
  statsText: { fontSize: 11, color: colors.text.disabled },
  analysisContainer: { paddingHorizontal: spacing.md },
  analysisSection: {
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.lg,
    padding: 14,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: fs.sm,
    fontWeight: fw.semibold as any,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  sectionSubtitle: {
    fontSize: 11,
    color: colors.text.disabled,
    marginBottom: spacing.sm,
    marginTop: -4,
  },
  analysisSummary: {},
  analysisMeta: { fontSize: fs.xs, color: colors.text.secondary },
  analysisRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  analysisRowLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  analysisRowText: { fontSize: fs.xs, color: colors.text.secondary },
  analysisRowValue: { fontSize: 11, color: colors.text.disabled },
  typeDot: { width: 8, height: 8, borderRadius: 4 },
  hourChart: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: 80,
    gap: 1,
  },
  hourBar: { flex: 1, alignItems: "center", justifyContent: "flex-end" },
  hourBarFill: { width: "100%", borderRadius: 2 },
  hourLabel: { fontSize: 8, color: colors.text.disabled, marginTop: 2 },
});
