import { View, Text, ScrollView, Pressable, Image, Linking } from "react-native";
import { useState } from "react";
import { getBridgeUrl, getAuthHeaders, type OsintProfile, type OsintFinding } from "../../lib/bridge-api";
import { EKFDashboard } from "./EKFDashboard";

interface Props {
  profile: OsintProfile;
  findings: OsintFinding[];
  onBack: () => void;
}

type Section = "overview" | "identity" | "faces" | "scene" | "metadata" | "pivots";

export function IntelDossier({ profile, findings, onBack }: Props) {
  const [activeSection, setActiveSection] = useState<Section>("overview");

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

  const sections: { key: Section; label: string; count: number }[] = [
    { key: "overview", label: "OVERVIEW", count: 0 },
    { key: "identity", label: "IDENTITY", count: identityCandidates?.raw_data?.candidates?.length || 0 },
    { key: "faces", label: "FACE MATCHES", count: (verifiedMatches[0]?.raw_data?.verifiedMatches?.length || 0) + discoveredProfiles.length + (unverifiedMatches[0]?.raw_data?.sourceUrls?.length || 0) },
    { key: "scene", label: "SCENE", count: sceneFindings.length },
    { key: "metadata", label: "METADATA", count: metadataFindings.length },
    { key: "pivots", label: "PIVOTS", count: pivotRecs.length },
  ];

  return (
    <View style={{ flex: 1 }}>
      {/* Header with back + subject */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 12 }}>
        <Pressable onPress={onBack} style={{ padding: 4 }}>
          <Text style={{ color: "#00e5ff", fontFamily: "SpaceMono", fontSize: 14 }}>{"< BACK"}</Text>
        </Pressable>
        <Image
          source={{ uri: imageUrl, headers: getAuthHeaders() }}
          style={{ width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: "#444" }}
        />
        <View style={{ flex: 1 }}>
          <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 13, fontWeight: "bold", textTransform: "uppercase" }} numberOfLines={1}>
            {identityName}
          </Text>
          <Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 9 }}>
            INTELLIGENCE DOSSIER
          </Text>
        </View>
      </View>

      {/* Section tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 36, marginBottom: 8 }}>
        {sections.map(s => (
          <Pressable
            key={s.key}
            onPress={() => setActiveSection(s.key)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              marginRight: 4,
              borderRadius: 4,
              backgroundColor: activeSection === s.key ? "#1a3a5c" : "#1a1a1a",
              borderWidth: 1,
              borderColor: activeSection === s.key ? "#00e5ff" : "#333",
            }}
          >
            <Text style={{
              color: activeSection === s.key ? "#00e5ff" : "#888",
              fontFamily: "SpaceMono",
              fontSize: 10,
              fontWeight: "bold",
            }}>
              {s.label}{s.count > 0 ? ` (${s.count})` : ""}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Section content */}
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        {activeSection === "overview" && (
          <OverviewSection
            findings={findings}
            profileId={profile.id}
            identityName={identityName}
            topCandidate={topCandidate}
            faceSearchIdentity={faceSearchIdentity}
            criticalCount={criticalCount}
            highCount={highCount}
            discoveredProfiles={discoveredProfiles}
            sceneFindings={sceneFindings}
          />
        )}
        {activeSection === "identity" && (
          <IdentitySection candidates={identityCandidates?.raw_data?.candidates || []} faceGuesses={faceSearchIdentity?.raw_data?.identityGuesses || []} />
        )}
        {activeSection === "faces" && (
          <FaceMatchSection verifiedMatches={verifiedMatches} discoveredProfiles={discoveredProfiles} unverifiedMatches={unverifiedMatches} />
        )}
        {activeSection === "scene" && (
          <SceneSection findings={sceneFindings} />
        )}
        {activeSection === "metadata" && (
          <MetadataSection findings={metadataFindings} />
        )}
        {activeSection === "pivots" && (
          <PivotSection pivots={pivotRecs} />
        )}
      </ScrollView>
    </View>
  );
}

