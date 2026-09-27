// Engagement ops record — same UI as the venture detail sheet, filled with
// engagement info (KK order 2026-09-27, dir_1790544238642). NOT app navigation:
// reachable ONLY from a kill chain's OPS RECORD row. Read-only ledger:
// overview card, feeds-chains, then pill tabs findings / queue / recon / log.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { apiFetch } from "../../lib/bridge-api";
import { useBridgeStream } from "../../lib/useBridgeStream";
import { colors } from "../../lib/design-tokens";
import { ProgressBar } from "../../components/business/ProgressBar";
import { FindingDetailModal } from "../../components/soc/FindingDetailModal";
import { SocErrorBoundary } from "../../components/soc/SocErrorBoundary";
import { severityColor, severityIcon } from "../../components/soc/phaseColors";
import {
  lifecycleColor,
  lifecycleLabel,
  chainStatusColor,
  chainStatusEmoji,
  fmtDate,
  fmtCvss,
  cvssColor,
} from "../../components/soc/chainConstants";
import { safe } from "../../components/soc/safe";

const ACCENT = colors.accent;
const HAIRLINE = "rgba(255,255,255,0.04)";
const FALLBACK_POLL_MS = 60_000;

type Tab = "findings" | "queue" | "recon" | "log";

interface EngagementMeta {
  id: string;
  client_name: string;
  engagement_type: string;
  status: string;
  start_date?: string | null;
  end_date?: string | null;
  engagement_phase?: string | null;
}

interface QueueItemRow {
  id: number;
  seq: number;
  title: string;
  description?: string | null;
  status: string;
}

interface FindingRowData {
  id: number;
  severity: string;
  title: string;
  lifecycle?: string | null;
  affected_asset?: string | null;
  cvss_score?: number | string | null;
  discovered_at?: string | null;
}

interface ReconHostRow {
  ip: string;
  hostname?: string | null;
  mac?: string | null;
  vendor?: string | null;
  status?: string | null;
  ports?: any;
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

const QUEUE_COLOR: Record<string, string> = {
  running: colors.success,
  done: ACCENT,
  failed: colors.error,
  skipped: colors.gray[400],
  pending: colors.warning,
};

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

  const fetchQueue = useCallback(async () => {
    try { const d = await apiFetch(`/soc/engagements/${id}/queue`); setQueue(d.queue || []); } catch {}
  }, [id]);

  const fetchFindings = useCallback(async () => {
    try { const d = await apiFetch(`/soc/engagements/${id}/findings`); setFindings(d.findings || []); } catch {}
  }, [id]);

  const fetchRecon = useCallback(async () => {
    try { const d = await apiFetch(`/soc/${id}/recon`); setReconHosts(d.hosts || []); } catch {}
  }, [id]);

