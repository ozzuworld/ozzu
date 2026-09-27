// FindingDetailModal — read-only finding record viewer (SOC v3 report plane).
// Fetches GET /soc/findings/:id on open and renders the full record:
// dual-axis status (kind = truth, lifecycle = disclosure), CVSS, chain link,
// description/remediation as markdown, reproduction steps, refs, linked
// artifacts. No actions — the app observes, the terminal acts. dir_1790538151856.

import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { getBridgeUrl, getAuthHeaders } from "../../lib/bridge-api";
import {
  colors, fontSize, fontWeight, radius, spacing, withAlpha,
} from "../../lib/design-tokens";
import { MarkdownContent } from "../ContentPanel";
import { severityColor } from "./phaseColors";
import {
  lifecycleColor, lifecycleLabel, fmtCvss, fmtDate, artifactIcon,
} from "./chainConstants";
import { safe } from "./safe";

interface LinkedArtifact {
  id: number;
  kind: string;
  filename: string;
  sha8: string;
  sanitized: boolean;
  push_state?: string | null;
}

interface FindingDetail {
  id: number;
  severity: string;
  title: string;
  description?: string | null;
  remediation?: string | null;
  reproduction?: any;
  affected_asset?: string | null;
  cvss_score?: number | string | null;
  cvss_vector?: string | null;
  refs?: string[] | null;
  mitre_attack?: string[] | null;
  kind?: string | null;
  status?: string | null;
  lifecycle?: string | null;
  skyline_id?: string | null;
  cve_id?: string | null;
  chain_id?: string | null;
  chain_slug?: string | null;
  chain_name?: string | null;
  engagement_id?: string | null;
  discovered_at?: string | null;
  discovered_by?: string | null;
}

interface Props {
  findingId: number | null;
  onClose: () => void;
}