// ─── OVERVIEW ───
function OverviewSection({ findings, profileId, identityName, topCandidate, faceSearchIdentity, criticalCount, highCount, discoveredProfiles, sceneFindings }: any) {
  const guesses = faceSearchIdentity?.raw_data?.identityGuesses || [];

  return (
    <View style={{ gap: 12 }}>
      {/* Classification banner */}
      <View style={{ backgroundColor: "#1a0000", borderWidth: 1, borderColor: "#f4433633", borderRadius: 8, padding: 12, alignItems: "center" }}>
        <Text style={{ color: "#f44336", fontFamily: "SpaceMono", fontSize: 10, fontWeight: "bold", letterSpacing: 3 }}>
          CLASSIFIED INTELLIGENCE ASSESSMENT
        </Text>
      </View>

      {/* Subject summary */}
      <Card title="SUBJECT IDENTIFICATION">
        <Row label="Primary Name" value={identityName.toUpperCase()} color="#fff" />
        {topCandidate && <Row label="Confidence" value={`${(topCandidate.confidence * 100).toFixed(0)}%`} color={topCandidate.confidence > 0.7 ? "#4caf50" : "#ffab00"} />}
        {topCandidate && <Row label="Source Count" value={`${topCandidate.sourceCount} independent source(s)`} />}
        {guesses.length > 0 && <Row label="Aliases" value={guesses.slice(0, 5).join(", ")} />}
      </Card>

      {/* Threat summary */}
      <Card title="THREAT ASSESSMENT">
        <Row label="Critical Findings" value={`${criticalCount}`} color={criticalCount > 0 ? "#f44336" : "#4caf50"} />
        <Row label="High Findings" value={`${highCount}`} color={highCount > 0 ? "#ff9800" : "#4caf50"} />
        <Row label="Total Findings" value={`${findings.length}`} />
        <Row label="Discovered Profiles" value={`${discoveredProfiles.length}`} color={discoveredProfiles.length > 0 ? "#00e5ff" : "#666"} />
      </Card>

      {/* Scene intel */}
      {sceneFindings.length > 0 && (
        <Card title="SCENE INTELLIGENCE">
          {sceneFindings.map((f: any, i: number) => {
            const a = f.raw_data?.analysis;
            if (!a) return null;
            return (
              <View key={i}>
                {a.location?.estimated_region && <Row label="Location" value={a.location.estimated_region} color="#ffab00" />}
                {a.context?.event_type && <Row label="Context" value={a.context.event_type} />}
                {a.people?.count > 0 && <Row label="People" value={`${a.people.count} detected`} />}
                {a.organizations?.logos?.length > 0 && <Row label="Organizations" value={a.organizations.logos.join(", ")} />}
              </View>
            );
          })}
        </Card>
      )}

      {/* EKF confidence dashboard */}
      <EKFDashboard profileId={profileId} />
    </View>
  );
}

// ─── IDENTITY ───
function IdentitySection({ candidates, faceGuesses }: { candidates: any[]; faceGuesses: string[] }) {
  return (
    <View style={{ gap: 12 }}>
      <Card title="IDENTITY CANDIDATES">
        {candidates.length === 0 && <Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 11 }}>No identity candidates resolved yet.</Text>}
        {candidates.map((c: any, i: number) => (
          <View key={i} style={{ backgroundColor: "#0a0a0a", borderRadius: 6, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: c.confidence > 0.7 ? "#4caf50" : c.confidence > 0.4 ? "#ffab00" : "#666" }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
              <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 13, fontWeight: "bold" }}>
                {c.name}
              </Text>
              <Text style={{ color: c.confidence > 0.7 ? "#4caf50" : "#ffab00", fontFamily: "SpaceMono", fontSize: 12 }}>
                {(c.confidence * 100).toFixed(0)}%
              </Text>
            </View>
            <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 9 }}>
              {c.sourceCount} source(s): {c.platforms?.join(", ")}
            </Text>
          </View>
        ))}
      </Card>

      {faceGuesses.length > 0 && (
        <Card title="SEARCH ENGINE GUESSES">
          {faceGuesses.map((g: string, i: number) => (
            <Text key={i} style={{ color: "#ccc", fontFamily: "SpaceMono", fontSize: 11, marginBottom: 4 }}>
              {i + 1}. {g}
            </Text>
          ))}
        </Card>
      )}
    </View>
  );
}

