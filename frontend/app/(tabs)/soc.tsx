// SOC screen — same UI as the Ventures/WORK screen (business.tsx), filled with
// SOC info (KK order 2026-09-27, dir_1790544238642). Structure copied 1:1:
// TopBar + GroupNav + sub-tab pills + overview card + card list. Three sub-tabs:
//   CHAINS    — overview card (disclosure %) + one card per kill chain
//   FINDINGS  — severity filter pills + one card per finding → detail modal
//   ACTIVITY  — section cards (findings / evidence runs / vendor coordination)
// Read-only report plane: the app observes, the terminal acts.

import { useState, useCallback, useEffect, useMemo } from "react";
import { View, Text, ScrollView, Pressable, RefreshControl } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { GroupNav } from "../../components/GroupNav";
import { TopBar } from "../../components/TopBar";
import { ProgressBar } from "../../components/business/ProgressBar";
import { FindingDetailModal } from "../../components/soc/FindingDetailModal";
import { apiFetch } from "../../lib/bridge-api";
import { useBridgeStream } from "../../lib/useBridgeStream";
import { colors } from "../../lib/design-tokens";
import { severityColor, severityIcon } from "../../components/soc/phaseColors";
import {
  CHAIN_STATUS_ORDER,
  chainStatusColor,
  chainStatusLabel,
  chainStatusEmoji,
  lifecycleColor,
  lifecycleLabel,
  cvssColor,
  fmtCvss,
  fmtDate,
  dropLabel,
  channelColor,
  DIRECTION_ICON,
} from "../../components/soc/chainConstants";
import { safe } from "../../components/soc/safe";

const ACCENT = colors.accent;
// Same hairline the ventures cards use (ProjectCard/business.tsx).
const HAIRLINE = "rgba(255,255,255,0.04)";

const SUB_TABS = [
  { key: "chains", label: "CHAINS" },
  { key: "findings", label: "FINDINGS" },
  { key: "activity", label: "ACTIVITY" },
] as const;

type SubTab = typeof SUB_TABS[number]["key"];

const SEV_FILTERS = [
  { key: "", label: "ALL" },
  { key: "critical", label: "CRIT" },
  { key: "high", label: "HIGH" },
  { key: "medium", label: "MED" },
  { key: "low", label: "LOW" },
  { key: "info", label: "INFO" },
] as const;

const PAGE = 100;

// ── Types (mirror GET /soc/chains, /soc/overview, /soc/findings) ──

interface ChainSummary {
  slug: string;
  name: string;
  drop_number: number | null;
  status: string;
  cvss_composed: string | number | null;
  published_repo: string | null;
  summary: string | null;
  component_count: number;
  artifact_count: number;
  finding_count: number;
}

interface BoardFinding {
  id: number;
  severity: string;
  title: string;
  lifecycle: string | null;
  skyline_id: string | null;
  cve_id: string | null;
  cvss_score: string | number | null;
  affected_asset?: string | null;
  discovered_at: string | null;
  chain_slug: string | null;
  chain_name: string | null;
}

interface Overview {
  recent_findings: Array<{
    id: number; severity: string; title: string; lifecycle: string | null;
    discovered_at: string; chain_slug?: string | null;
  }>;
  recent_runs: Array<{
    run_key: string; target: string; run_date: string;
    purpose: string | null; verdict: string | null; chain_slug?: string | null;
  }>;
  recent_coordination: Array<{
    channel: string; event_date: string; direction: string;
    subject: string | null; status: string;
  }>;
  findings_by_lifecycle: Array<{ lifecycle: string; n: number }>;
}

function stageIndex(status: string): number {
  return CHAIN_STATUS_ORDER.indexOf(status as (typeof CHAIN_STATUS_ORDER)[number]);
}

