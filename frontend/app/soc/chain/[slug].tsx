// Kill-chain detail — SOC v3 report plane (dir_1790538151856).
// One chain = one disclosure unit. This screen renders the full record:
// banner + identity header, the disclosure pipeline strip (researching →
// published with the current stage lit), component finding-cards, and five
// segments: Advisory (rendered markdown), Runs (evidence log), Findings
// (DB-linked records), Artifacts (sanitized viewer w/ leak-guard), Coord
// (vendor messages). Read-only — acting happens in the terminal.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { apiFetch, getBridgeUrl, getAuthHeaders } from "../../../lib/bridge-api";
import { useBridgeStream } from "../../../lib/useBridgeStream";
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
  withAlpha,
} from "../../../lib/design-tokens";
import { MarkdownContent } from "../../../components/ContentPanel";
import { FindingRow, type FindingRowData } from "../../../components/soc/FindingRow";
import { FindingDetailModal } from "../../../components/soc/FindingDetailModal";
import { severityColor } from "../../../components/soc/phaseColors";
import {
  CHAIN_STATUS_ORDER,
  chainStatusColor,
  chainStatusLabel,
  cvssColor,
  fmtCvss,
  fmtDate,
  dropLabel,
  artifactIcon,
  channelColor,
  DIRECTION_ICON,
} from "../../../components/soc/chainConstants";
import { safe } from "../../../components/soc/safe";

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
  repo?: string | null;
  updated_at?: string | null;
}

interface RunRow {
  id: number;
  run_key: string;
  target: string | null;
  run_date: string | null;
  verdict: string | null;
  purpose: string | null;
  summary: string | null;
  engagement_id: string | null;
}

interface CoordRow {
  id: number;
  channel: string;
  event_date: string;
  direction: string;
  subject: string | null;
  ref: string | null;
  status: string;
}

type Segment = "advisory" | "runs" | "findings" | "artifacts" | "coord";

const SEGMENTS: Array<{ key: Segment; label: string }> = [
  { key: "advisory", label: "Advisory" },
  { key: "runs", label: "Runs" },
  { key: "findings", label: "Findings" },
  { key: "artifacts", label: "Artifacts" },
  { key: "coord", label: "Coord" },
];

