// FindingDetailModal — read-only finding record in the venture-sheet UI
// language (KK order 2026-09-27, dir_1790544238642). Fetches
// GET /soc/findings/:id on open: status row, CVSS card, chain link,
// description / reproduction / remediation / mitre / refs / artifacts as
// section cards. No actions — the app observes, the terminal acts.

import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { getBridgeUrl, getAuthHeaders } from "../../lib/bridge-api";
import { colors } from "../../lib/design-tokens";
import { MarkdownContent } from "../ContentPanel";
import { severityColor, severityIcon } from "./phaseColors";
import {
  lifecycleColor, lifecycleLabel, fmtCvss, fmtDate, artifactIcon,
} from "./chainConstants";
import { safe } from "./safe";

const ACCENT = colors.accent;
const HAIRLINE = "rgba(255,255,255,0.04)";

interface LinkedArtifact {
  id: number;
  kind: string;
  filename: string;
  sha8: string;
  sanitized: boolean;
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
  lifecycle?: string | null;
  skyline_id?: string | null;
  cve_id?: string | null;
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
  const lcColor = lifecycleColor(finding?.lifecycle);
  const cv = fmtCvss(finding?.cvss_score);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={{ flex: 1, backgroundColor: colors.gray[850], paddingTop: insets.top }}>
        {/* Top row — same as the venture sheet's CLOSE row */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 }}>
          <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 10, fontWeight: "bold", letterSpacing: 2 }}>FINDING #{findingId}</Text>
          <Pressable onPress={onClose} hitSlop={16} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingHorizontal: 8, paddingVertical: 4 })}>
            <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 11 }}>CLOSE</Text>
          </Pressable>
        </View>

        {loading || !finding ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={ACCENT} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            {/* Header — venture-sheet shape */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <Text style={{ fontSize: 28 }}>{severityIcon(finding.severity)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.gray[50], fontSize: 15, fontWeight: "600", lineHeight: 21 }}>
                  {safe(finding.title)}
                </Text>
                <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10, marginTop: 4 }}>
                  <Text style={{ color: sevColor }}>{safe(finding.severity).toUpperCase()}</Text>
                  {" · "}
                  <Text style={{ color: lcColor }}>{lifecycleLabel(finding.lifecycle).toUpperCase()}</Text>
                  {finding.kind ? ` · ${safe(finding.kind).toUpperCase()}` : ""}
                </Text>
              </View>
            </View>

            {/* CVSS card — the venture PROGRESS-card slot */}
            {cv || finding.skyline_id || finding.cve_id ? (
              <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: HAIRLINE }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
                  <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2 }}>SEVERITY SCORE</Text>
                  {cv ? (
                    <Text style={{ color: sevColor, fontFamily: "monospace", fontSize: 28, fontWeight: "bold", lineHeight: 32 }}>{cv}</Text>
                  ) : null}
                </View>
                <View style={{ flexDirection: "row", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                  {finding.skyline_id ? <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10 }}>{safe(finding.skyline_id)}</Text> : null}
                  {finding.cve_id ? <Text style={{ color: colors.brand.orange, fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>{safe(finding.cve_id)}</Text> : null}
                  {finding.discovered_at ? <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>{fmtDate(finding.discovered_at)}{finding.discovered_by ? ` · ${safe(finding.discovered_by)}` : ""}</Text> : null}
                </View>
                {finding.cvss_vector ? (
                  <Text selectable style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, lineHeight: 14, marginTop: 8 }}>
                    {safe(finding.cvss_vector)}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {/* Kill chain link */}
            {finding.chain_slug ? (
              <SectionCard label="KILL CHAIN">
                <Pressable
                  onPress={() => { onClose(); router.push(`/soc/chain/${finding.chain_slug}`); }}
                  style={({ pressed }) => ({ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6, opacity: pressed ? 0.7 : 1 })}
                >
                  <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 12, flex: 1, paddingRight: 8 }} numberOfLines={1}>
                    {safe(finding.chain_name, finding.chain_slug)}
                  </Text>
                  <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 11, fontWeight: "bold" }}>OPEN ›</Text>
                </Pressable>
              </SectionCard>
            ) : null}

            {finding.affected_asset ? (
              <SectionCard label="AFFECTED ASSET">
                <Text selectable style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}>
                  {safe(finding.affected_asset)}
                </Text>
              </SectionCard>
            ) : null}

            {finding.description ? (
              <SectionCard label="DESCRIPTION">
                <MarkdownContent content={safe(finding.description)} />
              </SectionCard>
            ) : null}

            {renderRepro(finding.reproduction) ? (
              <SectionCard label="REPRODUCTION">
                {renderRepro(finding.reproduction)}
              </SectionCard>
            ) : null}

            {finding.remediation ? (
              <SectionCard label="REMEDIATION">
                <MarkdownContent content={safe(finding.remediation)} />
              </SectionCard>
            ) : null}

            {Array.isArray(finding.mitre_attack) && finding.mitre_attack.length > 0 ? (
              <SectionCard label="MITRE ATT&CK">
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {finding.mitre_attack.map((t) => (
                    <View key={t} style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, backgroundColor: colors.gray[700] }}>
                      <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>{safe(t)}</Text>
                    </View>
                  ))}
                </View>
              </SectionCard>
            ) : null}

            {Array.isArray(finding.refs) && finding.refs.length > 0 ? (
              <SectionCard label={`REFERENCES (${finding.refs.length})`}>
                {finding.refs.map((r, i) => (
                  <Text key={i} selectable style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 11, lineHeight: 17, paddingVertical: 2 }}>
                    {safe(r)}
                  </Text>
                ))}
              </SectionCard>
            ) : null}

            {artifacts.length > 0 ? (
              <SectionCard label={`LINKED ARTIFACTS (${artifacts.length})`}>
                {artifacts.map((a, i) => (
                  <View key={a.id} style={{
                    flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6,
                    borderBottomWidth: i < artifacts.length - 1 ? 1 : 0, borderBottomColor: HAIRLINE,
                  }}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 12 }} numberOfLines={1}>
                        {artifactIcon(a.kind)} {safe(a.filename)}
                      </Text>
                      <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10, marginTop: 2 }}>
                        {safe(a.kind)} · {safe(a.sha8)}
                      </Text>
                    </View>
                    <Text style={{ color: a.sanitized ? colors.success : colors.gray[400], fontFamily: "monospace", fontSize: 10, fontWeight: "bold" }}>
                      {a.sanitized ? "SANITIZED" : "INTERNAL"}
                    </Text>
                  </View>
                ))}
              </SectionCard>
            ) : null}
          </ScrollView>
        )}
      </View>
    </Modal>
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
        <View style={{ gap: 8 }}>
          {steps.map((s: any, i: number) => (
            <View key={i} style={{ flexDirection: "row", gap: 8 }}>
              <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>{i + 1}.</Text>
              <Text selectable style={{ flex: 1, color: colors.gray[300], fontSize: 12, lineHeight: 18 }}>{safe(s)}</Text>
            </View>
          ))}
        </View>
      );
    }
    if (Object.keys(repro).length === 0) return null;
    return (
      <Text selectable style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 11, lineHeight: 16 }}>
        {JSON.stringify(repro, null, 2)}
      </Text>
    );
  }
  return null;
}