export default function SOCScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string; severity?: string }>();

  const initialTab: SubTab =
    params.tab === "findings" || params.tab === "activity" ? params.tab : "chains";

  const [activeTab, setActiveTab] = useState<SubTab>(initialTab);
  const [chains, setChains] = useState<ChainSummary[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Findings tab state
  const [findings, setFindings] = useState<BoardFinding[]>([]);
  const [findingsTotal, setFindingsTotal] = useState(0);
  const [sevFilter, setSevFilter] = useState<string>(params.severity || "");
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailFinding, setDetailFinding] = useState<number | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [chainsRes, overviewRes] = await Promise.all([
        apiFetch("/soc/chains"),
        apiFetch("/soc/overview"),
      ]);
      setChains(chainsRes.chains || []);
      setOverview(overviewRes || null);
    } catch {}
    finally { setLoading(false); }
  }, []);

  const fetchFindings = useCallback(async (offset: number, append: boolean) => {
    try {
      const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (sevFilter) q.set("severity", sevFilter);
      const d = await apiFetch(`/soc/findings?${q.toString()}`);
      setFindings((prev) => (append ? [...prev, ...(d.findings || [])] : d.findings || []));
      setFindingsTotal(d.total || 0);
    } catch {}
  }, [sevFilter]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { fetchFindings(0, false); }, [fetchFindings]);

  useBridgeStream("socFindingAdded", () => { fetchAll(); fetchFindings(0, false); });
  useBridgeStream("socQueueChanged", () => { fetchAll(); });

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchAll(), fetchFindings(0, false)]);
    setRefreshing(false);
  }, [fetchAll, fetchFindings]);

  // ── Overview numbers (same role as the ventures PROJECTS overview card) ──
  const stats = useMemo(() => {
    const totalFindings = (overview?.findings_by_lifecycle || []).reduce((s, r) => s + r.n, 0);
    let stageSum = 0;
    let critHigh = 0;
    let published = 0;
    for (const c of chains) {
      const idx = stageIndex(c.status);
      stageSum += idx >= 0 ? idx + 1 : 0;
      if (c.status === "published") published += 1;
    }
    // crit/high come from the board's first page when unfiltered
    if (!sevFilter) {
      for (const f of findings) {
        if (f.severity === "critical" || f.severity === "high") critHigh += 1;
      }
    }
    const denom = chains.length * CHAIN_STATUS_ORDER.length;
    const pct = denom > 0 ? Math.round((stageSum / denom) * 100) : 0;
    return { totalFindings, critHigh, published, pct, stageSum, denom };
  }, [chains, overview, findings, sevFilter]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.gray[850] }}>
      <TopBar
        background={colors.gray[850]}
        title={<Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 3 }}>SOC</Text>}
      />

      <GroupNav group="work" />

      {/* Sub-tab navigation — same pills as WORK */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, backgroundColor: colors.gray[850] }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {SUB_TABS.map((tab) => (
              <Pressable
                key={tab.key}
                onPress={() => setActiveTab(tab.key)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 6,
                  backgroundColor: activeTab === tab.key ? ACCENT + "22" : "transparent",
                  borderWidth: 1,
                  borderColor: activeTab === tab.key ? ACCENT + "44" : "transparent",
                }}
              >
                <Text
                  style={{
                    color: activeTab === tab.key ? ACCENT : colors.gray[400],
                    fontFamily: "monospace",
                    fontSize: 10,
                    fontWeight: "bold",
                    letterSpacing: 1,
                  }}
                >
                  {tab.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      </View>

      {/* ── CHAINS ── */}
      {activeTab === "chains" && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.gray[400]} />}
        >
          {/* Overview card — same as ventures */}
          <View
            style={{
              backgroundColor: colors.gray[800],
              borderRadius: 14,
              padding: 18,
              marginBottom: 20,
              borderWidth: 1,
              borderColor: HAIRLINE,
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
              <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, letterSpacing: 2 }}>DISCLOSURE PROGRESS</Text>
              <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 28, fontWeight: "bold", lineHeight: 32 }}>{stats.pct}%</Text>
            </View>
            <ProgressBar done={stats.stageSum} total={stats.denom} color={ACCENT} height={8} glow />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 14, paddingHorizontal: 4 }}>
              <View style={{ alignItems: "center" }}>
                <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{chains.length}</Text>
                <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>CHAINS</Text>
              </View>
              <View style={{ alignItems: "center" }}>
                <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{stats.totalFindings}</Text>
                <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>FINDINGS</Text>
              </View>
              <View style={{ alignItems: "center" }}>
                <Text style={{ color: colors.error, fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{stats.critHigh}</Text>
                <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>CRIT+HIGH</Text>
              </View>
              <View style={{ alignItems: "center" }}>
                <Text style={{ color: colors.success, fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{stats.published}</Text>
                <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>PUBLIC</Text>
              </View>
            </View>
          </View>

          {/* Chain cards — ProjectCard shape */}
          {loading && chains.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 40 }}>
              <Text style={{ color: colors.gray[400], fontFamily: "monospace" }}>Loading chains...</Text>
            </View>
          ) : chains.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 60 }}>
              <Text style={{ fontSize: 48, marginBottom: 16 }}>🔐</Text>
              <Text style={{ color: colors.gray[300], fontSize: 15, marginBottom: 4 }}>No kill chains yet</Text>
              <Text style={{ color: colors.gray[400], fontSize: 12, textAlign: "center", paddingHorizontal: 40 }}>
                Chains appear here once Cipher records them
              </Text>
            </View>
          ) : (
            chains.map((c) => {
              const idx = stageIndex(c.status);
              const stage = idx >= 0 ? idx + 1 : 0;
              const statusColor = chainStatusColor(c.status);
              const cv = fmtCvss(c.cvss_composed);
              const drop = dropLabel(c.drop_number);
              return (
                <Pressable
                  key={c.slug}
                  onPress={() => router.push(`/soc/chain/${c.slug}`)}
                  style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}
                >
                  <View
                    style={{
                      backgroundColor: colors.gray[800],
                      borderRadius: 12,
                      borderLeftWidth: 3,
                      borderLeftColor: statusColor,
                      marginBottom: 12,
                      padding: 16,
                      borderWidth: 1,
                      borderColor: HAIRLINE,
                    }}
                  >
                    {/* Header row */}
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                        <Text style={{ fontSize: 22 }}>{chainStatusEmoji(c.status)}</Text>
                        <Text style={{ color: colors.gray[50], fontSize: 15, fontWeight: "600", flex: 1 }} numberOfLines={1}>
                          {safe(c.name, c.slug)}
                        </Text>
                      </View>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor }} />
                    </View>

                    {/* Summary — same slot as the venture description */}
                    {c.summary ? (
                      <Text style={{ color: colors.gray[300], fontSize: 12, lineHeight: 17, marginBottom: 10 }} numberOfLines={2}>
                        {safe(c.summary)}
                      </Text>
                    ) : null}

                    {/* Disclosure progress — same slot as task progress */}
                    <ProgressBar done={stage} total={CHAIN_STATUS_ORDER.length} color={statusColor} height={5} />
                    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
                      <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>
                        {stage}/{CHAIN_STATUS_ORDER.length} · {chainStatusLabel(c.status)}{drop ? ` · ${drop}` : ""}
                      </Text>
                      {cv ? (
                        <Text style={{ color: cvssColor(c.cvss_composed), fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
                          CVSS {cv}
                        </Text>
                      ) : (
                        <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
                          {c.finding_count} fnd
                        </Text>
                      )}
                    </View>
                  </View>
                </Pressable>
              );
            })
          )}
        </ScrollView>
      )}

      {/* ── FINDINGS ── */}
      {activeTab === "findings" && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.gray[400]} />}
        >
          {/* Severity filter — same pills as the dashboard period selector */}
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            {SEV_FILTERS.map((s) => (
              <Pressable
                key={s.key || "all"}
                onPress={() => setSevFilter(s.key)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: sevFilter === s.key ? ACCENT + "22" : colors.gray[800],
                  borderWidth: 1,
                  borderColor: sevFilter === s.key ? ACCENT + "44" : "rgba(255,255,255,0.06)",
                }}
              >
                <Text style={{ color: sevFilter === s.key ? ACCENT : colors.gray[300], fontFamily: "monospace", fontSize: 10, fontWeight: "bold", textTransform: "uppercase" }}>
                  {s.label}
                </Text>
              </Pressable>
            ))}
            <View style={{ flexBasis: "100%", height: 0 }} />
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>
              {findings.length}/{findingsTotal} findings
            </Text>
          </View>

          {findings.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 60 }}>
              <Text style={{ fontSize: 48, marginBottom: 16 }}>🛡️</Text>
              <Text style={{ color: colors.gray[300], fontSize: 15, marginBottom: 4 }}>No findings match</Text>
              <Text style={{ color: colors.gray[400], fontSize: 12, textAlign: "center", paddingHorizontal: 40 }}>
                Clear the severity filter to widen the board
              </Text>
            </View>
          ) : (
            findings.map((f) => {
              const sevC = severityColor(f.severity);
              const lcC = lifecycleColor(f.lifecycle);
              const cv = fmtCvss(f.cvss_score);
              return (
                <Pressable
                  key={f.id}
                  onPress={() => setDetailFinding(f.id)}
                  style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}
                >
                  <View
                    style={{
                      backgroundColor: colors.gray[800],
                      borderRadius: 12,
                      borderLeftWidth: 3,
                      borderLeftColor: sevC,
                      marginBottom: 12,
                      padding: 16,
                      borderWidth: 1,
                      borderColor: HAIRLINE,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                        <Text style={{ fontSize: 22 }}>{severityIcon(f.severity)}</Text>
                        <Text style={{ color: colors.gray[50], fontSize: 15, fontWeight: "600", flex: 1 }} numberOfLines={2}>
                          {safe(f.title)}
                        </Text>
                      </View>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: lcC, marginLeft: 8 }} />
                    </View>

                    <Text style={{ color: colors.gray[300], fontSize: 12, lineHeight: 17, marginBottom: 10 }} numberOfLines={2}>
                      {[f.chain_name, f.skyline_id || f.cve_id, f.affected_asset].filter(Boolean).map((s) => safe(String(s))).join(" · ") || safe(f.severity)}
                    </Text>

                    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 2 }}>
                      <Text style={{ color: lcC, fontFamily: "monospace", fontSize: 10 }}>
                        {lifecycleLabel(f.lifecycle).toUpperCase()}{f.discovered_at ? ` · ${fmtDate(f.discovered_at)}` : ""}
                      </Text>
                      {cv ? (
                        <Text style={{ color: cvssColor(f.cvss_score), fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
                          CVSS {cv}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                </Pressable>
              );
            })
          )}

          {findings.length < findingsTotal ? (
            <Pressable
              onPress={async () => { setLoadingMore(true); await fetchFindings(findings.length, true); setLoadingMore(false); }}
              disabled={loadingMore}
              style={{
                alignItems: "center",
                backgroundColor: ACCENT + "18",
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: ACCENT + "44",
                opacity: loadingMore ? 0.6 : 1,
              }}
            >
              <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                {loadingMore ? "LOADING..." : `+ LOAD ${findingsTotal - findings.length} MORE`}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      )}

      {/* ── ACTIVITY ── */}
      {activeTab === "activity" && (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.gray[400]} />}
        >
          {loading && !overview ? (
            <View style={{ alignItems: "center", paddingVertical: 40 }}>
              <Text style={{ color: colors.gray[400], fontFamily: "monospace" }}>Loading activity...</Text>
            </View>
          ) : (
            <>
              <ActivityCard
                label={`FINDINGS (${(overview?.recent_findings || []).length})`}
                empty="No findings recorded yet"
                rows={(overview?.recent_findings || []).map((f) => ({
                  key: `f${f.id}`,
                  title: safe(f.title),
                  sub: [f.chain_slug, fmtDate(f.discovered_at)].filter(Boolean).join(" · "),
                  right: safe(f.severity).toUpperCase(),
                  rightColor: severityColor(f.severity),
                  onPress: () => setDetailFinding(f.id),
                }))}
              />
              <ActivityCard
                label={`EVIDENCE RUNS (${(overview?.recent_runs || []).length})`}
                empty="No evidence runs recorded yet"
                rows={(overview?.recent_runs || []).map((r) => ({
                  key: `r${r.run_key}`,
                  title: safe(r.purpose, r.run_key),
                  sub: `${safe(r.target)}${r.run_date ? ` · ${fmtDate(r.run_date)}` : ""}`,
                  right: r.verdict ? safe(r.verdict).toUpperCase() : fmtDate(r.run_date),
                  rightColor: r.verdict === "fail" ? colors.error : r.verdict ? colors.success : colors.gray[300],
                  onPress: r.chain_slug ? () => router.push(`/soc/chain/${r.chain_slug}`) : undefined,
                }))}
              />
              <ActivityCard
                label={`VENDOR COORDINATION (${(overview?.recent_coordination || []).length})`}
                empty="No vendor coordination logged yet"
                rows={(overview?.recent_coordination || []).map((c, i) => ({
                  key: `c${c.channel}-${c.event_date}-${i}`,
                  title: safe(c.subject, c.channel),
                  sub: `${DIRECTION_ICON[c.direction] || "·"} ${safe(c.channel)} · ${fmtDate(c.event_date)}`,
                  right: safe(c.status).toUpperCase(),
                  rightColor: channelColor(c.channel),
                }))}
              />
            </>
          )}
        </ScrollView>
      )}

      <FindingDetailModal findingId={detailFinding} onClose={() => setDetailFinding(null)} />
      <StatusBar style="light" />
    </View>
  );
}