export default function ChainDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [chain, setChain] = useState<ChainDetail | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [findings, setFindings] = useState<FindingRowData[]>([]);
  const [coordination, setCoordination] = useState<CoordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [segment, setSegment] = useState<Segment>("advisory");
  const [advisoryText, setAdvisoryText] = useState<string | null>(null);
  const [viewArtifact, setViewArtifact] = useState<ArtifactRow | null>(null);
  const [detailFinding, setDetailFinding] = useState<number | null>(null);

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

  // Advisory segment content: ADVISORY.md first, README.md as fallback.
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

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (notFound || !chain) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
        <HeaderBack onBack={() => router.back()} />
        <Text style={{ color: colors.text.disabled, textAlign: "center", marginTop: spacing.xl }}>
          Kill chain not found
        </Text>
      </View>
    );
  }

  const banner = artifacts.find((a) => a.kind === "banner" && a.sanitized) || null;
  const statusColor = chainStatusColor(chain.status);
  const composed = fmtCvss(chain.cvss_composed);
  const standalone = fmtCvss(chain.cvss_standalone);
  const drop = dropLabel(chain.drop_number);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={{
        paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md,
        backgroundColor: colors.bg.elevated,
        borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
      }}>
        <HeaderBack onBack={() => router.back()} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          {drop ? (
            <View style={{
              backgroundColor: withAlpha(colors.accent, 0.15), borderRadius: radius.xs,
              paddingHorizontal: spacing.sm, paddingVertical: 2,
            }}>
              <Text style={{ color: colors.accentLight, fontSize: fs.xs, fontWeight: fw.bold, letterSpacing: 0.8 }}>{drop}</Text>
            </View>
          ) : null}
          <Text style={{ color: colors.text.primary, fontSize: fs.xl, fontWeight: fw.bold, flex: 1 }} numberOfLines={1}>
            {safe(chain.name, chain.slug)}
          </Text>
          <View style={{
            flexDirection: "row", alignItems: "center",
            backgroundColor: withAlpha(statusColor, 0.14), borderRadius: radius.sm,
            paddingHorizontal: spacing.sm, paddingVertical: 3,
          }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor, marginRight: spacing.xs }} />
            <Text style={{ color: statusColor, fontSize: fs.xs, fontWeight: fw.semibold }}>
              {chainStatusLabel(chain.status)}
            </Text>
          </View>
        </View>
      </View>

      {/* Segment nav */}
      <View style={{
        flexDirection: "row", backgroundColor: colors.bg.elevated,
        borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
      }}>
        {SEGMENTS.map((s) => {
          const active = segment === s.key;
          const count = s.key === "runs" ? runs.length
            : s.key === "findings" ? findings.length
            : s.key === "artifacts" ? artifacts.length
            : s.key === "coord" ? coordination.length
            : null;
          return (
            <Pressable
              key={s.key}
              onPress={() => setSegment(s.key)}
              style={({ pressed }) => [styles.tab, active && styles.tabActive, pressed && { opacity: 0.8 }]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text numberOfLines={1} style={{
                  color: active ? colors.accent : colors.text.tertiary,
                  fontSize: fs.md, fontWeight: active ? fw.bold : fw.medium,
                }}>
                  {s.label}
                </Text>
                {count != null && count > 0 ? (
                  <Text style={{
                    color: active ? colors.accent : colors.text.disabled,
                    fontSize: fs.xs, fontFamily: "monospace", fontWeight: fw.semibold,
                  }}>
                    {count}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing.xxxl }}>
        {/* Identity block: banner + summary + CVSS + pipeline */}
        {banner ? (
          <Image
            source={{ uri: `${getBridgeUrl()}/soc/artifacts/${banner.id}/content`, headers: getAuthHeaders() }}
            style={{ width: "100%", height: 170 }}
            resizeMode="cover"
          />
        ) : null}

        <View style={{ padding: spacing.lg, gap: spacing.md }}>
          {chain.summary ? (
            <Text style={{ color: colors.text.secondary, fontSize: fs.base, lineHeight: 20 }}>
              {safe(chain.summary)}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, alignItems: "center" }}>
            {composed ? (
              <View style={{
                flexDirection: "row", alignItems: "baseline", gap: 4,
                backgroundColor: withAlpha(cvssColor(chain.cvss_composed), 0.13),
                borderRadius: radius.sm, paddingHorizontal: spacing.sm + 2, paddingVertical: 5,
              }}>
                <Text style={{ color: colors.text.tertiary, fontSize: fs.xs, fontWeight: fw.semibold }}>CVSS</Text>
                <Text style={{ color: cvssColor(chain.cvss_composed), fontSize: fs.lg, fontWeight: fw.bold, fontFamily: "monospace" }}>
                  {composed}
                </Text>
              </View>
            ) : null}
            {standalone ? (
              <View style={{
                flexDirection: "row", alignItems: "baseline", gap: 4,
                backgroundColor: withAlpha(cvssColor(chain.cvss_standalone), 0.08),
                borderRadius: radius.sm, paddingHorizontal: spacing.sm + 2, paddingVertical: 5,
              }}>
                <Text style={{ color: colors.text.tertiary, fontSize: fs.xs, fontWeight: fw.semibold }}>SOLO</Text>
                <Text style={{ color: cvssColor(chain.cvss_standalone), fontSize: fs.lg, fontWeight: fw.bold, fontFamily: "monospace" }}>
                  {standalone}
                </Text>
              </View>
            ) : null}
            {chain.engagement_ids.length > 0 ? (
              <Text style={{ color: colors.text.tertiary, fontSize: fs.sm, fontFamily: "monospace" }}>
                {chain.engagement_ids.join(" · ")}
              </Text>
            ) : null}
          </View>

          {chain.published_repo ? (
            <Pressable
              onPress={() => Linking.openURL(chain.published_repo!).catch(() => {})}
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: spacing.sm,
                backgroundColor: withAlpha(colors.accent, 0.08),
                borderRadius: radius.md, padding: spacing.md,
                borderWidth: 1, borderColor: withAlpha(colors.accent, 0.22),
                opacity: pressed ? 0.85 : 1, alignSelf: "flex-start",
              })}
            >
              <Text style={{ fontSize: 14 }}>🔗</Text>
              <Text style={{ color: colors.accent, fontSize: fs.md, fontWeight: fw.semibold }}>
                Public repo{chain.published_at ? ` · ${fmtDate(chain.published_at)}` : ""}
              </Text>
            </Pressable>
          ) : null}

          {/* Disclosure pipeline strip */}
          <PipelineStrip status={chain.status} />
        </View>

        {/* Components — the chain's structure, always visible above segments */}
        {chain.components.length > 0 ? (
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
            <SectionHeader title="COMPONENTS" count={chain.components.length} />
            {chain.components.map((comp, i) => (
              <ComponentCard key={comp.skyline_id || comp.name || i} comp={comp} />
            ))}
          </View>
        ) : null}

        {/* Segment bodies */}
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm }}>
          {segment === "advisory" ? (
            advisoryArtifact && advisoryText != null ? (
              <MarkdownContent content={advisoryText} />
            ) : advisoryArtifact ? (
              <View style={{ paddingVertical: spacing.xxl, alignItems: "center" }}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : (
              <EmptySegment emoji="📄" text="No advisory packaged yet" />
            )
          ) : null}

          {segment === "runs" ? (
            runs.length === 0 ? (
              <EmptySegment emoji="▶️" text="No attributed evidence runs" sub="Runs link to this chain via log_run." />
            ) : (
              runs.map((r) => (
                <View key={r.id} style={{
                  backgroundColor: colors.gray[800], borderRadius: radius.md,
                  borderLeftWidth: 3, borderLeftColor: colors.accent,
                  borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
                  padding: spacing.md, gap: spacing.xs,
                }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Text style={{ color: colors.accent, fontFamily: "monospace", fontSize: fs.md, fontWeight: fw.bold }}>
                      {safe(r.run_key)}
                    </Text>
                    <Text style={{ color: colors.text.tertiary, fontSize: fs.xs, fontFamily: "monospace" }}>
                      {safe(r.target)}{r.run_date ? ` · ${fmtDate(r.run_date)}` : ""}
                    </Text>
                    <View style={{ flex: 1 }} />
                    {r.verdict ? (
                      <View style={{
                        backgroundColor: withAlpha(r.verdict === "fail" ? colors.error : colors.success, 0.14),
                        borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2,
                      }}>
                        <Text style={{
                          color: r.verdict === "fail" ? colors.error : colors.success,
                          fontSize: fs.xs, fontWeight: fw.semibold,
                        }}>
                          {safe(r.verdict)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  {r.purpose ? (
                    <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.medium }} numberOfLines={2}>
                      {safe(r.purpose)}
                    </Text>
                  ) : null}
                  {r.summary ? (
                    <Text style={{ color: colors.text.tertiary, fontSize: fs.sm, lineHeight: 17 }} numberOfLines={3}>
                      {safe(r.summary)}
                    </Text>
                  ) : null}
                </View>
              ))
            )
          ) : null}

          {segment === "findings" ? (
            findings.length === 0 ? (
              <EmptySegment emoji="🔎" text="No findings linked to this chain" />
            ) : (
              findings.map((f) => (
                <FindingRow key={f.id} finding={f} onPress={(x) => setDetailFinding(x.id)} />
              ))
            )
          ) : null}

          {segment === "artifacts" ? (
            artifacts.length === 0 ? (
              <EmptySegment emoji="📦" text="No artifacts recorded" />
            ) : (
              artifacts.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => { if (a.sanitized) setViewArtifact(a); }}
                  disabled={!a.sanitized}
                  style={({ pressed }) => ({
                    flexDirection: "row", alignItems: "center", gap: spacing.sm,
                    backgroundColor: colors.gray[800], borderRadius: radius.md,
                    borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
                    padding: spacing.md,
                    opacity: a.sanitized ? (pressed ? 0.9 : 1) : 0.55,
                  })}
                >
                  <Text style={{ fontSize: 15 }}>{artifactIcon(a.kind)}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.medium }} numberOfLines={1}>
                      {safe(a.filename)}
                    </Text>
                    <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontFamily: "monospace", marginTop: 1 }}>
                      {safe(a.kind)} · {safe(a.sha8)}{a.push_state ? ` · ${safe(a.push_state)}` : ""}
                    </Text>
                  </View>
                  {a.sanitized ? (
                    <Text style={{ color: colors.success, fontSize: fs.xs, fontWeight: fw.semibold }}>view ›</Text>
                  ) : (
                    <Text style={{ color: colors.text.disabled, fontSize: fs.xs }}>🔒 internal</Text>
                  )}
                </Pressable>
              ))
            )
          ) : null}

          {segment === "coord" ? (
            coordination.length === 0 ? (
              <EmptySegment emoji="✉️" text="No vendor coordination logged" />
            ) : (
              coordination.map((c) => {
                const chColor = channelColor(c.channel);
                return (
                  <View key={c.id} style={{
                    backgroundColor: colors.gray[800], borderRadius: radius.md,
                    borderLeftWidth: 3, borderLeftColor: chColor,
                    borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
                    padding: spacing.md, gap: spacing.xs,
                  }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <View style={{
                        backgroundColor: withAlpha(chColor, 0.14), borderRadius: radius.xs,
                        paddingHorizontal: spacing.sm, paddingVertical: 2,
                      }}>
                        <Text style={{ color: chColor, fontSize: fs.xs, fontWeight: fw.bold }}>
                          {safe(c.channel).toUpperCase()}
                        </Text>
                      </View>
                      <Text style={{ color: colors.text.tertiary, fontSize: fs.xs, fontFamily: "monospace" }}>
                        {DIRECTION_ICON[c.direction] || "·"} {fmtDate(c.event_date)}
                      </Text>
                      <View style={{ flex: 1 }} />
                      <View style={{
                        backgroundColor: withAlpha(c.status === "held" ? colors.warning : c.status === "done" ? colors.success : colors.gray[300], 0.12),
                        borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2,
                      }}>
                        <Text style={{
                          color: c.status === "held" ? colors.warning : c.status === "done" ? colors.success : colors.gray[300],
                          fontSize: fs.xs, fontWeight: fw.semibold,
                        }}>
                          {safe(c.status)}
                        </Text>
                      </View>
                    </View>
                    {c.subject ? (
                      <Text style={{ color: colors.text.primary, fontSize: fs.md, lineHeight: 18 }} numberOfLines={3}>
                        {safe(c.subject)}
                      </Text>
                    ) : null}
                  </View>
                );
              })
            )
          ) : null}
        </View>
      </ScrollView>

      {/* Artifact viewer modal (sanitized content only — backend enforces too) */}
      <ArtifactViewerModal artifact={viewArtifact} onClose={() => setViewArtifact(null)} />

      {/* Finding detail modal */}
      <FindingDetailModal findingId={detailFinding} onClose={() => setDetailFinding(null)} />
    </View>
  );
}