// ─── FACE MATCHES ───
function FaceMatchSection({ verifiedMatches, discoveredProfiles, unverifiedMatches }: any) {
  return (
    <View style={{ gap: 12 }}>
      {verifiedMatches.map((f: any, i: number) => {
        const matches = f.raw_data?.verifiedMatches || [];
        return (
          <Card key={i} title={`VERIFIED FACE MATCHES (${matches.length})`} titleColor="#f44336">
            {matches.slice(0, 15).map((m: any, j: number) => (
              <Pressable key={j} onPress={() => m.sourceUrl && Linking.openURL(m.sourceUrl)} style={{ backgroundColor: "#0a0a0a", borderRadius: 6, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: m.similarity > 0.7 ? "#f44336" : "#ffab00" }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 12, flex: 1 }} numberOfLines={1}>
                    {m.title || "Unknown"}
                  </Text>
                  <Text style={{ color: m.similarity > 0.7 ? "#f44336" : "#ffab00", fontFamily: "SpaceMono", fontSize: 11, marginLeft: 8 }}>
                    {(m.similarity * 100).toFixed(1)}%
                  </Text>
                </View>
                <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 9, marginTop: 2 }} numberOfLines={1}>
                  {m.sourceUrl} ({m.engine})
                </Text>
              </Pressable>
            ))}
          </Card>
        );
      })}

      {discoveredProfiles.length > 0 && (
        <Card title={`DISCOVERED PROFILES (${discoveredProfiles.length})`} titleColor="#00e5ff">
          {discoveredProfiles.map((f: any, i: number) => (
            <Pressable key={i} onPress={() => f.source_url && Linking.openURL(f.source_url)} style={{ backgroundColor: "#0a0a0a", borderRadius: 6, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: "#00e5ff" }}>
              <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 12 }}>
                {f.raw_data?.platform}: @{f.raw_data?.username}
              </Text>
              <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 9, marginTop: 2 }}>
                Similarity: {((f.raw_data?.similarity || 0) * 100).toFixed(1)}%
              </Text>
            </Pressable>
          ))}
        </Card>
      )}

      {unverifiedMatches.map((f: any, i: number) => {
        const urls = f.raw_data?.sourceUrls || [];
        return (
          <Card key={i} title={`UNVERIFIED PAGES (${urls.length})`} titleColor="#666">
            {urls.slice(0, 15).map((url: string, j: number) => (
              <Pressable key={j} onPress={() => Linking.openURL(url)} style={{ marginBottom: 4 }}>
                <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 10 }} numberOfLines={1}>
                  {url}
                </Text>
              </Pressable>
            ))}
          </Card>
        );
      })}

      {verifiedMatches.length === 0 && discoveredProfiles.length === 0 && unverifiedMatches.length === 0 && (
        <Card title="FACE MATCHES">
          <Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 11 }}>No face matches found yet. Run a scan on an image profile.</Text>
        </Card>
      )}
    </View>
  );
}

// ─── SCENE ───
function SceneSection({ findings }: { findings: OsintFinding[] }) {
  if (findings.length === 0) {
    return <Card title="SCENE ANALYSIS"><Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 11 }}>No scene analysis available. Gemini Vision API required.</Text></Card>;
  }

  return (
    <View style={{ gap: 12 }}>
      {findings.map((f, i) => {
        const a = f.raw_data?.analysis;
        if (!a) return <Card key={i} title="SCENE ANALYSIS"><Text style={{ color: "#ccc", fontFamily: "SpaceMono", fontSize: 11, lineHeight: 18 }}>{f.description}</Text></Card>;
        return (
          <View key={i} style={{ gap: 12 }}>
            {a.people?.count > 0 && (
              <Card title="PEOPLE">
                <Row label="Count" value={`${a.people.count}`} />
                {(a.people.details || []).map((p: any, j: number) => (
                  <View key={j} style={{ marginTop: 4 }}>
                    <Row label={`Person ${j + 1}`} value={`${p.estimated_age_range || "?"}, ${p.gender || "?"}`} />
                    {p.clothing && <Row label="  Clothing" value={p.clothing} />}
                    {p.distinguishing_features && <Row label="  Features" value={p.distinguishing_features} />}
                  </View>
                ))}
              </Card>
            )}
            {a.location && (
              <Card title="LOCATION ANALYSIS">
                {a.location.estimated_region && <Row label="Region" value={a.location.estimated_region} color="#ffab00" />}
                <Row label="Environment" value={a.location.environment || "Unknown"} />
                {a.location.climate_clues && <Row label="Climate" value={a.location.climate_clues} />}
                <Row label="Confidence" value={a.location.confidence || "Unknown"} />
                {a.location.indicators?.length > 0 && <Row label="Indicators" value={a.location.indicators.join(", ")} />}
              </Card>
            )}
            {(a.organizations?.logos?.length > 0 || a.organizations?.affiliations?.length > 0) && (
              <Card title="ORGANIZATIONS">
                {a.organizations.logos?.map((l: string, j: number) => <Row key={`l${j}`} label="Logo" value={l} />)}
                {a.organizations.badges?.map((b: string, j: number) => <Row key={`b${j}`} label="Badge" value={b} />)}
                {a.organizations.affiliations?.map((af: string, j: number) => <Row key={`a${j}`} label="Affiliation" value={af} />)}
              </Card>
            )}
            {a.text_ocr && (a.text_ocr.name_tags?.length > 0 || a.text_ocr.signs?.length > 0 || a.text_ocr.documents?.length > 0) && (
              <Card title="TEXT / OCR">
                {a.text_ocr.name_tags?.map((n: string, j: number) => <Row key={`n${j}`} label="Name Tag" value={n} color="#f44336" />)}
                {a.text_ocr.signs?.map((s: string, j: number) => <Row key={`s${j}`} label="Sign" value={s} />)}
                {a.text_ocr.documents?.map((d: string, j: number) => <Row key={`d${j}`} label="Document" value={d} />)}
              </Card>
            )}
            {a.context && (
              <Card title="CONTEXT">
                <Row label="Event" value={a.context.event_type || "Unknown"} />
                <Row label="Time" value={a.context.time_of_day || "Unknown"} />
                {a.context.season && <Row label="Season" value={a.context.season} />}
                {a.context.mood && <Row label="Mood" value={a.context.mood} />}
              </Card>
            )}
            {a.landmarks?.length > 0 && (
              <Card title="LANDMARKS">
                {a.landmarks.map((l: string, j: number) => <Row key={j} label={`Landmark ${j + 1}`} value={l} color="#ffab00" />)}
              </Card>
            )}
            {a.intelligence_notes && (
              <Card title="ANALYST NOTES">
                <Text style={{ color: "#ccc", fontFamily: "SpaceMono", fontSize: 11, lineHeight: 18 }}>{a.intelligence_notes}</Text>
              </Card>
            )}
          </View>
        );
      })}
    </View>
  );
}

