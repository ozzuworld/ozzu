// SOC tab — kill-chain-first reporting home (v3 record/report plane).
// dir_1790538151856: the app is NO LONGER an acting tool. This screen shows
// the campaign the way it is organized on disk + in the bridge record:
//   1. stat strip (chains / tracked findings / active engagements / published)
//   2. kill-chain cards (banner, DROP number, disclosure status, CVSS, counts)
//   3. active engagements (record view — tap for the read-only detail)
//   4. activity feed (findings, evidence runs, vendor coordination)
// Acting controls (Run / new engagement / Calls / relay toggle) are gone;
// work happens in the terminal, the app reports it.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  Image,
  Linking,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { GroupNav } from "../../components/GroupNav";
import { TopBar } from "../../components/TopBar";
import { StatusBadge } from "../../components/StatusBadge";
import { apiFetch, getBridgeUrl, getAuthHeaders } from "../../lib/bridge-api";
import { useBridgeStream } from "../../lib/useBridgeStream";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../lib/design-tokens";
import { EngagementCard, type EngagementSummary } from "../../components/soc/EngagementCard";
import { severityColor } from "../../components/soc/phaseColors";
import {
  chainStatusColor,
  chainStatusLabel,
  cvssColor,
  fmtCvss,
  fmtDate,
  dropLabel,
  channelColor,
} from "../../components/soc/chainConstants";
import { safe } from "../../components/soc/safe";

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
  engagements_by_status: Array<{ status: string; n: number }>;
}

type FeedItem = {
  key: string;
  tag: string;
  tagColor: string;
  title: string;
  sub: string;
  date: string;
  onPress?: () => void;
};

const ACTIVE_ENGAGEMENT = new Set(["in_progress", "approved"]);

