// Kill-chain container — SOC report console (dir_1790544238642, rebuilt from zero).
// One chain = one disclosure unit = the container for ALL of its work:
// identity + disclosure stage track, components, advisory, evidence runs,
// findings, artifacts (sanitized viewer, leak-guarded) and vendor
// coordination. The engagement ids here are the ONLY door into the ops
// record — engagements are not app-level navigation.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Image,
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
import {
  colors,
  spacing,
  radius,
  fontSize as fs,
  fontWeight as fw,
} from "../../../lib/design-tokens";
import { MarkdownContent } from "../../../components/ContentPanel";
import { FindingDetailModal } from "../../../components/soc/FindingDetailModal";
import { severityColor } from "../../../components/soc/phaseColors";
import {
  chainStatusColor,
  chainStatusLabel,
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
import {
  MONO,
  MicroLabel,
  Mono,
  Chip,
  SectionHead,
  StageTrack,
  RowGroup,
  PressRow,
  StatCell,
  SegTabs,
  EmptyState,
  ConsoleHeader,
} from "../../../components/soc/consoleKit";

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

type Segment = "advisory" | "runs" | "findings" | "artifacts" | "coord";

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
        <ConsoleHeader onBack={() => router.back()} label="kill chain" />
        <EmptyState text="chain not found" />
      </View>
    );
  }

  const statusColor = chainStatusColor(chain.status);
  const composed = fmtCvss(chain.cvss_composed);
  const standalone = fmtCvss(chain.cvss_standalone);
  const drop = dropLabel(chain.drop_number);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />

      <ConsoleHeader
        onBack={() => router.back()}
        label="kill chain"
        right={<Chip label={chainStatusLabel(chain.status)} color={statusColor} dot />}
      />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing.xxxl }}>
        {/* ── Identity: banner + name + stage track ── */}
        <View style={{ padding: spacing.md, gap: spacing.md, paddingTop: spacing.lg }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            {drop ? <Chip label={drop} color={colors.accent} filled /> : null}
            <View style={{ flex: 1 }} />
            {chain.published_repo ? <Chip label="public" color={colors.success} /> : null}
          </View>
          <Text style={{ color: colors.gray[50], fontSize: 24, fontWeight: fw.bold }} numberOfLines={2}>
            {safe(chain.name, chain.slug)}
          </Text>
          <StageTrack status={chain.status} />

          {chain.summary ? (
            <Text style={{ color: colors.text.secondary, fontSize: fs.base, lineHeight: 20 }}>
              {safe(chain.summary)}
            </Text>
          ) : null}

          {/* Counts strip */}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: spacing.xl, rowGap: spacing.md, flexWrap: "wrap" }}>
            {composed ? (
              <StatCell value={composed} label="cvss" color={cvssColor(chain.cvss_composed)} size={26} />
            ) : null}
            {standalone ? (
              <StatCell value={standalone} label="solo" color={cvssColor(chain.cvss_standalone)} size={fs.xxl} />
            ) : null}
            <StatCell value={chain.components.length} label="comps" size={fs.xxl} />
            <StatCell value={findings.length} label="findings" size={fs.xxl} />
            <StatCell value={artifacts.length} label="artifacts" size={fs.xxl} />
            <StatCell value={runs.length} label="runs" size={fs.xxl} />
          </View>

          {/* Ops record — the only door into engagements */}
          {chain.engagement_ids.length > 0 || chain.published_repo ? (
            <>
              <SectionHead label="ops record" />
              <RowGroup>
                {chain.engagement_ids.map((eid, i) => (
                  <PressRow
                    key={eid}
                    last={i === chain.engagement_ids.length - 1 && !chain.published_repo}
                    onPress={() => router.push(`/soc/${eid}`)}
                  >
                    <MicroLabel color={colors.text.disabled} size={9}>eng</MicroLabel>
                    <Mono color={colors.text.primary} size={fs.sm} weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
                      {safe(eid)}
                    </Mono>
                    <Mono color={colors.text.disabled} size={fs.lg}>›</Mono>
                  </PressRow>
                ))}
                {chain.published_repo ? (
                  <PressRow
                    last
                    onPress={() => Linking.openURL(chain.published_repo!).catch(() => {})}
                  >
                    <MicroLabel color={colors.success} size={9}>pub</MicroLabel>
                    <Mono color={colors.accent} size={fs.sm} numberOfLines={1} style={{ flex: 1 }}>
                      {chain.published_repo.replace(/^https?:\/\//, "")}
                    </Mono>
                    <Mono color={colors.text.disabled}>{chain.published_at ? fmtDate(chain.published_at) : ""}</Mono>
                  </PressRow>
                ) : null}
              </RowGroup>
            </>
          ) : null}
        </View>

        {/* ── Components: the chain's structure ── */}
        {chain.components.length > 0 ? (
          <View style={{ paddingHorizontal: spacing.md }}>
            <SectionHead label="components" right={String(chain.components.length)} />
            <RowGroup>
              {chain.components.map((comp, i) => {
                const sevColor = severityColor(comp.severity);
                const cv = fmtCvss(comp.cvss);
                return (
                  <PressRow key={comp.skyline_id || comp.name || String(i)} rail={sevColor} last={i === chain.components.length - 1}>
                    <View style={{ flex: 1, paddingLeft: spacing.xs }}>
                      <Text style={{ color: colors.text.primary, fontSize: fs.lg, fontWeight: fw.semibold }} numberOfLines={1}>
                        {safe(comp.name, "component")}
                      </Text>
                      {comp.role ? (
                        <Text style={{ color: colors.text.tertiary, fontSize: fs.sm, lineHeight: 17, marginTop: 2 }} numberOfLines={2}>
                          {safe(comp.role)}
                        </Text>
                      ) : null}
                      <Mono color={colors.text.disabled} style={{ marginTop: 3 }}>
                        {[comp.skyline_id, comp.cwe, comp.cve].filter(Boolean).join(" · ") || "—"}
                      </Mono>
                    </View>
                    {comp.severity ? <Chip label={safe(comp.severity)} color={sevColor} /> : null}
                    {cv ? <Mono color={cvssColor(comp.cvss)} size={fs.lg} weight="bold">{cv}</Mono> : null}
                  </PressRow>
                );
              })}
            </RowGroup>
          </View>
        ) : null}

        {/* ── Segments ── */}
        <View style={{ marginTop: spacing.lg }}>
          <SegTabs<Segment>
            tabs={[
              { key: "advisory", label: "advisory" },
              { key: "runs", label: "runs", count: runs.length },
              { key: "findings", label: "fnd", count: findings.length },
              { key: "artifacts", label: "artf", count: artifacts.length },
              { key: "coord", label: "coord", count: coordination.length },
            ]}
            active={segment}
            onChange={setSegment}
          />

          <View style={{ padding: spacing.md }}>
            {segment === "advisory" ? (
              advisoryArtifact && advisoryText != null ? (
                <MarkdownContent content={advisoryText} />
              ) : advisoryArtifact ? (
                <View style={{ paddingVertical: spacing.xxl, alignItems: "center" }}>
                  <ActivityIndicator color={colors.accent} />
                </View>
              ) : (
                <EmptyState text="no advisory packaged" />
              )
            ) : null}

            {segment === "runs" ? (
              runs.length === 0 ? (
                <EmptyState text="no attributed evidence runs" />
              ) : (
                <RowGroup>
                  {runs.map((r, i) => (
                    <PressRow key={r.id} last={i === runs.length - 1}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                          <Mono color={colors.accent} size={fs.md} weight="bold">{safe(r.run_key)}</Mono>
                          {r.verdict ? (
                            <Chip label={safe(r.verdict)} color={r.verdict === "fail" ? colors.error : colors.success} />
                          ) : null}
                        </View>
                        {r.purpose ? (
                          <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.medium, marginTop: 3 }} numberOfLines={2}>
                            {safe(r.purpose)}
                          </Text>
                        ) : null}
                        <Mono color={colors.text.disabled} style={{ marginTop: 3 }}>
                          {safe(r.target)}{r.run_date ? ` · ${fmtDate(r.run_date)}` : ""}
                        </Mono>
                      </View>
                    </PressRow>
                  ))}
                </RowGroup>
              )
            ) : null}

            {segment === "findings" ? (
              findings.length === 0 ? (
                <EmptyState text="no findings linked" />
              ) : (
                <RowGroup>
                  {findings.map((f, i) => (
                    <PressRow
                      key={f.id}
                      rail={lifecycleColor(f.lifecycle)}
                      last={i === findings.length - 1}
                      onPress={() => setDetailFinding(f.id)}
                    >
                      <View style={{ flex: 1, paddingLeft: spacing.xs }}>
                        <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.semibold, lineHeight: 18 }} numberOfLines={2}>
                          {safe(f.title)}
                        </Text>
                        <Mono color={colors.text.disabled} style={{ marginTop: 3 }}>
                          {[f.skyline_id, f.cve_id, f.discovered_at ? fmtDate(f.discovered_at) : null].filter(Boolean).join(" · ") || "—"}
                        </Mono>
                      </View>
                      <View style={{ alignItems: "flex-end", gap: 4 }}>
                        {fmtCvss(f.cvss_score) ? (
                          <Mono color={cvssColor(f.cvss_score)} size={fs.lg} weight="bold">{fmtCvss(f.cvss_score)}</Mono>
                        ) : null}
                        <MicroLabel color={lifecycleColor(f.lifecycle)} size={9}>
                          {lifecycleLabel(f.lifecycle)}
                        </MicroLabel>
                      </View>
                    </PressRow>
                  ))}
                </RowGroup>
              )
            ) : null}

            {segment === "artifacts" ? (
              artifacts.length === 0 ? (
                <EmptyState text="no artifacts recorded" />
              ) : (
                <RowGroup>
                  {artifacts.map((a, i) => (
                    <PressRow
                      key={a.id}
                      last={i === artifacts.length - 1}
                      onPress={a.sanitized ? () => setViewArtifact(a) : undefined}
                    >
                      <Mono color={colors.text.secondary} size={fs.lg}>{artifactIcon(a.kind)}</Mono>
                      <View style={{ flex: 1 }}>
                        <Mono color={colors.text.primary} size={fs.md} weight="semibold" numberOfLines={1}>
                          {safe(a.filename)}
                        </Mono>
                        <Mono color={colors.text.disabled} style={{ marginTop: 2 }}>
                          {safe(a.kind)} · {safe(a.sha8)}{a.push_state ? ` · ${safe(a.push_state)}` : ""}
                        </Mono>
                      </View>
                      {a.sanitized ? (
                        <Chip label="view" color={colors.success} />
                      ) : (
                        <Chip label="internal" color={colors.gray[500]} />
                      )}
                    </PressRow>
                  ))}
                </RowGroup>
              )
            ) : null}

            {segment === "coord" ? (
              coordination.length === 0 ? (
                <EmptyState text="no vendor coordination logged" />
              ) : (
                <RowGroup>
                  {coordination.map((c, i) => {
                    const chColor = channelColor(c.channel);
                    const stColor = c.status === "held" ? colors.warning : c.status === "done" ? colors.success : colors.gray[400];
                    return (
                      <PressRow key={c.id} rail={chColor} last={i === coordination.length - 1}>
                        <View style={{ flex: 1, paddingLeft: spacing.xs }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                            <Chip label={safe(c.channel)} color={chColor} />
                            <Mono color={colors.text.disabled}>
                              {DIRECTION_ICON[c.direction] || "·"} {fmtDate(c.event_date)}
                            </Mono>
                          </View>
                          {c.subject ? (
                            <Text style={{ color: colors.text.primary, fontSize: fs.md, lineHeight: 18, marginTop: 4 }} numberOfLines={3}>
                              {safe(c.subject)}
                            </Text>
                          ) : null}
                        </View>
                        <Chip label={safe(c.status)} color={stColor} />
                      </PressRow>
                    );
                  })}
                </RowGroup>
              )
            ) : null}
          </View>
        </View>
      </ScrollView>

      {/* Artifact viewer modal (sanitized content only — backend enforces too) */}
      <ArtifactViewerModal artifact={viewArtifact} onClose={() => setViewArtifact(null)} />

      {/* Finding detail modal */}
      <FindingDetailModal findingId={detailFinding} onClose={() => setDetailFinding(null)} />
    </View>
  );
}

