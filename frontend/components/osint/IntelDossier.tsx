import { View, Text, ScrollView, Pressable, Image, Linking, ActivityIndicator } from "react-native";
import { useState, useEffect, useCallback } from "react";
import { getBridgeUrl, getAuthHeaders, apiFetch, fetchOsintEkf, type OsintProfile, type OsintFinding, type EkfSummary } from "../../lib/bridge-api";

interface Props {
  profile: OsintProfile;
  findings: OsintFinding[];
  allFindings?: OsintFinding[];
  onBack: () => void;
}

type Section = "overview" | "identity" | "digital" | "faces" | "scene" | "threats";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "overview", label: "OVERVIEW" },
  { key: "identity", label: "IDENTITY" },
  { key: "digital", label: "DIGITAL" },
  { key: "faces", label: "FACES" },
  { key: "scene", label: "SCENE" },
  { key: "threats", label: "THREATS" },
];

export function IntelDossier({ profile, findings, allFindings, onBack }: Props) {
  const [activeSection, setActiveSection] = useState<Section>("overview");
  const [timePeriod, setTimePeriod] = useState(30);
  const [dossierData, setDossierData] = useState<any>(null);
  const [dossierLoading, setDossierLoading] = useState(true);
  const [ekfSummary, setEkfSummary] = useState<EkfSummary | null>(null);

  const imageUrl = `${getBridgeUrl()}/osint/images/${profile.id}/thumbnail`;

  // Categorize findings
  const identityCandidates = findings.find(f => f.module === "identity-resolver" && f.raw_data?.type === "identity_candidates");
  const topCandidate = identityCandidates?.raw_data?.candidates?.[0];
  const identityName = topCandidate?.name || profile.display_name || "Unknown Subject";

  const faceSearchIdentity = findings.find(f => f.module === "face-search" && f.raw_data?.type === "identity_candidates");
  const verifiedMatches = findings.filter(f => f.raw_data?.type === "verified_face_matches");
  const discoveredProfiles = findings.filter(f => f.raw_data?.type === "discovered_profile");
  const unverifiedMatches = findings.filter(f => f.raw_data?.type === "unverified_matches");
  const sceneFindings = findings.filter(f => f.raw_data?.type === "scene_analysis");
  const metadataFindings = findings.filter(f => f.module === "exiftool-cli" || f.module === "exif-extract");
  const pivotRecs = findings.filter(f => f.raw_data?.type === "pivot_recommendation");

  const criticalCount = findings.filter(f => f.severity === "critical").length;
  const highCount = findings.filter(f => f.severity === "high").length;
  const mediumCount = findings.filter(f => f.severity === "medium").length;
  const threatColor = criticalCount > 0 ? "#ef4444" : highCount > 0 ? "#f97316" : "#22c55e";

  // Load dossier report data
  const loadDossier = useCallback(async () => {
    setDossierLoading(true);
    try {
      const data = await apiFetch(`/osint/dossier/${profile.id}?days=${timePeriod}`);
      setDossierData(data.dossier);
    } catch {}
    setDossierLoading(false);
  }, [profile.id, timePeriod]);

  useEffect(() => { loadDossier(); }, [loadDossier]);

  // Load EKF
  useEffect(() => {
    fetchOsintEkf(profile.id).then(d => setEkfSummary(d.summary)).catch(() => {});
  }, [profile.id]);

  const totalFaceMatches = (verifiedMatches[0]?.raw_data?.verifiedMatches?.length || 0) +
    discoveredProfiles.length +
    (unverifiedMatches[0]?.raw_data?.sourceUrls?.length || 0);

  return (
    <View style={{ flex: 1, backgroundColor: "#0a0a0a" }}>
      {/* Classification banner */}
      <View style={{ backgroundColor: "#120000", paddingVertical: 4, alignItems: "center" }}>
        <Text style={{ color: "#ef4444", fontFamily: "SpaceMono", fontSize: 8, fontWeight: "bold", letterSpacing: 5 }}>
          CONFIDENTIAL // INTELLIGENCE DOSSIER
        </Text>
      </View>

      {/* Subject header */}
      <View style={{ flexDirection: "row", alignItems: "center", padding: 16, gap: 14, borderBottomWidth: 1, borderBottomColor: "#151515" }}>
        <Pressable onPress={onBack} style={{ padding: 4, marginRight: 2 }}>
          <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 18 }}>{"<"}</Text>
        </Pressable>
        <View style={{ width: 48, height: 48, borderRadius: 24, borderWidth: 2.5, borderColor: threatColor, padding: 2 }}>
          <Image
            source={{ uri: imageUrl, headers: getAuthHeaders() }}
            style={{ width: "100%", height: "100%", borderRadius: 22 }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: "#e5e5e5", fontFamily: "SpaceMono", fontSize: 15, fontWeight: "bold", textTransform: "uppercase", letterSpacing: 1 }} numberOfLines={1}>
            {identityName}
          </Text>
          <Text style={{ color: "#404040", fontFamily: "SpaceMono", fontSize: 9, letterSpacing: 1, marginTop: 1 }}>
            SUBJECT #{profile.id} // {findings.length} FINDINGS
          </Text>
        </View>
        {/* Threat indicator */}
        <View style={{ backgroundColor: threatColor + "15", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: threatColor + "33" }}>
          <Text style={{ color: threatColor, fontFamily: "SpaceMono", fontSize: 9, fontWeight: "bold", letterSpacing: 1 }}>
            {criticalCount > 0 ? "HIGH" : highCount > 0 ? "MED" : "LOW"}
          </Text>
        </View>
      </View>

      {/* Section tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 42, borderBottomWidth: 1, borderBottomColor: "#151515" }} contentContainerStyle={{ paddingHorizontal: 12, alignItems: "center" }}>
        {SECTIONS.map(s => {
          const active = activeSection === s.key;
          const count = s.key === "faces" ? totalFaceMatches :
            s.key === "identity" ? (identityCandidates?.raw_data?.candidates?.length || 0) :
            s.key === "scene" ? sceneFindings.length :
            s.key === "threats" ? (criticalCount + highCount) : 0;
          return (
            <Pressable
              key={s.key}
              onPress={() => setActiveSection(s.key)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 10,
                marginRight: 2,
                borderBottomWidth: 2,
                borderBottomColor: active ? "#00e5ff" : "transparent",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text style={{
                  color: active ? "#00e5ff" : "#444",
                  fontFamily: "SpaceMono",
                  fontSize: 10,
                  fontWeight: "bold",
                  letterSpacing: 1,
                }}>
                  {s.label}
                </Text>
                {count > 0 && (
                  <View style={{ backgroundColor: active ? "#00e5ff22" : "#1a1a1a", borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1 }}>
                    <Text style={{ color: active ? "#00e5ff" : "#555", fontFamily: "SpaceMono", fontSize: 8, fontWeight: "bold" }}>
                      {count}
                    </Text>
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Section content */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {activeSection === "overview" && (
          <OverviewSection
            findings={findings}
            identityName={identityName}
            topCandidate={topCandidate}
            faceSearchIdentity={faceSearchIdentity}
            criticalCount={criticalCount}
            highCount={highCount}
            mediumCount={mediumCount}
            discoveredProfiles={discoveredProfiles}
            sceneFindings={sceneFindings}
            totalFaceMatches={totalFaceMatches}
            ekfSummary={ekfSummary}
            dossierData={dossierData}
            dossierLoading={dossierLoading}
            timePeriod={timePeriod}
            setTimePeriod={setTimePeriod}
          />
        )}
        {activeSection === "identity" && (
          <IdentitySection
            candidates={identityCandidates?.raw_data?.candidates || []}
            faceGuesses={faceSearchIdentity?.raw_data?.identityGuesses || []}
            dossierData={dossierData}
          />
        )}
        {activeSection === "digital" && (
          <DigitalSection dossierData={dossierData} dossierLoading={dossierLoading} metadataFindings={metadataFindings} />
        )}
        {activeSection === "faces" && (
          <FaceSection verifiedMatches={verifiedMatches} discoveredProfiles={discoveredProfiles} unverifiedMatches={unverifiedMatches} />
        )}
        {activeSection === "scene" && (
          <SceneSection findings={sceneFindings} />
        )}
        {activeSection === "threats" && (
          <ThreatSection
            findings={findings}
            criticalCount={criticalCount}
            highCount={highCount}
            mediumCount={mediumCount}
            dossierData={dossierData}
            pivotRecs={pivotRecs}
          />
        )}
      </ScrollView>
    </View>
  );
}

