// Kill-chain detail — built the way the venture detail sheet is built
// (ProjectDetailSheet, verified on-screen 2026-09-27): emoji header + full
// summary, PROGRESS-style disclosure card, then the WORK as a grouped
// collapsible list — findings grouped by lifecycle like tasks grouped by
// phase — then components / runs, and document-type content (artifacts,
// coordination, the advisory README) behind collapsed disclosure rows like
// the sheet's EXPENSES. Read-only: the app observes, the terminal acts.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Image,
  LayoutAnimation,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { apiFetch, getBridgeUrl, getAuthHeaders } from "../../../lib/bridge-api";
import { useBridgeStream } from "../../../lib/useBridgeStream";
import { colors } from "../../../lib/design-tokens";
import { MarkdownContent } from "../../../components/ContentPanel";
import { ProgressBar } from "../../../components/business/ProgressBar";
import { FindingDetailModal } from "../../../components/soc/FindingDetailModal";
import { severityColor, severityIcon } from "../../../components/soc/phaseColors";
import {
  CHAIN_STATUS_ORDER,
  LIFECYCLE_ORDER,
  chainStatusColor,
  chainStatusLabel,
  chainStatusEmoji,
  lifecycleColor,
  lifecycleLabel,
  cvssColor,
  fmtCvss,
  fmtDate,
  dropLabel,
  artifactIcon,
  channelColor,
  DIRECTION_ICON,
} from "../../../components/soc/chainConstants";
import { safe } from "../../../components/soc/safe";

const ACCENT = colors.accent;
const HAIRLINE = "rgba(255,255,255,0.04)";

// ── Types (mirror GET /soc/chains/:slug) ──

interface ChainComponent {
  skyline_id?: string | null;
  name?: string | null;
  severity?: string | null;
  cvss?: number | string | null;
  cwe?: string | null;
  cve?: string | null;
  role?: string | null;
}

interface ChainDetail {
  id: string;
  slug: string;
  name: string;
  drop_number: number | null;
  status: string;
  cvss_composed: string | number | null;
  cvss_standalone: string | number | null;
  engagement_ids: string[];
  components: ChainComponent[];
  published_repo: string | null;
  published_at: string | null;
  summary: string | null;
}

interface ArtifactRow {
  id: number;
  kind: string;
  filename: string;
  sha8: string;
  sanitized: boolean;
  push_state?: string | null;
}

interface RunRow {
  id: number;
  run_key: string;
  target: string | null;
  run_date: string | null;
  verdict: string | null;
  purpose: string | null;
}

interface CoordRow {
  id: number;
  channel: string;
  event_date: string;
  direction: string;
  subject: string | null;
  status: string;
}

interface ChainFinding {
  id: number;
  severity: string;
  title: string;
  lifecycle: string | null;
  skyline_id: string | null;
  cve_id: string | null;
  cvss_score: string | number | null;
  discovered_at: string | null;
}