// ── Activity section card — DashboardView's TOP-BUYERS card shape ──

interface ActivityRow {
  key: string;
  title: string;
  sub: string;
  right: string;
  rightColor: string;
  onPress?: () => void;
}

function ActivityCard({ label, rows, empty }: { label: string; rows: ActivityRow[]; empty: string }) {
  return (
    <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: HAIRLINE }}>
      <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 10 }}>{label}</Text>
      {rows.length === 0 ? (
        <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 11, paddingVertical: 8 }}>{empty}</Text>
      ) : (
        rows.map((r, i) => {
          const inner = (
            <>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 12 }} numberOfLines={2}>{r.title}</Text>
                {r.sub ? <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10, marginTop: 2 }} numberOfLines={1}>{r.sub}</Text> : null}
              </View>
              <Text style={{ color: r.rightColor, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>{r.right}</Text>
            </>
          );
          const rowStyle = {
            flexDirection: "row" as const,
            justifyContent: "space-between" as const,
            alignItems: "center" as const,
            paddingVertical: 6,
            borderBottomWidth: i < rows.length - 1 ? 1 : 0,
            borderBottomColor: HAIRLINE,
          };
          return r.onPress ? (
            <Pressable key={r.key} onPress={r.onPress} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, rowStyle]}>
              {inner}
            </Pressable>
          ) : (
            <View key={r.key} style={rowStyle}>{inner}</View>
          );
        })
      )}
    </View>
  );
}