  const fetchAuditLog = useCallback(async () => {
    try { const d = await apiFetch(`/soc/audit-log/${id}`); setAuditLog(d.executions || []); } catch {}
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

  const forEngagement = useCallback((msg: any) => msg && msg.engagement_id === id, [id]);
  useBridgeStream("socQueueChanged", () => { fetchQueue(); }, {
    filter: forEngagement, fallbackPollMs: FALLBACK_POLL_MS, onFallback: fetchQueue,
  });
  useBridgeStream("socStepDone", () => { fetchQueue(); fetchAuditLog(); }, { filter: forEngagement });
  useBridgeStream("socFindingAdded", () => { fetchFindings(); }, { filter: forEngagement });

  const queueDone = useMemo(() => queue.filter((q) => q.status === "done").length, [queue]);
  const sevCounts = useMemo(() => {
    const c: Record<string, number> = { critical: 0, high: 0 };
    for (const f of findings) {
      if (f.severity === "critical" || f.severity === "high") c[f.severity] = (c[f.severity] || 0) + 1;
    }
    return c;
  }, [findings]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.gray[850], alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors.gray[400], fontFamily: "monospace" }}>Loading...</Text>
      </View>
    );
  }

  const queuePct = queue.length > 0 ? Math.round((queueDone / queue.length) * 100) : 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.gray[850], paddingTop: insets.top }}>
      <StatusBar style="light" />

      {/* Back row */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 }}>
        <Pressable onPress={() => router.back()} hitSlop={16} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, flexDirection: "row", alignItems: "center", gap: 4 })}>
          <Text style={{ color: colors.gray[300], fontSize: 14 }}>‹</Text>
          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 11 }}>BACK</Text>
        </Pressable>
        <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 10, fontWeight: "bold", letterSpacing: 2 }}>OPS RECORD</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {/* Header — venture-sheet shape */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <Text style={{ fontSize: 28 }}>🗂️</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 16, fontWeight: "bold" }} numberOfLines={2}>
              {safe(engagement?.client_name, id)}
            </Text>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10, marginTop: 2 }} numberOfLines={1}>
              {safe(id)} · {safe(engagement?.engagement_type, "engagement")}
              {engagement?.start_date ? ` · ${fmtDate(engagement.start_date)} → ${engagement?.end_date ? fmtDate(engagement.end_date) : "…"}` : ""}
            </Text>
          </View>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: engagement?.status === "completed" ? colors.success : ACCENT }} />
        </View>

        {/* Queue progress — same card as the venture PROGRESS card */}
        <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: HAIRLINE }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
            <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 11 }}>QUEUE PROGRESS</Text>
            <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>{queuePct}%</Text>
          </View>
          <ProgressBar done={queueDone} total={queue.length} color={ACCENT} height={6} />
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12, paddingHorizontal: 4 }}>
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{findings.length}</Text>
              <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>FINDINGS</Text>
            </View>
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: colors.error, fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{sevCounts.critical || 0}</Text>
              <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>CRITICAL</Text>
            </View>
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: colors.brand.orange, fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{sevCounts.high || 0}</Text>
              <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>HIGH</Text>
            </View>
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: colors.success, fontFamily: "monospace", fontSize: 20, fontWeight: "bold" }}>{queueDone}/{queue.length}</Text>
              <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>QUEUE</Text>
            </View>
          </View>
        </View>

        {/* Feeds chains — the way back up */}
        {chainLinks.length > 0 ? (
          <SectionCard label={`FEEDS CHAINS (${chainLinks.length})`}>
            {chainLinks.map((c, i) => (
              <Row
                key={c.slug}
                title={`${chainStatusEmoji(c.status)} ${safe(c.name, c.slug)}`}
                sub={safe(c.slug)}
                right="›"
                rightColor={chainStatusColor(c.status)}
                last={i === chainLinks.length - 1}
                onPress={() => router.push(`/soc/chain/${c.slug}`)}
              />
            ))}
          </SectionCard>
        ) : null}

        {/* Tab pills — same as WORK sub-tabs */}
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          {([
            { key: "findings", label: "FINDINGS", n: findings.length },
            { key: "queue", label: "QUEUE", n: queue.length },
            { key: "recon", label: "RECON", n: reconHosts.length },
            { key: "log", label: "LOG", n: auditLog.length },
          ] as Array<{ key: Tab; label: string; n: number }>).map((t) => {
            const on = tab === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 6,
                  backgroundColor: on ? ACCENT + "22" : "transparent",
                  borderWidth: 1,
                  borderColor: on ? ACCENT + "44" : "transparent",
                }}
              >
                <Text style={{ color: on ? ACCENT : colors.gray[400], fontFamily: "monospace", fontSize: 10, fontWeight: "bold", letterSpacing: 1 }}>
                  {t.label}{t.n > 0 ? ` ${t.n}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {tab === "findings" ? (
          findings.length === 0 ? (
            <EmptyBlock emoji="🛡️" text="No findings recorded" />
          ) : (
            <SectionCard label={`FINDINGS (${findings.length})`}>
              {findings.map((f, i) => {
                const cv = fmtCvss(f.cvss_score);
                return (
                  <Row
                    key={f.id}
                    title={`${severityIcon(f.severity)} ${safe(f.title)}`}
                    sub={[safe(f.severity).toUpperCase(), f.affected_asset, lifecycleLabel(f.lifecycle ?? null), f.discovered_at ? fmtDate(f.discovered_at) : null].filter(Boolean).join(" · ")}
                    right={cv || ""}
                    rightColor={cv ? cvssColor(f.cvss_score) : lifecycleColor(f.lifecycle ?? null)}
                    last={i === findings.length - 1}
                    onPress={() => setDetailFinding(f.id)}
                  />
                );
              })}
            </SectionCard>
          )
        ) : null}

        {tab === "queue" ? (
          queue.length === 0 ? (
            <EmptyBlock emoji="📋" text="Queue empty" />
          ) : (
            <SectionCard label={`QUEUE (${queue.length})`}>
              {queue.map((q, i) => (
                <Row
                  key={q.id}
                  title={`${String(q.seq).padStart(2, "0")} · ${safe(q.title)}`}
                  sub={q.description ? safe(q.description) : undefined}
                  right={safe(q.status).toUpperCase()}
                  rightColor={QUEUE_COLOR[q.status] || colors.gray[400]}
                  last={i === queue.length - 1}
                />
              ))}
            </SectionCard>
          )
        ) : null}

        {tab === "recon" ? (
          reconHosts.length === 0 ? (
            <EmptyBlock emoji="📡" text="No recon hosts" />
          ) : (
            <SectionCard label={`RECON HOSTS (${reconHosts.length})`}>
              {reconHosts.map((h, i) => {
                const ports: string[] = Array.isArray(h.ports)
                  ? h.ports.map((p: any) => (typeof p === "number" ? String(p) : p?.port ?? "")).filter(Boolean)
                  : [];
                return (
                  <Row
                    key={`${h.ip}-${i}`}
                    title={safe(h.ip)}
                    sub={[h.hostname, h.mac, h.vendor].filter(Boolean).map((s) => safe(String(s))).join(" · ") || undefined}
                    right={ports.length > 0 ? ports.join(",") : safe(h.status || "--").toUpperCase()}
                    rightColor={ports.length > 0 ? colors.info : h.status === "up" ? colors.success : colors.gray[400]}
                    last={i === reconHosts.length - 1}
                  />
                );
              })}
            </SectionCard>
          )
        ) : null}

        {tab === "log" ? (
          auditLog.length === 0 ? (
            <EmptyBlock emoji="🧾" text="No execution log" />
          ) : (
            <SectionCard label={`EXECUTION LOG (${auditLog.length})`}>
              {auditLog.map((row, i) => (
                <Row
                  key={`${row.session_id}-${i}`}
                  title={safe(row.task)}
                  sub={`${safe(row.agent_name)} · ${fmtDate(row.started_at)}${row.completed_at ? ` → ${fmtDate(row.completed_at)}` : ""}`}
                  right={safe(row.status).toUpperCase()}
                  rightColor={row.status === "success" ? colors.success : row.status === "failed" ? colors.error : colors.gray[400]}
                  last={i === auditLog.length - 1}
                />
              ))}
            </SectionCard>
          )
        ) : null}
      </ScrollView>

      <FindingDetailModal findingId={detailFinding} onClose={() => setDetailFinding(null)} />
    </View>
  );
}

// ── Shared blocks (venture-sheet vocabulary) ──

function SectionCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: HAIRLINE }}>
      <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>{label}</Text>
      {children}
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

function EmptyBlock({ emoji, text }: { emoji: string; text: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 40 }}>
      <Text style={{ fontSize: 40, marginBottom: 12 }}>{emoji}</Text>
      <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 12 }}>{text}</Text>
    </View>
  );
}