export default function ChainDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [chain, setChain] = useState<ChainDetail | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [findings, setFindings] = useState<ChainFinding[]>([]);
  const [coordination, setCoordination] = useState<CoordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [advisoryText, setAdvisoryText] = useState<string | null>(null);
  const [viewArtifact, setViewArtifact] = useState<ArtifactRow | null>(null);
  const [detailFinding, setDetailFinding] = useState<number | null>(null);
  // Collapsed groups — same mechanic as the sheet's collapsedPhases.
  // Findings groups start open (they are the work); document-type
  // sections start closed.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(["artifacts", "coord", "advisory"]),
  );

  const toggle = (key: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const fetchChain = useCallback(async () => {
    if (!slug) return;
    try {
      const d = await apiFetch(`/soc/chains/${slug}`);
      setChain(d.chain || null);
      setArtifacts(d.artifacts || []);
      setRuns(d.runs || []);
      setFindings(d.findings || []);
      setCoordination(d.coordination || []);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { fetchChain(); }, [fetchChain]);
  useBridgeStream("socFindingAdded", () => { fetchChain(); });

  const advisoryArtifact = useMemo(
    () => artifacts.find((a) => a.kind === "advisory" && a.sanitized)
      || artifacts.find((a) => a.kind === "readme" && a.sanitized)
      || null,
    [artifacts],
  );

  useEffect(() => {
    let mounted = true;
    setAdvisoryText(null);
    if (!advisoryArtifact) return;
    (async () => {
      try {
        const r = await fetch(
          `${getBridgeUrl()}/soc/artifacts/${advisoryArtifact.id}/content`,
          { headers: getAuthHeaders() },
        );
        if (!r.ok) return;
        const text = await r.text();
        if (mounted) setAdvisoryText(text);
      } catch {}
    })();
    return () => { mounted = false; };
  }, [advisoryArtifact]);

  // Findings grouped by lifecycle — the sheet's phase-group pattern.
  const findingGroups = useMemo(() => {
    const groups = new Map<string, ChainFinding[]>();
    for (const f of findings) {
      const key = f.lifecycle || "unfiled";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }
    const ordered: Array<[string, ChainFinding[]]> = [];
    for (const lc of [...LIFECYCLE_ORDER, "held", "duplicate", "withdrawn", "unfiled"]) {
      const rows = groups.get(lc);
      if (rows && rows.length > 0) ordered.push([lc, rows]);
    }
    for (const [k, v] of groups) {
      if (!ordered.some(([ok]) => ok === k)) ordered.push([k, v]);
    }
    return ordered;
  }, [findings]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.gray[850], alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors.gray[400], fontFamily: "monospace" }}>Loading...</Text>
      </View>
    );
  }

  if (notFound || !chain) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.gray[850], paddingTop: insets.top }}>
        <BackRow onBack={() => router.back()} />
        <View style={{ alignItems: "center", paddingVertical: 60 }}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>🔐</Text>
          <Text style={{ color: colors.gray[300], fontSize: 15 }}>Chain not found</Text>
        </View>
      </View>
    );
  }

  const statusColor = chainStatusColor(chain.status);
  const idx = CHAIN_STATUS_ORDER.indexOf(chain.status as (typeof CHAIN_STATUS_ORDER)[number]);
  const stage = idx >= 0 ? idx + 1 : 0;
  const pct = Math.round((stage / CHAIN_STATUS_ORDER.length) * 100);
  const composed = fmtCvss(chain.cvss_composed);
  const drop = dropLabel(chain.drop_number);
  const publishedCount = findings.filter((f) => f.lifecycle === "published").length;
  const filedCount = findings.filter((f) => f.lifecycle && f.lifecycle !== "published").length;
  const unfiledCount = findings.length - publishedCount - filedCount;

  return (
    <View style={{ flex: 1, backgroundColor: colors.gray[850], paddingTop: insets.top }}>
      <StatusBar style="light" />
      <BackRow onBack={() => router.back()} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {/* Header — sheet header: emoji + name + FULL summary */}
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
          <Text style={{ fontSize: 28 }}>{chainStatusEmoji(chain.status)}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 16, fontWeight: "bold" }}>
              {safe(chain.name, chain.slug)}
            </Text>
            {chain.summary ? (
              <Text style={{ color: colors.gray[300], fontSize: 12, marginTop: 4, lineHeight: 17 }}>{safe(chain.summary)}</Text>
            ) : null}
          </View>
        </View>

        {/* Disclosure card — the sheet's PROGRESS card */}
        <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: HAIRLINE }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
            <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 11 }}>DISCLOSURE</Text>
            <Text style={{ color: statusColor, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>{pct}%</Text>
          </View>
          <ProgressBar done={stage} total={CHAIN_STATUS_ORDER.length} color={statusColor} height={6} />
          <View style={{ flexDirection: "row", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>
              stage {stage}/{CHAIN_STATUS_ORDER.length} · {chainStatusLabel(chain.status)}
            </Text>
            {drop ? <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>{drop}</Text> : null}
            {composed ? <Text style={{ color: cvssColor(chain.cvss_composed), fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>CVSS {composed}</Text> : null}
            {chain.published_repo ? <Text style={{ color: colors.success, fontFamily: "monospace", fontSize: 10 }}>public</Text> : null}
          </View>
          <View style={{ flexDirection: "row", gap: 16, marginTop: 6 }}>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>{unfiledCount} unfiled</Text>
            <Text style={{ color: colors.brand.amberDeep, fontFamily: "monospace", fontSize: 10 }}>{filedCount} in disclosure</Text>
            <Text style={{ color: colors.success, fontFamily: "monospace", fontSize: 10 }}>{publishedCount} published</Text>
          </View>
        </View>

        {/* Ops record — the only door into engagements */}
        {chain.engagement_ids.length > 0 || chain.published_repo ? (
          <SectionCard label={`OPS RECORD (${chain.engagement_ids.length + (chain.published_repo ? 1 : 0)})`}>
            {chain.engagement_ids.map((eid, i) => (
              <Row
                key={eid}
                title={safe(eid)}
                sub="engagement"
                right="›"
                rightColor={colors.gray[400]}
                last={i === chain.engagement_ids.length - 1 && !chain.published_repo}
                onPress={() => router.push(`/soc/${eid}`)}
              />
            ))}
            {chain.published_repo ? (
              <Row
                title={chain.published_repo.replace(/^https?:\/\//, "")}
                sub={chain.published_at ? `published ${fmtDate(chain.published_at)}` : "published"}
                right="OPEN"
                rightColor={ACCENT}
                last
                onPress={() => Linking.openURL(chain.published_repo!).catch(() => {})}
              />
            ) : null}
          </SectionCard>
        ) : null}

        {/* ── The work: findings grouped by lifecycle, collapsible like phases ── */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 11, letterSpacing: 1 }}>
            FINDINGS ({findings.length})
          </Text>
        </View>
        {findings.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 32 }}>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 12 }}>No findings linked yet</Text>
          </View>
        ) : (
          findingGroups.map(([lc, rows]) => {
            const isCollapsed = collapsed.has(`f:${lc}`);
            return (
              <View key={lc} style={{ marginBottom: 12 }}>
                <Pressable
                  onPress={() => toggle(`f:${lc}`)}
                  style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6, paddingHorizontal: 4 }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={{ color: colors.gray[400], fontSize: 10 }}>{isCollapsed ? "▶" : "▼"}</Text>
                    <Text style={{ color: lifecycleColor(lc === "unfiled" ? null : lc), fontFamily: "monospace", fontSize: 10, letterSpacing: 1, textTransform: "uppercase" }}>
                      {lifecycleLabel(lc === "unfiled" ? null : lc).toUpperCase()}
                    </Text>
                  </View>
                  <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9 }}>{rows.length}</Text>
                </Pressable>
                {!isCollapsed ? (
                  <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, borderWidth: 1, borderColor: HAIRLINE }}>
                    {rows.map((f, i) => {
                      const cv = fmtCvss(f.cvss_score);
                      return (
                        <Row
                          key={f.id}
                          title={`${severityIcon(f.severity)} ${safe(f.title)}`}
                          sub={[f.skyline_id || f.cve_id, f.discovered_at ? fmtDate(f.discovered_at) : null].filter(Boolean).join(" · ") || undefined}
                          right={cv || safe(f.severity).toUpperCase()}
                          rightColor={cv ? cvssColor(f.cvss_score) : severityColor(f.severity)}
                          last={i === rows.length - 1}
                          onPress={() => setDetailFinding(f.id)}
                        />
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          })
        )}

        {/* Components */}
        {chain.components.length > 0 ? (
          <SectionCard label={`COMPONENTS (${chain.components.length})`}>
            {chain.components.map((comp, i) => {
              const cv = fmtCvss(comp.cvss);
              return (
                <Row
                  key={comp.skyline_id || comp.name || String(i)}
                  title={`${severityIcon(comp.severity)} ${safe(comp.name, "component")}`}
                  sub={[comp.skyline_id, comp.role, comp.cwe, comp.cve].filter(Boolean).map((s) => safe(String(s))).join(" · ") || undefined}
                  right={cv || safe(comp.severity || "").toUpperCase()}
                  rightColor={cv ? cvssColor(comp.cvss) : severityColor(comp.severity)}
                  last={i === chain.components.length - 1}
                />
              );
            })}
          </SectionCard>
        ) : null}

        {/* Evidence runs */}
        {runs.length > 0 ? (
          <SectionCard label={`EVIDENCE RUNS (${runs.length})`}>
            {runs.map((r, i) => (
              <Row
                key={r.id}
                title={safe(r.run_key)}
                sub={[r.purpose, r.target, r.run_date ? fmtDate(r.run_date) : null].filter(Boolean).map((s) => safe(String(s))).join(" · ")}
                right={r.verdict ? safe(r.verdict).toUpperCase() : ""}
                rightColor={r.verdict === "fail" ? colors.error : colors.success}
                last={i === runs.length - 1}
              />
            ))}
          </SectionCard>
        ) : null}

        {/* Document-type content — collapsed disclosure rows, like EXPENSES */}
        <DisclosureSection
          label={`ARTIFACTS (${artifacts.length})`}
          collapsed={collapsed.has("artifacts")}
          onToggle={() => toggle("artifacts")}
        >
          {artifacts.length === 0 ? (
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 11, paddingVertical: 8 }}>No artifacts recorded yet</Text>
          ) : (
            <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, borderWidth: 1, borderColor: HAIRLINE }}>
              {artifacts.map((a, i) => (
                <Row
                  key={a.id}
                  title={`${artifactIcon(a.kind)} ${safe(a.filename)}`}
                  sub={`${safe(a.kind)} · ${safe(a.sha8)}${a.push_state ? ` · ${safe(a.push_state)}` : ""}`}
                  right={a.sanitized ? "VIEW" : "INTERNAL"}
                  rightColor={a.sanitized ? colors.success : colors.gray[400]}
                  last={i === artifacts.length - 1}
                  onPress={a.sanitized ? () => setViewArtifact(a) : undefined}
                />
              ))}
            </View>
          )}
        </DisclosureSection>

        <DisclosureSection
          label={`COORDINATION (${coordination.length})`}
          collapsed={collapsed.has("coord")}
          onToggle={() => toggle("coord")}
        >
          {coordination.length === 0 ? (
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 11, paddingVertical: 8 }}>No vendor coordination logged</Text>
          ) : (
            <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, borderWidth: 1, borderColor: HAIRLINE }}>
              {coordination.map((c, i) => (
                <Row
                  key={c.id}
                  title={safe(c.subject, c.channel)}
                  sub={`${DIRECTION_ICON[c.direction] || "·"} ${safe(c.channel)} · ${fmtDate(c.event_date)}`}
                  right={safe(c.status).toUpperCase()}
                  rightColor={c.status === "held" ? colors.warning : c.status === "done" ? colors.success : channelColor(c.channel)}
                  last={i === coordination.length - 1}
                />
              ))}
            </View>
          )}
        </DisclosureSection>

        <DisclosureSection
          label="ADVISORY"
          collapsed={collapsed.has("advisory")}
          onToggle={() => toggle("advisory")}
        >
          {advisoryArtifact && advisoryText != null ? (
            <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, borderWidth: 1, borderColor: HAIRLINE }}>
              <MarkdownContent content={advisoryText} />
            </View>
          ) : advisoryArtifact ? (
            <View style={{ alignItems: "center", paddingVertical: 24 }}>
              <ActivityIndicator color={ACCENT} />
            </View>
          ) : (
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 11, paddingVertical: 8 }}>No advisory packaged yet</Text>
          )}
        </DisclosureSection>
      </ScrollView>

      <ArtifactViewerModal artifact={viewArtifact} onClose={() => setViewArtifact(null)} />
      <FindingDetailModal findingId={detailFinding} onClose={() => setDetailFinding(null)} />
    </View>
  );
}