// ─── OVERVIEW ───
function OverviewSection({ findings, identityName, topCandidate, faceSearchIdentity, criticalCount, highCount, mediumCount, discoveredProfiles, sceneFindings, totalFaceMatches, ekfSummary, dossierData, dossierLoading, timePeriod, setTimePeriod }: any) {
  const guesses = faceSearchIdentity?.raw_data?.identityGuesses || [];
  const confidence = topCandidate?.confidence || 0;
  const threatColor = criticalCount > 0 ? "#ef4444" : highCount > 0 ? "#f97316" : "#22c55e";
  const exposureLevel = criticalCount > 0 ? "HIGH" : highCount > 0 ? "MODERATE" : "LOW";
  const exposurePct = Math.min(100, Math.max(8, criticalCount * 25 + highCount * 15 + findings.length * 2));

  return (
    <>
      {/* Executive summary cards */}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <SummaryCard label="FINDINGS" value={`${findings.length}`} color="#00e5ff" />
        <SummaryCard label="THREATS" value={`${criticalCount + highCount}`} color={criticalCount > 0 ? "#ef4444" : highCount > 0 ? "#f97316" : "#22c55e"} />
        <SummaryCard label="CONFIDENCE" value={confidence > 0 ? `${(confidence * 100).toFixed(0)}%` : "--"} color={confidence > 0.7 ? "#22c55e" : "#eab308"} />
        <SummaryCard label="FACES" value={`${totalFaceMatches}`} color="#a855f7" />
      </View>

      {/* Subject identification */}
      <Card title="SUBJECT IDENTIFICATION">
        <InfoRow label="Primary Name" value={identityName.toUpperCase()} valueColor="#e5e5e5" />
        {confidence > 0 && (
          <InfoRow label="Confidence" value={`${(confidence * 100).toFixed(0)}%`} valueColor={confidence > 0.7 ? "#22c55e" : "#eab308"} />
        )}
        {topCandidate?.sourceCount > 0 && (
          <InfoRow label="Sources" value={`${topCandidate.sourceCount} independent`} />
        )}
        {guesses.length > 0 && <InfoRow label="Aliases" value={guesses.slice(0, 5).join(", ")} />}
        {topCandidate?.platforms?.length > 0 && (
          <InfoRow label="Platforms" value={topCandidate.platforms.join(", ")} />
        )}
      </Card>

      {/* Exposure gauge */}
      <Card title="EXPOSURE ASSESSMENT">
        <View style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
            <Text style={{ color: "#444", fontFamily: "SpaceMono", fontSize: 9 }}>EXPOSURE LEVEL</Text>
            <Text style={{ color: threatColor, fontFamily: "SpaceMono", fontSize: 9, fontWeight: "bold" }}>{exposureLevel}</Text>
          </View>
          <View style={{ height: 8, backgroundColor: "#151515", borderRadius: 4, overflow: "hidden" }}>
            <View style={{ height: "100%", width: `${exposurePct}%`, backgroundColor: threatColor, borderRadius: 4 }} />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ThreatPill value={criticalCount} label="CRITICAL" color="#ef4444" />
          <ThreatPill value={highCount} label="HIGH" color="#f97316" />
          <ThreatPill value={mediumCount} label="MEDIUM" color="#eab308" />
          <ThreatPill value={findings.filter((f: any) => f.severity === "info").length} label="INFO" color="#555" />
        </View>
      </Card>

      {/* Scene intel summary */}
      {sceneFindings.length > 0 && (
        <Card title="SCENE INTELLIGENCE">
          {sceneFindings.slice(0, 1).map((f: any, i: number) => {
            const a = f.raw_data?.analysis;
            if (!a) return null;
            return (
              <View key={i} style={{ gap: 4 }}>
                {a.location?.estimated_region && <InfoRow label="Location" value={a.location.estimated_region} valueColor="#ffab00" />}
                {a.context?.event_type && <InfoRow label="Context" value={a.context.event_type} />}
                {a.people?.count > 0 && <InfoRow label="People" value={`${a.people.count} detected`} />}
                {a.organizations?.logos?.length > 0 && <InfoRow label="Organizations" value={a.organizations.logos.join(", ")} />}
                {a.context?.time_of_day && <InfoRow label="Time" value={a.context.time_of_day} />}
              </View>
            );
          })}
        </Card>
      )}

      {/* EKF Confidence */}
      {ekfSummary && <EkfCard summary={ekfSummary} />}

      {/* Time-period report */}
      <View style={{ flexDirection: "row", gap: 6, justifyContent: "center", marginTop: 4 }}>
        {[1, 7, 30, 90].map(d => (
          <Pressable
            key={d}
            onPress={() => setTimePeriod(d)}
            style={{
              backgroundColor: timePeriod === d ? "#00e5ff" : "#111",
              paddingHorizontal: 14,
              paddingVertical: 5,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: timePeriod === d ? "#00e5ff" : "#1a1a1a",
            }}
          >
            <Text style={{ color: timePeriod === d ? "#000" : "#555", fontFamily: "SpaceMono", fontSize: 10, fontWeight: "bold" }}>
              {d}D
            </Text>
          </Pressable>
        ))}
      </View>

      {dossierLoading ? (
        <View style={{ padding: 20, alignItems: "center" }}>
          <ActivityIndicator color="#333" />
          <Text style={{ color: "#333", fontFamily: "SpaceMono", fontSize: 9, marginTop: 6 }}>GENERATING REPORT...</Text>
        </View>
      ) : dossierData?.whatChanged?.newFindingsCount > 0 ? (
        <Card title={`CHANGES (LAST ${timePeriod} DAYS)`}>
          <InfoRow label="New Findings" value={`${dossierData.whatChanged.newFindingsCount}`} valueColor="#00e5ff" />
          {dossierData.whatChanged.highlights?.slice(0, 3).map((h: any, i: number) => (
            <Text key={i} style={{ color: "#777", fontFamily: "SpaceMono", fontSize: 10, marginTop: 2 }}>
              [{h.severity?.toUpperCase()}] {h.title}
            </Text>
          ))}
        </Card>
      ) : null}
    </>
  );
}

