// Findings board — SOC v3 report plane (dir_1790538151856).
// Every recorded finding with its disclosure lifecycle status, filterable by
// lifecycle / severity / kill chain. Tap a row for the full record
// (FindingDetailModal). Read-only: statuses move via Cipher's MCP tools, the
// board reflects them.

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
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { apiFetch } from "../../lib/bridge-api";
import { useBridgeStream } from "../../lib/useBridgeStream";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../lib/design-tokens";
import { FindingDetailModal } from "../../components/soc/FindingDetailModal";
import { severityColor } from "../../components/soc/phaseColors";
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
const PAGE = 100;

export default function FindingsBoardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [findings, setFindings] = useState<BoardFinding[]>([]);
  const [total, setTotal] = useState(0);
  const [chains, setChains] = useState<ChainOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lifecycle, setLifecycle] = useState<string | null>(null);
  const [severity, setSeverity] = useState<string | null>(null);
  const [chain, setChain] = useState<string | null>(null);
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

  const lifecyclePills = useMemo(
    () => [...LIFECYCLE_ORDER, ...LIFECYCLE_EXTRA],
    [],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={{
        paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md,
        backgroundColor: colors.bg.elevated,
        borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
      }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Pressable onPress={() => router.back()} hitSlop={16} style={({ pressed }) => ({
            opacity: pressed ? 0.6 : 1, paddingVertical: spacing.xs, paddingRight: spacing.md,
          })}>
            <Text style={{ color: colors.accent, fontSize: fs.lg, fontWeight: fw.medium }}>← Back</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text.primary, fontSize: fs.xl, fontWeight: fw.bold }}>Findings</Text>
          </View>
          {!loading ? (
            <Text style={{ color: colors.text.tertiary, fontSize: fs.sm, fontFamily: "monospace" }}>
              {findings.length}/{total}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Filter row 1 — lifecycle */}
      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        style={{ backgroundColor: colors.bg.elevated, flexGrow: 0 }}
        contentContainerStyle={{ gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
      >
        <FilterPill label="all" selected={lifecycle == null} color={colors.accent} onPress={() => setLifecycle(null)} />
        {lifecyclePills.map((lc) => (
          <FilterPill
            key={lc}
            label={lifecycleLabel(lc)}
            selected={lifecycle === lc}
            color={lifecycleColor(lc)}
            onPress={() => setLifecycle(lifecycle === lc ? null : lc)}
          />
        ))}
      </ScrollView>

      {/* Filter row 2 — severity + chain */}
      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        style={{ backgroundColor: colors.bg.elevated, flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border.subtle }}
        contentContainerStyle={{ gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
      >
        {SEVERITIES.map((sv) => (
          <FilterPill
            key={sv}
            label={sv}
            selected={severity === sv}
            color={severityColor(sv)}
            onPress={() => setSeverity(severity === sv ? null : sv)}
          />
        ))}
        {chains.length > 0 ? (
          <View style={{ width: 1, backgroundColor: colors.border.default, marginHorizontal: spacing.xs }} />
        ) : null}
        {chains.map((c) => (
          <FilterPill
            key={c.slug}
            label={`⛓ ${c.name}`}
            selected={chain === c.slug}
            color={colors.brand.purple}
            onPress={() => setChain(chain === c.slug ? null : c.slug)}
          />
        ))}
      </ScrollView>

      {/* Board */}
      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: spacing.sm }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.disabled} />}
        >
          {findings.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: spacing.xxxl }}>
              <Text style={{ fontSize: 40, marginBottom: spacing.sm }}>🔎</Text>
              <Text style={{ color: colors.text.tertiary, fontSize: fs.md }}>No findings match these filters</Text>
            </View>
          ) : (
            findings.map((f) => <BoardRow key={f.id} finding={f} onPress={() => setDetailId(f.id)} />)
          )}
          {hasMore ? (
            <Pressable
              onPress={onLoadMore}
              disabled={loadingMore}
              style={({ pressed }) => ({
                alignItems: "center", paddingVertical: spacing.md,
                borderRadius: radius.md, marginTop: spacing.xs,
                backgroundColor: pressed ? withAlpha(colors.text.secondary, 0.10) : withAlpha(colors.text.secondary, 0.06),
                opacity: loadingMore ? 0.5 : 1,
              })}
            >
              <Text style={{ color: colors.text.secondary, fontSize: fs.md, fontWeight: fw.medium }}>
                {loadingMore ? "Loading…" : `Load more (${total - findings.length} remaining)`}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      )}

      <FindingDetailModal findingId={detailId} onClose={() => setDetailId(null)} />
    </View>
  );
}

