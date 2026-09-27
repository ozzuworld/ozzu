// Engagement ops record — SOC report console (dir_1790544238642, rebuilt).
// NOT app navigation: this screen is reachable ONLY from a kill chain's
// "ops record" row. It is the raw engagement ledger — findings, queue
// history, recon hosts, execution log — in console language. Read-only;
// acting happens in the terminal with King Kazuma.

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
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
  fontSize as fs,
  fontWeight as fw,
} from "../../lib/design-tokens";
import { FindingDetailModal } from "../../components/soc/FindingDetailModal";
import { SocErrorBoundary } from "../../components/soc/SocErrorBoundary";
import { severityColor } from "../../components/soc/phaseColors";
import {
  lifecycleColor,
  lifecycleLabel,
  chainStatusColor,
  fmtDate,
  fmtCvss,
  cvssColor,
} from "../../components/soc/chainConstants";
import { safe } from "../../components/soc/safe";
import {
  MONO,
  MicroLabel,
  Mono,
  Chip,
  SectionHead,
  RowGroup,
  PressRow,
  SegTabs,
  EmptyState,
  ConsoleHeader,
} from "../../components/soc/consoleKit";

type Tab = "findings" | "queue" | "recon" | "log";

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

interface QueueItemRow {
  id: number;
  seq: number;
  title: string;
  description?: string | null;
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
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

const QUEUE_COLOR: Record<string, string> = {
  running: colors.success,
  done: colors.accent,
  failed: colors.error,
  skipped: colors.text.tertiary,
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
      <StatusBar style="light" />

      <ConsoleHeader
        onBack={() => router.back()}
        label="engagement · ops record"
        right={<Chip label={safe(engagement?.status, "--")} color={colors.brand.blue} dot />}
        title={safe(engagement?.client_name, engagement?.id, id)}
      />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: spacing.xxxl }}>
        {/* Identity strip */}
        <View style={{ padding: spacing.md, gap: spacing.sm }}>
          <Mono color={colors.text.secondary} size={fs.sm} weight="semibold" numberOfLines={1}>
            {safe(id)}
          </Mono>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, alignItems: "center" }}>
            <Chip label={safe(engagement?.engagement_type, "engagement")} color={colors.text.secondary} />
            {engagement?.engagement_phase ? (
              <Chip label={safe(engagement.engagement_phase)} color={colors.brand.purple} />
            ) : null}
            {engagement?.start_date ? (
              <Mono color={colors.text.disabled}>{fmtDate(engagement.start_date)} → {engagement.end_date ? fmtDate(engagement.end_date) : "…"}</Mono>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.lg, rowGap: spacing.sm }}>
            {Object.entries(sevCounts).filter(([, n]) => n > 0).map(([sev, n]) => (
              <View key={sev} style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
                <Mono color={severityColor(sev)} size={fs.lg} weight="bold">{n}</Mono>
                <MicroLabel color={severityColor(sev)} size={9}>{sev}</MicroLabel>
              </View>
            ))}
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
              <Mono color={colors.text.secondary} size={fs.lg} weight="bold">{queueDone}/{queue.length}</Mono>
              <MicroLabel color={colors.text.disabled} size={9}>queue done</MicroLabel>
            </View>
          </View>

          {/* Chains this engagement feeds — the way back up */}
          {chainLinks.length > 0 ? (
            <>
              <SectionHead label="feeds chains" />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                {chainLinks.map((c) => (
                  <Chip
                    key={c.slug}
                    label={c.name.length > 22 ? `${c.name.slice(0, 21)}…` : c.name}
                    color={chainStatusColor(c.status)}
                    onPress={() => router.push(`/soc/chain/${c.slug}`)}
                  />
                ))}
              </View>
            </>
          ) : null}
        </View>

        <SegTabs<Tab>
          tabs={[
            { key: "findings", label: "fnd", count: findings.length },
            { key: "queue", label: "queue", count: queue.length },
            { key: "recon", label: "recon", count: reconHosts.length },
            { key: "log", label: "log", count: auditLog.length },
          ]}
          active={tab}
          onChange={setTab}
        />

        <View style={{ padding: spacing.md }}>
          {tab === "findings" ? (
            findings.length === 0 ? (
              <EmptyState text="no findings recorded" />
            ) : (
              <RowGroup>
                {findings.map((f, i) => (
                  <PressRow
                    key={f.id}
                    rail={severityColor(f.severity)}
                    last={i === findings.length - 1}
                    onPress={() => setDetailFinding(f.id)}
                  >
                    <View style={{ flex: 1, paddingLeft: spacing.xs }}>
                      <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.semibold, lineHeight: 18 }} numberOfLines={2}>
                        {safe(f.title)}
                      </Text>
                      <Mono color={colors.text.disabled} style={{ marginTop: 3 }}>
                        {[
                          safe(f.severity).toUpperCase(),
                          f.affected_asset,
                          f.discovered_at ? fmtDate(f.discovered_at) : null,
                        ].filter(Boolean).join(" · ")}
                      </Mono>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      {fmtCvss(f.cvss_score) ? (
                        <Mono color={cvssColor(f.cvss_score)} size={fs.lg} weight="bold">{fmtCvss(f.cvss_score)}</Mono>
                      ) : null}
                      <MicroLabel color={lifecycleColor(f.lifecycle ?? null)} size={9}>
                        {lifecycleLabel(f.lifecycle ?? null)}
                      </MicroLabel>
                    </View>
                  </PressRow>
                ))}
              </RowGroup>
            )
          ) : null}

          {tab === "queue" ? (
            queue.length === 0 ? (
              <EmptyState text="queue empty" />
            ) : (
              <RowGroup>
                {queue.map((q, i) => (
                  <PressRow key={q.id} rail={QUEUE_COLOR[q.status] || colors.text.disabled} last={i === queue.length - 1}>
                    <Mono color={colors.text.disabled} size={fs.sm} weight="bold">
                      {String(q.seq).padStart(2, "0")}
                    </Mono>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.medium }} numberOfLines={1}>
                        {safe(q.title)}
                      </Text>
                      {q.description ? (
                        <Text style={{ color: colors.text.tertiary, fontSize: fs.xs, marginTop: 2 }} numberOfLines={1}>
                          {safe(q.description)}
                        </Text>
                      ) : null}
                    </View>
                    <Chip label={safe(q.status)} color={QUEUE_COLOR[q.status] || colors.text.disabled} />
                  </PressRow>
                ))}
              </RowGroup>
            )
          ) : null}

          {tab === "recon" ? (
            reconHosts.length === 0 ? (
              <EmptyState text="no recon hosts" />
            ) : (
              <RowGroup>
                {reconHosts.map((h, i) => {
                  const ports: string[] = Array.isArray(h.ports)
                    ? h.ports.map((p: any) => (typeof p === "number" ? String(p) : p?.port ?? "")).filter(Boolean)
                    : [];
                  return (
                    <PressRow key={`${h.ip}-${i}`} last={i === reconHosts.length - 1}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
                          <Mono color={colors.text.primary} size={fs.md} weight="bold">{safe(h.ip)}</Mono>
                          {h.hostname ? (
                            <Text style={{ color: colors.text.tertiary, fontSize: fs.sm }} numberOfLines={1}>{safe(h.hostname)}</Text>
                          ) : null}
                        </View>
                        <Mono color={colors.text.disabled} style={{ marginTop: 2 }}>
                          {[h.mac, h.vendor].filter(Boolean).join(" · ") || "—"}
                        </Mono>
                      </View>
                      <View style={{ alignItems: "flex-end", gap: 3 }}>
                        {ports.length > 0 ? (
                          <Mono color={colors.info} size={9} numberOfLines={1}>{ports.join(",")}</Mono>
                        ) : null}
                        <MicroLabel color={h.status === "up" ? colors.success : colors.text.disabled} size={9}>
                          {safe(h.status, "--")}
                        </MicroLabel>
                      </View>
                    </PressRow>
                  );
                })}
              </RowGroup>
            )
          ) : null}

          {tab === "log" ? (
            auditLog.length === 0 ? (
              <EmptyState text="no execution log" />
            ) : (
              <RowGroup>
                {auditLog.map((row, i) => (
                  <PressRow
                    key={`${row.session_id}-${i}`}
                    rail={row.status === "success" ? colors.success : row.status === "failed" ? colors.error : colors.text.disabled}
                    last={i === auditLog.length - 1}
                  >
                    <View style={{ flex: 1, paddingLeft: spacing.xs }}>
                      <Text style={{ color: colors.text.primary, fontSize: fs.md, fontWeight: fw.medium, lineHeight: 18 }} numberOfLines={2}>
                        {safe(row.task)}
                      </Text>
                      <Mono color={colors.text.disabled} style={{ marginTop: 3 }}>
                        {safe(row.agent_name)} · {fmtDate(row.started_at)}
                        {row.completed_at ? ` → ${fmtDate(row.completed_at)}` : ""}
                      </Mono>
                    </View>
                    <Chip label={safe(row.status)} color={row.status === "success" ? colors.success : row.status === "failed" ? colors.error : colors.text.disabled} />
                  </PressRow>
                ))}
              </RowGroup>
            )
          ) : null}
        </View>
      </ScrollView>

      <FindingDetailModal findingId={detailFinding} onClose={() => setDetailFinding(null)} />
    </View>
  );
}