// ─── IDENTITY ───
function IdentitySection({ candidates, faceGuesses, dossierData }: { candidates: any[]; faceGuesses: string[]; dossierData: any }) {
  return (
    <>
      <Card title="IDENTITY CANDIDATES">
        {candidates.length === 0 && <EmptyText text="No identity candidates resolved yet. Run a scan." />}
        {candidates.map((c: any, i: number) => (
          <View key={i} style={{ backgroundColor: "#0d0d0d", borderRadius: 8, padding: 12, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: c.confidence > 0.7 ? "#22c55e" : c.confidence > 0.4 ? "#eab308" : "#444" }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
              <Text style={{ color: "#e5e5e5", fontFamily: "SpaceMono", fontSize: 13, fontWeight: "bold" }}>
                {c.name}
              </Text>
              <Text style={{ color: c.confidence > 0.7 ? "#22c55e" : "#eab308", fontFamily: "SpaceMono", fontSize: 12 }}>
                {(c.confidence * 100).toFixed(0)}%
              </Text>
            </View>
            <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 9 }}>
              {c.sourceCount} source(s) // {c.platforms?.join(", ")}
            </Text>
          </View>
        ))}
      </Card>

      {faceGuesses.length > 0 && (
        <Card title="SEARCH ENGINE RESULTS">
          {faceGuesses.map((g: string, i: number) => (
            <Text key={i} style={{ color: "#999", fontFamily: "SpaceMono", fontSize: 11, marginBottom: 3 }}>
              {i + 1}. {g}
            </Text>
          ))}
        </Card>
      )}

      {/* Digital identity from dossier */}
      {dossierData?.subjectOverview && (
        <Card title="KNOWN IDENTIFIERS">
          {dossierData.subjectOverview.names?.length > 0 && <InfoRow label="Names" value={dossierData.subjectOverview.names.join(", ")} />}
          {dossierData.subjectOverview.usernames?.length > 0 && <InfoRow label="Usernames" value={dossierData.subjectOverview.usernames.slice(0, 8).join(", ")} />}
          {dossierData.subjectOverview.emails?.length > 0 && <InfoRow label="Emails" value={dossierData.subjectOverview.emails.join(", ")} />}
          {dossierData.subjectOverview.phones?.length > 0 && <InfoRow label="Phones" value={dossierData.subjectOverview.phones.join(", ")} />}
          {dossierData.subjectOverview.locations?.length > 0 && <InfoRow label="Locations" value={dossierData.subjectOverview.locations.map((l: any) => l.text).filter(Boolean).join("; ")} />}
        </Card>
      )}
    </>
  );
}

