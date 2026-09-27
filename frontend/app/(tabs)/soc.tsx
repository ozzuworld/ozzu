// SOC home — kill-chain campaign console (dir_1790544238642, rebuilt from zero).
// The app is a REPORTING tool organized by kill chains. This screen shows:
//   1. the lead chain as a hero panel (banner, disclosure stage track, counts)
//   2. every kill chain as a dense row (status rail, DROP, CVSS)
//   3. the findings pulse — every finding by lifecycle status, tappable
//   4. the activity record (findings / evidence runs / vendor coordination)
// Nothing else lives here. Engagements are NOT part of the app's navigation:
// they are an ops record reachable only from inside a chain.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { TopBar } from "../../components/TopBar";
import { apiFetch } from "../../lib/bridge-api";
import { useBridgeStream } from "../../lib/useBridgeStream";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
} from "../../lib/design-tokens";
import { severityColor } from "../../components/soc/phaseColors";
import {
  chainStatusColor,
  chainStatusLabel,
  lifecycleColor,
  lifecycleLabel,
  cvssColor,
  fmtCvss,
  fmtDate,
  dropLabel,
  channelColor,
} from "../../components/soc/chainConstants";
import { safe } from "../../components/soc/safe";
import {
  MONO,
  MicroLabel,
  Mono,
  Chip,
  SectionHead,
  StageTrack,
  PulseBar,
  type PulseSegment,
  RowGroup,
  PressRow,
  StatCell,
  EmptyState,
} from "../../components/soc/consoleKit";

// ── Types (mirrors GET /soc/chains + GET /soc/overview) ──

interface ChainSummary {
  slug: string;
  name: string;
  drop_number: number | null;
  status: string;
  cvss_composed: string | number | null;
  cvss_standalone: string | number | null;
  published_repo: string | null;
  published_at: string | null;
  summary: string | null;
  engagement_ids: string[] | string | null;
  component_count: number;
  artifact_count: number;
  finding_count: number;
  banner_artifact_id: number | null;
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

type FeedItem = {
  key: string;
  tag: string;
  tagColor: string;
  title: string;
  date: string;
  onPress?: () => void;
};

const UNSET = "(unset)";

export default function SOCScreen() {
  const router = useRouter();

  const [chains, setChains] = useState<ChainSummary[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [chainsRes, overviewRes] = await Promise.all([
        apiFetch("/soc/chains"),
        apiFetch("/soc/overview"),
      ]);
      setChains(chainsRes.chains || []);
      setOverview(overviewRes || null);
    } catch (error) {
      console.error("Error fetching SOC overview:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Record-plane pushes: a new finding / queue change anywhere in the campaign
  // refreshes the record. No exec streams — the app doesn't act.
  useBridgeStream("socFindingAdded", () => { fetchAll(); });
  useBridgeStream("socQueueChanged", () => { fetchAll(); });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  // Findings pulse: every finding, by lifecycle status, tappable → board.
  const pulse = useMemo<PulseSegment[]>(() => {
    const rows = overview?.findings_by_lifecycle || [];
    return rows
      .filter((r) => r.n > 0)
      .map((r) => {
        const unset = !r.lifecycle || r.lifecycle === UNSET;
        return {
          key: unset ? "unset" : r.lifecycle,
          label: unset ? "unfiled" : lifecycleLabel(r.lifecycle),
          n: r.n,
          color: unset ? colors.gray[500] : lifecycleColor(r.lifecycle),
        };
      });
  }, [overview]);
  const tracked = useMemo(
    () => pulse.filter((p) => p.key !== "unset").reduce((s, p) => s + p.n, 0),
    [pulse],
  );

  const feed = useMemo<FeedItem[]>(() => {
    const items: Array<FeedItem & { sort: string }> = [];
    for (const f of overview?.recent_findings || []) {
      items.push({
        key: `f${f.id}`,
        tag: "FINDING",
        tagColor: severityColor(f.severity),
        title: safe(f.title),
        date: fmtDate(f.discovered_at),
        sort: f.discovered_at || "",
        onPress: () => router.push("/soc/findings"),
      });
    }
    for (const r of overview?.recent_runs || []) {
      items.push({
        key: `r${r.run_key}`,
        tag: "RUN",
        tagColor: colors.accent,
        title: safe(r.purpose, r.run_key),
        date: fmtDate(r.run_date),
        sort: r.run_date || "",
        onPress: r.chain_slug ? () => router.push(`/soc/chain/${r.chain_slug}`) : undefined,
      });
    }
    for (const c of overview?.recent_coordination || []) {
      items.push({
        key: `c${c.channel}-${c.event_date}`,
        tag: (c.channel || "msg").toUpperCase().slice(0, 8),
        tagColor: channelColor(c.channel),
        title: safe(c.subject, c.channel),
        date: fmtDate(c.event_date),
        sort: c.event_date || "",
      });
    }
    items.sort((a, b) => (b.sort || "").localeCompare(a.sort || ""));
    return items.slice(0, 12).map(({ sort, ...rest }) => rest);
  }, [overview, router]);

  const hero = chains[0] || null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <StatusBar style="light" />

      <TopBar
        title={
          <Text style={{
            color: colors.gray[50], fontSize: fs.xl, fontWeight: fw.bold,
            fontFamily: MONO, letterSpacing: 6,
          }}>
            SOC
          </Text>
        }
        background={colors.bg.elevated}
        borderBottom
        right={
          <Chip label="findings" color={colors.brand.purple} onPress={() => router.push("/soc/findings")} />
        }
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.xxxl }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.disabled} />
        }
      >
        {/* Campaign stamp row */}
        <View style={{
          flexDirection: "row", alignItems: "center",
          marginTop: spacing.md, marginBottom: spacing.md,
        }}>
          <MicroLabel color={colors.text.secondary}>campaign record</MicroLabel>
          <View style={{ flex: 1 }} />
          <Mono color={colors.text.disabled}>{fmtDate(new Date().toISOString())}</Mono>
        </View>