// ── Row ──

function BoardRow({ finding, onPress }: { finding: BoardFinding; onPress: () => void }) {
  const sevColor = severityColor(finding.severity);
  const lcColor = lifecycleColor(finding.lifecycle);
  const cv = fmtCvss(finding.cvss_score);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: colors.gray[800],
        borderRadius: radius.md,
        borderLeftWidth: 3,
        borderLeftColor: sevColor,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.04)",
        padding: spacing.md,
        opacity: pressed ? 0.92 : 1,
      })}
    >
      {/* Title row */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
        <Text style={{ flex: 1, color: colors.text.primary, fontSize: fs.base, fontWeight: fw.medium, lineHeight: 18 }} numberOfLines={2}>
          {safe(finding.title)}
        </Text>
        {cv ? (
          <View style={{
            backgroundColor: withAlpha(cvssColor(finding.cvss_score), 0.13),
            borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2,
          }}>
            <Text style={{ color: cvssColor(finding.cvss_score), fontSize: fs.sm, fontWeight: fw.bold, fontFamily: "monospace" }}>
              {cv}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Status chips */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm }}>
        <Chip label={lifecycleLabel(finding.lifecycle)} color={lcColor} dot />
        <Chip label={safe(finding.severity)} color={sevColor} />
        {finding.skyline_id ? <Chip label={safe(finding.skyline_id)} color={colors.accent} mono />
          : finding.cve_id ? <Chip label={safe(finding.cve_id)} color={colors.brand.orange} mono /> : null}
        {finding.chain_slug ? <Chip label={`⛓ ${safe(finding.chain_name, finding.chain_slug)}`} color={colors.brand.purple} /> : null}
      </View>

      {/* Meta line */}
      <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.sm, gap: spacing.sm }}>
        <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontFamily: "monospace", flex: 1 }} numberOfLines={1}>
          {safe(finding.engagement_id, "—")}{finding.kind ? ` · ${safe(finding.kind)}` : ""}
        </Text>
        <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontFamily: "monospace" }}>
          {fmtDate(finding.discovered_at)}
        </Text>
      </View>
    </Pressable>
  );
}

function Chip({ label, color, mono, dot }: { label: string; color: string; mono?: boolean; dot?: boolean }) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 4,
      backgroundColor: withAlpha(color, 0.11), borderRadius: radius.sm,
      paddingHorizontal: spacing.sm, paddingVertical: 2,
    }}>
      {dot ? <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: color }} /> : null}
      <Text style={{ color, fontSize: fs.xs, fontWeight: fw.semibold, fontFamily: mono ? "monospace" : undefined }}>
        {label}
      </Text>
    </View>
  );
}

function FilterPill({ label, selected, color, onPress }: {
  label: string; selected: boolean; color: string; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          paddingHorizontal: spacing.md, paddingVertical: 5,
          borderRadius: radius.full,
          backgroundColor: selected ? withAlpha(color, 0.20) : withAlpha(colors.text.secondary, 0.07),
          borderWidth: 1,
          borderColor: selected ? withAlpha(color, 0.55) : "transparent",
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text style={{
        color: selected ? color : colors.text.secondary,
        fontSize: fs.sm,
        fontWeight: selected ? fw.semibold : fw.medium,
      }}>
        {label}
      </Text>
    </Pressable>
  );
}