// ── Pipeline strip ──

function PipelineStrip({ status }: { status: string }) {
  const currentIdx = CHAIN_STATUS_ORDER.indexOf(status as (typeof CHAIN_STATUS_ORDER)[number]);
  return (
    <View style={{
      backgroundColor: colors.gray[850], borderRadius: radius.md,
      borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
      paddingVertical: spacing.md,
    }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.md }}>
        {CHAIN_STATUS_ORDER.map((s, i) => {
          const reached = currentIdx >= 0 && i <= currentIdx;
          const isCurrent = i === currentIdx;
          const dotColor = reached ? (isCurrent ? chainStatusColor(status) : withAlpha(chainStatusColor(s), 0.85)) : colors.gray[600];
          return (
            <View key={s} style={{ flexDirection: "row", alignItems: "flex-start" }}>
              <View style={{ alignItems: "center", width: 62 }}>
                <View style={{
                  width: isCurrent ? 13 : 9, height: isCurrent ? 13 : 9,
                  borderRadius: 7, backgroundColor: dotColor,
                  borderWidth: isCurrent ? 2 : 0,
                  borderColor: withAlpha(chainStatusColor(status), 0.35),
                  marginTop: isCurrent ? 0 : 2,
                }} />
                <Text numberOfLines={2} style={{
                  color: isCurrent ? chainStatusColor(status) : reached ? colors.text.secondary : colors.text.disabled,
                  fontSize: 8, fontWeight: isCurrent ? fw.bold : fw.medium,
                  textAlign: "center", marginTop: 4, lineHeight: 10,
                }}>
                  {chainStatusLabel(s)}
                </Text>
              </View>
              {i < CHAIN_STATUS_ORDER.length - 1 ? (
                <View style={{
                  width: 16, height: 2, marginTop: 6,
                  backgroundColor: currentIdx >= 0 && i < currentIdx ? withAlpha(chainStatusColor(s), 0.6) : colors.gray[600],
                }} />
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ── Component card ──

function ComponentCard({ comp }: { comp: ChainComponent }) {
  const sevColor = severityColor(comp.severity);
  const cv = fmtCvss(comp.cvss);
  return (
    <View style={{
      backgroundColor: colors.gray[800], borderRadius: radius.md,
      borderLeftWidth: 3, borderLeftColor: sevColor,
      borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
      padding: spacing.md, gap: spacing.xs + 2,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text style={{ color: colors.text.primary, fontSize: fs.lg, fontWeight: fw.semibold, flex: 1 }} numberOfLines={1}>
          {safe(comp.name, "component")}
        </Text>
        {comp.severity ? (
          <View style={{
            backgroundColor: withAlpha(sevColor, 0.14), borderRadius: radius.sm,
            paddingHorizontal: spacing.sm, paddingVertical: 2,
          }}>
            <Text style={{ color: sevColor, fontSize: fs.xs, fontWeight: fw.bold }}>
              {safe(comp.severity).toUpperCase()}
            </Text>
          </View>
        ) : null}
        {cv ? (
          <Text style={{ color: cvssColor(comp.cvss), fontSize: fs.md, fontWeight: fw.bold, fontFamily: "monospace" }}>
            {cv}
          </Text>
        ) : null}
      </View>
      {comp.role ? (
        <Text style={{ color: colors.text.secondary, fontSize: fs.md, lineHeight: 17 }} numberOfLines={3}>
          {safe(comp.role)}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: 2 }}>
        {comp.skyline_id ? <TagChip text={comp.skyline_id} color={colors.accent} /> : null}
        {comp.cwe ? <TagChip text={safe(comp.cwe)} color={colors.text.tertiary} /> : null}
        {comp.cve ? <TagChip text={safe(comp.cve)} color={colors.brand.orange} /> : null}
      </View>
    </View>
  );
}

function TagChip({ text, color }: { text: string; color: string }) {
  return (
    <View style={{
      backgroundColor: withAlpha(color, 0.10), borderRadius: radius.xs,
      paddingHorizontal: spacing.sm, paddingVertical: 2,
    }}>
      <Text style={{ color, fontSize: fs.xs, fontFamily: "monospace", fontWeight: fw.semibold }}>{text}</Text>
    </View>
  );
}

// ── Artifact viewer ──

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
      <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
        <View style={{
          flexDirection: "row", alignItems: "center",
          paddingHorizontal: spacing.md, paddingVertical: spacing.md + 2,
          backgroundColor: colors.bg.elevated,
          borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
        }}>
          <Pressable onPress={onClose} hitSlop={16} style={({ pressed }) => ({
            opacity: pressed ? 0.6 : 1, paddingVertical: spacing.sm, paddingRight: spacing.md,
          })}>
            <Text style={{ color: colors.accent, fontSize: fs.lg, fontWeight: fw.semibold }}>← Back</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Text style={{ color: colors.text.tertiary, fontSize: fs.sm, fontFamily: "monospace" }} numberOfLines={1}>
            {safe(artifact.filename)} · {safe(artifact.sha8)}
          </Text>
        </View>

        {isImage ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, alignItems: "center", justifyContent: "center" }}>
            <Image
              source={{ uri: `${getBridgeUrl()}/soc/artifacts/${artifact.id}/content`, headers: getAuthHeaders() }}
              style={{ width: "100%", height: 240, borderRadius: radius.md }}
              resizeMode="contain"
            />
          </ScrollView>
        ) : failed ? (
          <Text style={{ color: colors.text.disabled, textAlign: "center", marginTop: spacing.xxxl }}>
            Could not load artifact
          </Text>
        ) : text == null ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl }}>
            {isMarkdown ? (
              <MarkdownContent content={text} />
            ) : (
              <Text selectable style={{ color: colors.text.secondary, fontFamily: "monospace", fontSize: fs.xs, lineHeight: 17 }}>
                {text}
              </Text>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

// ── Shared bits ──

function HeaderBack({ onBack }: { onBack: () => void }) {
  return (
    <Pressable onPress={onBack} hitSlop={16} style={({ pressed }) => ({
      opacity: pressed ? 0.6 : 1, marginBottom: spacing.xs, paddingVertical: spacing.xs, alignSelf: "flex-start",
    })}>
      <Text style={{ color: colors.accent, fontSize: fs.lg, fontWeight: fw.medium }}>← Back</Text>
    </Pressable>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
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

function EmptySegment({ emoji, text, sub }: { emoji: string; text: string; sub?: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: spacing.xxxl }}>
      <Text style={{ fontSize: 36, marginBottom: spacing.sm }}>{emoji}</Text>
      <Text style={{ color: colors.text.tertiary, fontSize: fs.md }}>{text}</Text>
      {sub ? <Text style={{ color: colors.text.disabled, fontSize: fs.sm, marginTop: spacing.xs }}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm + 4,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: colors.accent,
  },
});
