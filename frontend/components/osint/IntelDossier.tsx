import { View, Text, ScrollView, Pressable, Image, Linking, ActivityIndicator, LayoutAnimation, Platform, UIManager } from "react-native";
import { useState, useEffect, useCallback } from "react";
import { getBridgeUrl, getAuthHeaders, apiFetch, fetchOsintEkf, type OsintProfile, type OsintFinding, type EkfSummary } from "../../lib/bridge-api";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Filter non-Latin text (Russian from Yandex, etc.)
function isLatin(text: string): boolean {
  if (!text) return false;
  const latinChars = text.replace(/[\s\d\W]/g, "").split("").filter(c => /[a-zA-Z\u00C0-\u024F]/.test(c)).length;
  const totalChars = text.replace(/[\s\d\W]/g, "").length;
  return totalChars === 0 || latinChars / totalChars > 0.5;
}

function cleanText(text: string): string {
  if (!text) return "";
  return isLatin(text) ? text : "";
}

interface Props {
  profile: OsintProfile;
  findings: OsintFinding[];
  allFindings?: OsintFinding[];
  onBack: () => void;
}

type Tab = "overview" | "identity" | "digital" | "faces" | "scene" | "threats";

export function IntelDossier({ profile, findings, allFindings, onBack }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [dossierData, setDossierData] = useState<any>(null);
  const [dossierLoading, setDossierLoading] = useState(true);
  const [ekf, setEkf] = useState<EkfSummary | null>(null);

  const imageUrl = `${getBridgeUrl()}/osint/images/${profile.id}/thumbnail`;

  // Parse findings
  const idCandidates = findings.find(f => f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates");
  const topCandidate = idCandidates?.raw_data?.candidates?.[0];
  const subjectName = topCandidate?.name || profile.display_name || "Unknown Subject";
  const confidence = topCandidate?.confidence || 0;

  const faceGuesses = findings.find(f => f.module === "face-search" && f.raw_data?.type === "identity_candidates");
  const verified = findings.filter(f => f.raw_data?.type === "verified_face_matches");
  const discovered = findings.filter(f => f.raw_data?.type === "discovered_profile");
  const unverified = findings.filter(f => f.raw_data?.type === "unverified_matches");
  const scenes = findings.filter(f => f.raw_data?.type === "scene_analysis");
  const metadata = findings.filter(f => f.module === "exiftool-cli" || f.module === "exif-extract");
  const pivots = findings.filter(f => f.raw_data?.type === "pivot_recommendation");

  const crit = findings.filter(f => f.severity === "critical").length;
  const high = findings.filter(f => f.severity === "high").length;
  const med = findings.filter(f => f.severity === "medium").length;
  const ringColor = crit > 0 ? "#dc2626" : high > 0 ? "#ea580c" : "#16a34a";

  const totalFaces = (verified[0]?.raw_data?.verifiedMatches?.length || 0) + discovered.length + (unverified[0]?.raw_data?.sourceUrls?.length || 0);

  // Load enriched dossier
  const loadDossier = useCallback(async () => {
    setDossierLoading(true);
    try {
      const data = await apiFetch(`/osint/dossier/${profile.id}?days=30`);
      setDossierData(data.dossier);
    } catch {}
    setDossierLoading(false);
  }, [profile.id]);

  useEffect(() => { loadDossier(); }, [loadDossier]);
  useEffect(() => { fetchOsintEkf(profile.id).then(d => setEkf(d.summary)).catch(() => {}); }, [profile.id]);

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "identity", label: "Identity", badge: idCandidates?.raw_data?.candidates?.length || 0 },
    { key: "digital", label: "Digital" },
    { key: "faces", label: "Faces", badge: totalFaces },
    { key: "scene", label: "Scene", badge: scenes.length },
    { key: "threats", label: "Threats", badge: crit + high },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: "#080808" }}>
      {/* Top bar */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 12, borderBottomWidth: 1, borderBottomColor: "#141414" }}>
        <Pressable onPress={onBack} hitSlop={12} style={{ padding: 4 }}>
          <Text style={{ color: "#444", fontSize: 20, fontWeight: "300" }}>{"<"}</Text>
        </Pressable>
        <View style={{ width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: ringColor, overflow: "hidden" }}>
          <Image source={{ uri: imageUrl, headers: getAuthHeaders() }} style={{ width: 36, height: 36, borderRadius: 18 }} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: "#e5e5e5", fontSize: 15, fontWeight: "700" }} numberOfLines={1}>
            {subjectName}
          </Text>
          <Text style={{ color: "#2a2a2a", fontSize: 9, marginTop: 1 }}>
            {findings.length} findings // Subject #{profile.id}
          </Text>
        </View>
        <View style={{ backgroundColor: ringColor + "18", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
          <Text style={{ color: ringColor, fontSize: 9, fontWeight: "800", letterSpacing: 1 }}>
            {crit > 0 ? "HIGH" : high > 0 ? "MED" : "LOW"}
          </Text>
        </View>
      </View>

      {/* Tab bar */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: "#141414" }} contentContainerStyle={{ paddingHorizontal: 12 }}>
        {tabs.map(t => {
          const active = tab === t.key;
          return (
            <Pressable key={t.key} onPress={() => setTab(t.key)} style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: active ? "#00b4d8" : "transparent" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Text style={{ color: active ? "#e5e5e5" : "#3a3a3a", fontSize: 12, fontWeight: active ? "700" : "500" }}>
                  {t.label}
                </Text>
                {(t.badge ?? 0) > 0 && (
                  <View style={{ backgroundColor: active ? "#00b4d822" : "#1a1a1a", borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 }}>
                    <Text style={{ color: active ? "#00b4d8" : "#444", fontSize: 9, fontWeight: "700" }}>{t.badge}</Text>
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Tab content — each tab is its own scrollable screen */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false} key={tab}>
        {tab === "overview" && <OverviewTab findings={findings} subjectName={subjectName} confidence={confidence} crit={crit} high={high} med={med} totalFaces={totalFaces} scenes={scenes} ekf={ekf} discovered={discovered} dossierData={dossierData} dossierLoading={dossierLoading} />}
        {tab === "identity" && <IdentityTab candidates={idCandidates?.raw_data?.candidates || []} faceGuesses={faceSearchGuesses(faceGuesses)} dossier={dossierData} />}
        {tab === "digital" && <DigitalTab dossier={dossierData} loading={dossierLoading} metadata={metadata} />}
        {tab === "faces" && <FacesTab verified={verified} discovered={discovered} unverified={unverified} />}
        {tab === "scene" && <SceneTab scenes={scenes} />}
        {tab === "threats" && <ThreatsTab findings={findings} crit={crit} high={high} med={med} dossier={dossierData} pivots={pivots} />}
      </ScrollView>
    </View>
  );
}

function faceSearchGuesses(finding: any): string[] {
  return (finding?.raw_data?.identityGuesses || []).filter((g: string) => isLatin(g));
}

// ═══════════════════════════════════════════
// OVERVIEW TAB — Visual dashboard
// ═══════════════════════════════════════════
function OverviewTab({ findings, subjectName, confidence, crit, high, med, totalFaces, scenes, ekf, discovered, dossierData, dossierLoading }: any) {
  const threatColor = crit > 0 ? "#dc2626" : high > 0 ? "#ea580c" : "#16a34a";
  const threatLabel = crit > 0 ? "HIGH EXPOSURE" : high > 0 ? "MODERATE" : "LOW EXPOSURE";
  const exposurePct = Math.min(100, Math.max(8, crit * 25 + high * 15 + findings.length * 2));

  return (
    <View style={{ gap: 16 }}>
      {/* Threat gauge */}
      <View style={{ backgroundColor: "#0c0c0c", borderRadius: 16, padding: 20, alignItems: "center", borderWidth: 1, borderColor: "#141414" }}>
        <Text style={{ color: "#2a2a2a", fontSize: 9, fontWeight: "600", letterSpacing: 2, marginBottom: 8 }}>EXPOSURE LEVEL</Text>
        <Text style={{ color: threatColor, fontSize: 28, fontWeight: "800", letterSpacing: 2, marginBottom: 6 }}>
          {threatLabel}
        </Text>
        {/* Gauge bar */}
        <View style={{ width: "100%", height: 6, backgroundColor: "#141414", borderRadius: 3, overflow: "hidden", marginTop: 4 }}>
          <View style={{ height: "100%", width: `${exposurePct}%`, backgroundColor: threatColor, borderRadius: 3 }} />
        </View>
      </View>

      {/* Stat grid — 2x2 */}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <StatWidget label="Findings" value={findings.length} color="#00b4d8" />
        <StatWidget label="Threats" value={crit + high} color={crit > 0 ? "#dc2626" : "#ea580c"} />
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <StatWidget label="Face Hits" value={totalFaces} color="#a855f7" />
        <StatWidget label="Confidence" value={confidence > 0 ? `${(confidence * 100).toFixed(0)}%` : "--"} color={confidence > 0.7 ? "#16a34a" : "#ca8a04"} isText />
      </View>

      {/* Quick intel cards — collapsible */}
      {scenes.length > 0 && (() => {
        const a = scenes[0].raw_data?.analysis;
        if (!a) return null;
        const items: { label: string; value: string }[] = [];
        if (a.location?.estimated_region) items.push({ label: "Location", value: a.location.estimated_region });
        if (a.context?.event_type) items.push({ label: "Context", value: a.context.event_type });
        if (a.people?.count > 0) items.push({ label: "People", value: `${a.people.count} detected` });
        if (a.organizations?.logos?.length > 0) items.push({ label: "Orgs", value: a.organizations.logos.join(", ") });
        if (items.length === 0) return null;
        return <CollapsibleCard title="Scene Intel" items={items} accent="#a855f7" />;
      })()}

      {discovered.length > 0 && (
        <CollapsibleCard
          title={`Discovered Profiles (${discovered.length})`}
          items={discovered.slice(0, 5).map((f: any) => ({
            label: f.raw_data?.platform || "?",
            value: `@${f.raw_data?.username || "?"} (${((f.raw_data?.similarity || 0) * 100).toFixed(0)}%)`,
          }))}
          accent="#00b4d8"
        />
      )}

      {/* EKF fusion — compact */}
      {ekf && <EkfWidget summary={ekf} />}

      {/* Dossier changes */}
      {dossierLoading ? (
        <View style={{ padding: 24, alignItems: "center" }}>
          <ActivityIndicator color="#1a1a1a" />
        </View>
      ) : dossierData?.whatChanged?.newFindingsCount > 0 ? (
        <CollapsibleCard
          title={`Recent Changes (${dossierData.whatChanged.newFindingsCount} new)`}
          items={(dossierData.whatChanged.highlights || []).slice(0, 4).filter((h: any) => isLatin(h.title || "")).map((h: any) => ({
            label: h.severity?.toUpperCase() || "INFO",
            value: h.title,
          }))}
          accent="#ca8a04"
        />
      ) : null}
    </View>
  );
}

// ═══════════════════════════════════════════
// IDENTITY TAB
// ═══════════════════════════════════════════
function IdentityTab({ candidates, faceGuesses, dossier }: { candidates: any[]; faceGuesses: string[]; dossier: any }) {
  return (
    <View style={{ gap: 16 }}>
      {candidates.length === 0 && faceGuesses.length === 0 && !dossier?.subjectOverview ? (
        <EmptyState text="No identity data yet. Run a scan." />
      ) : null}

      {candidates.map((c: any, i: number) => (
        <View key={i} style={{ backgroundColor: "#0c0c0c", borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: "#141414" }}>
          {/* Confidence bar at top */}
          <View style={{ height: 3, backgroundColor: "#141414" }}>
            <View style={{ height: 3, width: `${c.confidence * 100}%`, backgroundColor: c.confidence > 0.7 ? "#16a34a" : c.confidence > 0.4 ? "#ca8a04" : "#dc2626" }} />
          </View>
          <View style={{ padding: 16 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <Text style={{ color: "#e5e5e5", fontSize: 16, fontWeight: "700" }}>{cleanText(c.name) || "Unknown"}</Text>
              <Text style={{ color: c.confidence > 0.7 ? "#16a34a" : "#ca8a04", fontSize: 14, fontWeight: "800" }}>
                {(c.confidence * 100).toFixed(0)}%
              </Text>
            </View>
            <Text style={{ color: "#3a3a3a", fontSize: 10 }}>
              {c.sourceCount} source{c.sourceCount !== 1 ? "s" : ""} // {(c.platforms || []).filter((p: string) => isLatin(p)).join(", ")}
            </Text>
          </View>
        </View>
      ))}

      {faceGuesses.length > 0 && (
        <CollapsibleCard
          title="Search Engine Matches"
          items={faceGuesses.map((g, i) => ({ label: `#${i + 1}`, value: g }))}
          accent="#ca8a04"
        />
      )}

      {dossier?.subjectOverview && (() => {
        const s = dossier.subjectOverview;
        const items: { label: string; value: string }[] = [];
        if (s.names?.length > 0) items.push({ label: "Names", value: s.names.filter((n: string) => isLatin(n)).join(", ") });
        if (s.usernames?.length > 0) items.push({ label: "Usernames", value: s.usernames.slice(0, 6).join(", ") });
        if (s.emails?.length > 0) items.push({ label: "Emails", value: s.emails.join(", ") });
        if (s.phones?.length > 0) items.push({ label: "Phones", value: s.phones.join(", ") });
        if (s.locations?.length > 0) items.push({ label: "Locations", value: s.locations.map((l: any) => l.text).filter(Boolean).filter((t: string) => isLatin(t)).join("; ") });
        if (items.length === 0) return null;
        return <CollapsibleCard title="Known Identifiers" items={items} accent="#00b4d8" defaultOpen />;
      })()}
    </View>
  );
}

// ═══════════════════════════════════════════
// DIGITAL TAB
// ═══════════════════════════════════════════
function DigitalTab({ dossier, loading, metadata }: any) {
  if (loading) return <View style={{ padding: 40, alignItems: "center" }}><ActivityIndicator color="#1a1a1a" /></View>;

  const hasFootprint = dossier?.digitalFootprint?.totalAccounts > 0;
  const hasSocial = dossier?.socialIntelligence?.platformCount > 0;

  if (!hasFootprint && !hasSocial && metadata.length === 0) {
    return <EmptyState text="No digital footprint data. Run a scan to discover accounts." />;
  }

  return (
    <View style={{ gap: 16 }}>
      {hasFootprint && (
        <>
          <StatWidget label="Accounts Found" value={dossier.digitalFootprint.totalAccounts} color="#00b4d8" fullWidth />
          {Object.entries(dossier.digitalFootprint.byCategory || {}).map(([cat, accounts]: [string, any]) => (
            accounts.length > 0 ? (
              <CollapsibleCard
                key={cat}
                title={`${cat} (${accounts.length})`}
                items={accounts.filter((a: any) => isLatin(a.platform || "") || isLatin(a.value || "")).map((a: any) => ({
                  label: a.platform,
                  value: `${a.value}${a.followers ? ` (${a.followers.toLocaleString()})` : ""}${a.verified ? " [V]" : ""}`,
                }))}
                accent="#00b4d8"
              />
            ) : null
          ))}
        </>
      )}

      {hasSocial && (
        <>
          {Object.values(dossier.socialIntelligence.platforms || {}).map((p: any, i: number) => {
            if (!isLatin(p.platform || "")) return null;
            return (
              <View key={i} style={{ backgroundColor: "#0c0c0c", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#141414" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <Text style={{ color: "#e5e5e5", fontSize: 13, fontWeight: "700" }}>{p.platform}</Text>
                  {p.verified && <View style={{ backgroundColor: "#16a34a22", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}><Text style={{ color: "#16a34a", fontSize: 8, fontWeight: "700" }}>VERIFIED</Text></View>}
                </View>
                {p.displayName && isLatin(p.displayName) && <Text style={{ color: "#888", fontSize: 11, marginBottom: 2 }}>{p.displayName}</Text>}
                {p.followers != null && (
                  <Text style={{ color: "#3a3a3a", fontSize: 10 }}>
                    {p.followers.toLocaleString()} followers{p.posts ? ` // ${p.posts.toLocaleString()} posts` : ""}
                  </Text>
                )}
                {p.bio && isLatin(p.bio) && <Text style={{ color: "#2a2a2a", fontSize: 10, marginTop: 4 }} numberOfLines={2}>{p.bio.substring(0, 120)}</Text>}
              </View>
            );
          })}
        </>
      )}

      {metadata.length > 0 && (
        <CollapsibleCard
          title={`Image Metadata (${metadata.length})`}
          items={metadata.filter((f: any) => isLatin(f.title || f.description || "")).map((f: any) => ({
            label: f.severity?.toUpperCase() || "INFO",
            value: f.title || f.description || "",
          }))}
          accent="#ea580c"
        />
      )}
    </View>
  );
}

// ═══════════════════════════════════════════
// FACES TAB
// ═══════════════════════════════════════════
function FacesTab({ verified, discovered, unverified }: any) {
  const hasAny = verified.length > 0 || discovered.length > 0 || unverified.length > 0;
  if (!hasAny) return <EmptyState text="No face matches yet. Upload an image and run a scan." />;

  return (
    <View style={{ gap: 16 }}>
      {verified.map((f: any, i: number) => {
        const matches = (f.raw_data?.verifiedMatches || []).filter((m: any) => isLatin(m.title || ""));
        if (matches.length === 0) return null;
        return (
          <View key={i} style={{ gap: 8 }}>
            <SectionHeader title={`Verified Matches (${matches.length})`} color="#dc2626" />
            {matches.slice(0, 12).map((m: any, j: number) => (
              <Pressable key={j} onPress={() => m.sourceUrl && Linking.openURL(m.sourceUrl)}>
                <View style={{ backgroundColor: "#0c0c0c", borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "#141414", borderLeftWidth: 3, borderLeftColor: m.similarity > 0.7 ? "#dc2626" : "#ca8a04" }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ color: "#ccc", fontSize: 12, fontWeight: "600", flex: 1 }} numberOfLines={1}>{m.title}</Text>
                    <Text style={{ color: m.similarity > 0.7 ? "#dc2626" : "#ca8a04", fontSize: 11, fontWeight: "800", marginLeft: 10 }}>
                      {(m.similarity * 100).toFixed(0)}%
                    </Text>
                  </View>
                  <Text style={{ color: "#222", fontSize: 9, marginTop: 4 }} numberOfLines={1}>{m.engine} // {m.sourceUrl}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        );
      })}

      {discovered.length > 0 && (
        <View style={{ gap: 8 }}>
          <SectionHeader title={`Discovered Profiles (${discovered.length})`} color="#00b4d8" />
          {discovered.map((f: any, i: number) => (
            <Pressable key={i} onPress={() => f.source_url && Linking.openURL(f.source_url)}>
              <View style={{ backgroundColor: "#0c0c0c", borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "#141414", borderLeftWidth: 3, borderLeftColor: "#00b4d8" }}>
                <Text style={{ color: "#ccc", fontSize: 12, fontWeight: "600" }}>{f.raw_data?.platform}: @{f.raw_data?.username}</Text>
                <Text style={{ color: "#333", fontSize: 10, marginTop: 3 }}>{((f.raw_data?.similarity || 0) * 100).toFixed(0)}% match</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}

      {unverified.map((f: any, i: number) => {
        const urls = (f.raw_data?.sourceUrls || []).filter((u: string) => isLatin(u));
        if (urls.length === 0) return null;
        return (
          <CollapsibleCard
            key={i}
            title={`Unverified Pages (${urls.length})`}
            items={urls.slice(0, 12).map((url: string, j: number) => ({ label: `#${j + 1}`, value: url }))}
            accent="#3a3a3a"
            onItemPress={(item: any) => Linking.openURL(item.value)}
          />
        );
      })}
    </View>
  );
}

// ═══════════════════════════════════════════
// SCENE TAB
// ═══════════════════════════════════════════
function SceneTab({ scenes }: { scenes: OsintFinding[] }) {
  if (scenes.length === 0) return <EmptyState text="No scene analysis. Requires Gemini Vision." />;

  return (
    <View style={{ gap: 16 }}>
      {scenes.map((f, i) => {
        const a = f.raw_data?.analysis;
        if (!a) {
          return <View key={i} style={{ backgroundColor: "#0c0c0c", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#141414" }}>
            <Text style={{ color: "#777", fontSize: 11, lineHeight: 18 }}>{cleanText(f.description || "")}</Text>
          </View>;
        }
        return (
          <View key={i} style={{ gap: 12 }}>
            {a.location && (
              <CollapsibleCard
                title="Geolocation"
                items={[
                  a.location.estimated_region && { label: "Region", value: a.location.estimated_region },
                  { label: "Environment", value: a.location.environment || "Unknown" },
                  a.location.climate_clues && { label: "Climate", value: a.location.climate_clues },
                  { label: "Confidence", value: a.location.confidence || "Unknown" },
                  ...(a.location.indicators || []).map((ind: string) => ({ label: "Indicator", value: ind })),
                ].filter(Boolean)}
                accent="#ca8a04"
                defaultOpen
              />
            )}

            {a.people?.count > 0 && (
              <CollapsibleCard
                title={`People (${a.people.count})`}
                items={(a.people.details || []).map((p: any, j: number) => ({
                  label: `Person ${j + 1}`,
                  value: `${p.estimated_age_range || "?"}, ${p.gender || "?"}${p.clothing ? ` — ${p.clothing}` : ""}`,
                }))}
                accent="#a855f7"
                defaultOpen
              />
            )}

            {(a.organizations?.logos?.length > 0 || a.organizations?.affiliations?.length > 0) && (
              <CollapsibleCard
                title="Organizations"
                items={[
                  ...(a.organizations.logos || []).map((l: string) => ({ label: "Logo", value: l })),
                  ...(a.organizations.badges || []).map((b: string) => ({ label: "Badge", value: b })),
                  ...(a.organizations.affiliations || []).map((af: string) => ({ label: "Affiliation", value: af })),
                ].filter((item) => isLatin(item.value))}
                accent="#00b4d8"
              />
            )}

            {a.text_ocr && (a.text_ocr.name_tags?.length > 0 || a.text_ocr.signs?.length > 0) && (
              <CollapsibleCard
                title="Text / OCR"
                items={[
                  ...(a.text_ocr.name_tags || []).map((n: string) => ({ label: "Name Tag", value: n })),
                  ...(a.text_ocr.signs || []).map((s: string) => ({ label: "Sign", value: s })),
                  ...(a.text_ocr.documents || []).map((d: string) => ({ label: "Document", value: d })),
                ].filter((item) => isLatin(item.value))}
                accent="#dc2626"
              />
            )}

            {a.context && (
              <CollapsibleCard
                title="Context"
                items={[
                  { label: "Event", value: a.context.event_type || "Unknown" },
                  { label: "Time", value: a.context.time_of_day || "Unknown" },
                  a.context.season && { label: "Season", value: a.context.season },
                  a.context.mood && { label: "Mood", value: a.context.mood },
                ].filter(Boolean)}
                accent="#3a3a3a"
              />
            )}

            {a.landmarks?.length > 0 && (
              <CollapsibleCard title="Landmarks" items={a.landmarks.filter((l: string) => isLatin(l)).map((l: string, j: number) => ({ label: `#${j + 1}`, value: l }))} accent="#ca8a04" />
            )}

            {a.intelligence_notes && isLatin(a.intelligence_notes) && (
              <View style={{ backgroundColor: "#0c0c0c", borderRadius: 14, padding: 16, borderWidth: 1, borderColor: "#141414" }}>
                <Text style={{ color: "#00b4d8", fontSize: 10, fontWeight: "700", letterSpacing: 1, marginBottom: 8 }}>ANALYST NOTES</Text>
                <Text style={{ color: "#888", fontSize: 11, lineHeight: 18 }}>{a.intelligence_notes}</Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ═══════════════════════════════════════════
// THREATS TAB
// ═══════════════════════════════════════════
function ThreatsTab({ findings, crit, high, med, dossier, pivots }: any) {
  const threatColor = crit > 0 ? "#dc2626" : high > 0 ? "#ea580c" : "#16a34a";
  const critFindings = findings.filter((f: any) => f.severity === "critical");
  const highFindings = findings.filter((f: any) => f.severity === "high");

  return (
    <View style={{ gap: 16 }}>
      {/* Threat summary */}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <ThreatWidget value={crit} label="Critical" color="#dc2626" />
        <ThreatWidget value={high} label="High" color="#ea580c" />
        <ThreatWidget value={med} label="Medium" color="#ca8a04" />
      </View>

      {critFindings.length > 0 && (
        <View style={{ gap: 8 }}>
          <SectionHeader title="Critical" color="#dc2626" />
          {critFindings.map((f: any, i: number) => <FindingRow key={i} finding={f} color="#dc2626" />)}
        </View>
      )}

      {highFindings.length > 0 && (
        <View style={{ gap: 8 }}>
          <SectionHeader title="High Severity" color="#ea580c" />
          {highFindings.slice(0, 10).map((f: any, i: number) => <FindingRow key={i} finding={f} color="#ea580c" />)}
        </View>
      )}

      {dossier?.exposureAssessment && (() => {
        const ea = dossier.exposureAssessment;
        const items = [
          ea.breachCount > 0 && { label: "Breaches", value: `${ea.breachCount}` },
          ea.dataBrokerCount > 0 && { label: "Data Brokers", value: `${ea.dataBrokerCount}` },
          (ea.pasteExposure > 0 || ea.leakExposure > 0) && { label: "Leaks", value: `${(ea.pasteExposure || 0) + (ea.leakExposure || 0)}` },
        ].filter(Boolean);
        if (items.length === 0) return null;
        return <CollapsibleCard title="Exposure Assessment" items={items as any} accent="#ea580c" />;
      })()}

      {pivots.length > 0 && (
        <CollapsibleCard
          title={`Investigation Leads (${pivots.length})`}
          items={pivots.slice(0, 8).filter((f: any) => isLatin(f.title || "")).map((f: any) => ({
            label: f.raw_data?.pivotType || "lead",
            value: cleanText(f.title) || cleanText(f.raw_data?.pivotValue) || "Unknown",
          }))}
          accent="#16a34a"
        />
      )}

      {crit === 0 && high === 0 && (
        <EmptyState text="No critical or high severity threats detected." />
      )}
    </View>
  );
}

// ═══════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════

function StatWidget({ label, value, color, fullWidth, isText }: { label: string; value: any; color: string; fullWidth?: boolean; isText?: boolean }) {
  return (
    <View style={{ flex: fullWidth ? undefined : 1, width: fullWidth ? "100%" : undefined, backgroundColor: "#0c0c0c", borderRadius: 14, padding: 18, alignItems: "center", borderWidth: 1, borderColor: "#141414" }}>
      <Text style={{ color, fontSize: isText ? 22 : 28, fontWeight: "800" }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </Text>
      <Text style={{ color: "#2a2a2a", fontSize: 9, fontWeight: "600", letterSpacing: 1, marginTop: 4 }}>{label.toUpperCase()}</Text>
    </View>
  );
}

function ThreatWidget({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: value > 0 ? color + "10" : "#0c0c0c", borderRadius: 14, padding: 16, alignItems: "center", borderWidth: 1, borderColor: value > 0 ? color + "22" : "#141414" }}>
      <Text style={{ color: value > 0 ? color : "#222", fontSize: 24, fontWeight: "800" }}>{value}</Text>
      <Text style={{ color: "#3a3a3a", fontSize: 9, fontWeight: "600", marginTop: 4 }}>{label}</Text>
    </View>
  );
}

function CollapsibleCard({ title, items, accent, defaultOpen, onItemPress }: {
  title: string; items: { label: string; value: string }[]; accent: string; defaultOpen?: boolean; onItemPress?: (item: any) => void;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <View style={{ backgroundColor: "#0c0c0c", borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: "#141414" }}>
      <Pressable onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setOpen(!open); }}
        style={{ flexDirection: "row", alignItems: "center", padding: 14 }}>
        <View style={{ width: 3, height: 14, borderRadius: 1.5, backgroundColor: accent, marginRight: 10 }} />
        <Text style={{ color: "#ccc", fontSize: 12, fontWeight: "600", flex: 1 }}>{title}</Text>
        <Text style={{ color: "#333", fontSize: 12 }}>{open ? "−" : "+"}</Text>
      </Pressable>
      {open && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 6 }}>
          {items.map((item, i) => (
            <Pressable key={i} disabled={!onItemPress} onPress={() => onItemPress?.(item)}>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Text style={{ color: "#3a3a3a", fontSize: 10, width: 70 }}>{item.label}</Text>
                <Text style={{ color: onItemPress ? "#00b4d8" : "#888", fontSize: 10, flex: 1 }} numberOfLines={2}>{item.value}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function FindingRow({ finding, color }: { finding: any; color: string }) {
  const [expanded, setExpanded] = useState(false);
  const title = cleanText(finding.title);
  if (!title) return null;

  return (
    <Pressable onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setExpanded(!expanded); }}>
      <View style={{ backgroundColor: "#0c0c0c", borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "#141414", borderLeftWidth: 3, borderLeftColor: color }}>
        <Text style={{ color: "#ccc", fontSize: 11, fontWeight: "600" }}>{title}</Text>
        {expanded && finding.description && isLatin(finding.description) && (
          <Text style={{ color: "#555", fontSize: 10, marginTop: 6, lineHeight: 16 }}>{finding.description}</Text>
        )}
      </View>
    </Pressable>
  );
}

function SectionHeader({ title, color }: { title: string; color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: "#888", fontSize: 11, fontWeight: "700" }}>{title}</Text>
    </View>
  );
}

function EkfWidget({ summary }: { summary: EkfSummary }) {
  const [expanded, setExpanded] = useState(false);
  const ci = summary.confidence_intervals || {};

  const attrs = [
    { key: "identity_certainty", label: "Identity", pct: true },
    { key: "name_confidence", label: "Name", pct: true },
    { key: "location_confidence", label: "Location", pct: true },
    { key: "employer_confidence", label: "Employer", pct: true },
  ];

  return (
    <View style={{ backgroundColor: "#0c0c0c", borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: "#141414" }}>
      <Pressable onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setExpanded(!expanded); }}
        style={{ flexDirection: "row", alignItems: "center", padding: 14 }}>
        <View style={{ width: 3, height: 14, borderRadius: 1.5, backgroundColor: "#00b4d8", marginRight: 10 }} />
        <Text style={{ color: "#ccc", fontSize: 12, fontWeight: "600", flex: 1 }}>Intelligence Fusion</Text>
        <Text style={{ color: "#3a3a3a", fontSize: 9, marginRight: 8 }}>{summary.observations} obs</Text>
        <Text style={{ color: "#333", fontSize: 12 }}>{expanded ? "−" : "+"}</Text>
      </Pressable>
      {expanded && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 10 }}>
          {attrs.map(({ key, label, pct }) => {
            const val = ci[key]?.value ?? 0;
            const bar = pct ? Math.min(1, Math.max(0, val)) : Math.min(1, val / 100);
            const barColor = bar > 0.7 ? "#16a34a" : bar > 0.4 ? "#ca8a04" : "#dc2626";
            return (
              <View key={key}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
                  <Text style={{ color: "#555", fontSize: 10 }}>{label}</Text>
                  <Text style={{ color: "#ccc", fontSize: 10, fontWeight: "700" }}>{pct ? `${(val * 100).toFixed(0)}%` : val.toFixed(1)}</Text>
                </View>
                <View style={{ height: 3, backgroundColor: "#141414", borderRadius: 2, overflow: "hidden" }}>
                  <View style={{ height: 3, width: `${bar * 100}%`, backgroundColor: barColor, borderRadius: 2 }} />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 40 }}>
      <Text style={{ color: "#2a2a2a", fontSize: 12, textAlign: "center" }}>{text}</Text>
    </View>
  );
}