// ─── DIGITAL FOOTPRINT ───
function DigitalSection({ dossierData, dossierLoading, metadataFindings }: any) {
  if (dossierLoading) return <View style={{ padding: 40, alignItems: "center" }}><ActivityIndicator color="#333" /></View>;

  return (
    <>
      {dossierData?.digitalFootprint ? (
        <Card title={`DIGITAL FOOTPRINT (${dossierData.digitalFootprint.totalAccounts} ACCOUNTS)`}>
          {Object.entries(dossierData.digitalFootprint.byCategory || {}).map(([cat, accounts]: [string, any]) => (
            accounts.length > 0 && (
              <View key={cat} style={{ marginBottom: 10 }}>
                <Text style={{ color: "#00e5ff", fontFamily: "SpaceMono", fontSize: 9, fontWeight: "bold", letterSpacing: 1, marginBottom: 4 }}>
                  {cat.toUpperCase()} ({accounts.length})
                </Text>
                {accounts.map((a: any, i: number) => (
                  <View key={i} style={{ flexDirection: "row", gap: 8, paddingLeft: 8, marginBottom: 3 }}>
                    <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 10, width: 80 }}>{a.platform}</Text>
                    <Text style={{ color: "#aaa", fontFamily: "SpaceMono", fontSize: 10, flex: 1 }} numberOfLines={1}>
                      {a.value}{a.followers ? ` (${a.followers.toLocaleString()})` : ""}{a.verified ? " [verified]" : ""}
                    </Text>
                  </View>
                ))}
              </View>
            )
          ))}
        </Card>
      ) : (
        <Card title="DIGITAL FOOTPRINT">
          <EmptyText text="No digital footprint data available." />
        </Card>
      )}

      {dossierData?.socialIntelligence?.platformCount > 0 && (
        <Card title={`SOCIAL INTELLIGENCE (${dossierData.socialIntelligence.platformCount} PLATFORMS)`}>
          {Object.values(dossierData.socialIntelligence.platforms || {}).map((p: any, i: number) => (
            <View key={i} style={{ marginBottom: 8, paddingLeft: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
                <Text style={{ color: "#d4d4d4", fontFamily: "SpaceMono", fontSize: 11, fontWeight: "bold" }}>
                  {p.platform}{p.verified ? " [V]" : ""}
                </Text>
                <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 9 }}>
                  {p.displayName || ""}
                </Text>
              </View>
              {p.followers != null && (
                <Text style={{ color: "#444", fontFamily: "SpaceMono", fontSize: 9 }}>
                  {p.followers.toLocaleString()} followers{p.posts ? ` // ${p.posts.toLocaleString()} posts` : ""}
                </Text>
              )}
              {p.bio && (
                <Text style={{ color: "#333", fontFamily: "SpaceMono", fontSize: 9, marginTop: 2 }} numberOfLines={2}>
                  {p.bio.substring(0, 150)}
                </Text>
              )}
            </View>
          ))}
        </Card>
      )}

      {metadataFindings.length > 0 && (
        <Card title="IMAGE METADATA">
          {metadataFindings.map((f: any, i: number) => (
            <View key={i} style={{ marginBottom: 4 }}>
              <Text style={{ color: f.severity === "critical" ? "#ef4444" : f.severity === "high" ? "#f97316" : "#999", fontFamily: "SpaceMono", fontSize: 10 }}>
                {f.title || f.description}
              </Text>
            </View>
          ))}
        </Card>
      )}
    </>
  );
}