export default function SOCScreen() {
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [chains, setChains] = useState<ChainSummary[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [engagements, setEngagements] = useState<EngagementSummary[]>([]);
  const [showAllEngagements, setShowAllEngagements] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [chainsRes, overviewRes, engRes] = await Promise.all([
        apiFetch("/soc/chains"),
        apiFetch("/soc/overview"),
        apiFetch("/soc/engagements"),
      ]);
      setChains(chainsRes.chains || []);
      setOverview(overviewRes || null);
      setEngagements(engRes.engagements || []);
    } catch (error) {
      console.error("Error fetching SOC overview:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Record-plane pushes: a new finding / queue change anywhere in the campaign
  // refreshes the feed + counters. No exec streams — the app doesn't act.
  useBridgeStream("socFindingAdded", () => { fetchAll(); });
  useBridgeStream("socQueueChanged", () => { fetchAll(); });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  const activeEngagements = useMemo(
    () => engagements.filter((e) => ACTIVE_ENGAGEMENT.has(e.status)),
    [engagements],
  );
  const visibleEngagements = showAllEngagements ? activeEngagements : activeEngagements.slice(0, 3);

  const stats = useMemo(() => {
    const tracked = (overview?.findings_by_lifecycle || [])
      .filter((r) => r.lifecycle && r.lifecycle !== "(unset)")
      .reduce((s, r) => s + r.n, 0);
    const activeEng = (overview?.engagements_by_status || [])
      .filter((r) => ACTIVE_ENGAGEMENT.has(r.status))
      .reduce((s, r) => s + r.n, 0);
    const published = chains.filter((c) => c.status === "published").length;
    return [
      { label: "CHAINS", value: chains.length, color: colors.brand.purple },
      { label: "TRACKED", value: tracked, color: colors.info },
      { label: "ACTIVE", value: activeEng, color: colors.warning },
      { label: "PUBLISHED", value: published, color: colors.accent },
    ];
  }, [overview, chains]);

  const feed = useMemo<FeedItem[]>(() => {
    const items: Array<FeedItem & { sort: string }> = [];
    for (const f of overview?.recent_findings || []) {
      items.push({
        key: `f${f.id}`,
        tag: "FINDING",
        tagColor: severityColor(f.severity),
        title: safe(f.title),
        sub: [f.chain_slug ? `⛓ ${f.chain_slug}` : null, safe(f.severity).toUpperCase(), f.lifecycle || "unfiled"]
          .filter(Boolean).join(" · "),
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
        sub: [r.run_key, safe(r.target), r.verdict || null].filter(Boolean).join(" · "),
        date: fmtDate(r.run_date),
        sort: r.run_date || "",
        onPress: r.chain_slug ? () => router.push(`/soc/chain/${r.chain_slug}`) : undefined,
      });
    }
    for (const c of overview?.recent_coordination || []) {
      items.push({
        key: `c${c.channel}-${c.event_date}-${fmtDate(c.event_date)}`,
        tag: (c.channel || "msg").toUpperCase(),
        tagColor: channelColor(c.channel),
        title: safe(c.subject, c.channel),
        sub: [safe(c.direction), safe(c.status)].filter(Boolean).join(" · "),
        date: fmtDate(c.event_date),
        sort: c.event_date || "",
      });
    }
    items.sort((a, b) => (b.sort || "").localeCompare(a.sort || ""));
    return items.slice(0, 14).map(({ sort, ...rest }) => rest);
  }, [overview, router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />

      <TopBar
        title="🔐 SOC"
        background={colors.bg.elevated}
        borderBottom
        right={
          <>
            <Pressable
              onPress={() => router.push("/soc/findings")}
              hitSlop={8}
              style={({ pressed }) => ({
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 12,
                backgroundColor: pressed ? withAlpha(colors.brand.purple, 0.18) : withAlpha(colors.brand.purple, 0.10),
              })}
            >
              <Text style={{ color: colors.brand.purple, fontSize: fs.sm, fontWeight: fw.semibold }}>Findings</Text>
            </Pressable>
            <StatusBadge />
          </>
        }
      />
      <GroupNav group="work" />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.xxxl }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.text.disabled} />
        }
      >
        {/* ── Stat strip ── */}
        <View style={{
          flexDirection: "row", gap: spacing.sm,
          marginTop: spacing.md, marginBottom: spacing.lg,
        }}>
          {stats.map((s) => (
            <View key={s.label} style={{
              flex: 1, backgroundColor: colors.gray[850], borderRadius: radius.md,
              paddingVertical: spacing.md, alignItems: "center",
              borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
            }}>
              <Text style={{ color: s.color, fontSize: fs.xxl, fontWeight: fw.bold, fontFamily: "monospace" }}>
                {s.value}
              </Text>
              <Text style={{ color: colors.text.tertiary, fontSize: 9, fontWeight: fw.semibold, letterSpacing: 0.5, marginTop: 2 }}>
                {s.label}
              </Text>
            </View>
          ))}
        </View>

        {/* ── Kill chains ── */}
        <SectionHeader title="KILL CHAINS" count={chains.length} />
        {loading ? (
          <Text style={{ color: colors.text.disabled, textAlign: "center", marginTop: spacing.xl }}>
            Loading campaign…
          </Text>
        ) : chains.length === 0 ? (
          <EmptyHint
            emoji="⛓️"
            text="No kill chains recorded yet"
            sub="Chains appear here once Cipher records them via add_kill_chain."
          />
        ) : (
          chains.map((c) => <ChainCard key={c.slug} chain={c} onPress={() => router.push(`/soc/chain/${c.slug}`)} />)
        )}

        {/* ── Active engagements ── */}
        {activeEngagements.length > 0 ? (
          <>
            <SectionHeader title="ACTIVE ENGAGEMENTS" count={activeEngagements.length} />
            {visibleEngagements.map((eng) => (
              <EngagementCard key={eng.id} engagement={eng} onPress={() => router.push(`/soc/${eng.id}`)} />
            ))}
            {activeEngagements.length > 3 ? (
              <Pressable
                onPress={() => setShowAllEngagements((v) => !v)}
                style={({ pressed }) => ({
                  alignItems: "center", paddingVertical: spacing.md,
                  borderRadius: radius.md, marginBottom: spacing.lg,
                  backgroundColor: pressed ? withAlpha(colors.text.secondary, 0.08) : "transparent",
                })}
              >
                <Text style={{ color: colors.text.secondary, fontSize: fs.md, fontWeight: fw.medium }}>
                  {showAllEngagements ? "Show less ▲" : `Show all ${activeEngagements.length} active ▼`}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        {/* ── Activity feed ── */}
        <SectionHeader title="ACTIVITY" count={feed.length} />
        {feed.length === 0 && !loading ? (
          <EmptyHint emoji="📡" text="No activity recorded yet" sub="Findings, evidence runs and vendor messages land here." />
        ) : (
          <View style={{
            backgroundColor: colors.gray[850], borderRadius: radius.lg,
            borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
            overflow: "hidden",
          }}>
            {feed.map((item, i) => (
              <Pressable
                key={item.key}
                onPress={item.onPress}
                disabled={!item.onPress}
                style={({ pressed }) => ({
                  flexDirection: "row", alignItems: "center", gap: spacing.sm,
                  paddingHorizontal: spacing.md, paddingVertical: spacing.md,
                  borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.border.subtle,
                  backgroundColor: pressed && item.onPress ? withAlpha(colors.text.secondary, 0.06) : "transparent",
                })}
              >
                <View style={{
                  width: 58, alignItems: "center", paddingVertical: 2,
                  backgroundColor: withAlpha(item.tagColor, 0.12), borderRadius: radius.xs,
                }}>
                  <Text style={{ color: item.tagColor, fontSize: 8, fontWeight: fw.bold, letterSpacing: 0.3 }} numberOfLines={1}>
                    {item.tag}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.medium }} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={{ color: colors.text.tertiary, fontSize: fs.xs, marginTop: 1 }} numberOfLines={1}>
                    {item.sub}
                  </Text>
                </View>
                <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontFamily: "monospace" }}>
                  {item.date}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ── Chain card ── banner header + DROP/status overlay + summary + chips.

function ChainCard({ chain, onPress }: { chain: ChainSummary; onPress: () => void }) {
  const statusColor = chainStatusColor(chain.status);
  const composed = fmtCvss(chain.cvss_composed);
  const standalone = fmtCvss(chain.cvss_standalone);
  const drop = dropLabel(chain.drop_number);
  const engCount = Array.isArray(chain.engagement_ids) ? chain.engagement_ids.length : 0;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.98 : 1 }], marginBottom: spacing.md })}
    >
      <View style={{
        backgroundColor: colors.gray[800],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.04)",
        overflow: "hidden",
      }}>
        {/* Banner + overlay strip */}
        {chain.banner_artifact_id ? (
          <View>
            <Image
              source={{
                uri: `${getBridgeUrl()}/soc/artifacts/${chain.banner_artifact_id}/content`,
                headers: getAuthHeaders(),
              }}
              style={{ width: "100%", height: 128 }}
              resizeMode="cover"
            />
            <View style={{
              position: "absolute", left: 0, right: 0, bottom: 0,
              flexDirection: "row", alignItems: "center", gap: spacing.sm,
              paddingHorizontal: spacing.md, paddingVertical: 6,
              backgroundColor: withAlpha(colors.bg.base, 0.78),
            }}>
              {drop ? (
                <View style={{
                  backgroundColor: withAlpha(colors.accent, 0.18), borderRadius: radius.xs,
                  paddingHorizontal: spacing.sm, paddingVertical: 2,
                }}>
                  <Text style={{ color: colors.accentLight, fontSize: fs.xs, fontWeight: fw.bold, letterSpacing: 0.8 }}>{drop}</Text>
                </View>
              ) : null}
              <View style={{ flex: 1 }} />
              <View style={{
                flexDirection: "row", alignItems: "center",
                backgroundColor: withAlpha(statusColor, 0.16), borderRadius: radius.xs,
                paddingHorizontal: spacing.sm, paddingVertical: 2,
              }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor, marginRight: spacing.xs }} />
                <Text style={{ color: statusColor, fontSize: fs.xs, fontWeight: fw.semibold }}>
                  {chainStatusLabel(chain.status)}
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        {/* Body */}
        <View style={{ padding: spacing.lg }}>
          {!chain.banner_artifact_id ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm }}>
              {drop ? <Text style={{ color: colors.accentLight, fontSize: fs.xs, fontWeight: fw.bold, letterSpacing: 0.8 }}>{drop}</Text> : null}
              <View style={{ flex: 1 }} />
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor }} />
            </View>
          ) : null}

          <Text style={{ color: colors.gray[50], fontSize: 17, fontWeight: fw.bold, marginBottom: 6 }}>
            {safe(chain.name, chain.slug)}
          </Text>

          {chain.summary ? (
            <Text style={{ color: colors.gray[300], fontSize: fs.md, lineHeight: 17, marginBottom: spacing.md }} numberOfLines={2}>
              {safe(chain.summary)}
            </Text>
          ) : null}

          {/* Metric chips */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {composed ? (
              <MetricChip
                label={`CVSS ${composed}`}
                color={cvssColor(chain.cvss_composed)}
              />
            ) : null}
            {standalone ? (
              <MetricChip label={`${standalone} solo`} color={cvssColor(chain.cvss_standalone)} dim />
            ) : null}
            <MetricChip label={`${chain.component_count} components`} color={colors.text.secondary} />
            <MetricChip label={`${chain.finding_count} findings`} color={colors.text.secondary} />
            {engCount > 0 ? <MetricChip label={`${engCount} eng`} color={colors.text.secondary} /> : null}
          </View>

          {/* Published footer */}
          {chain.published_repo ? (
            <Pressable
              onPress={() => Linking.openURL(chain.published_repo!).catch(() => {})}
              hitSlop={6}
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: spacing.xs,
                marginTop: spacing.md, opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ color: colors.text.tertiary, fontSize: fs.sm }}>🔗</Text>
              <Text style={{ color: colors.accent, fontSize: fs.sm, fontWeight: fw.medium }} numberOfLines={1}>
                Public disclosure{chain.published_at ? ` · ${fmtDate(chain.published_at)}` : ""}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function MetricChip({ label, color, dim }: { label: string; color: string; dim?: boolean }) {
  return (
    <View style={{
      backgroundColor: dim ? withAlpha(color, 0.07) : withAlpha(color, 0.11),
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 4,
    }}>
      <Text style={{ color, fontSize: fs.sm, fontWeight: fw.semibold, fontFamily: "monospace" }}>{label}</Text>
    </View>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: spacing.sm,
      marginBottom: spacing.md, marginTop: spacing.sm,
    }}>
      <Text style={{
        color: colors.text.tertiary, fontSize: fs.xs, fontWeight: fw.semibold,
        textTransform: "uppercase", letterSpacing: 1,
      }}>
        {title}
      </Text>
      <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontFamily: "monospace" }}>{count}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border.subtle }} />
    </View>
  );
}

function EmptyHint({ emoji, text, sub }: { emoji: string; text: string; sub?: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: spacing.xxl }}>
      <Text style={{ fontSize: 40, marginBottom: spacing.sm }}>{emoji}</Text>
      <Text style={{ color: colors.text.tertiary, fontSize: fs.md }}>{text}</Text>
      {sub ? (
        <Text style={{ color: colors.text.disabled, fontSize: fs.sm, marginTop: spacing.xs, textAlign: "center" }}>{sub}</Text>
      ) : null}
    </View>
  );
}
