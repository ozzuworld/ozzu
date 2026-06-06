// DetailTab — the "everything else" tab: scope, ROE, recon hosts, task graph,
// audit log, engagement metadata. Each section collapsible, all default closed.

import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  colors,
  fontSize,
  fontWeight,
  radius,
  spacing,
  withAlpha,
} from "../../lib/design-tokens";

export interface EngagementMeta {
  id: string;
  client_name: string;
  engagement_type: string;
  status: string;
  scope?: any;
  roe?: any;
  start_date?: string | null;
  end_date?: string | null;
  engagement_phase?: string | null;
}

export interface ReconHostRow {
  ip: string;
  hostname?: string | null;
  mac?: string | null;
  vendor?: string | null;
  status?: string | null;
  ports?: any;
  discovered_at?: string | null;
}

export interface AuditLogRow {
  session_id: string;
  agent_name: string;
  task: string;
  status: string;
  started_at: string;
  completed_at?: string | null;
}

export interface TaskGraphNode {
  id: number;
  directive: string;
  phase?: string | null;
  status: string;
  parent_ids?: number[];
}

interface DetailTabProps {
  engagement: EngagementMeta;
  reconHosts: ReconHostRow[];
  auditLog: AuditLogRow[];
  taskGraph: TaskGraphNode[];
}

type SectionKey = "meta" | "scope" | "recon" | "graph" | "log";

export function DetailTab({ engagement, reconHosts, auditLog, taskGraph }: DetailTabProps) {
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    meta: false,
    scope: false,
    recon: false,
    graph: false,
    log: false,
  });
  const toggle = (k: SectionKey) => setOpen((p) => ({ ...p, [k]: !p[k] }));

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.sm }}
    >
      <Section title="Metadata" count={null} open={open.meta} onToggle={() => toggle("meta")}>
        <MetaRow label="ID" value={engagement.id} mono />
        <MetaRow label="Client" value={engagement.client_name} />
        <MetaRow label="Type" value={engagement.engagement_type} />
        <MetaRow label="Status" value={engagement.status} />
        {engagement.engagement_phase ? <MetaRow label="Phase" value={engagement.engagement_phase} /> : null}
        {engagement.start_date ? <MetaRow label="Start" value={engagement.start_date} /> : null}
        {engagement.end_date ? <MetaRow label="End" value={engagement.end_date} /> : null}
      </Section>

      <Section
        title="Scope & ROE"
        count={null}
        open={open.scope}
        onToggle={() => toggle("scope")}
      >
        <CodeBlock value={prettyJson(engagement.scope)} placeholder="no scope" />
        <View style={{ height: spacing.sm }} />
        <CodeBlock value={prettyJson(engagement.roe)} placeholder="no ROE" />
      </Section>

      <Section title="Recon hosts" count={reconHosts.length} open={open.recon} onToggle={() => toggle("recon")}>
        {reconHosts.length === 0 ? (
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs }}>none discovered</Text>
        ) : (
          reconHosts.map((h) => (
            <View
              key={h.ip}
              style={{
                backgroundColor: colors.bg.elevated,
                borderRadius: radius.sm,
                padding: spacing.sm,
                marginBottom: spacing.xs,
              }}
            >
              <Text style={{ color: colors.text.primary, fontFamily: "monospace", fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
                {h.ip}
                {h.hostname ? ` · ${h.hostname}` : ""}
              </Text>
              {h.vendor || h.mac ? (
                <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, fontFamily: "monospace", marginTop: 2 }}>
                  {h.mac || ""}{h.mac && h.vendor ? " · " : ""}{h.vendor || ""}
                </Text>
              ) : null}
              {Array.isArray(h.ports) && h.ports.length > 0 ? (
                <Text style={{ color: colors.text.secondary, fontSize: fontSize.xs, fontFamily: "monospace", marginTop: 4 }} numberOfLines={2}>
                  ports: {h.ports.map((p: any) => p.port || p).join(", ")}
                </Text>
              ) : null}
            </View>
          ))
        )}
      </Section>

      <Section title="Task graph" count={taskGraph.length} open={open.graph} onToggle={() => toggle("graph")}>
        {taskGraph.length === 0 ? (
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs }}>no agent tasks yet</Text>
        ) : (
          taskGraph.map((t) => (
            <View
              key={t.id}
              style={{
                backgroundColor: colors.bg.elevated,
                borderRadius: radius.sm,
                padding: spacing.sm,
                marginBottom: spacing.xs,
                borderLeftWidth: 2,
                borderLeftColor: t.status === "done" ? colors.success : t.status === "in_flight" ? colors.brand.blue : colors.text.tertiary,
              }}
            >
              <Text style={{ color: colors.text.primary, fontSize: fontSize.xs, fontWeight: fontWeight.medium }} numberOfLines={2}>
                #{t.id} {t.directive}
              </Text>
              <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, marginTop: 2, fontFamily: "monospace" }}>
                {t.phase || "—"} · {t.status}{t.parent_ids && t.parent_ids.length > 0 ? ` · ← ${t.parent_ids.join(",")}` : ""}
              </Text>
            </View>
          ))
        )}
      </Section>

      <Section title="Audit log" count={auditLog.length} open={open.log} onToggle={() => toggle("log")}>
        {auditLog.length === 0 ? (
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs }}>no executions yet</Text>
        ) : (
          auditLog.map((e) => (
            <View
              key={e.session_id}
              style={{
                backgroundColor: colors.bg.elevated,
                borderRadius: radius.sm,
                padding: spacing.sm,
                marginBottom: spacing.xs,
              }}
            >
              <Text style={{ color: colors.text.primary, fontSize: fontSize.xs }} numberOfLines={1}>
                {e.task}
              </Text>
              <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, marginTop: 2, fontFamily: "monospace" }}>
                {e.agent_name} · {e.status} · {e.started_at?.slice(0, 19).replace("T", " ")}
              </Text>
            </View>
          ))
        )}
      </Section>
    </ScrollView>
  );
}

function Section({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number | null;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.gray[800],
          borderRadius: radius.md,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={{ color: colors.text.tertiary, fontSize: fontSize.sm, marginRight: spacing.sm }}>
          {open ? "▼" : "▶"}
        </Text>
        <Text style={{ flex: 1, color: colors.text.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>
          {title}
        </Text>
        {count != null ? (
          <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, fontFamily: "monospace" }}>{count}</Text>
        ) : null}
      </Pressable>
      {open ? <View style={{ padding: spacing.md, gap: spacing.xs }}>{children}</View> : null}
    </View>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={{ flexDirection: "row", marginBottom: spacing.xs }}>
      <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs, width: 70, textTransform: "uppercase", letterSpacing: 0.3 }}>
        {label}
      </Text>
      <Text style={{ flex: 1, color: colors.text.primary, fontSize: fontSize.sm, fontFamily: mono ? "monospace" : undefined }}>
        {value}
      </Text>
    </View>
  );
}

function CodeBlock({ value, placeholder }: { value: string; placeholder: string }) {
  if (!value || value === "null" || value === "{}") {
    return <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs }}>{placeholder}</Text>;
  }
  return (
    <View
      style={{
        backgroundColor: colors.bg.base,
        borderRadius: radius.sm,
        padding: spacing.sm,
        borderWidth: 1,
        borderColor: withAlpha(colors.text.tertiary, 0.1),
      }}
    >
      <Text selectable style={{ color: colors.text.secondary, fontFamily: "monospace", fontSize: fontSize.xs, lineHeight: 16 }}>
        {value}
      </Text>
    </View>
  );
}

function prettyJson(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") {
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