// ─── FACE MATCHES ───
function FaceSection({ verifiedMatches, discoveredProfiles, unverifiedMatches }: any) {
  const hasAny = verifiedMatches.length > 0 || discoveredProfiles.length > 0 || unverifiedMatches.length > 0;

  if (!hasAny) {
    return <Card title="FACE MATCHES"><EmptyText text="No face matches found. Run a scan on an image profile." /></Card>;
  }

  return (
    <>
      {verifiedMatches.map((f: any, i: number) => {
        const matches = f.raw_data?.verifiedMatches || [];
        return (
          <Card key={i} title={`VERIFIED MATCHES (${matches.length})`} accent="#ef4444">
            {matches.slice(0, 15).map((m: any, j: number) => (
              <Pressable key={j} onPress={() => m.sourceUrl && Linking.openURL(m.sourceUrl)}>
                <View style={{ backgroundColor: "#0d0d0d", borderRadius: 8, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: m.similarity > 0.7 ? "#ef4444" : "#eab308" }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ color: "#d4d4d4", fontFamily: "SpaceMono", fontSize: 11, flex: 1 }} numberOfLines={1}>
                      {m.title || "Unknown"}
                    </Text>
                    <Text style={{ color: m.similarity > 0.7 ? "#ef4444" : "#eab308", fontFamily: "SpaceMono", fontSize: 10, marginLeft: 8 }}>
                      {(m.similarity * 100).toFixed(1)}%
                    </Text>
                  </View>
                  <Text style={{ color: "#333", fontFamily: "SpaceMono", fontSize: 8, marginTop: 3 }} numberOfLines={1}>
                    {m.sourceUrl} // {m.engine}
                  </Text>
                </View>
              </Pressable>
            ))}
          </Card>
        );
      })}

      {discoveredProfiles.length > 0 && (
        <Card title={`DISCOVERED PROFILES (${discoveredProfiles.length})`} accent="#00e5ff">
          {discoveredProfiles.map((f: any, i: number) => (
            <Pressable key={i} onPress={() => f.source_url && Linking.openURL(f.source_url)}>
              <View style={{ backgroundColor: "#0d0d0d", borderRadius: 8, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: "#00e5ff" }}>
                <Text style={{ color: "#d4d4d4", fontFamily: "SpaceMono", fontSize: 11 }}>
                  {f.raw_data?.platform}: @{f.raw_data?.username}
                </Text>
                <Text style={{ color: "#444", fontFamily: "SpaceMono", fontSize: 9, marginTop: 2 }}>
                  {((f.raw_data?.similarity || 0) * 100).toFixed(1)}% match
                </Text>
              </View>
            </Pressable>
          ))}
        </Card>
      )}

      {unverifiedMatches.map((f: any, i: number) => {
        const urls = f.raw_data?.sourceUrls || [];
        return urls.length > 0 ? (
          <Card key={i} title={`UNVERIFIED PAGES (${urls.length})`} accent="#444">
            {urls.slice(0, 15).map((url: string, j: number) => (
              <Pressable key={j} onPress={() => Linking.openURL(url)}>
                <Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 9, marginBottom: 4 }} numberOfLines={1}>
                  {url}
                </Text>
              </Pressable>
            ))}
          </Card>
        ) : null;
      })}
    </>
  );
}

