import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  TextInput,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
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

let CallImportModule: any = null;
try { CallImportModule = require("../../modules/call-import"); } catch {}

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
  summary: { unique_numbers: number; total_calls: number; active_days: number; first_call: string; last_call: string };
  by_type: Array<{ line_type: string; is_voip: boolean; number_count: number; call_count: number }>;
  by_country: Array<{ country: string; number_count: number; call_count: number }>;
  by_hour: Array<{ hour: number; call_count: number }>;
  by_carrier: Array<{ carrier: string; is_voip: boolean; number_count: number }>;
  prefix_clusters: Array<{ prefix: string; number_count: number; call_count: number }>;
}

type Phase = "dashboard" | "importing" | "scanning" | "results";

const API_HEADERS = (token: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
});

export default function CallInvestigationScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();
  const [numbers, setNumbers] = useState<CallNumber[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [phase, setPhase] = useState<Phase>("dashboard");
  const [importProgress, setImportProgress] = useState("");
  const [extractedNumbers, setExtractedNumbers] = useState<string[]>([]);
  const [scanningCount, setScanningCount] = useState(0);
  const [tab, setTab] = useState<"feed" | "intel">("feed");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const token = process.env.EXPO_PUBLIC_BRIDGE_TOKEN || "";

  const fetchData = useCallback(async () => {
    try {
      const [numRes, anaRes] = await Promise.all([
        fetch(`${getBridgeUrl()}/soc/calls`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${getBridgeUrl()}/soc/calls/analysis`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (numRes.ok) setNumbers((await numRes.json()).numbers || []);
      if (anaRes.ok) setAnalysis(await anaRes.json());
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh while scanning
  useEffect(() => {
    if (phase === "scanning") {
      pollRef.current = setInterval(fetchData, 3000);
      return () => { if (pollRef.current) clearInterval(pollRef.current); };
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [phase, fetchData]);

  // ── Import from screenshots ──
  const importFromScreenshots = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        quality: 1,
      });
      if (result.canceled || !result.assets?.length) return;

      setPhase("importing");
      setImportProgress(`Processing ${result.assets.length} screenshot${result.assets.length > 1 ? "s" : ""}...`);

      const uris = result.assets.map((a) => a.uri);
      let extracted: string[] = [];

      if (CallImportModule?.extractNumbersFromMultiple) {
        const nums = await CallImportModule.extractNumbersFromMultiple(uris);
        extracted = nums.map((n: any) => n.number);
      } else {
        Alert.alert("OCR Unavailable", "Native OCR module not available. Use manual input instead.");
        setPhase("dashboard");
        return;
      }

      if (!extracted.length) {
        Alert.alert("No Numbers Found", "Could not extract any phone numbers from the screenshots. Try clearer screenshots of your Phone app Recents.");
        setPhase("dashboard");
        return;
      }

      setExtractedNumbers(extracted);
      setImportProgress(`Found ${extracted.length} unique numbers. Importing...`);

      // Send to bridge
      const calls = extracted.map((num) => ({
        phone_number: num,
        direction: "incoming",
        call_time: new Date().toISOString(),
      }));

      const resp = await fetch(`${getBridgeUrl()}/soc/calls`, {
        method: "POST",
        headers: API_HEADERS(token),
        body: JSON.stringify({ calls }),
      });

      if (resp.ok) {
        const data = await resp.json();
        setScanningCount(data.osint_queued || 0);
        setPhase("scanning");
        setImportProgress(`Imported ${data.imported} numbers. OSINT scanning ${data.osint_queued} new numbers...`);
        fetchData();
      }
    } catch (err) {
      Alert.alert("Import Error", String(err));
      setPhase("dashboard");
    }
  }, [token, fetchData]);

  // ── Manual paste import ──
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState("");

  const importFromPaste = useCallback(async () => {
    const lines = pasteText.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean);
    const nums = lines
      .map((l) => l.replace(/[^\d+]/g, ""))
      .filter((n) => n.length >= 7);

    if (!nums.length) {
      Alert.alert("No Numbers", "Paste phone numbers (one per line, or comma-separated)");
      return;
    }

    setPhase("importing");
    setImportProgress(`Importing ${nums.length} numbers...`);
    setExtractedNumbers(nums);

    const calls = nums.map((num) => ({
      phone_number: num,
      direction: "incoming",
      call_time: new Date().toISOString(),
    }));

    try {
      const resp = await fetch(`${getBridgeUrl()}/soc/calls`, {
        method: "POST",
        headers: API_HEADERS(token),
        body: JSON.stringify({ calls }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setScanningCount(data.osint_queued || 0);
        setPhase("scanning");
        setPasteMode(false);
        setPasteText("");
        fetchData();
      }
    } catch (err) {
      Alert.alert("Error", String(err));
      setPhase("dashboard");
    }
  }, [pasteText, token, fetchData]);

  const voipNumbers = numbers.filter((n) => n.is_voip);
  const mobileNumbers = numbers.filter((n) => n.is_voip === false);
  const pendingOsint = numbers.filter((n) => !n.last_scanned);
  const totalCalls = numbers.reduce((s, n) => s + n.call_count, 0);

  // Check if scanning is done
  useEffect(() => {
    if (phase === "scanning" && pendingOsint.length === 0 && numbers.length > 0) {
      setPhase("results");
    }
  }, [phase, pendingOsint.length, numbers.length]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <TopBar title="Call Intel" onBack={() => router.back()} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchData(); }}
            tintColor={colors.accent}
          />
        }
      >
        {/* ── Phase: Importing ── */}
        {(phase === "importing" || phase === "scanning") && (
          <View style={styles.progressCard}>
            <ActivityIndicator color={colors.accent} size="small" />
            <Text style={styles.progressText}>{importProgress}</Text>
            {phase === "scanning" && pendingOsint.length > 0 && (
              <Text style={styles.progressSub}>
                {pendingOsint.length} numbers awaiting OSINT scan...
              </Text>
            )}
            {phase === "scanning" && (
              <Pressable
                style={({ pressed }) => [styles.skipBtn, pressed && { opacity: 0.7 }]}
                onPress={() => setPhase("results")}
              >
                <Text style={styles.skipBtnText}>View Results</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* ── Phase: Results summary ── */}
        {phase === "results" && (
          <View style={styles.resultsBanner}>
            <Text style={styles.resultsDone}>Scan Complete</Text>
            <Text style={styles.resultsDetail}>
              {voipNumbers.length} VoIP (likely robocaller) · {mobileNumbers.length} Mobile · {pendingOsint.length} pending
            </Text>
            <Pressable
              style={({ pressed }) => [styles.newScanBtn, pressed && { opacity: 0.7 }]}
              onPress={() => setPhase("dashboard")}
            >
              <Text style={styles.newScanBtnText}>New Import</Text>
            </Pressable>
          </View>
        )}

        {/* ── Stats Banner ── */}
        <View style={styles.statsBanner}>
          <StatPill label="Numbers" value={numbers.length} color={colors.accent} />
          <StatPill label="Calls" value={totalCalls} color={colors.brand.blue} />
          <StatPill label="VoIP" value={voipNumbers.length} color={colors.error} />
          <StatPill label="Mobile" value={mobileNumbers.length} color={colors.success} />
        </View>

        {/* ── Import Actions (dashboard phase) ── */}
        {phase === "dashboard" && (
          <View style={styles.actionsRow}>
            <Pressable
              style={({ pressed }) => [styles.actionCard, styles.actionPrimary, pressed && { transform: [{ scale: 0.97 }] }]}
              onPress={importFromScreenshots}
            >
              <Text style={styles.actionIcon}>📸</Text>
              <Text style={styles.actionTitle}>Screenshot Import</Text>
              <Text style={styles.actionSub}>Select screenshots of your{"\n"}Phone app Recents</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [styles.actionCard, pressed && { transform: [{ scale: 0.97 }] }]}
              onPress={() => setPasteMode(!pasteMode)}
            >
              <Text style={styles.actionIcon}>📋</Text>
              <Text style={styles.actionTitle}>Paste Numbers</Text>
              <Text style={styles.actionSub}>Paste a list of phone{"\n"}numbers to investigate</Text>
            </Pressable>
          </View>
        )}

        {/* ── Paste input ── */}
        {pasteMode && phase === "dashboard" && (
          <View style={styles.pasteCard}>
            <TextInput
              style={styles.pasteInput}
              placeholder={"+57 300 123 4567\n+57 301 234 5678\n..."}
              placeholderTextColor={colors.text.disabled}
              value={pasteText}
              onChangeText={setPasteText}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
            />
            <Pressable
              style={({ pressed }) => [styles.pasteSubmit, pressed && { opacity: 0.7 }]}
              onPress={importFromPaste}
            >
              <Text style={styles.pasteSubmitText}>Import & Scan</Text>
            </Pressable>
          </View>
        )}

        {/* ── Tab selector ── */}
        {numbers.length > 0 && (
          <View style={styles.tabRow}>
            {([
              { key: "feed" as const, label: "Numbers", count: numbers.length },
              { key: "intel" as const, label: "Intelligence", count: null },
            ]).map((t) => (
              <Pressable
                key={t.key}
                style={[styles.tabPill, tab === t.key && styles.tabPillActive]}
                onPress={() => setTab(t.key)}
              >
                <Text style={[styles.tabPillText, tab === t.key && styles.tabPillTextActive]}>
                  {t.label}{t.count !== null ? ` (${t.count})` : ""}
                </Text>
              </Pressable>
            ))}
            {numbers.length > 0 && (
              <Pressable
                style={({ pressed }) => [styles.rescanPill, pressed && { opacity: 0.7 }]}
                onPress={async () => {
                  await fetch(`${getBridgeUrl()}/soc/calls/rescan`, {
                    method: "POST",
                    headers: API_HEADERS(token),
                    body: JSON.stringify({}),
                  });
                  Alert.alert("Rescanning", "OSINT rescan queued for all numbers");
                  setPhase("scanning");
                  fetchData();
                }}
              >
                <Text style={styles.rescanPillText}>Rescan All</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* ── Numbers Feed ── */}
        {tab === "feed" && (
          numbers.length === 0 && !loading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>📞</Text>
              <Text style={styles.emptyTitle}>No numbers yet</Text>
              <Text style={styles.emptySub}>
                Import your call log from screenshots{"\n"}or paste numbers to start investigating
              </Text>
            </View>
          ) : (
            <>
              {/* VoIP section */}
              {voipNumbers.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <View style={[styles.sectionDot, { backgroundColor: colors.error }]} />
                    <Text style={styles.sectionTitle}>VoIP Numbers ({voipNumbers.length})</Text>
                    <Text style={styles.sectionHint}>likely robocaller</Text>
                  </View>
                  {voipNumbers.map((n) => <NumberRow key={n.phone_number} item={n} />)}
                </View>
              )}

              {/* Pending OSINT */}
              {pendingOsint.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <View style={[styles.sectionDot, { backgroundColor: colors.warning }]} />
                    <Text style={styles.sectionTitle}>Scanning ({pendingOsint.length})</Text>
                    <ActivityIndicator size="small" color={colors.warning} />
                  </View>
                  {pendingOsint.slice(0, 5).map((n) => <NumberRow key={n.phone_number} item={n} />)}
                  {pendingOsint.length > 5 && (
                    <Text style={styles.moreText}>+{pendingOsint.length - 5} more scanning...</Text>
                  )}
                </View>
              )}

              {/* Mobile / identified */}
              {mobileNumbers.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <View style={[styles.sectionDot, { backgroundColor: colors.success }]} />
                    <Text style={styles.sectionTitle}>Mobile ({mobileNumbers.length})</Text>
                  </View>
                  {mobileNumbers.map((n) => <NumberRow key={n.phone_number} item={n} />)}
                </View>
              )}

              {/* Unknown type */}
              {numbers.filter((n) => n.is_voip === null && n.last_scanned).length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <View style={[styles.sectionDot, { backgroundColor: colors.text.disabled }]} />
                    <Text style={styles.sectionTitle}>
                      Unknown ({numbers.filter((n) => n.is_voip === null && n.last_scanned).length})
                    </Text>
                  </View>
                  {numbers
                    .filter((n) => n.is_voip === null && n.last_scanned)
                    .map((n) => <NumberRow key={n.phone_number} item={n} />)}
                </View>
              )}
            </>
          )
        )}

        {/* ── Intelligence Tab ── */}
        {tab === "intel" && analysis && <IntelView data={analysis} />}

        <View style={{ height: 120 }} />
      </ScrollView>
    </View>
  );
}

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={[styles.statPill, { borderColor: withAlpha(color, 0.3) }]}>
      <Text style={[styles.statPillValue, { color }]}>{value}</Text>
      <Text style={styles.statPillLabel}>{label}</Text>
    </View>
  );
}

function NumberRow({ item }: { item: CallNumber }) {
  const borderColor = item.is_voip ? colors.error : item.is_voip === false ? colors.success : colors.text.disabled;
  const scanning = !item.last_scanned;

  return (
    <View style={[styles.numberRow, { borderLeftColor: borderColor }]}>
      <View style={styles.numberRowTop}>
        <Text style={styles.numberText}>{item.international_format || item.phone_number}</Text>
        <View style={styles.numberBadges}>
          {item.is_voip && <Badge text="VoIP" color={colors.error} />}
          {item.is_voip === false && <Badge text="Mobile" color={colors.success} />}
          {scanning && <Badge text="Scanning..." color={colors.warning} />}
        </View>
      </View>
      {(item.carrier || item.country) && (
        <Text style={styles.numberMeta}>
          {[item.carrier, item.country].filter(Boolean).join(" · ")}
        </Text>
      )}
      <Text style={styles.numberStats}>
        {item.call_count} call{item.call_count !== 1 ? "s" : ""}
        {item.answered_count > 0 ? ` · ${item.answered_count} answered` : ""}
        {item.last_call ? ` · ${new Date(item.last_call).toLocaleDateString()}` : ""}
      </Text>
    </View>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: withAlpha(color, 0.12) }]}>
      <Text style={[styles.badgeText, { color }]}>{text}</Text>
    </View>
  );
}

function IntelView({ data }: { data: Analysis }) {
  const maxHour = Math.max(...data.by_hour.map((h) => h.call_count), 1);
  const peakHour = data.by_hour.reduce((a, b) => (b.call_count > a.call_count ? b : a), { hour: 0, call_count: 0 });

  return (
    <>
      {/* Overview */}
      <View style={styles.intelCard}>
        <Text style={styles.intelCardTitle}>Overview</Text>
        <View style={styles.intelGrid}>
          <IntelStat label="Unique Numbers" value={data.summary.unique_numbers} />
          <IntelStat label="Total Calls" value={data.summary.total_calls} />
          <IntelStat label="Active Days" value={data.summary.active_days} />
          <IntelStat label="Peak Hour" value={`${peakHour.hour}:00`} />
        </View>
      </View>

      {/* Carrier breakdown */}
      {data.by_carrier.length > 0 && (
        <View style={styles.intelCard}>
          <Text style={styles.intelCardTitle}>Source Carriers</Text>
          <Text style={styles.intelCardSub}>Identifies which VoIP providers or carriers the calls originate from</Text>
          {data.by_carrier.map((c, i) => (
            <View key={i} style={styles.intelRow}>
              <View style={styles.intelRowLeft}>
                <View style={[styles.sectionDot, { backgroundColor: c.is_voip ? colors.error : colors.brand.blue }]} />
                <Text style={styles.intelRowText}>{c.carrier}</Text>
                {c.is_voip && <Badge text="VoIP" color={colors.error} />}
              </View>
              <Text style={styles.intelRowValue}>{c.number_count}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Prefix clusters (auto-dialer detection) */}
      {data.prefix_clusters.length > 0 && (
        <View style={styles.intelCard}>
          <Text style={styles.intelCardTitle}>Number Clusters</Text>
          <Text style={styles.intelCardSub}>Sequential prefixes = auto-dialer. Same source rotating caller IDs.</Text>
          {data.prefix_clusters.map((p, i) => (
            <View key={i} style={styles.intelRow}>
              <View style={styles.intelRowLeft}>
                <Text style={[styles.intelRowText, { fontVariant: ["tabular-nums"] }]}>{p.prefix}•••</Text>
              </View>
              <Text style={styles.intelRowValue}>{p.number_count} nums · {p.call_count} calls</Text>
            </View>
          ))}
        </View>
      )}

      {/* Country breakdown */}
      {data.by_country.length > 0 && (
        <View style={styles.intelCard}>
          <Text style={styles.intelCardTitle}>Origin Countries</Text>
          {data.by_country.map((c, i) => (
            <View key={i} style={styles.intelRow}>
              <Text style={styles.intelRowText}>{c.country}</Text>
              <Text style={styles.intelRowValue}>{c.number_count} nums · {c.call_count} calls</Text>
            </View>
          ))}
        </View>
      )}

      {/* Hourly heatmap */}
      {data.by_hour.length > 0 && (
        <View style={styles.intelCard}>
          <Text style={styles.intelCardTitle}>Call Timing</Text>
          <Text style={styles.intelCardSub}>Reveals the caller's operating hours / timezone</Text>
          <View style={styles.hourGrid}>
            {Array.from({ length: 24 }, (_, h) => {
              const entry = data.by_hour.find((e) => e.hour === h);
              const count = entry?.call_count || 0;
              const intensity = count / maxHour;
              return (
                <View key={h} style={styles.hourCell}>
                  <View
                    style={[
                      styles.hourBlock,
                      {
                        backgroundColor: count > 0
                          ? withAlpha(colors.error, 0.15 + intensity * 0.85)
                          : colors.bg.surface,
                      },
                    ]}
                  >
                    <Text style={[styles.hourBlockCount, count > 0 && { color: colors.text.primary }]}>
                      {count || ""}
                    </Text>
                  </View>
                  <Text style={styles.hourCellLabel}>{h}</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* Type breakdown */}
      {data.by_type.length > 0 && (
        <View style={styles.intelCard}>
          <Text style={styles.intelCardTitle}>Line Types</Text>
          {data.by_type.map((t, i) => {
            const total = data.by_type.reduce((s, x) => s + x.number_count, 0) || 1;
            const pct = Math.round((t.number_count / total) * 100);
            return (
              <View key={i} style={styles.intelRow}>
                <View style={styles.intelRowLeft}>
                  <View style={[styles.sectionDot, { backgroundColor: t.is_voip ? colors.error : colors.success }]} />
                  <Text style={styles.intelRowText}>{t.line_type || "unknown"}</Text>
                </View>
                <View style={styles.barContainer}>
                  <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: t.is_voip ? colors.error : colors.success }]} />
                </View>
                <Text style={styles.intelRowValue}>{pct}%</Text>
              </View>
            );
          })}
        </View>
      )}
    </>
  );
}

function IntelStat({ label, value }: { label: string; value: number | string }) {
  return (
    <View style={styles.intelStat}>
      <Text style={styles.intelStatValue}>{value}</Text>
      <Text style={styles.intelStatLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.base },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.md },

  // Progress card
  progressCard: {
    backgroundColor: withAlpha(colors.accent, 0.08),
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.md,
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: withAlpha(colors.accent, 0.2),
  },
  progressText: { fontSize: fs.sm, color: colors.text.primary, textAlign: "center" },
  progressSub: { fontSize: fs.xs, color: colors.text.tertiary },
  skipBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    borderRadius: radius.full,
    backgroundColor: withAlpha(colors.accent, 0.15),
  },
  skipBtnText: { fontSize: fs.xs, color: colors.accent, fontWeight: fw.semibold as any },

  // Results banner
  resultsBanner: {
    backgroundColor: withAlpha(colors.success, 0.08),
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: spacing.md,
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: withAlpha(colors.success, 0.2),
  },
  resultsDone: { fontSize: fs.md, color: colors.success, fontWeight: fw.bold as any },
  resultsDetail: { fontSize: fs.xs, color: colors.text.secondary, textAlign: "center" },
  newScanBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    borderRadius: radius.full,
    backgroundColor: withAlpha(colors.accent, 0.15),
  },
  newScanBtnText: { fontSize: fs.xs, color: colors.accent, fontWeight: fw.semibold as any },

  // Stats banner
  statsBanner: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  statPill: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  statPillValue: { fontSize: 20, fontWeight: fw.bold as any },
  statPillLabel: { fontSize: 10, color: colors.text.disabled, marginTop: 2 },

  // Action cards
  actionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  actionCard: {
    flex: 1,
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.lg,
    padding: 14,
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  actionPrimary: {
    borderColor: withAlpha(colors.accent, 0.3),
    backgroundColor: withAlpha(colors.accent, 0.05),
  },
  actionIcon: { fontSize: 28 },
  actionTitle: { fontSize: fs.sm, fontWeight: fw.semibold as any, color: colors.text.primary },
  actionSub: { fontSize: 10, color: colors.text.disabled, textAlign: "center", lineHeight: 14 },

  // Paste card
  pasteCard: {
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.lg,
    padding: 14,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  pasteInput: {
    backgroundColor: colors.bg.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.text.primary,
    fontSize: fs.sm,
    minHeight: 120,
    marginBottom: spacing.sm,
    fontVariant: ["tabular-nums"],
  },
  pasteSubmit: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 10,
    alignItems: "center",
  },
  pasteSubmitText: { color: colors.bg.base, fontSize: fs.sm, fontWeight: fw.semibold as any },

  // Tabs
  tabRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    alignItems: "center",
  },
  tabPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.full,
    backgroundColor: colors.bg.surface,
  },
  tabPillActive: { backgroundColor: withAlpha(colors.accent, 0.15) },
  tabPillText: { fontSize: fs.xs, color: colors.text.tertiary, fontWeight: fw.medium as any },
  tabPillTextActive: { color: colors.accent },
  rescanPill: {
    marginLeft: "auto",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: colors.bg.surface,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  rescanPillText: { fontSize: 10, color: colors.text.disabled },

  // Empty state
  empty: { alignItems: "center", paddingTop: 40, gap: 8 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: fs.md, color: colors.text.secondary, fontWeight: fw.semibold as any },
  emptySub: { fontSize: fs.xs, color: colors.text.disabled, textAlign: "center", lineHeight: 18 },

  // Sections
  section: { marginTop: spacing.sm },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: spacing.xs,
    paddingVertical: 4,
  },
  sectionDot: { width: 8, height: 8, borderRadius: 4 },
  sectionTitle: { fontSize: fs.xs, fontWeight: fw.semibold as any, color: colors.text.secondary },
  sectionHint: { fontSize: 10, color: colors.text.disabled, marginLeft: "auto" },
  moreText: { fontSize: 11, color: colors.text.disabled, paddingVertical: 6, paddingLeft: 14 },

  // Number row
  numberRow: {
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
  },
  numberRowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  numberText: {
    fontSize: fs.sm,
    fontWeight: fw.semibold as any,
    color: colors.text.primary,
    fontVariant: ["tabular-nums"],
  },
  numberBadges: { flexDirection: "row", gap: 4 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.full },
  badgeText: { fontSize: 9, fontWeight: fw.semibold as any },
  numberMeta: { fontSize: 11, color: colors.text.tertiary, marginTop: 3 },
  numberStats: { fontSize: 10, color: colors.text.disabled, marginTop: 4 },

  // Intel cards
  intelCard: {
    backgroundColor: colors.bg.elevated,
    borderRadius: radius.lg,
    padding: 14,
    marginBottom: spacing.md,
  },
  intelCardTitle: { fontSize: fs.sm, fontWeight: fw.semibold as any, color: colors.text.primary, marginBottom: 4 },
  intelCardSub: { fontSize: 10, color: colors.text.disabled, marginBottom: spacing.sm },
  intelGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  intelStat: {
    width: "47%",
    backgroundColor: colors.bg.surface,
    borderRadius: radius.md,
    padding: 10,
    alignItems: "center",
  },
  intelStatValue: { fontSize: 22, fontWeight: fw.bold as any, color: colors.text.primary },
  intelStatLabel: { fontSize: 10, color: colors.text.disabled, marginTop: 2 },
  intelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.subtle,
  },
  intelRowLeft: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  intelRowText: { fontSize: fs.xs, color: colors.text.secondary },
  intelRowValue: { fontSize: 11, color: colors.text.disabled },
  barContainer: {
    flex: 1,
    height: 4,
    backgroundColor: colors.bg.surface,
    borderRadius: 2,
    marginHorizontal: spacing.sm,
    maxWidth: 80,
  },
  barFill: { height: 4, borderRadius: 2 },

  // Hour heatmap
  hourGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 3,
  },
  hourCell: { alignItems: "center", width: "11.5%" },
  hourBlock: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  hourBlockCount: { fontSize: 8, color: colors.text.disabled },
  hourCellLabel: { fontSize: 7, color: colors.text.disabled, marginTop: 1 },
});