// ── Artifact viewer (sanitized content only) ──

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
          flexDirection: "row", alignItems: "center", gap: spacing.sm,
          paddingHorizontal: spacing.md, paddingVertical: spacing.md,
          backgroundColor: colors.bg.elevated,
          borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
        }}>
          <Pressable onPress={onClose} hitSlop={16} style={({ pressed }) => ({
            opacity: pressed ? 0.6 : 1,
            paddingHorizontal: spacing.sm + 2, paddingVertical: 3,
            borderWidth: 1, borderColor: colors.border.default, borderRadius: radius.xs,
          })}>
            <Text style={{ color: colors.text.secondary, fontSize: fs.md, fontFamily: MONO, fontWeight: fw.bold }}>‹</Text>
          </Pressable>
          <MicroLabel color={colors.text.secondary}>artifact</MicroLabel>
          <View style={{ flex: 1 }} />
          <Mono color={colors.text.disabled} numberOfLines={1}>{safe(artifact.sha8)}</Mono>
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
          <EmptyState text="could not load artifact" />
        ) : text == null ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl }}>
            <Mono color={colors.text.secondary} size={fs.sm} weight="semibold" style={{ marginBottom: spacing.md }}>
              {safe(artifact.filename)}
            </Mono>
            {isMarkdown ? (
              <MarkdownContent content={text} />
            ) : (
              <Text selectable style={{ color: colors.text.secondary, fontFamily: MONO, fontSize: fs.xs, lineHeight: 17 }}>
                {text}
              </Text>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