// ─── SCENE ───
function SceneSection({ findings }: { findings: OsintFinding[] }) {
  if (findings.length === 0) {
    return <Card title="SCENE ANALYSIS"><EmptyText text="No scene analysis available. Requires Gemini Vision API." /></Card>;
  }

  return (
    <>
      {findings.map((f, i) => {
        const a = f.raw_data?.analysis;
        if (!a) {
          return (
            <Card key={i} title="SCENE ANALYSIS">
              <Text style={{ color: "#999", fontFamily: "SpaceMono", fontSize: 10, lineHeight: 16 }}>{f.description}</Text>
            </Card>
          );
        }
        return (
          <View key={i} style={{ gap: 12 }}>
            {a.people?.count > 0 && (
              <Card title="PEOPLE DETECTED">
                <InfoRow label="Count" value={`${a.people.count}`} />
                {(a.people.details || []).map((p: any, j: number) => (
                  <View key={j} style={{ marginTop: 6, paddingLeft: 4 }}>
                    <Text style={{ color: "#999", fontFamily: "SpaceMono", fontSize: 10, fontWeight: "bold" }}>
                      Person {j + 1}: {p.estimated_age_range || "?"}, {p.gender || "?"}
                    </Text>
                    {p.clothing && <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 9, paddingLeft: 8 }}>Clothing: {p.clothing}</Text>}
                    {p.distinguishing_features && <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 9, paddingLeft: 8 }}>Features: {p.distinguishing_features}</Text>}
                  </View>
                ))}
              </Card>
            )}
            {a.location && (
              <Card title="GEOLOCATION ANALYSIS">
                {a.location.estimated_region && <InfoRow label="Region" value={a.location.estimated_region} valueColor="#ffab00" />}
                <InfoRow label="Environment" value={a.location.environment || "Unknown"} />
                {a.location.climate_clues && <InfoRow label="Climate" value={a.location.climate_clues} />}
                <InfoRow label="Confidence" value={a.location.confidence || "Unknown"} />
                {a.location.indicators?.length > 0 && <InfoRow label="Indicators" value={a.location.indicators.join(", ")} />}
              </Card>
            )}
            {(a.organizations?.logos?.length > 0 || a.organizations?.affiliations?.length > 0) && (
              <Card title="ORGANIZATIONS & AFFILIATIONS">
                {a.organizations.logos?.map((l: string, j: number) => <InfoRow key={`l${j}`} label="Logo" value={l} />)}
                {a.organizations.badges?.map((b: string, j: number) => <InfoRow key={`b${j}`} label="Badge" value={b} />)}
                {a.organizations.affiliations?.map((af: string, j: number) => <InfoRow key={`a${j}`} label="Affiliation" value={af} />)}
              </Card>
            )}
            {a.text_ocr && (a.text_ocr.name_tags?.length > 0 || a.text_ocr.signs?.length > 0 || a.text_ocr.documents?.length > 0) && (
              <Card title="TEXT / OCR EXTRACTION">
                {a.text_ocr.name_tags?.map((n: string, j: number) => <InfoRow key={`n${j}`} label="Name Tag" value={n} valueColor="#ef4444" />)}
                {a.text_ocr.signs?.map((s: string, j: number) => <InfoRow key={`s${j}`} label="Sign" value={s} />)}
                {a.text_ocr.documents?.map((d: string, j: number) => <InfoRow key={`d${j}`} label="Document" value={d} />)}
              </Card>
            )}
            {a.context && (
              <Card title="CONTEXTUAL ANALYSIS">
                <InfoRow label="Event" value={a.context.event_type || "Unknown"} />
                <InfoRow label="Time" value={a.context.time_of_day || "Unknown"} />
                {a.context.season && <InfoRow label="Season" value={a.context.season} />}
                {a.context.mood && <InfoRow label="Mood" value={a.context.mood} />}
              </Card>
            )}
            {a.landmarks?.length > 0 && (
              <Card title="LANDMARKS">
                {a.landmarks.map((l: string, j: number) => <InfoRow key={j} label={`#${j + 1}`} value={l} valueColor="#ffab00" />)}
              </Card>
            )}
            {a.intelligence_notes && (
              <Card title="ANALYST NOTES">
                <Text style={{ color: "#999", fontFamily: "SpaceMono", fontSize: 10, lineHeight: 16 }}>{a.intelligence_notes}</Text>
              </Card>
            )}
          </View>
        );
      })}
    </>
  );
}

