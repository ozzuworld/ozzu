// Kill-chain detail — a 1:1 copy of the venture detail sheet's skeleton
// (ProjectDetailSheet, verified on-screen + full-page 2026-09-28), with SOC
// data in the same slots and NOTHING else:
//   header → PROGRESS card (label / bar / colored counts) → accent link →
//   collapsed disclosure rows (EXPENSES slot) → STATUS segment row →
//   TASKS-equivalent (FINDINGS header + view toggle + phase groups + cards)
// Everything that is not one of those six blocks lives INSIDE the sheet's own
// mechanisms (collapsed rows, accent link, modal). Read-only by design.

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
  lifecycleLabel,
  cvssColor,
  fmtCvss,
  fmtDate,
  artifactIcon,
  channelColor,
  DIRECTION_ICON,
} from "../../../components/soc/chainConstants";
import { safe } from "../../../components/soc/safe";

const ACCENT = colors.accent;
const HAIRLINE = "rgba(255,255,255,0.04)";

// TaskCard.tsx STATUS_COLOR, verbatim — the only circle colors the sheet has.
const TASK_CIRCLE: Record<string, string> = {
  pending: colors.gray[400],
  in_progress: colors.brand.amberDeep,
  done: colors.success,
};

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
  // Collapsed disclosure rows — the sheet's EXPENSES mechanic. All closed.
  // Engagements live here too: the sheet has no nav link on its face, so
  // nothing gets one here either.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(["engagements", "components", "runs", "artifacts", "coord", "advisory"]),
  );
  // FINDINGS view toggle — the sheet's PHASES/STATUS mini-toggle. Severity
  // first so the groups never duplicate the STATUS stage row above.
  const [groupBy, setGroupBy] = useState<"severity" | "lifecycle">("severity");

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

  // Findings grouped like the sheet's task phase-groups.
  const findingGroups = useMemo(() => {
    const keyOf = (f: ChainFinding) =>
      groupBy === "severity" ? (f.severity || "info") : (f.lifecycle || "unfiled");
    const groups = new Map<string, ChainFinding[]>();
    for (const f of findings) {
      const key = keyOf(f);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }
    const order = groupBy === "severity"
      ? ["critical", "high", "medium", "low", "info"]
      : [...LIFECYCLE_ORDER, "held", "duplicate", "withdrawn", "unfiled"];
    const ordered: Array<[string, ChainFinding[]]> = [];
    for (const k of order) {
      const rows = groups.get(k);
      if (rows && rows.length > 0) ordered.push([k, rows]);
    }
    for (const [k, v] of groups) {
      if (!ordered.some(([ok]) => ok === k)) ordered.push([k, v]);
    }
    return ordered;
  }, [findings, groupBy]);

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
  const publishedCount = findings.filter((f) => f.lifecycle === "published").length;
  const filedCount = findings.filter((f) => f.lifecycle && f.lifecycle !== "published").length;
  const unfiledCount = findings.length - publishedCount - filedCount;

  return (
    <View style={{ flex: 1, backgroundColor: colors.gray[850], paddingTop: insets.top }}>
      <StatusBar style="light" />
      <BackRow onBack={() => router.back()} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {/* 1 — header: emoji + name + full description (sheet header) */}
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

        {/* 2 — PROGRESS card: label / bar / one colored counts line. Nothing else.
            Same axes as the sheet: bar = done/total, counts = the same breakdown. */}
        <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: HAIRLINE }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
            <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 11 }}>PROGRESS</Text>
            <Text style={{ color: statusColor, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>
              {findings.length > 0 ? Math.round((publishedCount / findings.length) * 100) : 0}%
            </Text>
          </View>
          <ProgressBar done={publishedCount} total={Math.max(findings.length, 1)} color={statusColor} height={6} />
          <View style={{ flexDirection: "row", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>{unfiledCount} unfiled</Text>
            <Text style={{ color: colors.brand.amberDeep, fontFamily: "monospace", fontSize: 10 }}>{filedCount} in disclosure</Text>
            <Text style={{ color: colors.success, fontFamily: "monospace", fontSize: 10 }}>{publishedCount} published</Text>
          </View>
        </View>

        {/* 3 — collapsed disclosure rows (the sheet's EXPENSES slot). Engagements
            included: content-named rows only, no invented links. */}
        <DisclosureSection label={`ENGAGEMENTS (${chain.engagement_ids.length})`} collapsed={collapsed.has("engagements")} onToggle={() => toggle("engagements")}>
          <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, borderWidth: 1, borderColor: HAIRLINE }}>
            {chain.engagement_ids.map((eid, i) => (
              <Row
                key={eid}
                title={safe(eid)}
                sub="engagement"
                right="OPEN"
                rightColor={ACCENT}
                last={i === chain.engagement_ids.length - 1}
                onPress={() => router.push(`/soc/${eid}`)}
              />
            ))}
            {chain.published_repo ? (
              <Row
                title={chain.published_repo.replace(/^https?:\/\//, "")}
                sub={chain.published_at ? `published ${fmtDate(chain.published_at)}` : "published"}
                right="OPEN"
                rightColor={colors.success}
                last={chain.engagement_ids.length === 0}
                onPress={() => Linking.openURL(chain.published_repo!).catch(() => {})}
              />
            ) : null}
          </View>
        </DisclosureSection>

        <DisclosureSection label={`COMPONENTS (${chain.components.length})`} collapsed={collapsed.has("components")} onToggle={() => toggle("components")}>
          <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, borderWidth: 1, borderColor: HAIRLINE }}>
            {chain.components.map((comp, i) => {
              const cv = fmtCvss(comp.cvss);
              return (
                <Row
                  key={comp.skyline_id || comp.name || String(i)}
                  title={`${severityIcon(comp.severity)} ${safe(comp.name, "component")}`}
                  sub={[comp.skyline_id, comp.role].filter(Boolean).map((s) => safe(String(s))).join(" · ") || undefined}
                  right={cv || safe(comp.severity || "").toUpperCase()}
                  rightColor={cv ? cvssColor(comp.cvss) : severityColor(comp.severity)}
                  last={i === chain.components.length - 1}
                />
              );
            })}
          </View>
        </DisclosureSection>

        <DisclosureSection label={`EVIDENCE RUNS (${runs.length})`} collapsed={collapsed.has("runs")} onToggle={() => toggle("runs")}>
          <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, borderWidth: 1, borderColor: HAIRLINE }}>
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
          </View>
        </DisclosureSection>

        <DisclosureSection label={`ARTIFACTS (${artifacts.length})`} collapsed={collapsed.has("artifacts")} onToggle={() => toggle("artifacts")}>
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
        </DisclosureSection>

        <DisclosureSection label={`COORDINATION (${coordination.length})`} collapsed={collapsed.has("coord")} onToggle={() => toggle("coord")}>
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
        </DisclosureSection>

        <DisclosureSection label="ADVISORY" collapsed={collapsed.has("advisory")} onToggle={() => toggle("advisory")}>
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

        {/* 5 — STATUS segment row (sheet's STATUS, read-only) */}
        <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10, marginBottom: 6 }}>STATUS</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          {CHAIN_STATUS_ORDER.map((s, i) => {
            const active = i === idx;
            const past = i < idx;
            const col = chainStatusColor(s);
            return (
              <View
                key={s}
                style={{
                  flexBasis: "23%",
                  flexGrow: 1,
                  alignItems: "center",
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: active ? col + "22" : "transparent",
                  borderWidth: 1,
                  borderColor: active ? col + "66" : HAIRLINE,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    color: active ? col : colors.gray[400],
                    fontFamily: "monospace",
                    fontSize: 9,
                    fontWeight: "bold",
                  }}
                >
                  {chainStatusLabel(s).toUpperCase()}
                </Text>
              </View>
            );
          })}
        </View>

        {/* 6 — the work: FINDINGS header + toggle, phase groups, task cards */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 11, letterSpacing: 1 }}>
            FINDINGS ({findings.length})
          </Text>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {(["severity", "lifecycle"] as const).map((g) => (
              <Pressable
                key={g}
                onPress={() => setGroupBy(g)}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 4,
                  backgroundColor: groupBy === g ? colors.gray[700] : "transparent",
                }}
              >
                <Text style={{
                  color: groupBy === g ? colors.gray[100] : colors.gray[400],
                  fontFamily: "monospace",
                  fontSize: 9,
                  fontWeight: "bold",
                }}>
                  {g.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {findings.length === 0 ? (
          <View style={{ alignItems: "center", paddingVertical: 32 }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>🔐</Text>
            <Text style={{ color: colors.gray[300], fontSize: 15 }}>No findings linked yet</Text>
            <Text style={{ color: colors.gray[400], fontSize: 12, marginTop: 4 }}>Findings appear here as they are filed</Text>
          </View>
        ) : (
          findingGroups.map(([key, rows]) => {
            const isCollapsed = collapsed.has(`f:${key}`);
            return (
              <View key={key} style={{ marginBottom: 12 }}>
                <Pressable
                  onPress={() => toggle(`f:${key}`)}
                  style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6, paddingHorizontal: 4 }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={{ color: colors.gray[400], fontSize: 10 }}>{isCollapsed ? "▶" : "▼"}</Text>
                    <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 10, letterSpacing: 1 }}>
                      {(groupBy === "severity" ? key : lifecycleLabel(key === "unfiled" ? null : key)).toUpperCase()}
                    </Text>
                  </View>
                  <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9 }}>{rows.length}</Text>
                </Pressable>
                {!isCollapsed ? (
                  <View style={{ gap: 8 }}>
                    {rows.map((f) => {
                      // TaskCard's three circle states, verbatim: pending =
                      // gray ring, in_progress = amber ring + dot, done =
                      // green fill. Finding lifecycle maps onto them.
                      const state = f.lifecycle === "published" ? "done"
                        : f.lifecycle ? "in_progress" : "pending";
                      const isDone = state === "done";
                      return (
                        <Pressable
                          key={f.id}
                          onPress={() => setDetailFinding(f.id)}
                          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
                        >
                          <View style={{
                            backgroundColor: colors.gray[800],
                            borderRadius: 10,
                            padding: 14,
                            marginBottom: 8,
                            opacity: isDone ? 0.55 : 1,
                            borderWidth: 1,
                            borderColor: "rgba(255,255,255,0.03)",
                            flexDirection: "row",
                            alignItems: "center",
                          }}>
                            <View style={{ marginRight: 12 }}>
                              <View style={{
                                width: 18,
                                height: 18,
                                borderRadius: 9,
                                borderWidth: 2,
                                borderColor: TASK_CIRCLE[state],
                                backgroundColor: isDone ? colors.success : "transparent",
                                alignItems: "center",
                                justifyContent: "center",
                              }}>
                                {state === "in_progress" ? (
                                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand.amberDeep }} />
                                ) : null}
                              </View>
                            </View>
                            <Text
                              style={{
                                flex: 1,
                                color: isDone ? colors.gray[400] : colors.gray[50],
                                fontSize: 14,
                                textDecorationLine: isDone ? "line-through" : "none",
                              }}
                              numberOfLines={1}
                            >
                              {safe(f.title)}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>

      <ArtifactViewerModal artifact={viewArtifact} onClose={() => setViewArtifact(null)} />
      <FindingDetailModal findingId={detailFinding} onClose={() => setDetailFinding(null)} />
    </View>
  );
}

// ── Sheet vocabulary ──

function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 }}>
      <Pressable onPress={onBack} hitSlop={16} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, flexDirection: "row", alignItems: "center", gap: 4 })}>
        <Text style={{ color: colors.gray[300], fontSize: 14 }}>‹</Text>
        <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 11 }}>BACK</Text>
      </Pressable>
    </View>
  );
}

// Collapsed-by-default disclosure row — the sheet's "EXPENSES (n) ▸".
function DisclosureSection({ label, collapsed, onToggle, children }: {
  label: string; collapsed: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
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
