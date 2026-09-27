// Findings board — SOC report console (dir_1790544238642, rebuilt from zero).
// EVERY recorded finding, each with its disclosure lifecycle status shown
// automatically (the rail + label come from the record, nothing hand-set).
// Filterable by lifecycle / severity / kill chain; deep-linkable via route
// params (?lifecycle=filed). Tap a row for the full record. Read-only.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { apiFetch } from "../../lib/bridge-api";
import { useBridgeStream } from "../../lib/useBridgeStream";
import {
  colors,
  spacing,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../lib/design-tokens";
import { FindingDetailModal } from "../../components/soc/FindingDetailModal";
import {
  LIFECYCLE_ORDER,
  LIFECYCLE_EXTRA,
  lifecycleColor,
  lifecycleLabel,
  cvssColor,
  fmtCvss,
  fmtDate,
} from "../../components/soc/chainConstants";
import { safe } from "../../components/soc/safe";
import {
  MONO,
  Mono,
  RowGroup,
  PressRow,
  ConsoleHeader,
  EmptyState,
  microStyle,
} from "../../components/soc/consoleKit";

interface BoardFinding {
  id: number;
  engagement_id: string | null;
  severity: string;
  title: string;
  lifecycle: string | null;
  skyline_id: string | null;
  cve_id: string | null;
  cvss_score: string | number | null;
  kind: string | null;
  status: string | null;
  discovered_at: string | null;
  chain_slug: string | null;
  chain_name: string | null;
}

interface ChainOption { slug: string; name: string; }

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const SEV_COLOR: Record<string, string> = {
  critical: colors.error,
  high: colors.brand.orange,
  medium: colors.brand.amberDeep,
  low: colors.info,
  info: colors.text.secondary,
};
const PAGE = 100;

export default function FindingsBoardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ lifecycle?: string; severity?: string; chain?: string }>();

  const [findings, setFindings] = useState<BoardFinding[]>([]);
  const [total, setTotal] = useState(0);
  const [chains, setChains] = useState<ChainOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lifecycle, setLifecycle] = useState<string | null>(params.lifecycle || null);
  const [severity, setSeverity] = useState<string | null>(params.severity || null);
  const [chain, setChain] = useState<string | null>(params.chain || null);
  const [detailId, setDetailId] = useState<number | null>(null);

  const buildQuery = useCallback((offset: number) => {
    const p = new URLSearchParams();
    if (lifecycle) p.set("lifecycle", lifecycle);
    if (severity) p.set("severity", severity);
    if (chain) p.set("chain", chain);
    p.set("limit", String(PAGE));
    p.set("offset", String(offset));
    return `/soc/findings?${p.toString()}`;
  }, [lifecycle, severity, chain]);

  const fetchPage = useCallback(async (offset: number, append: boolean) => {
    try {
      const d = await apiFetch(buildQuery(offset));
      setFindings((prev) => (append ? [...prev, ...(d.findings || [])] : d.findings || []));
      setTotal(d.total || 0);
    } catch {}
  }, [buildQuery]);

  // Filter change → refetch from scratch.
  useEffect(() => {
    setLoading(true);
    fetchPage(0, false).finally(() => setLoading(false));
  }, [fetchPage]);

  useEffect(() => {
    apiFetch("/soc/chains")
      .then((d) => setChains((d.chains || []).map((c: any) => ({ slug: c.slug, name: c.name }))))
      .catch(() => {});
  }, []);

  useBridgeStream("socFindingAdded", () => { fetchPage(0, false); });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchPage(0, false);
    setRefreshing(false);
  }, [fetchPage]);

  const onLoadMore = useCallback(async () => {
    setLoadingMore(true);
    await fetchPage(findings.length, true);
    setLoadingMore(false);
  }, [fetchPage, findings.length]);

  const hasMore = findings.length < total;
  const lifecyclePills = useMemo(() => [...LIFECYCLE_ORDER, ...LIFECYCLE_EXTRA], []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />

      <ConsoleHeader
        onBack={() => router.back()}
        label="findings"
        right={
          !loading ? (
            <Mono color={colors.text.disabled} size={fs.sm} weight="semibold">
              {findings.length}/{total}
            </Mono>
          ) : null
        }
      />

      {/* ── Filters: sharp mono chips, two rails ── */}
      <View style={{
        borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
        backgroundColor: colors.bg.elevated,
        paddingVertical: spacing.sm, gap: spacing.sm,
      }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.sm }}>
          <FilterChip label="all" color={colors.text.secondary} active={!lifecycle} onPress={() => setLifecycle(null)} />
          {lifecyclePills.map((lc) => (
            <FilterChip
              key={lc}
              label={lifecycleLabel(lc)}
              color={lifecycleColor(lc)}
              active={lifecycle === lc}
              onPress={() => setLifecycle(lifecycle === lc ? null : lc)}
            />
          ))}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.sm }}>
          {SEVERITIES.map((sv) => (
            <FilterChip
              key={sv}
              label={sv}
              color={SEV_COLOR[sv]}
              active={severity === sv}
              onPress={() => setSeverity(severity === sv ? null : sv)}
            />
          ))}
          <View style={{ width: 1, height: 18, backgroundColor: colors.border.default, marginHorizontal: spacing.xs }} />
          {chains.map((c) => (
            <FilterChip
              key={c.slug}
              label={c.name.length > 16 ? `${c.name.slice(0, 15)}…` : c.name}
              color={colors.brand.purple}
              active={chain === c.slug}
              onPress={() => setChain(chain === c.slug ? null : c.slug)}
            />
          ))}
        </ScrollView>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: spacing.xxxl }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.disabled} />
        }
      >
        {loading ? (
          <View style={{ paddingVertical: spacing.xxxl, alignItems: "center" }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : findings.length === 0 ? (
          <EmptyState text="no findings match" sub="clear a filter to widen the board" />
        ) : (
          <View style={{ paddingHorizontal: spacing.md, paddingTop: spacing.md }}>
            <RowGroup>
              {findings.map((f, i) => {
                const lcColor = lifecycleColor(f.lifecycle);
                const cv = fmtCvss(f.cvss_score);
                return (
                  <PressRow
                    key={f.id}
                    rail={lcColor}
                    last={i === findings.length - 1 && !hasMore}
                    onPress={() => setDetailId(f.id)}
                  >
                    <View style={{ flex: 1, paddingLeft: spacing.xs }}>
                      <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.semibold, lineHeight: 18 }} numberOfLines={2}>
                        {safe(f.title)}
                      </Text>
                      <Mono color={colors.text.disabled} style={{ marginTop: 3 }}>
                        {[
                          f.skyline_id || f.cve_id,
                          f.chain_slug,
                          f.severity.toUpperCase(),
                          f.discovered_at ? fmtDate(f.discovered_at) : null,
                        ].filter(Boolean).join(" · ")}
                      </Mono>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      {cv ? <Mono color={cvssColor(f.cvss_score)} size={fs.lg} weight="bold">{cv}</Mono> : null}
                      <Text style={microStyle(lcColor, 9)}>{lifecycleLabel(f.lifecycle)}</Text>
                    </View>
                  </PressRow>
                );
              })}
              {hasMore ? (
                <Pressable
                  onPress={onLoadMore}
                  disabled={loadingMore}
                  style={({ pressed }) => ({
                    alignItems: "center", paddingVertical: spacing.md,
                    opacity: pressed || loadingMore ? 0.6 : 1,
                  })}
                >
                  <Mono color={colors.accent} size={fs.sm} weight="bold">
                    {loadingMore ? "loading…" : `load more · ${total - findings.length} remaining`}
                  </Mono>
                </Pressable>
              ) : null}
            </RowGroup>
          </View>
        )}
      </ScrollView>

      <FindingDetailModal findingId={detailId} onClose={() => setDetailId(null)} />
    </View>
  );
}

// ── Filter chip: sharp, uppercase mono, alpha fill when active ──

function FilterChip({ label, color, active, onPress }: {
  label: string; color: string; active: boolean; onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      paddingHorizontal: spacing.sm + 2, paddingVertical: 4,
      borderRadius: 3,
      backgroundColor: active ? withAlpha(color, 0.16) : "transparent",
      borderWidth: 1,
      borderColor: active ? withAlpha(color, 0.5) : colors.border.default,
      opacity: pressed ? 0.7 : 1,
    })}>
      <Text style={{
        color: active ? color : colors.text.tertiary,
        fontSize: 9, fontWeight: fw.bold, letterSpacing: 1,
        textTransform: "uppercase", fontFamily: MONO,
      }}>
        {label}
      </Text>
    </Pressable>
  );
}