// ─── THREATS ───
function ThreatSection({ findings, criticalCount, highCount, mediumCount, dossierData, pivotRecs }: any) {
  const threatColor = criticalCount > 0 ? "#ef4444" : highCount > 0 ? "#f97316" : "#22c55e";
  const threatLevel = criticalCount > 0 ? "HIGH" : highCount > 0 ? "MODERATE" : "LOW";
  const criticalFindings = findings.filter((f: any) => f.severity === "critical");
  const highFindings = findings.filter((f: any) => f.severity === "high");

  return (
    <>
      <Card title="THREAT LEVEL">
        <View style={{ backgroundColor: threatColor + "12", borderRadius: 8, padding: 14, alignItems: "center", marginBottom: 10, borderWidth: 1, borderColor: threatColor + "25" }}>
          <Text style={{ color: threatColor, fontFamily: "SpaceMono", fontSize: 20, fontWeight: "bold", letterSpacing: 3 }}>
            {threatLevel}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ThreatPill value={criticalCount} label="CRITICAL" color="#ef4444" />
          <ThreatPill value={highCount} label="HIGH" color="#f97316" />
          <ThreatPill value={mediumCount} label="MEDIUM" color="#eab308" />
        </View>
      </Card>

      {criticalFindings.length > 0 && (
        <Card title="CRITICAL FINDINGS" accent="#ef4444">
          {criticalFindings.map((f: any, i: number) => (
            <View key={i} style={{ backgroundColor: "#0d0d0d", borderRadius: 6, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: "#ef4444" }}>
              <Text style={{ color: "#e5e5e5", fontFamily: "SpaceMono", fontSize: 10, fontWeight: "bold" }}>{f.title}</Text>
              {f.description && <Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 9, marginTop: 3 }} numberOfLines={2}>{f.description}</Text>}
            </View>
          ))}
        </Card>
      )}

      {highFindings.length > 0 && (
        <Card title="HIGH SEVERITY FINDINGS" accent="#f97316">
          {highFindings.slice(0, 10).map((f: any, i: number) => (
            <View key={i} style={{ backgroundColor: "#0d0d0d", borderRadius: 6, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: "#f97316" }}>
              <Text style={{ color: "#d4d4d4", fontFamily: "SpaceMono", fontSize: 10, fontWeight: "bold" }}>{f.title}</Text>
              {f.description && <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 9, marginTop: 3 }} numberOfLines={2}>{f.description}</Text>}
            </View>
          ))}
        </Card>
      )}

      {/* Exposure data from dossier */}
      {dossierData?.exposureAssessment && (
        <Card title="EXPOSURE ASSESSMENT">
          <InfoRow label="Breaches" value={`${dossierData.exposureAssessment.breachCount || 0}`} valueColor={dossierData.exposureAssessment.breachCount > 0 ? "#ef4444" : undefined} />
          <InfoRow label="Data Brokers" value={`${dossierData.exposureAssessment.dataBrokerCount || 0}`} />
          <InfoRow label="Paste/Leaks" value={`${(dossierData.exposureAssessment.pasteExposure || 0) + (dossierData.exposureAssessment.leakExposure || 0)}`} />
          {dossierData.exposureAssessment.breaches?.slice(0, 5).map((b: any, i: number) => (
            <Text key={i} style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 9, paddingLeft: 8, marginTop: 2 }}>
              [{b.severity}] {b.title}
            </Text>
          ))}
        </Card>
      )}

      {/* Pivot recommendations */}
      {pivotRecs.length > 0 && (
        <Card title={`INVESTIGATION LEADS (${pivotRecs.length})`} accent="#22c55e">
          {pivotRecs.slice(0, 8).map((f: any, i: number) => (
            <View key={i} style={{ backgroundColor: "#0d0d0d", borderRadius: 6, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: f.raw_data?.autoExecute ? "#22c55e" : "#333" }}>
              <Text style={{ color: "#d4d4d4", fontFamily: "SpaceMono", fontSize: 10 }}>{f.title}</Text>
              {f.raw_data?.pivotValue && (
                <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 9, marginTop: 2 }}>
                  {f.raw_data.pivotType}: {f.raw_data.pivotValue}
                </Text>
              )}
            </View>
          ))}
        </Card>
      )}
    </>
  );
}