// ─── METADATA ───
function MetadataSection({ findings }: { findings: OsintFinding[] }) {
  if (findings.length === 0) {
    return <Card title="METADATA"><Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 11 }}>No metadata extracted.</Text></Card>;
  }
  return (
    <View style={{ gap: 12 }}>
      {findings.map((f, i) => (
        <Card key={i} title={f.title || "METADATA"} titleColor={f.severity === "critical" ? "#f44336" : f.severity === "high" ? "#ff9800" : undefined}>
          {f.description ? (
            <Text style={{ color: "#ccc", fontFamily: "SpaceMono", fontSize: 11, lineHeight: 16 }}>{f.description}</Text>
          ) : (
            <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 10 }}>{JSON.stringify(f.raw_data, null, 2).substring(0, 500)}</Text>
          )}
        </Card>
      ))}
    </View>
  );
}

// ─── PIVOTS ───
function PivotSection({ pivots }: { pivots: OsintFinding[] }) {
  if (pivots.length === 0) {
    return <Card title="PIVOT RECOMMENDATIONS"><Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 11 }}>No pivot recommendations generated.</Text></Card>;
  }

  const namePivots = pivots.filter(p => p.raw_data?.pivotType === "name_variants");
  const usernamePivots = pivots.filter(p => p.raw_data?.pivotType === "username");
  const emailPivots = pivots.filter(p => p.raw_data?.pivotType === "email");

  return (
    <View style={{ gap: 12 }}>
      {namePivots.length > 0 && (
        <Card title={`NAME VARIANT PIVOTS (${namePivots.length})`} titleColor="#4caf50">
          {namePivots.map((p, i) => (
            <View key={i} style={{ marginBottom: 8 }}>
              <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 12, fontWeight: "bold" }}>{p.raw_data?.fullName}</Text>
              <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 10, marginTop: 2 }}>
                Variants: {p.raw_data?.variants?.join(", ")}
              </Text>
              {p.raw_data?.autoExecute && <Text style={{ color: "#4caf50", fontFamily: "SpaceMono", fontSize: 9, marginTop: 2 }}>AUTO-EXECUTE</Text>}
            </View>
          ))}
        </Card>
      )}
      {usernamePivots.length > 0 && (
        <Card title={`USERNAME PIVOTS (${usernamePivots.length})`}>
          {usernamePivots.map((p, i) => (
            <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
              <Text style={{ color: "#ccc", fontFamily: "SpaceMono", fontSize: 11 }}>{p.raw_data?.pivotValue}</Text>
              <Text style={{ color: p.raw_data?.autoExecute ? "#4caf50" : "#666", fontFamily: "SpaceMono", fontSize: 9 }}>
                {(p.raw_data?.confidence * 100 || 0).toFixed(0)}%
              </Text>
            </View>
          ))}
        </Card>
      )}
      {emailPivots.length > 0 && (
        <Card title={`EMAIL PIVOTS (${emailPivots.length})`}>
          {emailPivots.map((p, i) => (
            <View key={i} style={{ marginBottom: 4 }}>
              <Text style={{ color: "#ccc", fontFamily: "SpaceMono", fontSize: 11 }}>{p.raw_data?.pivotValue}</Text>
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}

// ─── Shared UI ───
function Card({ title, titleColor, children }: { title: string; titleColor?: string; children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: "#111", borderRadius: 8, padding: 12, borderWidth: 1, borderColor: "#222" }}>
      <Text style={{ color: titleColor || "#00e5ff", fontFamily: "SpaceMono", fontSize: 11, fontWeight: "bold", letterSpacing: 1, marginBottom: 8 }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flexDirection: "row", marginBottom: 4 }}>
      <Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 10, width: 120 }}>{label}</Text>
      <Text style={{ color: color || "#ccc", fontFamily: "SpaceMono", fontSize: 10, flex: 1 }}>{value}</Text>
    </View>
  );
}