// ── Shared blocks (venture-sheet vocabulary) ──

function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 }}>
      <Pressable onPress={onBack} hitSlop={16} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, flexDirection: "row", alignItems: "center", gap: 4 })}>
        <Text style={{ color: colors.gray[300], fontSize: 14 }}>‹</Text>
        <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 11 }}>BACK</Text>
      </Pressable>
      <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 10, fontWeight: "bold", letterSpacing: 2 }}>KILL CHAIN</Text>
    </View>
  );
}

function SectionCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: HAIRLINE }}>
      <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>{label}</Text>
      {children}
    </View>
  );
}

// Collapsed-by-default disclosure row — the sheet's "EXPENSES (n) ▸" pattern.
function DisclosureSection({ label, collapsed, onToggle, children }: {
  label: string; collapsed: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Pressable
        onPress={onToggle}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: collapsed ? 0 : 8, paddingVertical: 4 }}
      >
        <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, letterSpacing: 2 }}>{label}</Text>
        <Text style={{ color: colors.gray[400], fontSize: 10 }}>{collapsed ? "▸" : "▾"}</Text>
      </Pressable>
      {!collapsed ? children : null}
    </View>
  );
}

function Row({ title, sub, right, rightColor, last, onPress }: {
  title: string; sub?: string; right: string; rightColor: string; last?: boolean; onPress?: () => void;
}) {
  const style = {
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    alignItems: "center" as const,
    paddingVertical: 6,
    borderBottomWidth: last ? 0 : 1,
    borderBottomColor: HAIRLINE,
  };
  const inner = (
    <>
      <View style={{ flex: 1, paddingRight: 8 }}>
        <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 12 }} numberOfLines={2}>{title}</Text>
        {sub ? <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10, marginTop: 2 }} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {right ? <Text style={{ color: rightColor, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }} numberOfLines={1}>{right}</Text> : null}
    </>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, style]}>{inner}</Pressable>
  ) : (
    <View style={style}>{inner}</View>
  );
}