// ─── EKF Card ───
const EKF_ATTRS: Record<string, { label: string; isPercent?: boolean }> = {
  identity_certainty: { label: "Identity Certainty", isPercent: true },
  name_confidence: { label: "Name Confidence", isPercent: true },
  location_confidence: { label: "Location", isPercent: true },
  employer_confidence: { label: "Employer", isPercent: true },
  online_presence: { label: "Online Presence" },
  threat_level: { label: "Threat Level" },
};

function EkfCard({ summary }: { summary: EkfSummary }) {
  const ci = summary.confidence_intervals || {};
  return (
    <Card title="INTELLIGENCE FUSION (EKF)">
      <Text style={{ color: "#333", fontFamily: "SpaceMono", fontSize: 8, marginBottom: 10 }}>
        {summary.observations} observations fused
      </Text>
      {Object.entries(EKF_ATTRS).map(([key, { label, isPercent }]) => {
        const ciData = ci[key];
        const value = ciData?.value ?? 0;
        const barValue = isPercent ? Math.min(1, Math.max(0, value)) : Math.min(1, Math.max(0, value / 100));
        const barColor = barValue > 0.7 ? "#22c55e" : barValue > 0.4 ? "#eab308" : "#ef4444";
        const displayVal = isPercent ? `${(value * 100).toFixed(0)}%` : value.toFixed(1);
        return (
          <View key={key} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
              <Text style={{ color: "#777", fontFamily: "SpaceMono", fontSize: 9 }}>{label}</Text>
              <Text style={{ color: "#d4d4d4", fontFamily: "SpaceMono", fontSize: 9, fontWeight: "bold" }}>{displayVal}</Text>
            </View>
            <View style={{ height: 4, backgroundColor: "#151515", borderRadius: 2, overflow: "hidden" }}>
              <View style={{ height: 4, width: `${barValue * 100}%`, backgroundColor: barColor, borderRadius: 2 }} />
            </View>
          </View>
        );
      })}
    </Card>
  );
}

// ─── Shared UI Components ───

function Card({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: "#0f0f0f", borderRadius: 10, padding: 14, borderWidth: 1, borderColor: "#181818" }}>
      <Text style={{ color: accent || "#00e5ff", fontFamily: "SpaceMono", fontSize: 10, fontWeight: "bold", letterSpacing: 1.5, marginBottom: 10 }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function InfoRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={{ flexDirection: "row", marginBottom: 4 }}>
      <Text style={{ color: "#404040", fontFamily: "SpaceMono", fontSize: 10, width: 100 }}>{label}</Text>
      <Text style={{ color: valueColor || "#888", fontFamily: "SpaceMono", fontSize: 10, flex: 1 }}>{value || "---"}</Text>
    </View>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: "#0f0f0f", borderRadius: 8, padding: 10, alignItems: "center", borderWidth: 1, borderColor: "#181818" }}>
      <Text style={{ color, fontFamily: "SpaceMono", fontSize: 18, fontWeight: "bold" }}>{value}</Text>
      <Text style={{ color: "#333", fontFamily: "SpaceMono", fontSize: 7, letterSpacing: 0.5, marginTop: 2 }}>{label}</Text>
    </View>
  );
}

function ThreatPill({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", backgroundColor: value > 0 ? color + "10" : "#0d0d0d", borderRadius: 6, padding: 8, borderWidth: 1, borderColor: value > 0 ? color + "20" : "#151515" }}>
      <Text style={{ color: value > 0 ? color : "#333", fontFamily: "SpaceMono", fontSize: 16, fontWeight: "bold" }}>{value}</Text>
      <Text style={{ color: "#404040", fontFamily: "SpaceMono", fontSize: 7 }}>{label}</Text>
    </View>
  );
}

function EmptyText({ text }: { text: string }) {
  return <Text style={{ color: "#333", fontFamily: "SpaceMono", fontSize: 10 }}>{text}</Text>;
}
