// FindingDetailModal — read-only finding record viewer, console language
// (dir_1790544238642). Fetches GET /soc/findings/:id on open and renders the
// full record: dual-axis status (kind = truth, lifecycle = disclosure),
// CVSS, chain link, description/remediation as markdown, reproduction steps,
// refs, linked artifacts. No actions — the app observes, the terminal acts.

import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { getBridgeUrl, getAuthHeaders } from "../../lib/bridge-api";
import {
  colors, fontSize as fs, fontWeight as fw, spacing, withAlpha,
} from "../../lib/design-tokens";
import { MarkdownContent } from "../ContentPanel";
import { severityColor } from "./phaseColors";
import {
  lifecycleColor, lifecycleLabel, fmtCvss, fmtDate, artifactIcon,
} from "./chainConstants";
import { safe } from "./safe";
import {
  MONO, MicroLabel, Mono, Chip, SectionHead, RowGroup, PressRow, ConsoleHeader,
} from "./consoleKit";

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
        <ConsoleHeader
          onBack={onClose}
          label="finding record"
          right={<Mono color={colors.text.disabled} size={fs.sm} weight="semibold">#{findingId}</Mono>}
        />

        {loading || !finding ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl }}>
            {/* Status chips + title */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md }}>
              <Chip label={safe(finding.severity, "unknown")} color={sevColor} filled dot />
              <Chip label={lifecycleLabel(finding.lifecycle)} color={lifecycleColor(finding.lifecycle)} />
              {finding.kind ? <Chip label={safe(finding.kind)} color={colors.gray[400]} /> : null}
            </View>
            <Text style={{ color: colors.gray[50], fontSize: fs.xl, fontWeight: fw.bold, lineHeight: 26 }}>
              {safe(finding.title)}
            </Text>

            {/* Identity meta — dense label/value rows */}
            <View style={{ marginTop: spacing.lg }}>
              <RowGroup>
                {fmtCvss(finding.cvss_score) ? (
                  <MetaRow label="cvss" value={fmtCvss(finding.cvss_score)!} valueColor={sevColor} big />
                ) : null}
                {finding.skyline_id ? <MetaRow label="skyline" value={safe(finding.skyline_id)} /> : null}
                {finding.cve_id ? <MetaRow label="cve" value={safe(finding.cve_id)} valueColor={colors.brand.orange} /> : null}
                {finding.engagement_id ? <MetaRow label="engagement" value={safe(finding.engagement_id)} /> : null}
                {finding.discovered_at ? <MetaRow label="discovered" value={fmtDate(finding.discovered_at)} /> : null}
                {finding.discovered_by ? <MetaRow label="by" value={safe(finding.discovered_by)} last={!finding.cvss_vector} /> : null}
                {finding.cvss_vector ? (
                  <View style={{ padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border.subtle }}>
                    <Text selectable style={{ color: colors.text.disabled, fontFamily: MONO, fontSize: 9, lineHeight: 14 }}>
                      {safe(finding.cvss_vector)}
                    </Text>
                  </View>
                ) : null}
              </RowGroup>
            </View>

            {/* Chain link */}
            {finding.chain_slug ? (
              <>
                <SectionHead label="kill chain" />
                <RowGroup>
                  <PressRow onPress={() => { onClose(); router.push(`/soc/chain/${finding.chain_slug}`); }} last>
                    <MicroLabel color={colors.brand.purple} size={9}>chain</MicroLabel>
                    <Text style={{ flex: 1, color: colors.text.primary, fontSize: fs.md, fontWeight: fw.semibold }} numberOfLines={1}>
                      {safe(finding.chain_name, finding.chain_slug)}
                    </Text>
                    <Mono color={colors.text.disabled} size={fs.lg}>›</Mono>
                  </PressRow>
                </RowGroup>
              </>
            ) : null}

            {finding.affected_asset ? (
              <>
                <SectionHead label="affected asset" />
                <Mono color={colors.text.secondary} size={fs.sm} style={{ lineHeight: 20 }}>
                  {safe(finding.affected_asset)}
                </Mono>
              </>
            ) : null}

            {finding.description ? (
              <>
                <SectionHead label="description" />
                <MarkdownContent content={safe(finding.description)} />
              </>
            ) : null}

            {renderRepro(finding.reproduction) ? (
              <>
                <SectionHead label="reproduction" />
                {renderRepro(finding.reproduction)}
              </>
            ) : null}

            {finding.remediation ? (
              <>
                <SectionHead label="remediation" />
                <MarkdownContent content={safe(finding.remediation)} />
              </>
            ) : null}

            {Array.isArray(finding.mitre_attack) && finding.mitre_attack.length > 0 ? (
              <>
                <SectionHead label="mitre att&ck" />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                  {finding.mitre_attack.map((t) => (
                    <Chip key={t} label={safe(t)} color={colors.brand.blue} />
                  ))}
                </View>
              </>
            ) : null}

            {Array.isArray(finding.refs) && finding.refs.length > 0 ? (
              <>
                <SectionHead label="references" />
                <View style={{ gap: spacing.xs }}>
                  {finding.refs.map((r, i) => (
                    <Mono key={i} color={colors.text.secondary} size={fs.xs} style={{ lineHeight: 16 }}>
                      {safe(r)}
                    </Mono>
                  ))}
                </View>
              </>
            ) : null}

            {artifacts.length > 0 ? (
              <>
                <SectionHead label="linked artifacts" right={String(artifacts.length)} />
                <RowGroup>
                  {artifacts.map((a, i) => (
                    <PressRow key={a.id} last={i === artifacts.length - 1}>
                      <Mono color={colors.text.secondary} size={fs.lg}>{artifactIcon(a.kind)}</Mono>
                      <Mono color={colors.text.primary} size={fs.md} weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
                        {safe(a.filename)}
                      </Mono>
                      <Mono color={colors.text.disabled}>{safe(a.sha8)}</Mono>
                      {!a.sanitized ? <Chip label="internal" color={colors.gray[500]} /> : null}
                    </PressRow>
                  ))}
                </RowGroup>
              </>
            ) : null}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function MetaRow({ label, value, valueColor, big, last }: {
  label: string; value: string; valueColor?: string; big?: boolean; last?: boolean;
}) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: spacing.md,
      paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2,
      borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.border.subtle,
    }}>
      <MicroLabel color={colors.text.disabled} size={9} style={{ width: 84 }}>{label}</MicroLabel>
      <Text style={{
        flex: 1,
        color: valueColor || colors.text.primary,
        fontSize: big ? fs.lg : fs.sm,
        fontWeight: big ? fw.bold : fw.medium,
        fontFamily: MONO,
      }} numberOfLines={1}>
        {value}
      </Text>
    </View>
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
              <Mono color={colors.accent} size={fs.sm} weight="bold">{i + 1}.</Mono>
              <Text selectable style={{ flex: 1, color: colors.text.secondary, fontSize: fs.sm, lineHeight: 20 }}>{safe(s)}</Text>
            </View>
          ))}
        </View>
      );
    }
    if (Object.keys(repro).length === 0) return null;
    return (
      <View style={{
        backgroundColor: withAlpha(colors.gray[850], 0.6), borderRadius: 4,
        padding: spacing.md, borderWidth: 1, borderColor: colors.border.subtle,
      }}>
        <Text selectable style={{ color: colors.text.secondary, fontFamily: MONO, fontSize: fs.xs, lineHeight: 16 }}>
          {JSON.stringify(repro, null, 2)}
        </Text>
      </View>
    );
  }
  return null;
}