// ── Artifact viewer (sanitized content only — backend enforces too) ──

function ArtifactViewerModal({ artifact, onClose }: { artifact: ArtifactRow | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    setText(null);
    setFailed(false);
    if (!artifact || artifact.kind === "banner") return;
    (async () => {
      try {
        const r = await fetch(`${getBridgeUrl()}/soc/artifacts/${artifact.id}/content`, { headers: getAuthHeaders() });
        if (!r.ok) { if (mounted) setFailed(true); return; }
        const body = await r.text();
        if (mounted) setText(body);
      } catch {
        if (mounted) setFailed(true);
      }
    })();
    return () => { mounted = false; };
  }, [artifact]);

  if (!artifact) return null;
  const isImage = artifact.kind === "banner";
  const isMarkdown = /\.(md|markdown)$/i.test(artifact.filename) || artifact.kind === "advisory"
    || artifact.kind === "readme" || artifact.kind === "mitigations" || artifact.kind === "coordination-log";

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={{ flex: 1, backgroundColor: colors.gray[850], paddingTop: insets.top }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 }}>
          <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10, letterSpacing: 2, flex: 1 }} numberOfLines={1}>
            {safe(artifact.filename)}
          </Text>
          <Pressable onPress={onClose} hitSlop={16} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingHorizontal: 8, paddingVertical: 4 })}>
            <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 11 }}>CLOSE</Text>
          </Pressable>
        </View>

        {isImage ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, alignItems: "center", justifyContent: "center" }}>
            <Image
              source={{ uri: `${getBridgeUrl()}/soc/artifacts/${artifact.id}/content`, headers: getAuthHeaders() }}
              style={{ width: "100%", height: 240, borderRadius: 10 }}
              resizeMode="contain"
            />
          </ScrollView>
        ) : failed ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>📎</Text>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 12 }}>Could not load artifact</Text>
          </View>
        ) : text == null ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={ACCENT} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, borderWidth: 1, borderColor: HAIRLINE }}>
              {isMarkdown ? (
                <MarkdownContent content={text} />
              ) : (
                <Text selectable style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 11, lineHeight: 17 }}>
                  {text}
                </Text>
              )}
            </View>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
