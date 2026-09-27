// Engagement record — SOC v3 report plane (dir_1790538151856).
// READ-ONLY rebuild of the old acting screen: the app no longer runs queue
// steps, cancels, skips or streams executor output. This is the record view
// of one engagement: findings, queue history, recon hosts, execution log,
// plus links to any kill chains this engagement feeds. Acting happens in the
// terminal with King Kazuma; this screen reflects it.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
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
import { ProgressBar } from "../../components/business/ProgressBar";
import { PhasePill } from "../../components/soc/PhasePill";
import { FindingRow, type FindingRowData } from "../../components/soc/FindingRow";
import { FindingDetailModal } from "../../components/soc/FindingDetailModal";
import { QueueRow, type QueueItemRow } from "../../components/soc/QueueRow";
import { SocErrorBoundary } from "../../components/soc/SocErrorBoundary";
import { severityColor } from "../../components/soc/phaseColors";
import { fmtDate } from "../../components/soc/chainConstants";
import { safe } from "../../components/soc/safe";

type Tab = "findings" | "queue" | "recon" | "log";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "findings", label: "Findings" },
  { key: "queue", label: "Queue" },
  { key: "recon", label: "Recon" },
  { key: "log", label: "Log" },
];

const FALLBACK_POLL_MS = 60_000;

interface EngagementMeta {
  id: string;
  client_name: string;
  engagement_type: string;
  status: string;
  scope?: any;
  roe?: any;
  start_date?: string | null;
  end_date?: string | null;
  engagement_phase?: string | null;
  created_at?: string | null;
}

interface ReconHostRow {
  ip: string;
  hostname?: string | null;
  mac?: string | null;
  vendor?: string | null;
  status?: string | null;
  ports?: any;
  discovered_at?: string | null;
}

interface AuditLogRow {
  session_id: string;
  agent_name: string;
  task: string;
  status: string;
  started_at: string;
  completed_at?: string | null;
}

interface ChainLink { slug: string; name: string; status: string; }

export default function EngagementRecordScreen() {
  const router = useRouter();
  const [resetKey, setResetKey] = useState(0);
  return (
    <SocErrorBoundary
      key={resetKey}
      onReset={() => setResetKey((k) => k + 1)}
      onBack={() => router.back()}
    >
      <EngagementRecordInner />
    </SocErrorBoundary>
  );
}

