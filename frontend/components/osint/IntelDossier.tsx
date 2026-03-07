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

type Tab = "overview" | "identity" | "faces" | "scene" | "threats";

export function IntelDossier({ profile, findings, onBack }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [dossier, setDossier] = useState<any>(null);
  const [dossierLoading, setDossierLoading] = useState(true);
  const [ekf, setEkf] = useState<EkfSummary | null>(null);

  const imgUrl = `${getBridgeUrl()}/osint/images/${profile.id}/thumbnail`;

  // Parse
  const idCand = findings.find(f => f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates");
  const top = idCand?.raw_data?.candidates?.[0];
  const name = top?.name || profile.display_name || "Unknown";
  const conf = top?.confidence || 0;

  const faceGuess = findings.find(f => f.module === "face-search" && f.raw_data?.type === "identity_candidates");
  const verified = findings.filter(f => f.raw_data?.type === "verified_face_matches");
  const discovered = findings.filter(f => f.raw_data?.type === "discovered_profile");
  const unverified = findings.filter(f => f.raw_data?.type === "unverified_matches");
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

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "identity", label: "Identity", badge: idCand?.raw_data?.candidates?.length || 0 },
    { key: "faces", label: "Faces", badge: totalFaces },
    { key: "scene", label: "Scene", badge: scenes.length },
    { key: "threats", label: "Threats", badge: crit + high },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {/* ═══ HUD HEADER ═══ */}
      <View style={{ borderBottomWidth: 1, borderBottomColor: "#111" }}>
        {/* Back + classification */}
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
          <Pressable onPress={onBack} hitSlop={16} style={{ marginRight: 12, padding: 4 }}>
            <Text style={{ color: "#444", fontSize: 18 }}>{"<"}</Text>
          </Pressable>
          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={{ color: "#dc262644", fontSize: 8, fontWeight: "800", letterSpacing: 4 }}>CONFIDENTIAL</Text>
          </View>
          <View style={{ width: 30 }} />
        </View>

        {/* Subject HUD — photo, gauge, key stats */}
        <View style={{ flexDirection: "row", padding: 16, paddingTop: 8, gap: 16, alignItems: "center" }}>
          {/* Photo with threat ring glow */}
          <View style={{ position: "relative" }}>
            <View style={{ position: "absolute", top: -6, left: -6, right: -6, bottom: -6, borderRadius: 40, backgroundColor: ringColor, opacity: 0.07 }} />
            <View style={{ position: "absolute", top: -3, left: -3, right: -3, bottom: -3, borderRadius: 37, backgroundColor: ringColor, opacity: 0.05 }} />
            <View style={{ width: 64, height: 64, borderRadius: 32, borderWidth: 2.5, borderColor: ringColor, overflow: "hidden" }}>
              <Image source={{ uri: imgUrl, headers: getAuthHeaders() }} style={{ width: 59, height: 59, borderRadius: 29 }} />
            </View>
          </View>

          {/* Name + quick stats */}
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#f5f5f5", fontSize: 17, fontWeight: "800" }} numberOfLines={1}>{name}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
              {conf > 0 && <HudBadge text={`${(conf * 100).toFixed(0)}%`} color={conf > 0.7 ? "#16a34a" : "#ca8a04"} />}
              <HudBadge text={`${findings.length} findings`} color="#555" />
              {totalFaces > 0 && <HudBadge text={`${totalFaces} faces`} color="#a855f7" />}
            </View>
          </View>

          {/* Circular threat gauge */}
          <ThreatGauge crit={crit} high={high} med={med} total={findings.length} />
        </View>
      </View>

      {/* ═══ TAB BAR ═══ */}
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

      {/* ═══ TAB CONTENT ═══ */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 50 }} showsVerticalScrollIndicator={false} key={tab}>
        {tab === "overview" && <OverviewScreen findings={findings} crit={crit} high={high} med={med} totalFaces={totalFaces} scenes={scenes} ekf={ekf} discovered={discovered} dossier={dossier} dossierLoading={dossierLoading} conf={conf} />}
        {tab === "identity" && <IdentityScreen candidates={idCand?.raw_data?.candidates || []} guesses={(faceGuess?.raw_data?.identityGuesses || []).filter(isLatin)} dossier={dossier} />}
        {tab === "faces" && <FacesScreen verified={verified} discovered={discovered} unverified={unverified} profileId={profile.id} />}
        {tab === "scene" && <SceneScreen scenes={scenes} />}
        {tab === "threats" && <ThreatsScreen findings={findings} crit={crit} high={high} med={med} dossier={dossier} pivots={pivots} />}
      </ScrollView>
    </View>
  );
}