        {loading ? (
          <EmptyState text="loading campaign record" />
        ) : chains.length === 0 ? (
          <EmptyState text="no kill chains recorded" sub="chains appear once Cipher records them" />
        ) : (
          <>
            {/* ── Lead chain hero ── */}
            {hero ? (
              <Pressable
                onPress={() => router.push(`/soc/chain/${hero.slug}`)}
                style={({ pressed }) => ({
                  opacity: pressed ? 0.94 : 1,
                  borderWidth: 1, borderColor: colors.border.default,
                  borderRadius: radius.lg, overflow: "hidden",
                  backgroundColor: colors.gray[850],
                })}
              >
                <View style={{ padding: spacing.md, gap: spacing.md }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    {dropLabel(hero.drop_number) ? (
                      <Chip label={dropLabel(hero.drop_number)!} color={colors.accent} filled />
                    ) : null}
                    <Chip label={chainStatusLabel(hero.status)} color={chainStatusColor(hero.status)} dot />
                    <View style={{ flex: 1 }} />
                    {hero.published_repo ? <Chip label="public" color={colors.success} /> : null}
                  </View>
                  <Text style={{ color: colors.gray[50], fontSize: 22, fontWeight: fw.bold }} numberOfLines={1}>
                    {safe(hero.name, hero.slug)}
                  </Text>
                  <StageTrack status={hero.status} />
                  {hero.summary ? (
                    <Text style={{ color: colors.text.secondary, fontSize: fs.sm, lineHeight: 18 }} numberOfLines={2}>
                      {safe(hero.summary)}
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: "row", alignItems: "flex-end", gap: spacing.xl }}>
                    {fmtCvss(hero.cvss_composed) ? (
                      <StatCell
                        value={fmtCvss(hero.cvss_composed)!}
                        label="cvss"
                        color={cvssColor(hero.cvss_composed)}
                        size={26}
                      />
                    ) : null}
                    <StatCell value={hero.component_count} label="comps" />
                    <StatCell value={hero.finding_count} label="findings" />
                    <StatCell value={hero.artifact_count} label="artifacts" />
                  </View>
                </View>
              </Pressable>
            ) : null}

            {/* ── All chains, dense ── */}
            <SectionHead label="kill chains" right={String(chains.length)} />
            <RowGroup>
              {chains.map((c, i) => {
                const cv = fmtCvss(c.cvss_composed);
                return (
                  <PressRow
                    key={c.slug}
                    rail={chainStatusColor(c.status)}
                    last={i === chains.length - 1}
                    onPress={() => router.push(`/soc/chain/${c.slug}`)}
                  >
                    <View style={{ flex: 1, paddingLeft: spacing.xs }}>
                      <Text style={{ color: colors.text.primary, fontSize: fs.lg, fontWeight: fw.semibold }} numberOfLines={1}>
                        {safe(c.name, c.slug)}
                      </Text>
                      <Mono color={colors.text.tertiary} style={{ marginTop: 2 }}>
                        {dropLabel(c.drop_number) || "----"} · {chainStatusLabel(c.status)} · {c.component_count} cmp · {c.finding_count} fnd
                      </Mono>
                    </View>
                    {cv ? (
                      <Mono color={cvssColor(c.cvss_composed)} size={fs.lg} weight="bold">{cv}</Mono>
                    ) : null}
                    <Mono color={colors.text.disabled} size={fs.lg}>›</Mono>
                  </PressRow>
                );
              })}
            </RowGroup>

            {/* ── Findings pulse ── */}
            <SectionHead label="findings by status" right={`${tracked} tracked`} rightColor={colors.info} />
            <PulseBar segments={pulse.filter((p) => p.key !== "unset")} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xl, rowGap: spacing.md }}>
              {pulse.map((p) => (
                <StatCell
                  key={p.key}
                  value={p.n}
                  label={p.label}
                  color={p.color}
                  size={fs.xxl}
                  onPress={() => router.push(p.key === "unset" ? "/soc/findings" : `/soc/findings?lifecycle=${p.key}`)}
                />
              ))}
            </View>

            {/* ── Activity record ── */}
            <SectionHead label="activity" right={String(feed.length)} />
            {feed.length === 0 ? (
              <EmptyState text="no activity recorded" />
            ) : (
              <RowGroup>
                {feed.map((item, i) => (
                  <PressRow key={item.key} last={i === feed.length - 1} onPress={item.onPress}>
                    <View style={{ width: 66 }}>
                      <Chip label={item.tag} color={item.tagColor} />
                    </View>
                    <Text
                      style={{ flex: 1, color: colors.text.primary, fontSize: fs.md, fontWeight: fw.medium, lineHeight: 18 }}
                      numberOfLines={2}
                    >
                      {item.title}
                    </Text>
                    <Mono color={colors.text.disabled} style={{ flexShrink: 0 }}>{item.date}</Mono>
                  </PressRow>
                ))}
              </RowGroup>
            )}
          </>
        )}

      </ScrollView>
    </View>
  );
}