function EngagementRecordInner() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { insets } = usePhoneLayout();

  const [engagement, setEngagement] = useState<EngagementMeta | null>(null);
  const [queue, setQueue] = useState<QueueItemRow[]>([]);
  const [findings, setFindings] = useState<FindingRowData[]>([]);
  const [reconHosts, setReconHosts] = useState<ReconHostRow[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLogRow[]>([]);
  const [chainLinks, setChainLinks] = useState<ChainLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("findings");
  const [detailFinding, setDetailFinding] = useState<number | null>(null);

  // ── Fetchers (read-only) ──

  const fetchQueue = useCallback(async () => {
    try {
      const d = await apiFetch(`/soc/engagements/${id}/queue`);
      setQueue(d.queue || []);
    } catch {}
  }, [id]);

  const fetchFindings = useCallback(async () => {
    try {
      const d = await apiFetch(`/soc/engagements/${id}/findings`);
      setFindings(d.findings || []);
    } catch {}
  }, [id]);

  const fetchRecon = useCallback(async () => {
    try {
      const d = await apiFetch(`/soc/${id}/recon`);
      setReconHosts(d.hosts || []);
    } catch {}
  }, [id]);

  const fetchAuditLog = useCallback(async () => {
    try {
      const d = await apiFetch(`/soc/audit-log/${id}`);
      setAuditLog(d.executions || []);
    } catch {}
  }, [id]);

  const fetchChainLinks = useCallback(async () => {
    try {
      const d = await apiFetch("/soc/chains");
      const linked = (d.chains || [])
        .filter((c: any) => Array.isArray(c.engagement_ids) && c.engagement_ids.includes(id))
        .map((c: any) => ({ slug: c.slug, name: c.name, status: c.status }));
      setChainLinks(linked);
    } catch {}
  }, [id]);

  const fetchAll = useCallback(async () => {
    try {
      const engData = await apiFetch(`/soc/engagements/${id}`);
      setEngagement(engData.engagement || null);
      await Promise.all([fetchQueue(), fetchFindings(), fetchRecon(), fetchAuditLog(), fetchChainLinks()]);
    } catch {
      Alert.alert("Error", "Failed to load engagement");
    } finally {
      setLoading(false);
    }
  }, [id, fetchQueue, fetchFindings, fetchRecon, fetchAuditLog, fetchChainLinks]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Record-refresh pushes only — no exec output stream (the app doesn't act).
  const forEngagement = useCallback((msg: any) => msg && msg.engagement_id === id, [id]);
  useBridgeStream("socQueueChanged", () => { fetchQueue(); }, {
    filter: forEngagement, fallbackPollMs: FALLBACK_POLL_MS, onFallback: fetchQueue,
  });
  useBridgeStream("socStepDone", () => { fetchQueue(); fetchAuditLog(); }, { filter: forEngagement });
  useBridgeStream("socFindingAdded", () => { fetchFindings(); }, { filter: forEngagement });

  const queueDone = useMemo(() => queue.filter((q) => q.status === "done").length, [queue]);
  const sevCounts = useMemo(() => {
    const c: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) c[f.severity] = (c[f.severity] || 0) + 1;
    return c;
  }, [findings]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!engagement) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
        <Text style={{ color: colors.text.disabled, textAlign: "center", marginTop: spacing.xl }}>
          Engagement not found
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={{
        paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md,
        backgroundColor: colors.bg.elevated,
        borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
      }}>
        <Pressable onPress={() => router.back()} hitSlop={16} style={({ pressed }) => ({
          opacity: pressed ? 0.6 : 1, marginBottom: spacing.xs, paddingVertical: spacing.xs, alignSelf: "flex-start",
        })}>
          <Text style={{ color: colors.accent, fontSize: fs.lg, fontWeight: fw.medium }}>← Back</Text>
        </Pressable>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Text style={{ color: colors.text.primary, fontSize: fs.lg, fontWeight: fw.bold, flex: 1 }} numberOfLines={1}>
            {safe(engagement.client_name, "—")}
          </Text>
          <PhasePill phase={engagement.engagement_phase} size="sm" />
        </View>
        <Text style={{ color: colors.text.tertiary, fontSize: fs.sm, fontFamily: "monospace", marginTop: 2 }} numberOfLines={1}>
          {safe(engagement.id, "—")}{engagement.engagement_type ? ` · ${engagement.engagement_type}` : ""}
          {engagement.start_date ? ` · ${fmtDate(engagement.start_date)} →` : ""}
        </Text>

        {/* Severity strip + queue progress */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm }}>
          {(["critical", "high", "medium", "low", "info"] as const).map((sv) => (
            sevCounts[sv] > 0 ? (
              <View key={sv} style={{
                flexDirection: "row", alignItems: "center", gap: 4,
                backgroundColor: withAlpha(severityColor(sv), 0.12),
                borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2,
              }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: severityColor(sv) }} />
                <Text style={{ color: severityColor(sv), fontSize: fs.xs, fontWeight: fw.bold, fontFamily: "monospace" }}>
                  {sevCounts[sv]}
                </Text>
              </View>
            ) : null
          ))}
          <View style={{ flex: 1 }} />
          {queue.length > 0 ? (
            <Text style={{ color: colors.text.tertiary, fontSize: fs.xs, fontFamily: "monospace" }}>
              queue {queueDone}/{queue.length}
            </Text>
          ) : null}
        </View>

        {/* Chain links */}
        {chainLinks.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm }}>
            {chainLinks.map((c) => (
              <Pressable
                key={c.slug}
                onPress={() => router.push(`/soc/chain/${c.slug}`)}
                style={({ pressed }) => ({
                  flexDirection: "row", alignItems: "center", gap: 4,
                  backgroundColor: withAlpha(colors.brand.purple, 0.12),
                  borderRadius: radius.full, paddingHorizontal: spacing.sm + 2, paddingVertical: 4,
                  borderWidth: 1, borderColor: withAlpha(colors.brand.purple, 0.3),
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Text style={{ fontSize: 10 }}>⛓️</Text>
                <Text style={{ color: colors.brand.purple, fontSize: fs.xs, fontWeight: fw.semibold }}>
                  {safe(c.name, c.slug)}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      {/* Tab nav */}
      <View style={{
        flexDirection: "row", backgroundColor: colors.bg.elevated,
        borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
      }}>
        {TABS.map((t) => {
          const active = tab === t.key;
          const badge = t.key === "findings" ? findings.length
            : t.key === "queue" ? queue.length
            : t.key === "recon" ? reconHosts.length
            : auditLog.length;
          return (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              style={({ pressed }) => [styles.tab, active && styles.tabActive, pressed && { opacity: 0.8 }]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text numberOfLines={1} style={{
                  color: active ? colors.accent : colors.text.tertiary,
                  fontSize: fs.md, fontWeight: active ? fw.bold : fw.medium,
                }}>
                  {t.label}
                </Text>
                {badge > 0 ? (
                  <Text style={{
                    color: active ? colors.accent : colors.text.disabled,
                    fontSize: fs.xs, fontFamily: "monospace", fontWeight: fw.semibold,
                  }}>
                    {badge}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Tab bodies */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: spacing.sm }}
      >
        {tab === "findings" ? (
          findings.length === 0 ? (
            <EmptyTab emoji="🔎" text="No findings recorded on this engagement" />
          ) : (
            findings.map((f) => <FindingRow key={f.id} finding={f} onPress={(x) => setDetailFinding(x.id)} />)
          )
        ) : null}

        {tab === "queue" ? (
          queue.length === 0 ? (
            <EmptyTab emoji="📋" text="No queue steps recorded" />
          ) : (
            <>
              <View style={{ marginBottom: spacing.xs }}>
                <ProgressBar done={queueDone} total={queue.length} color={colors.accent} height={4} />
              </View>
              {queue.map((q) => <QueueRow key={q.id} item={q} />)}
            </>
          )
        ) : null}

        {tab === "recon" ? (
          reconHosts.length === 0 ? (
            <EmptyTab emoji="📡" text="No recon hosts recorded" />
          ) : (
            reconHosts.map((h, i) => {
              const ports = Array.isArray(h.ports) ? h.ports : [];
              return (
                <View key={`${h.ip}-${i}`} style={{
                  backgroundColor: colors.gray[800], borderRadius: radius.md,
                  borderLeftWidth: 3,
                  borderLeftColor: h.status === "up" ? colors.success : colors.text.disabled,
                  borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
                  padding: spacing.md, gap: spacing.xs,
                }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.semibold, fontFamily: "monospace" }}>
                      {safe(h.ip)}
                    </Text>
                    {h.hostname ? (
                      <Text style={{ color: colors.text.tertiary, fontSize: fs.sm, flex: 1 }} numberOfLines={1}>
                        {safe(h.hostname)}
                      </Text>
                    ) : <View style={{ flex: 1 }} />}
                    <View style={{
                      width: 7, height: 7, borderRadius: 4,
                      backgroundColor: h.status === "up" ? colors.success : colors.text.disabled,
                    }} />
                  </View>
                  {h.vendor || h.mac ? (
                    <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontFamily: "monospace" }} numberOfLines={1}>
                      {[safe(h.mac), safe(h.vendor)].filter(Boolean).join(" · ")}
                    </Text>
                  ) : null}
                  {ports.length > 0 ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: 2 }}>
                      {ports.slice(0, 12).map((p: any, pi: number) => {
                        const port = typeof p === "object" ? p?.port : p;
                        const svc = typeof p === "object" ? p?.service || p?.version : null;
                        return (
                          <View key={pi} style={{
                            backgroundColor: withAlpha(colors.info, 0.10), borderRadius: radius.xs,
                            paddingHorizontal: spacing.xs + 2, paddingVertical: 2,
                          }}>
                            <Text style={{ color: colors.brand.blue, fontSize: 9, fontFamily: "monospace" }}>
                              {safe(port)}{svc ? ` ${safe(svc)}` : ""}
                            </Text>
                          </View>
                        );
                      })}
                      {ports.length > 12 ? (
                        <Text style={{ color: colors.text.disabled, fontSize: 9, fontFamily: "monospace" }}>
                          +{ports.length - 12}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })
          )
        ) : null}

        {tab === "log" ? (
          auditLog.length === 0 ? (
            <EmptyTab emoji="🧾" text="No execution log entries" />
          ) : (
            auditLog.map((row, i) => {
              const done = row.status === "done" || row.status === "completed";
              const failed = row.status === "failed";
              const stColor = failed ? colors.error : done ? colors.success : colors.warning;
              return (
                <View key={`${row.session_id}-${i}`} style={{
                  backgroundColor: colors.gray[800], borderRadius: radius.md,
                  borderLeftWidth: 3, borderLeftColor: stColor,
                  borderWidth: 1, borderColor: "rgba(255,255,255,0.04)",
                  padding: spacing.md, gap: 2,
                }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.medium, flex: 1 }} numberOfLines={1}>
                      {safe(row.task)}
                    </Text>
                    <Text style={{ color: stColor, fontSize: fs.xs, fontWeight: fw.semibold }}>{safe(row.status)}</Text>
                  </View>
                  <Text style={{ color: colors.text.disabled, fontSize: fs.xs, fontFamily: "monospace" }} numberOfLines={1}>
                    {safe(row.agent_name)} · {row.started_at ? new Date(row.started_at).toLocaleString() : "—"}
                    {row.completed_at ? ` → ${new Date(row.completed_at).toLocaleTimeString()}` : ""}
                  </Text>
                </View>
              );
            })
          )
        ) : null}
      </ScrollView>

      <FindingDetailModal findingId={detailFinding} onClose={() => setDetailFinding(null)} />
    </View>
  );
}

function EmptyTab({ emoji, text }: { emoji: string; text: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: spacing.xxxl }}>
      <Text style={{ fontSize: 36, marginBottom: spacing.sm }}>{emoji}</Text>
      <Text style={{ color: colors.text.tertiary, fontSize: fs.md }}>{text}</Text>
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