export function FindingDetailModal({ findingId, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [finding, setFinding] = useState<FindingDetail | null>(null);
  const [artifacts, setArtifacts] = useState<LinkedArtifact[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    if (findingId == null) { setFinding(null); setArtifacts([]); return; }
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(`${getBridgeUrl()}/soc/findings/${findingId}`, { headers: getAuthHeaders() });
        if (!r.ok) return;
        const d = await r.json();
        if (!mounted) return;
        setFinding(d.finding || null);
        setArtifacts(d.artifacts || []);
      } catch {} finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [findingId]);

  if (findingId == null) return null;
  const sevColor = severityColor(finding?.severity);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: insets.top }}>
        {/* Header */}
        <View style={{
          flexDirection: "row", alignItems: "center",
          paddingHorizontal: spacing.md, paddingVertical: spacing.md + 2,
          backgroundColor: colors.bg.elevated,
          borderBottomWidth: 1, borderBottomColor: colors.border.subtle,
        }}>
          <Pressable onPress={onClose} hitSlop={16} style={({ pressed }) => ({
            opacity: pressed ? 0.6 : 1,
            paddingVertical: spacing.sm, paddingRight: spacing.md,
          })}>
            <Text style={{ color: colors.accent, fontSize: fontSize.lg, fontWeight: fontWeight.semibold }}>← Back</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: fontSize.sm }}>
            #{findingId}
          </Text>
        </View>

        {loading || !finding ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl, gap: spacing.md }}>
            {/* Severity + title */}
            <View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm, flexWrap: "wrap" }}>
                <Pill color={sevColor} label={safe(finding.severity, "unknown").toUpperCase()} />
                <Pill color={lifecycleColor(finding.lifecycle)} label={lifecycleLabel(finding.lifecycle)} />
                {finding.kind ? <Pill color={colors.gray[300]} label={safe(finding.kind)} /> : null}
              </View>
              <Text style={{ color: colors.text.primary, fontSize: fontSize.xl, fontWeight: fontWeight.bold, lineHeight: 24 }}>
                {safe(finding.title)}
              </Text>
            </View>

            {/* Identity meta */}
            <View style={{
              flexDirection: "row", flexWrap: "wrap", gap: spacing.md,
              backgroundColor: colors.bg.elevated, borderRadius: radius.md, padding: spacing.md,
            }}>
              {fmtCvss(finding.cvss_score) ? <MetaChip label="CVSS" value={fmtCvss(finding.cvss_score)!} valueColor={sevColor} /> : null}
              {finding.skyline_id ? <MetaChip label="Skyline" value={safe(finding.skyline_id)} /> : null}
              {finding.cve_id ? <MetaChip label="CVE" value={safe(finding.cve_id)} /> : null}
              {finding.engagement_id ? <MetaChip label="Engagement" value={safe(finding.engagement_id)} /> : null}
              {finding.discovered_at ? <MetaChip label="Discovered" value={fmtDate(finding.discovered_at)} /> : null}
              {finding.discovered_by ? <MetaChip label="By" value={safe(finding.discovered_by)} /> : null}
            </View>

            {finding.cvss_vector ? (
              <Text selectable style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: fontSize.xs }}>
                {safe(finding.cvss_vector)}
              </Text>
            ) : null}

            {/* Chain link */}
            {finding.chain_slug ? (
              <Pressable
                onPress={() => { onClose(); router.push(`/soc/chain/${finding.chain_slug}`); }}
                style={({ pressed }) => ({
                  flexDirection: "row", alignItems: "center", gap: spacing.sm,
                  backgroundColor: withAlpha(colors.brand.purple, 0.10),
                  borderRadius: radius.md, padding: spacing.md,
                  borderWidth: 1, borderColor: withAlpha(colors.brand.purple, 0.25),
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text style={{ fontSize: 16 }}>⛓️</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>
                    {safe(finding.chain_name, finding.chain_slug)}
                  </Text>
                  <Text style={{ color: colors.text.tertiary, fontSize: fontSize.xs }}>Part of this kill chain — tap to open</Text>
                </View>
                <Text style={{ color: colors.text.disabled, fontSize: fontSize.md }}>›</Text>
              </Pressable>
            ) : null}

            {finding.affected_asset ? (
              <Section title="Affected asset">
                <Text selectable style={{ color: colors.text.secondary, fontFamily: "monospace", fontSize: fontSize.sm }}>
                  {safe(finding.affected_asset)}
                </Text>
              </Section>
            ) : null}

            {finding.description ? (
              <Section title="Description">
                <MarkdownContent content={safe(finding.description)} />
              </Section>
            ) : null}

            {renderRepro(finding.reproduction) ? (
              <Section title="Reproduction">
                {renderRepro(finding.reproduction)}
              </Section>
            ) : null}

            {finding.remediation ? (
              <Section title="Remediation">
                <MarkdownContent content={safe(finding.remediation)} />
              </Section>
            ) : null}

            {Array.isArray(finding.mitre_attack) && finding.mitre_attack.length > 0 ? (
              <Section title="MITRE ATT&CK">
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
                  {finding.mitre_attack.map((t) => (
                    <View key={t} style={{
                      backgroundColor: withAlpha(colors.brand.blue, 0.12), borderRadius: radius.sm,
                      paddingHorizontal: spacing.sm, paddingVertical: 3,
                    }}>
                      <Text style={{ color: colors.brand.blue, fontFamily: "monospace", fontSize: fontSize.xs }}>{safe(t)}</Text>
                    </View>
                  ))}
                </View>
              </Section>
            ) : null}

            {Array.isArray(finding.refs) && finding.refs.length > 0 ? (
              <Section title="References">
                <View style={{ gap: spacing.xs }}>
                  {finding.refs.map((r, i) => (
                    <Text key={i} selectable style={{ color: colors.text.secondary, fontFamily: "monospace", fontSize: fontSize.xs, lineHeight: 16 }}>
                      {safe(r)}
                    </Text>
                  ))}
                </View>
              </Section>
            ) : null}

            {artifacts.length > 0 ? (
              <Section title="Linked artifacts">
                <View style={{ gap: spacing.sm }}>
                  {artifacts.map((a) => (
                    <View key={a.id} style={{
                      flexDirection: "row", alignItems: "center", gap: spacing.sm,
                      backgroundColor: colors.bg.elevated, borderRadius: radius.md, padding: spacing.md,
                    }}>
                      <Text style={{ fontSize: 14 }}>{artifactIcon(a.kind)}</Text>
                      <Text style={{ flex: 1, color: colors.text.primary, fontSize: fontSize.md }} numberOfLines={1}>{safe(a.filename)}</Text>
                      <Text style={{ color: colors.text.disabled, fontFamily: "monospace", fontSize: fontSize.xs }}>{safe(a.sha8)}</Text>
                      {!a.sanitized ? <Text style={{ fontSize: fontSize.xs }}>🔒</Text> : null}
                    </View>
                  ))}
                </View>
              </Section>
            ) : null}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function renderRepro(repro: any): React.ReactNode | null {
  if (!repro) return null;
  if (typeof repro === "string") {
    if (!repro.trim()) return null;
    return <MarkdownContent content={repro} />;
  }
  if (typeof repro === "object") {
    const steps = repro.steps;
    if (Array.isArray(steps) && steps.length > 0) {
      return (
        <View style={{ gap: spacing.sm }}>
          {steps.map((s: any, i: number) => (
            <View key={i} style={{ flexDirection: "row", gap: spacing.sm }}>
              <Text style={{ color: colors.accent, fontFamily: "monospace", fontSize: fontSize.sm, fontWeight: fontWeight.bold }}>{i + 1}.</Text>
              <Text selectable style={{ flex: 1, color: colors.text.secondary, fontSize: fontSize.sm, lineHeight: 20 }}>{safe(s)}</Text>
            </View>
          ))}
        </View>
      );
    }
    if (Object.keys(repro).length === 0) return null;
    return (
      <View style={{
        backgroundColor: colors.bg.elevated, borderRadius: radius.md,
        padding: spacing.md, borderWidth: 1, borderColor: colors.border.subtle,
      }}>
        <Text selectable style={{ color: colors.text.secondary, fontFamily: "monospace", fontSize: fontSize.xs, lineHeight: 16 }}>
          {JSON.stringify(repro, null, 2)}
        </Text>
      </View>
    );
  }
  return null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={{
        color: colors.text.tertiary, fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold, textTransform: "uppercase", letterSpacing: 0.5,
      }}>{title}</Text>
      {children}
    </View>
  );
}

function MetaChip({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={{ gap: 2, minWidth: 70 }}>
      <Text style={{ color: colors.text.disabled, fontSize: fontSize.xs }}>{label}</Text>
      <Text style={{ color: valueColor || colors.text.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>{value}</Text>
    </View>
  );
}

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center",
      backgroundColor: withAlpha(color, 0.14), borderRadius: radius.sm,
      paddingHorizontal: spacing.sm, paddingVertical: 3,
    }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, marginRight: spacing.xs }} />
      <Text style={{ color, fontSize: fontSize.xs, fontWeight: fontWeight.semibold }}>{label}</Text>
    </View>
  );
}
