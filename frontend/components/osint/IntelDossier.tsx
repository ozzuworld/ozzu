import { View, Text, ScrollView, Pressable, Image, Linking, ActivityIndicator, Animated, Dimensions } from "react-native";
import { useState, useEffect, useCallback, useRef } from "react";
import { getBridgeUrl, getAuthHeaders, apiFetch, fetchOsintEkf, type OsintProfile, type OsintFinding, type EkfSummary } from "../../lib/bridge-api";

const { width: SW } = Dimensions.get("window");

// Filter non-Latin text
function isLatin(t: string): boolean {
  if (!t) return false;
  const l = t.replace(/[\s\d\W]/g, "").split("").filter(c => /[a-zA-Z\u00C0-\u024F]/.test(c)).length;
  const n = t.replace(/[\s\d\W]/g, "").length;
  return n === 0 || l / n > 0.5;
}
function clean(t: string) { return t && isLatin(t) ? t : ""; }

interface Props {
  profile: OsintProfile;
  findings: OsintFinding[];
  allFindings?: OsintFinding[];
  onBack: () => void;
}

type Tab = "assessment" | "overview" | "identity" | "faces" | "geoint" | "sources";

export function IntelDossier({ profile, findings, onBack }: Props) {
  const [tab, setTab] = useState<Tab>("assessment");
  const [dossier, setDossier] = useState<any>(null);
  const [dossierLoading, setDossierLoading] = useState(true);
  const [ekf, setEkf] = useState<EkfSummary | null>(null);
  const [assessment, setAssessment] = useState<any>(null);
  const [assessLoading, setAssessLoading] = useState(true);
  const [assessGenerating, setAssessGenerating] = useState(false);
  const [typedRels, setTypedRels] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);

  const imgUrl = `${getBridgeUrl()}/osint/images/${profile.id}/thumbnail`;

  // Parse — pick first Latin candidate
  const idCand = findings.find(f => f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates");
  const allCandidates = idCand?.raw_data?.candidates || [];
  const top = allCandidates.find((c: any) => {
    const n = c.name || "";
    if (!n || /^[0-9×x]+$/.test(n)) return false;
    return isLatin(n);
  }) || allCandidates[0];
  const name = (top?.name && isLatin(top.name) ? top.name : null) || profile.label || "Unknown";
  const conf = top?.confidence || 0;

  const verified = findings.filter(f => f.raw_data?.type === "verified_face_matches");
  const discovered = findings.filter(f => f.raw_data?.type === "discovered_profile");
  const scenes = findings.filter(f => f.raw_data?.type === "scene_analysis");
  const pivots = findings.filter(f => f.raw_data?.type === "pivot_recommendation");

  const crit = findings.filter(f => f.severity === "critical").length;
  const high = findings.filter(f => f.severity === "high").length;
  const med = findings.filter(f => f.severity === "medium").length;
  const ringColor = crit > 0 ? "#dc2626" : high > 0 ? "#ea580c" : "#16a34a";
  const totalFaces = (verified[0]?.raw_data?.verifiedMatches?.length || 0) + discovered.length;

  useEffect(() => {
    apiFetch(`/osint/dossier/${profile.id}?days=30`).then(d => setDossier(d.dossier)).catch(() => {}).finally(() => setDossierLoading(false));
  }, [profile.id]);
  useEffect(() => { fetchOsintEkf(profile.id).then(d => setEkf(d.summary)).catch(() => {}); }, [profile.id]);

  // Load assessment
  useEffect(() => {
    setAssessLoading(true);
    apiFetch(`/osint/assessment/${profile.id}`)
      .then(d => setAssessment(d.assessment))
      .catch(() => {})
      .finally(() => setAssessLoading(false));
  }, [profile.id]);

  // Load typed relationships + GEOINT locations
  useEffect(() => {
    apiFetch(`/osint/relationships/${profile.id}/typed`)
      .then(d => setTypedRels(d.relationships || []))
      .catch(() => {});
    apiFetch(`/osint/locations/${profile.id}`)
      .then(d => setLocations(d.locations || []))
      .catch(() => {});
  }, [profile.id]);

  const generateAssessment = useCallback(async () => {
    setAssessGenerating(true);
    try {
      const d = await apiFetch(`/osint/assessment/${profile.id}`, { method: "POST" });
      setAssessment(d.assessment);
    } catch (e: any) {
      console.error("Assessment generation failed:", e);
    } finally {
      setAssessGenerating(false);
    }
  }, [profile.id]);

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "assessment", label: "Intel" },
    { key: "overview", label: "Overview" },
    { key: "identity", label: "Identity", badge: allCandidates.length },
    { key: "faces", label: "Faces", badge: totalFaces },
    { key: "geoint", label: "GEOINT", badge: locations.length },
    { key: "sources", label: "Sources" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {/* HUD HEADER */}
      <View style={{ borderBottomWidth: 1, borderBottomColor: "#111" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
          <Pressable onPress={onBack} hitSlop={16} style={{ marginRight: 12, padding: 4 }}>
            <Text style={{ color: "#444", fontSize: 18 }}>{"<"}</Text>
          </Pressable>
          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={{ color: assessment?.classification === "SECRET" ? "#dc262644" : "#dc262622", fontSize: 8, fontWeight: "800", letterSpacing: 4 }}>
              {assessment?.classification || "CONFIDENTIAL"}
            </Text>
          </View>
          <View style={{ width: 30 }} />
        </View>

        <View style={{ flexDirection: "row", padding: 16, paddingTop: 8, gap: 16, alignItems: "center" }}>
          <View style={{ position: "relative" }}>
            <View style={{ position: "absolute", top: -6, left: -6, right: -6, bottom: -6, borderRadius: 40, backgroundColor: ringColor, opacity: 0.07 }} />
            <View style={{ width: 64, height: 64, borderRadius: 32, borderWidth: 2.5, borderColor: ringColor, overflow: "hidden" }}>
              <Image source={{ uri: imgUrl, headers: getAuthHeaders() }} style={{ width: 59, height: 59, borderRadius: 29 }} />
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#f5f5f5", fontSize: 17, fontWeight: "800" }} numberOfLines={1}>{name}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
              {assessment?.identityConfidence && <ConfBadge level={assessment.identityConfidence} />}
              {assessment?.exposureScore && <ExposureBadge score={assessment.exposureScore} />}
              {!assessment && conf > 0 && <HudBadge text={`${(conf * 100).toFixed(0)}%`} color={conf > 0.7 ? "#16a34a" : "#ca8a04"} />}
              <HudBadge text={`${findings.length}`} color="#555" />
            </View>
          </View>
          <ThreatGauge crit={crit} high={high} med={med} total={findings.length} />
        </View>
      </View>

      {/* TAB BAR */}
      <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#111" }}>
        {tabs.map(t => {
          const active = tab === t.key;
          return (
            <Pressable key={t.key} onPress={() => setTab(t.key)} style={{ flex: 1, paddingVertical: 12, alignItems: "center", borderBottomWidth: 2, borderBottomColor: active ? "#00b4d8" : "transparent" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text style={{ color: active ? "#e5e5e5" : "#2a2a2a", fontSize: 11, fontWeight: active ? "800" : "500" }}>{t.label}</Text>
                {(t.badge ?? 0) > 0 && <View style={{ backgroundColor: active ? "#00b4d822" : "#111", borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 }}>
                  <Text style={{ color: active ? "#00b4d8" : "#333", fontSize: 8, fontWeight: "800" }}>{t.badge}</Text>
                </View>}
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* TAB CONTENT */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 50 }} showsVerticalScrollIndicator={false} key={tab}>
        {tab === "assessment" && <AssessmentScreen assessment={assessment} loading={assessLoading} generating={assessGenerating} onGenerate={generateAssessment} typedRels={typedRels} />}
        {tab === "overview" && <OverviewScreen findings={findings} crit={crit} high={high} med={med} totalFaces={totalFaces} scenes={scenes} ekf={ekf} discovered={discovered} dossier={dossier} dossierLoading={dossierLoading} conf={conf} />}
        {tab === "identity" && <IdentityScreen candidates={idCand?.raw_data?.candidates || []} dossier={dossier} />}
        {tab === "faces" && <FacesScreen verified={verified} discovered={discovered} profileId={profile.id} />}
        {tab === "geoint" && <GeointScreen locations={locations} findings={findings} />}
        {tab === "sources" && <SourcesScreen assessment={assessment} findings={findings} />}
      </ScrollView>
    </View>
  );
}

// =============================================
// ASSESSMENT — CIA-style intelligence report
// =============================================
function AssessmentScreen({ assessment, loading, generating, onGenerate, typedRels }: any) {
  if (loading) return <View style={{ alignItems: "center", paddingVertical: 60 }}><ActivityIndicator color="#00b4d8" /><Text style={{ color: "#333", fontSize: 10, marginTop: 12 }}>Loading assessment...</Text></View>;

  if (!assessment) {
    return (
      <View style={{ alignItems: "center", paddingVertical: 40, gap: 16 }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, borderWidth: 1, borderColor: "#1a1a1a", justifyContent: "center", alignItems: "center" }}>
          <Text style={{ color: "#1a1a1a", fontSize: 24 }}>?</Text>
        </View>
        <Text style={{ color: "#333", fontSize: 12 }}>No intelligence assessment generated yet</Text>
        <Pressable onPress={onGenerate} disabled={generating} style={{ backgroundColor: generating ? "#111" : "#00b4d815", borderRadius: 12, paddingHorizontal: 24, paddingVertical: 14, borderWidth: 1, borderColor: "#00b4d830" }}>
          {generating ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator size="small" color="#00b4d8" />
              <Text style={{ color: "#00b4d8", fontSize: 12, fontWeight: "700" }}>Analyzing intelligence...</Text>
            </View>
          ) : (
            <Text style={{ color: "#00b4d8", fontSize: 12, fontWeight: "800" }}>GENERATE ASSESSMENT</Text>
          )}
        </Pressable>
        <Text style={{ color: "#222", fontSize: 9, textAlign: "center", paddingHorizontal: 40 }}>
          Synthesizes all findings into a CIA-style intelligence assessment using AI analysis
        </Text>
      </View>
    );
  }

  const a = assessment;
  const confColor = a.identityConfidence === "HIGH" ? "#16a34a" : a.identityConfidence === "MODERATE" ? "#ca8a04" : "#dc2626";
  const riskColor = (r: string) => r === "CRITICAL" ? "#dc2626" : r === "HIGH" ? "#ea580c" : r === "MODERATE" ? "#ca8a04" : "#16a34a";

  return (
    <View style={{ gap: 14 }}>
      {/* EXECUTIVE SUMMARY */}
      <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
        <Text style={{ color: "#dc2626", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>EXECUTIVE SUMMARY</Text>
        <Text style={{ color: "#ccc", fontSize: 12, lineHeight: 20 }}>{a.executiveSummary}</Text>
      </View>

      {/* IDENTITY CONFIDENCE */}
      <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: confColor + "30" }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Text style={{ color: "#555", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>IDENTITY CONFIDENCE</Text>
          <View style={{ backgroundColor: confColor + "18", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 4 }}>
            <Text style={{ color: confColor, fontSize: 12, fontWeight: "900" }}>{a.identityConfidence}</Text>
          </View>
        </View>
        <Text style={{ color: "#888", fontSize: 11, lineHeight: 18 }}>{a.identityConfidenceJustification}</Text>
      </View>

      {/* KEY FINDINGS */}
      {a.keyFindings?.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 12 }}>KEY FINDINGS</Text>
          {a.keyFindings.map((kf: any, i: number) => (
            <View key={i} style={{ marginBottom: 12, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: riskColor(kf.confidence) + "40" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <ConfBadge level={kf.confidence} small />
                {kf.sourceGrades?.map((g: string, j: number) => <GradeBadge key={j} grade={g} />)}
                {kf.category && <Text style={{ color: "#222", fontSize: 8, fontWeight: "600" }}>{kf.category.toUpperCase()}</Text>}
              </View>
              <Text style={{ color: "#bbb", fontSize: 11, lineHeight: 18 }}>{kf.finding}</Text>
            </View>
          ))}
        </View>
      )}

      {/* VULNERABILITY ASSESSMENT */}
      {a.vulnerabilityAssessment && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <Text style={{ color: "#ea580c", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>VULNERABILITY ASSESSMENT</Text>
            <View style={{ backgroundColor: riskColor(a.vulnerabilityAssessment.overallRisk) + "18", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ color: riskColor(a.vulnerabilityAssessment.overallRisk), fontSize: 10, fontWeight: "900" }}>{a.vulnerabilityAssessment.overallRisk}</Text>
            </View>
          </View>
          {["identity", "digital", "financial", "social", "physical"].map(cat => {
            const v = a.vulnerabilityAssessment[cat];
            if (!v) return null;
            const c = riskColor(v.risk);
            return (
              <View key={cat} style={{ marginBottom: 12 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <Text style={{ color: "#555", fontSize: 10, fontWeight: "700", textTransform: "uppercase" }}>{cat}</Text>
                  <Text style={{ color: c, fontSize: 9, fontWeight: "800" }}>{v.risk}</Text>
                </View>
                <View style={{ height: 4, backgroundColor: "#111", borderRadius: 2, overflow: "hidden", marginBottom: 4 }}>
                  <View style={{ height: 4, width: v.risk === "CRITICAL" ? "100%" : v.risk === "HIGH" ? "75%" : v.risk === "MODERATE" ? "50%" : "25%", backgroundColor: c, borderRadius: 2 }} />
                </View>
                <Text style={{ color: "#444", fontSize: 10, lineHeight: 16 }}>{v.detail}</Text>
              </View>
            );
          })}
        </View>
      )}

      {/* EXPOSURE SCORE */}
      {a.exposureScore && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <Text style={{ color: "#a855f7", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>DIGITAL EXPOSURE</Text>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
              <Text style={{ color: riskColor(a.exposureScore.level), fontSize: 24, fontWeight: "900" }}>{a.exposureScore.overall}</Text>
              <Text style={{ color: "#333", fontSize: 10 }}>/100</Text>
            </View>
          </View>
          <View style={{ height: 8, backgroundColor: "#111", borderRadius: 4, overflow: "hidden", marginBottom: 14 }}>
            <AnimatedBar width={a.exposureScore.overall} color={riskColor(a.exposureScore.level)} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {Object.entries(a.exposureScore.categories || {}).map(([cat, data]: [string, any]) => (
              <View key={cat} style={{ backgroundColor: "#0a0a0a", borderRadius: 10, padding: 12, minWidth: (SW - 64) / 2 - 4, flex: 1 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                  <Text style={{ color: "#444", fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>{cat}</Text>
                  <Text style={{ color: "#888", fontSize: 9, fontWeight: "800" }}>{data.score}/{data.max}</Text>
                </View>
                <View style={{ height: 3, backgroundColor: "#111", borderRadius: 1, overflow: "hidden" }}>
                  <View style={{ height: 3, width: `${data.max > 0 ? (data.score / data.max) * 100 : 0}%`, backgroundColor: data.score / data.max > 0.7 ? "#dc2626" : data.score / data.max > 0.4 ? "#ca8a04" : "#16a34a", borderRadius: 1 }} />
                </View>
                {data.factors?.length > 0 && <Text style={{ color: "#333", fontSize: 8, marginTop: 4 }} numberOfLines={2}>{data.factors[0]}</Text>}
              </View>
            ))}
          </View>
        </View>
      )}

      {/* NETWORK ANALYSIS */}
      {a.networkAnalysis && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>NETWORK ANALYSIS</Text>
          <Text style={{ color: "#999", fontSize: 11, lineHeight: 20 }}>{a.networkAnalysis}</Text>

          {/* Typed relationships */}
          {typedRels.length > 0 && (
            <View style={{ marginTop: 14 }}>
              <Text style={{ color: "#333", fontSize: 9, fontWeight: "700", letterSpacing: 1, marginBottom: 8 }}>RELATIONSHIPS ({typedRels.length})</Text>
              {typedRels.slice(0, 12).map((r: any, i: number) => (
                <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <Text style={{ color: "#555", fontSize: 10, fontWeight: "700", width: 80 }} numberOfLines={1}>{r.source === "subject" ? name : r.source}</Text>
                  <View style={{ backgroundColor: "#111", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                    <Text style={{ color: "#00b4d8", fontSize: 8, fontWeight: "700" }}>{r.type.replace(/_/g, " ")}</Text>
                  </View>
                  <Text style={{ color: "#888", fontSize: 10, flex: 1 }} numberOfLines={1}>{r.target}</Text>
                  <Text style={{ color: "#222", fontSize: 8 }}>{r.confidence}%</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {/* BEHAVIORAL PATTERNS */}
      {a.behavioralPatterns && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#ca8a04", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>BEHAVIORAL PATTERNS</Text>
          <Text style={{ color: "#999", fontSize: 11, lineHeight: 20 }}>{a.behavioralPatterns}</Text>
        </View>
      )}

      {/* OUTLOOK */}
      {a.outlook && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#16a34a", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>OUTLOOK</Text>
          <Text style={{ color: "#999", fontSize: 11, lineHeight: 20 }}>{a.outlook}</Text>
        </View>
      )}

      {/* INTELLIGENCE GAPS */}
      {a.intelligenceGaps?.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#dc2626", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>INTELLIGENCE GAPS</Text>
          {a.intelligenceGaps.map((gap: string, i: number) => (
            <View key={i} style={{ flexDirection: "row", gap: 8, marginBottom: 6 }}>
              <Text style={{ color: "#dc262660", fontSize: 10 }}>{i + 1}.</Text>
              <Text style={{ color: "#888", fontSize: 11, lineHeight: 18, flex: 1 }}>{gap}</Text>
            </View>
          ))}
        </View>
      )}

      {/* COLLECTION RECOMMENDATIONS */}
      {a.collectionRecommendations?.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#555", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>COLLECTION RECOMMENDATIONS</Text>
          {a.collectionRecommendations.map((rec: string, i: number) => (
            <View key={i} style={{ flexDirection: "row", gap: 8, marginBottom: 6 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#333", marginTop: 5 }} />
              <Text style={{ color: "#777", fontSize: 11, lineHeight: 18, flex: 1 }}>{rec}</Text>
            </View>
          ))}
        </View>
      )}

      {/* SOURCE MATRIX mini */}
      {a.metadata && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#333", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>SOURCE MATRIX</Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {["A", "B", "C", "D", "E", "F"].map(g => {
              const count = a.metadata.gradedFindings?.[g] || 0;
              if (count === 0) return null;
              return (
                <View key={g} style={{ alignItems: "center", gap: 4 }}>
                  <GradeBadge grade={g} />
                  <Text style={{ color: "#555", fontSize: 10, fontWeight: "800" }}>{count}</Text>
                </View>
              );
            })}
          </View>
          <Text style={{ color: "#222", fontSize: 9, marginTop: 10 }}>
            {a.metadata.totalFindings} total findings | {a.metadata.modelUsed} | {new Date(a.metadata.generatedAt).toLocaleDateString()}
          </Text>
        </View>
      )}

      {/* Re-generate button */}
      <Pressable onPress={onGenerate} disabled={generating} style={{ backgroundColor: "#080808", borderRadius: 14, padding: 14, alignItems: "center", borderWidth: 1, borderColor: "#111" }}>
        {generating ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ActivityIndicator size="small" color="#00b4d8" />
            <Text style={{ color: "#333", fontSize: 11, fontWeight: "600" }}>Re-analyzing...</Text>
          </View>
        ) : (
          <Text style={{ color: "#222", fontSize: 11, fontWeight: "600" }}>Regenerate Assessment</Text>
        )}
      </Pressable>
    </View>
  );
}

// =============================================
// OVERVIEW — visual dashboard (existing)
// =============================================
function OverviewScreen({ findings, crit, high, med, totalFaces, scenes, ekf, discovered, dossier, dossierLoading, conf }: any) {
  const threatColor = crit > 0 ? "#dc2626" : high > 0 ? "#ea580c" : "#16a34a";
  const exposurePct = Math.min(100, Math.max(5, crit * 25 + high * 15 + findings.length * 2));

  return (
    <View style={{ gap: 14 }}>
      <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 10 }}>
          <Text style={{ color: "#555", fontSize: 10, fontWeight: "700", letterSpacing: 2 }}>EXPOSURE</Text>
          <Text style={{ color: threatColor, fontSize: 10, fontWeight: "800" }}>
            {crit > 0 ? "CRITICAL" : high > 0 ? "ELEVATED" : "NOMINAL"}
          </Text>
        </View>
        <View style={{ height: 8, backgroundColor: "#111", borderRadius: 4, overflow: "hidden" }}>
          <AnimatedBar width={exposurePct} color={threatColor} />
        </View>
        <View style={{ flexDirection: "row", gap: 16, marginTop: 12, justifyContent: "center" }}>
          <SevDot count={crit} label="CRIT" color="#dc2626" />
          <SevDot count={high} label="HIGH" color="#ea580c" />
          <SevDot count={med} label="MED" color="#ca8a04" />
          <SevDot count={findings.filter((f: any) => f.severity === "info").length} label="INFO" color="#333" />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: 10 }}>
        <IntelTile value={findings.length} label="Findings" color="#00b4d8" />
        <IntelTile value={totalFaces} label="Face Hits" color="#a855f7" />
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <IntelTile value={discovered.length} label="Profiles" color="#00b4d8" />
        <IntelTile value={conf > 0 ? `${(conf * 100).toFixed(0)}%` : "--"} label="ID Confidence" color={conf > 0.7 ? "#16a34a" : "#ca8a04"} />
      </View>

      {scenes.length > 0 && (() => {
        const a = scenes[0].raw_data?.analysis;
        if (!a) return null;
        const location = a.location?.estimated_region;
        const context = a.context?.event_type;
        const people = a.people?.count;
        if (!location && !context) return null;
        return (
          <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
            <Text style={{ color: "#ca8a04", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>SCENE INTEL</Text>
            <View style={{ gap: 8 }}>
              {location && <IntelLine icon="pin" text={location} color="#ca8a04" />}
              {context && <IntelLine icon="event" text={context} />}
              {people > 0 && <IntelLine icon="people" text={`${people} person${people > 1 ? "s" : ""} detected`} />}
              {a.organizations?.logos?.length > 0 && <IntelLine icon="org" text={a.organizations.logos.join(", ")} />}
            </View>
          </View>
        );
      })()}

      {ekf && <EkfBars summary={ekf} />}

      {!dossierLoading && dossier?.digitalFootprint?.totalAccounts > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>DIGITAL FOOTPRINT</Text>
            <Text style={{ color: "#333", fontSize: 10 }}>{dossier.digitalFootprint.totalAccounts} accounts</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(dossier.digitalFootprint.byCategory || {}).map(([cat, accounts]: [string, any]) => (
              accounts.length > 0 ? (
                <View key={cat} style={{ backgroundColor: "#111", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                  <Text style={{ color: "#888", fontSize: 10, fontWeight: "600" }}>{cat} ({accounts.length})</Text>
                </View>
              ) : null
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

// =============================================
// IDENTITY
// =============================================
function IdentityScreen({ candidates, dossier }: any) {
  if (candidates.length === 0 && !dossier?.subjectOverview) return <Empty text="No identity data yet" />;

  return (
    <View style={{ gap: 14 }}>
      {candidates.map((c: any, i: number) => {
        const n = clean(c.name);
        if (!n) return null;
        return (
          <View key={i} style={{ backgroundColor: "#080808", borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: "#111" }}>
            <View style={{ height: 4, backgroundColor: "#111" }}>
              <View style={{ height: 4, width: `${c.confidence * 100}%`, backgroundColor: c.confidence > 0.7 ? "#16a34a" : c.confidence > 0.4 ? "#ca8a04" : "#dc2626" }} />
            </View>
            <View style={{ padding: 16 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ color: "#f5f5f5", fontSize: 16, fontWeight: "800" }}>{n}</Text>
                <View style={{ backgroundColor: (c.confidence > 0.7 ? "#16a34a" : "#ca8a04") + "18", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Text style={{ color: c.confidence > 0.7 ? "#16a34a" : "#ca8a04", fontSize: 13, fontWeight: "900" }}>
                    {(c.confidence * 100).toFixed(0)}%
                  </Text>
                </View>
              </View>
              <Text style={{ color: "#333", fontSize: 10, marginTop: 6 }}>
                {c.sourceCount} source{c.sourceCount !== 1 ? "s" : ""} // {(c.platforms || []).filter(isLatin).join(", ")}
              </Text>
            </View>
          </View>
        );
      })}

      {dossier?.subjectOverview && (() => {
        const s = dossier.subjectOverview;
        const items: [string, string][] = [];
        if (s.names?.length) items.push(["Names", s.names.filter(isLatin).join(", ")]);
        if (s.usernames?.length) items.push(["Usernames", s.usernames.slice(0, 6).join(", ")]);
        if (s.emails?.length) items.push(["Emails", s.emails.join(", ")]);
        if (s.phones?.length) items.push(["Phones", s.phones.join(", ")]);
        if (s.locations?.length) items.push(["Locations", s.locations.map((l: any) => l.text).filter(Boolean).filter(isLatin).join("; ")]);
        const filtered = items.filter(([, v]) => v);
        if (!filtered.length) return null;
        return (
          <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
            <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 12 }}>KNOWN IDENTIFIERS</Text>
            {filtered.map(([k, v], i) => (
              <View key={i} style={{ flexDirection: "row", marginBottom: 8, gap: 12 }}>
                <Text style={{ color: "#333", fontSize: 10, fontWeight: "700", width: 70 }}>{k}</Text>
                <Text style={{ color: "#999", fontSize: 10, flex: 1 }}>{v}</Text>
              </View>
            ))}
          </View>
        );
      })()}
    </View>
  );
}

// =============================================
// FACES
// =============================================
function FacesScreen({ verified, discovered, profileId }: any) {
  const hasAny = verified.length > 0 || discovered.length > 0;
  if (!hasAny) return <Empty text="No face matches yet" />;

  const allVerified = (verified[0]?.raw_data?.verifiedMatches || []).filter((m: any) => isLatin(m.title || ""));

  return (
    <View style={{ gap: 14 }}>
      {allVerified.length > 0 && (
        <>
          <Text style={{ color: "#dc2626", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>VERIFIED MATCHES ({allVerified.length})</Text>
          {allVerified.slice(0, 15).map((m: any, j: number) => (
            <Pressable key={j} onPress={() => m.sourceUrl && Linking.openURL(m.sourceUrl)}>
              <View style={{ backgroundColor: "#080808", borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: "#111" }}>
                <View style={{ height: 3, backgroundColor: "#111" }}>
                  <View style={{ height: 3, width: `${m.similarity * 100}%`, backgroundColor: m.similarity > 0.7 ? "#dc2626" : "#ca8a04" }} />
                </View>
                <View style={{ padding: 14, flexDirection: "row", alignItems: "center" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#ccc", fontSize: 12, fontWeight: "600" }} numberOfLines={1}>{m.title}</Text>
                    <Text style={{ color: "#222", fontSize: 9, marginTop: 3 }} numberOfLines={1}>{m.engine}</Text>
                  </View>
                  <View style={{ backgroundColor: (m.similarity > 0.7 ? "#dc2626" : "#ca8a04") + "18", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text style={{ color: m.similarity > 0.7 ? "#dc2626" : "#ca8a04", fontSize: 12, fontWeight: "900" }}>{(m.similarity * 100).toFixed(0)}%</Text>
                  </View>
                </View>
              </View>
            </Pressable>
          ))}
        </>
      )}

      {discovered.length > 0 && (
        <>
          <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginTop: 4 }}>DISCOVERED PROFILES ({discovered.length})</Text>
          {discovered.map((f: any, i: number) => (
            <Pressable key={i} onPress={() => f.source_url && Linking.openURL(f.source_url)}>
              <View style={{ backgroundColor: "#080808", borderRadius: 12, padding: 14, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "#111" }}>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "#00b4d810", justifyContent: "center", alignItems: "center", marginRight: 12 }}>
                  <Text style={{ color: "#00b4d8", fontSize: 12, fontWeight: "800" }}>{(f.raw_data?.platform || "?")[0].toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#ccc", fontSize: 12, fontWeight: "700" }}>@{f.raw_data?.username}</Text>
                  <Text style={{ color: "#333", fontSize: 10, marginTop: 2 }}>{f.raw_data?.platform}</Text>
                </View>
                <Text style={{ color: "#555", fontSize: 11, fontWeight: "700" }}>{((f.raw_data?.similarity || 0) * 100).toFixed(0)}%</Text>
              </View>
            </Pressable>
          ))}
        </>
      )}
    </View>
  );
}

// =============================================
// GEOINT — geospatial intelligence
// =============================================
function GeointScreen({ locations, findings }: { locations: any[], findings: any[] }) {
  const forensicFindings = (findings || []).filter((f: any) => f.module === "photo-forensics");
  if (!locations.length && !forensicFindings.length) return <Empty text="No geospatial data collected" />;

  const TYPE_COLORS: Record<string, string> = {
    exact_gps: "#dc2626",
    iptc_location: "#ea580c",
    profile_declared: "#ca8a04",
    geocoded_address: "#ca8a04",
    citizenship: "#00b4d8",
    education: "#a855f7",
    employer: "#16a34a",
    scene_estimated: "#555",
    ip_geolocation: "#0ea5e9",
    news_mention: "#6366f1",
    whois_registrant: "#8b5cf6",
    timezone_inferred: "#333",
    visual_heuristic: "#f59e0b",
    flight_destination: "#0284c7",
  };

  const TYPE_LABELS: Record<string, string> = {
    exact_gps: "EXACT GPS",
    iptc_location: "IPTC",
    profile_declared: "PROFILE",
    citizenship: "CITIZENSHIP",
    education: "EDUCATION",
    employer: "EMPLOYER",
    scene_estimated: "SCENE EST.",
    ip_geolocation: "IP GEO",
    news_mention: "NEWS",
    whois_registrant: "WHOIS",
    timezone_inferred: "TIMEZONE",
    visual_heuristic: "VISUAL",
    flight_destination: "FLIGHT",
  };

  // Sort by confidence
  const sorted = [...locations].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  // Group by type
  const byType: Record<string, number> = {};
  for (const l of sorted) {
    byType[l.location_type || "unknown"] = (byType[l.location_type || "unknown"] || 0) + 1;
  }

  const exact = sorted.filter(l => l.location_type === "exact_gps");
  const highConf = sorted.filter(l => (l.confidence || 0) >= 0.7 && l.location_type !== "exact_gps");

  return (
    <View style={{ gap: 14 }}>
      {/* Summary */}
      <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <Text style={{ color: "#16a34a", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>GEOSPATIAL INTELLIGENCE</Text>
          <Text style={{ color: "#555", fontSize: 10 }}>{locations.length} signals</Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {Object.entries(byType).map(([type, count]) => (
            <View key={type} style={{ backgroundColor: (TYPE_COLORS[type] || "#333") + "15", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: (TYPE_COLORS[type] || "#333") + "20" }}>
              <Text style={{ color: TYPE_COLORS[type] || "#555", fontSize: 9, fontWeight: "700" }}>{TYPE_LABELS[type] || type} ({count})</Text>
            </View>
          ))}
        </View>
      </View>

      {/* World Map Visualization */}
      {(() => {
        const mappable = sorted.filter(l => l.latitude && l.longitude);
        if (mappable.length === 0) return null;

        const MAP_W = SW - 64;
        const MAP_H = MAP_W * 0.5;
        const [selectedPin, setSelectedPin] = useState<number | null>(null);

        // Mercator projection
        const toX = (lon: number) => ((lon + 180) / 360) * MAP_W;
        const toY = (lat: number) => {
          const latRad = (lat * Math.PI) / 180;
          const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
          return (MAP_H / 2) - (MAP_W * mercN) / (2 * Math.PI);
        };

        // Continent outlines (simplified lat/lon polyline segments for dark bg)
        const GRID_LATS = [-60, -30, 0, 30, 60];
        const GRID_LONS = [-120, -60, 0, 60, 120];

        return (
          <View style={{ backgroundColor: "#050508", borderRadius: 14, padding: 12, borderWidth: 1, borderColor: "#111" }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <Text style={{ color: "#16a34a", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>LOCATION MAP</Text>
              <Text style={{ color: "#333", fontSize: 9 }}>{mappable.length} plotted</Text>
            </View>
            <View style={{ width: MAP_W, height: MAP_H, backgroundColor: "#0a0a10", borderRadius: 8, overflow: "hidden", borderWidth: 1, borderColor: "#151520" }}>
              {/* Grid lines */}
              {GRID_LATS.map(lat => (
                <View key={`lat${lat}`} style={{ position: "absolute", top: toY(lat), left: 0, width: MAP_W, height: 1, backgroundColor: "#111118" }} />
              ))}
              {GRID_LONS.map(lon => (
                <View key={`lon${lon}`} style={{ position: "absolute", top: 0, left: toX(lon), width: 1, height: MAP_H, backgroundColor: "#111118" }} />
              ))}
              {/* Equator */}
              <View style={{ position: "absolute", top: toY(0), left: 0, width: MAP_W, height: 1, backgroundColor: "#1a1a25" }} />
              {/* Prime meridian */}
              <View style={{ position: "absolute", top: 0, left: toX(0), width: 1, height: MAP_H, backgroundColor: "#1a1a25" }} />

              {/* Location dots */}
              {mappable.map((l, i) => {
                const x = toX(l.longitude);
                const y = toY(l.latitude);
                if (x < 0 || x > MAP_W || y < 0 || y > MAP_H) return null;
                const color = TYPE_COLORS[l.location_type] || "#555";
                const size = l.confidence >= 0.8 ? 8 : l.confidence >= 0.5 ? 6 : 4;
                const isSelected = selectedPin === i;
                return (
                  <Pressable
                    key={i}
                    onPress={() => setSelectedPin(isSelected ? null : i)}
                    style={{
                      position: "absolute",
                      left: x - size / 2 - 4,
                      top: y - size / 2 - 4,
                      padding: 4,
                      zIndex: isSelected ? 100 : l.confidence >= 0.8 ? 10 : 1,
                    }}
                  >
                    <View style={{
                      width: size, height: size, borderRadius: size / 2,
                      backgroundColor: color,
                      borderWidth: isSelected ? 2 : 0,
                      borderColor: "#fff",
                      ...(isSelected ? { width: size + 4, height: size + 4, borderRadius: (size + 4) / 2 } : {}),
                    }} />
                  </Pressable>
                );
              })}

              {/* Selected pin tooltip */}
              {selectedPin !== null && mappable[selectedPin] && (() => {
                const l = mappable[selectedPin];
                const x = Math.min(Math.max(toX(l.longitude), 60), MAP_W - 60);
                const y = toY(l.latitude);
                const above = y > MAP_H / 2;
                return (
                  <View style={{
                    position: "absolute",
                    left: x - 55,
                    top: above ? y - 42 : y + 14,
                    width: 110,
                    backgroundColor: "#111118",
                    borderRadius: 6,
                    padding: 6,
                    borderWidth: 1,
                    borderColor: TYPE_COLORS[l.location_type] || "#333",
                    zIndex: 200,
                  }}>
                    <Text style={{ color: "#ccc", fontSize: 8, fontWeight: "700" }} numberOfLines={2}>{l.location_text}</Text>
                    <Text style={{ color: "#555", fontSize: 7, marginTop: 2 }}>{TYPE_LABELS[l.location_type] || l.location_type} | {((l.confidence || 0) * 100).toFixed(0)}%</Text>
                  </View>
                );
              })()}
            </View>

            {/* Map legend */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              {Object.entries(byType).filter(([t]) => sorted.some(l => l.location_type === t && l.latitude)).map(([type]) => (
                <View key={type} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: TYPE_COLORS[type] || "#333" }} />
                  <Text style={{ color: "#444", fontSize: 7 }}>{TYPE_LABELS[type] || type}</Text>
                </View>
              ))}
            </View>
          </View>
        );
      })()}

      {/* Exact GPS — critical */}
      {exact.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#dc262630" }}>
          <Text style={{ color: "#dc2626", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>EXACT GPS COORDINATES</Text>
          {exact.map((l, i) => (
            <View key={i} style={{ marginBottom: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: "#dc262640" }}>
              <Text style={{ color: "#ccc", fontSize: 12, fontWeight: "600" }}>{l.latitude?.toFixed(6)}, {l.longitude?.toFixed(6)}</Text>
              <Text style={{ color: "#444", fontSize: 10, marginTop: 2 }}>{l.location_text} | Source: {l.source_module}</Text>
            </View>
          ))}
        </View>
      )}

      {/* High confidence locations */}
      {highConf.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#ca8a04", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>HIGH CONFIDENCE LOCATIONS</Text>
          {highConf.slice(0, 15).map((l, i) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: (TYPE_COLORS[l.location_type] || "#333") + "18", justifyContent: "center", alignItems: "center" }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: TYPE_COLORS[l.location_type] || "#333" }} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#ccc", fontSize: 11, fontWeight: "600" }} numberOfLines={1}>{l.location_text}</Text>
                <Text style={{ color: "#333", fontSize: 9, marginTop: 2 }}>
                  {TYPE_LABELS[l.location_type] || l.location_type} | {((l.confidence || 0) * 100).toFixed(0)}% | {l.source_module}
                  {l.latitude ? ` | ${l.latitude.toFixed(4)}, ${l.longitude.toFixed(4)}` : ""}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* All locations — compact list */}
      {sorted.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#555", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>ALL LOCATION SIGNALS ({sorted.length})</Text>
          {sorted.slice(0, 30).map((l, i) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: TYPE_COLORS[l.location_type] || "#333" }} />
              <Text style={{ color: "#888", fontSize: 10, flex: 1 }} numberOfLines={1}>{l.location_text}</Text>
              <Text style={{ color: "#333", fontSize: 9 }}>{((l.confidence || 0) * 100).toFixed(0)}%</Text>
            </View>
          ))}
        </View>
      )}

      {/* Movement Intelligence */}
      {(() => {
        const movementFindings = (findings || []).filter((f: any) => f.module === "movement-intel" && f.severity !== "info");
        if (!movementFindings.length) return null;
        return (
          <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
            <Text style={{ color: "#0284c7", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>MOVEMENT INTELLIGENCE</Text>
            {movementFindings.map((f: any, i: number) => {
              const isFlightHigh = f.raw_data?.type === "flight_tracking" && f.raw_data?.flightCount > 0;
              const isVessel = f.raw_data?.type === "vessel_tracking";
              const icon = isFlightHigh ? "+" : isVessel ? "~" : "-";
              const sevColor = f.severity === "high" ? "#0284c7" : f.severity === "medium" ? "#ca8a04" : "#555";
              return (
                <View key={i} style={{ marginBottom: 10, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: sevColor + "40" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <View style={{ backgroundColor: sevColor + "20", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                      <Text style={{ color: sevColor, fontSize: 8, fontWeight: "800" }}>{isFlightHigh ? "FLIGHT" : isVessel ? "VESSEL" : f.raw_data?.type === "wigle_scan" ? "WI-FI" : "MOVE"}</Text>
                    </View>
                    <Text style={{ color: "#ccc", fontSize: 11, fontWeight: "600", flex: 1 }} numberOfLines={2}>{f.title?.replace("Flight tracking: ", "").replace("Vessel tracking: ", "").replace("Wi-Fi scan: ", "")}</Text>
                  </View>
                  {f.description && <Text style={{ color: "#555", fontSize: 9, marginTop: 2 }} numberOfLines={4}>{f.description}</Text>}
                  {isFlightHigh && f.raw_data?.airportsVisited?.length > 0 && (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                      {f.raw_data.airportsVisited.slice(0, 10).map((ap: string, j: number) => (
                        <View key={j} style={{ backgroundColor: "#0284c720", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                          <Text style={{ color: "#0284c7", fontSize: 8, fontWeight: "700" }}>{ap}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        );
      })()}

      {/* Photo Forensics */}
      {forensicFindings.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#f59e0b", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>PHOTO FORENSICS</Text>
          {forensicFindings.map((f: any, i: number) => {
            const sev = f.severity;
            const sevColor = sev === "critical" ? "#dc2626" : sev === "high" ? "#ea580c" : sev === "medium" ? "#ca8a04" : "#555";
            return (
              <View key={i} style={{ marginBottom: 10, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: sevColor + "40" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <View style={{ backgroundColor: sevColor + "20", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                    <Text style={{ color: sevColor, fontSize: 8, fontWeight: "800" }}>{(sev || "info").toUpperCase()}</Text>
                  </View>
                  <Text style={{ color: "#ccc", fontSize: 11, fontWeight: "600", flex: 1 }} numberOfLines={2}>{f.title?.replace("Photo forensics: ", "").replace("Shadow analysis: ", "").replace("Camera fingerprint: ", "")}</Text>
                </View>
                {f.description && <Text style={{ color: "#555", fontSize: 9, marginTop: 2 }} numberOfLines={4}>{f.description}</Text>}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// =============================================
// SOURCES — source reliability matrix
// =============================================
function SourcesScreen({ assessment, findings }: any) {
  const matrix = assessment?.sourceMatrix || [];

  if (!matrix.length && !findings.length) return <Empty text="No source data" />;

  return (
    <View style={{ gap: 14 }}>
      {/* Grade distribution */}
      {assessment?.metadata?.gradedFindings && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#555", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 14 }}>SOURCE RELIABILITY DISTRIBUTION</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {["A", "B", "C", "D", "E", "F"].map(g => {
              const count = assessment.metadata.gradedFindings[g] || 0;
              const total = assessment.metadata.totalFindings || 1;
              const pct = (count / total) * 100;
              const labels: Record<string, string> = { A: "Reliable", B: "Usually Reliable", C: "Fairly Reliable", D: "Not Reliable", E: "Unreliable", F: "Unknown" };
              return (
                <View key={g} style={{ flex: 1, alignItems: "center", gap: 6 }}>
                  <GradeBadge grade={g} />
                  <View style={{ width: "100%", height: 60, backgroundColor: "#0a0a0a", borderRadius: 4, justifyContent: "flex-end", overflow: "hidden" }}>
                    <View style={{ width: "100%", height: `${Math.max(2, pct)}%`, backgroundColor: GRADE_COLORS[g] + "40", borderRadius: 2 }} />
                  </View>
                  <Text style={{ color: "#555", fontSize: 12, fontWeight: "800" }}>{count}</Text>
                  <Text style={{ color: "#222", fontSize: 7, textAlign: "center" }}>{labels[g]}</Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* Module breakdown */}
      {matrix.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#555", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 12 }}>MODULE SOURCE MATRIX</Text>
          {matrix.slice(0, 25).map((m: any, i: number) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <GradeBadge grade={m.grade} />
              <Text style={{ color: "#888", fontSize: 10, flex: 1, fontWeight: "500" }}>{m.module}</Text>
              <Text style={{ color: "#444", fontSize: 10, fontWeight: "700" }}>{m.count}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// =============================================
// SHARED COMPONENTS
// =============================================

const GRADE_COLORS: Record<string, string> = {
  A: "#16a34a", B: "#22c55e", C: "#ca8a04", D: "#ea580c", E: "#dc2626", F: "#555",
};

function GradeBadge({ grade }: { grade: string }) {
  const c = GRADE_COLORS[grade] || "#555";
  return (
    <View style={{ width: 20, height: 20, borderRadius: 4, backgroundColor: c + "18", justifyContent: "center", alignItems: "center" }}>
      <Text style={{ color: c, fontSize: 10, fontWeight: "900" }}>{grade}</Text>
    </View>
  );
}

function ConfBadge({ level, small }: { level: string; small?: boolean }) {
  const c = level === "HIGH" ? "#16a34a" : level === "MODERATE" ? "#ca8a04" : "#dc2626";
  return (
    <View style={{ backgroundColor: c + "15", borderRadius: 6, paddingHorizontal: small ? 6 : 8, paddingVertical: small ? 2 : 3 }}>
      <Text style={{ color: c, fontSize: small ? 8 : 9, fontWeight: "700" }}>{level}</Text>
    </View>
  );
}

function ExposureBadge({ score }: { score: any }) {
  const c = score.level === "CRITICAL" ? "#dc2626" : score.level === "HIGH" ? "#ea580c" : score.level === "MODERATE" ? "#ca8a04" : "#16a34a";
  return (
    <View style={{ backgroundColor: c + "15", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ color: c, fontSize: 9, fontWeight: "700" }}>{score.overall}/100</Text>
    </View>
  );
}

function ThreatGauge({ crit, high, med, total }: { crit: number; high: number; med: number; total: number }) {
  const color = crit > 0 ? "#dc2626" : high > 0 ? "#ea580c" : "#16a34a";
  const label = crit > 0 ? "HIGH" : high > 0 ? "MED" : "LOW";
  const pct = Math.min(100, Math.max(5, crit * 25 + high * 15 + total * 2));
  return (
    <View style={{ width: 48, height: 48, justifyContent: "center", alignItems: "center" }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, borderWidth: 3, borderColor: "#111", justifyContent: "center", alignItems: "center", position: "absolute" }} />
      <View style={{ width: 48, height: 48, borderRadius: 24, borderWidth: 3, borderColor: color, borderTopColor: pct > 75 ? color : "#111", borderRightColor: pct > 50 ? color : "#111", borderBottomColor: pct > 25 ? color : "#111", position: "absolute", transform: [{ rotate: "-90deg" }] }} />
      <Text style={{ color, fontSize: 9, fontWeight: "900" }}>{label}</Text>
    </View>
  );
}

function HudBadge({ text, color }: { text: string; color: string }) {
  return (
    <View style={{ backgroundColor: color + "15", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ color, fontSize: 9, fontWeight: "700" }}>{text}</Text>
    </View>
  );
}

function IntelTile({ value, label, color }: { value: any; label: string; color: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: "#080808", borderRadius: 14, padding: 16, alignItems: "center", borderWidth: 1, borderColor: "#111" }}>
      <Text style={{ color, fontSize: 26, fontWeight: "900" }}>{value}</Text>
      <Text style={{ color: "#2a2a2a", fontSize: 9, fontWeight: "600", letterSpacing: 1, marginTop: 4 }}>{label}</Text>
    </View>
  );
}

const ICON_MAP: Record<string, string> = { pin: "\u25C9", event: "\u25B6", people: "\u25CF", org: "\u25A0", env: "\u25CB", climate: "\u223F", conf: "\u2713", indicator: "\u2022" };

function IntelLine({ icon, text, color, big }: { icon: string; text: string; color?: string; big?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ color: color || "#555", fontSize: 10 }}>{ICON_MAP[icon] || "\u2022"}</Text>
      <Text style={{ color: color || "#999", fontSize: big ? 14 : 11, fontWeight: big ? "700" : "400" }}>{text}</Text>
    </View>
  );
}

function SevDot({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <View style={{ alignItems: "center", gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: count > 0 ? color : "#1a1a1a" }} />
        <Text style={{ color: count > 0 ? color : "#222", fontSize: 14, fontWeight: "800" }}>{count}</Text>
      </View>
      <Text style={{ color: "#2a2a2a", fontSize: 8, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

function AnimatedBar({ width, color }: { width: number; color: string }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(anim, { toValue: width, duration: 800, useNativeDriver: false }).start(); }, [width]);
  return <Animated.View style={{ height: 8, borderRadius: 4, backgroundColor: color, width: anim.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] }) }} />;
}

function EkfBars({ summary }: { summary: EkfSummary }) {
  const ci = summary.confidence_intervals || {};
  const attrs = [
    { key: "identity_certainty", label: "Identity" },
    { key: "name_confidence", label: "Name" },
    { key: "location_confidence", label: "Location" },
  ];
  return (
    <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
        <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>INTELLIGENCE FUSION</Text>
        <Text style={{ color: "#222", fontSize: 9 }}>{summary.observations} obs</Text>
      </View>
      {attrs.map(({ key, label }) => {
        const val = ci[key]?.value ?? 0;
        const pct = Math.min(100, Math.max(0, val * 100));
        const barColor = pct > 70 ? "#16a34a" : pct > 40 ? "#ca8a04" : "#dc2626";
        return (
          <View key={key} style={{ marginBottom: 10 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
              <Text style={{ color: "#444", fontSize: 10 }}>{label}</Text>
              <Text style={{ color: "#ccc", fontSize: 10, fontWeight: "800" }}>{pct.toFixed(0)}%</Text>
            </View>
            <View style={{ height: 4, backgroundColor: "#111", borderRadius: 2, overflow: "hidden" }}>
              <View style={{ height: 4, width: `${pct}%`, backgroundColor: barColor, borderRadius: 2 }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 60 }}>
      <View style={{ width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: "#1a1a1a", justifyContent: "center", alignItems: "center", marginBottom: 16 }}>
        <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: "#1a1a1a" }} />
      </View>
      <Text style={{ color: "#2a2a2a", fontSize: 12 }}>{text}</Text>
    </View>
  );
}