// ═══════════════════════════════════════════
// OVERVIEW — visual dashboard
// ═══════════════════════════════════════════
function OverviewScreen({ findings, crit, high, med, totalFaces, scenes, ekf, discovered, dossier, dossierLoading, conf }: any) {
  const threatColor = crit > 0 ? "#dc2626" : high > 0 ? "#ea580c" : "#16a34a";
  const exposurePct = Math.min(100, Math.max(5, crit * 25 + high * 15 + findings.length * 2));

  return (
    <View style={{ gap: 14 }}>
      {/* Exposure bar — visual gauge across full width */}
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
        {/* Severity breakdown dots */}
        <View style={{ flexDirection: "row", gap: 16, marginTop: 12, justifyContent: "center" }}>
          <SevDot count={crit} label="CRIT" color="#dc2626" />
          <SevDot count={high} label="HIGH" color="#ea580c" />
          <SevDot count={med} label="MED" color="#ca8a04" />
          <SevDot count={findings.filter((f: any) => f.severity === "info").length} label="INFO" color="#333" />
        </View>
      </View>

      {/* Quick intel tiles — 2x2 */}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <IntelTile icon="eye" value={findings.length} label="Findings" color="#00b4d8" />
        <IntelTile icon="face" value={totalFaces} label="Face Hits" color="#a855f7" />
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <IntelTile icon="link" value={discovered.length} label="Profiles" color="#00b4d8" />
        <IntelTile icon="target" value={conf > 0 ? `${(conf * 100).toFixed(0)}%` : "--"} label="ID Confidence" color={conf > 0.7 ? "#16a34a" : "#ca8a04"} />
      </View>

      {/* Scene snapshot — if available, show key location/context as visual block */}
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

      {/* EKF confidence bars — compact */}
      {ekf && <EkfBars summary={ekf} />}

      {/* Digital footprint summary */}
      {!dossierLoading && dossier?.digitalFootprint?.totalAccounts > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>DIGITAL FOOTPRINT</Text>
            <Text style={{ color: "#333", fontSize: 10 }}>{dossier.digitalFootprint.totalAccounts} accounts</Text>
          </View>
          {/* Category pills */}
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

// ═══════════════════════════════════════════
// IDENTITY
// ═══════════════════════════════════════════
function IdentityScreen({ candidates, guesses, dossier }: any) {
  if (candidates.length === 0 && guesses.length === 0 && !dossier?.subjectOverview) {
    return <Empty text="No identity data yet" />;
  }

  return (
    <View style={{ gap: 14 }}>
      {/* Candidate cards with confidence bars */}
      {candidates.map((c: any, i: number) => {
        const n = clean(c.name);
        if (!n) return null;
        return (
          <View key={i} style={{ backgroundColor: "#080808", borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: "#111" }}>
            {/* Confidence bar fills the top */}
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

      {guesses.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#ca8a04", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>SEARCH ENGINE MATCHES</Text>
          {guesses.map((g: string, i: number) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: "#111", justifyContent: "center", alignItems: "center" }}>
                <Text style={{ color: "#555", fontSize: 9, fontWeight: "800" }}>{i + 1}</Text>
              </View>
              <Text style={{ color: "#aaa", fontSize: 12 }}>{g}</Text>
            </View>
          ))}
        </View>
      )}

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

// ═══════════════════════════════════════════
// FACES — thumbnail grid + match list
// ═══════════════════════════════════════════
function FacesScreen({ verified, discovered, unverified, profileId }: any) {
  const hasAny = verified.length > 0 || discovered.length > 0 || unverified.length > 0;
  if (!hasAny) return <Empty text="No face matches yet" />;

  const allVerified = (verified[0]?.raw_data?.verifiedMatches || []).filter((m: any) => isLatin(m.title || ""));

  return (
    <View style={{ gap: 14 }}>
      {/* Verified face match cards with similarity visual */}
      {allVerified.length > 0 && (
        <>
          <Text style={{ color: "#dc2626", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>
            VERIFIED MATCHES ({allVerified.length})
          </Text>
          {allVerified.slice(0, 15).map((m: any, j: number) => (
            <Pressable key={j} onPress={() => m.sourceUrl && Linking.openURL(m.sourceUrl)}>
              <View style={{ backgroundColor: "#080808", borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: "#111" }}>
                {/* Similarity bar */}
                <View style={{ height: 3, backgroundColor: "#111" }}>
                  <View style={{ height: 3, width: `${m.similarity * 100}%`, backgroundColor: m.similarity > 0.7 ? "#dc2626" : "#ca8a04" }} />
                </View>
                <View style={{ padding: 14, flexDirection: "row", alignItems: "center" }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: "#ccc", fontSize: 12, fontWeight: "600" }} numberOfLines={1}>{m.title}</Text>
                    <Text style={{ color: "#222", fontSize: 9, marginTop: 3 }} numberOfLines={1}>{m.engine}</Text>
                  </View>
                  <View style={{ backgroundColor: (m.similarity > 0.7 ? "#dc2626" : "#ca8a04") + "18", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text style={{ color: m.similarity > 0.7 ? "#dc2626" : "#ca8a04", fontSize: 12, fontWeight: "900" }}>
                      {(m.similarity * 100).toFixed(0)}%
                    </Text>
                  </View>
                </View>
              </View>
            </Pressable>
          ))}
        </>
      )}

      {/* Discovered profiles — platform icons */}
      {discovered.length > 0 && (
        <>
          <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginTop: 4 }}>
            DISCOVERED PROFILES ({discovered.length})
          </Text>
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

      {/* Unverified — compact link list */}
      {unverified.map((f: any, i: number) => {
        const urls = (f.raw_data?.sourceUrls || []).filter(isLatin);
        if (!urls.length) return null;
        return (
          <View key={i}>
            <Text style={{ color: "#333", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginTop: 4, marginBottom: 8 }}>
              UNVERIFIED ({urls.length})
            </Text>
            {urls.slice(0, 10).map((url: string, j: number) => (
              <Pressable key={j} onPress={() => Linking.openURL(url)}>
                <Text style={{ color: "#444", fontSize: 10, marginBottom: 6 }} numberOfLines={1}>{url}</Text>
              </Pressable>
            ))}
          </View>
        );
      })}
    </View>
  );
}

// ═══════════════════════════════════════════
// SCENE — visual intel blocks
// ═══════════════════════════════════════════
function SceneScreen({ scenes }: { scenes: OsintFinding[] }) {
  if (!scenes.length) return <Empty text="No scene analysis available" />;

  return (
    <View style={{ gap: 14 }}>
      {scenes.map((f, i) => {
        const a = f.raw_data?.analysis;
        if (!a) return (
          <View key={i} style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
            <Text style={{ color: "#888", fontSize: 11, lineHeight: 18 }}>{clean(f.description || "")}</Text>
          </View>
        );
        return (
          <View key={i} style={{ gap: 12 }}>
            {a.location && (
              <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
                <Text style={{ color: "#ca8a04", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>GEOLOCATION</Text>
                {a.location.estimated_region && <IntelLine icon="pin" text={a.location.estimated_region} color="#ca8a04" big />}
                <View style={{ gap: 6, marginTop: 8 }}>
                  {a.location.environment && <IntelLine icon="env" text={a.location.environment} />}
                  {a.location.climate_clues && <IntelLine icon="climate" text={a.location.climate_clues} />}
                  {a.location.confidence && <IntelLine icon="conf" text={`Confidence: ${a.location.confidence}`} />}
                  {(a.location.indicators || []).map((ind: string, j: number) => <IntelLine key={j} icon="indicator" text={ind} />)}
                </View>
              </View>
            )}

            {a.people?.count > 0 && (
              <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
                <Text style={{ color: "#a855f7", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>PEOPLE ({a.people.count})</Text>
                {(a.people.details || []).map((p: any, j: number) => (
                  <View key={j} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8, backgroundColor: "#0a0a0a", borderRadius: 10, padding: 12 }}>
                    <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "#a855f712", justifyContent: "center", alignItems: "center" }}>
                      <Text style={{ color: "#a855f7", fontSize: 14, fontWeight: "800" }}>{j + 1}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: "#ccc", fontSize: 11, fontWeight: "600" }}>{p.estimated_age_range || "?"}, {p.gender || "?"}</Text>
                      {p.clothing && <Text style={{ color: "#444", fontSize: 10, marginTop: 2 }}>{p.clothing}</Text>}
                      {p.distinguishing_features && <Text style={{ color: "#444", fontSize: 10, marginTop: 1 }}>{p.distinguishing_features}</Text>}
                    </View>
                  </View>
                ))}
              </View>
            )}

            {(a.organizations?.logos?.length > 0 || a.organizations?.affiliations?.length > 0) && (
              <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
                <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>ORGANIZATIONS</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {[...(a.organizations.logos || []), ...(a.organizations.affiliations || [])].filter(isLatin).map((o: string, j: number) => (
                    <View key={j} style={{ backgroundColor: "#00b4d80a", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: "#00b4d815" }}>
                      <Text style={{ color: "#888", fontSize: 10, fontWeight: "600" }}>{o}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {a.intelligence_notes && isLatin(a.intelligence_notes) && (
              <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
                <Text style={{ color: "#555", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 8 }}>ANALYST NOTES</Text>
                <Text style={{ color: "#999", fontSize: 11, lineHeight: 20 }}>{a.intelligence_notes}</Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ═══════════════════════════════════════════
// THREATS
// ═══════════════════════════════════════════
function ThreatsScreen({ findings, crit, high, med, dossier, pivots }: any) {
  const critF = findings.filter((f: any) => f.severity === "critical");
  const highF = findings.filter((f: any) => f.severity === "high");

  if (crit === 0 && high === 0 && med === 0) return <Empty text="No threats detected" />;

  return (
    <View style={{ gap: 14 }}>
      {/* Threat counters */}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <ThreatCounter value={crit} label="Critical" color="#dc2626" />
        <ThreatCounter value={high} label="High" color="#ea580c" />
        <ThreatCounter value={med} label="Medium" color="#ca8a04" />
      </View>

      {/* Critical findings */}
      {critF.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: "#dc2626", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>CRITICAL</Text>
          {critF.map((f: any, i: number) => <ThreatCard key={i} finding={f} color="#dc2626" />)}
        </View>
      )}

      {highF.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: "#ea580c", fontSize: 10, fontWeight: "800", letterSpacing: 2 }}>HIGH</Text>
          {highF.slice(0, 10).map((f: any, i: number) => <ThreatCard key={i} finding={f} color="#ea580c" />)}
        </View>
      )}

      {/* Exposure */}
      {dossier?.exposureAssessment && (dossier.exposureAssessment.breachCount > 0 || dossier.exposureAssessment.dataBrokerCount > 0) && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#ea580c", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>EXPOSURE</Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {dossier.exposureAssessment.breachCount > 0 && <IntelTile icon="breach" value={dossier.exposureAssessment.breachCount} label="Breaches" color="#dc2626" />}
            {dossier.exposureAssessment.dataBrokerCount > 0 && <IntelTile icon="broker" value={dossier.exposureAssessment.dataBrokerCount} label="Brokers" color="#ea580c" />}
          </View>
        </View>
      )}

      {/* Leads */}
      {pivots.length > 0 && (
        <View style={{ backgroundColor: "#080808", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#111" }}>
          <Text style={{ color: "#16a34a", fontSize: 10, fontWeight: "800", letterSpacing: 2, marginBottom: 10 }}>LEADS ({pivots.length})</Text>
          {pivots.slice(0, 6).filter((f: any) => isLatin(f.title || "")).map((f: any, i: number) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#16a34a" }} />
              <Text style={{ color: "#888", fontSize: 11, flex: 1 }}>{clean(f.title) || clean(f.raw_data?.pivotValue)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ═══════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════

function ThreatGauge({ crit, high, med, total }: { crit: number; high: number; med: number; total: number }) {
  const color = crit > 0 ? "#dc2626" : high > 0 ? "#ea580c" : "#16a34a";
  const label = crit > 0 ? "HIGH" : high > 0 ? "MED" : "LOW";
  const pct = Math.min(100, Math.max(5, crit * 25 + high * 15 + total * 2));

  // Circular gauge using border trick
  return (
    <View style={{ width: 48, height: 48, justifyContent: "center", alignItems: "center" }}>
      {/* Outer ring */}
      <View style={{ width: 48, height: 48, borderRadius: 24, borderWidth: 3, borderColor: "#111", justifyContent: "center", alignItems: "center", position: "absolute" }} />
      {/* Colored arc — simplified as a colored ring segment */}
      <View style={{
        width: 48, height: 48, borderRadius: 24,
        borderWidth: 3,
        borderColor: color,
        borderTopColor: pct > 75 ? color : "#111",
        borderRightColor: pct > 50 ? color : "#111",
        borderBottomColor: pct > 25 ? color : "#111",
        position: "absolute",
        transform: [{ rotate: "-90deg" }],
      }} />
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

function IntelTile({ icon, value, label, color }: { icon: string; value: any; label: string; color: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: "#080808", borderRadius: 14, padding: 16, alignItems: "center", borderWidth: 1, borderColor: "#111" }}>
      <Text style={{ color, fontSize: 26, fontWeight: "900" }}>{typeof value === "number" ? value : value}</Text>
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

function ThreatCounter({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: value > 0 ? color + "08" : "#080808", borderRadius: 14, padding: 16, alignItems: "center", borderWidth: 1, borderColor: value > 0 ? color + "20" : "#111" }}>
      <Text style={{ color: value > 0 ? color : "#222", fontSize: 28, fontWeight: "900" }}>{value}</Text>
      <Text style={{ color: "#333", fontSize: 9, fontWeight: "600", marginTop: 4 }}>{label}</Text>
    </View>
  );
}

function ThreatCard({ finding, color }: { finding: any; color: string }) {
  const title = clean(finding.title);
  if (!title) return null;
  return (
    <View style={{ backgroundColor: "#080808", borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "#111", borderLeftWidth: 3, borderLeftColor: color }}>
      <Text style={{ color: "#ccc", fontSize: 11, fontWeight: "600" }}>{title}</Text>
      {finding.description && isLatin(finding.description) && (
        <Text style={{ color: "#333", fontSize: 10, marginTop: 4 }} numberOfLines={2}>{finding.description}</Text>
      )}
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
