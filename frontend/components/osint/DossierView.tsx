import { useState, useEffect, useCallback } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, Share } from "react-native";
import { apiFetch } from "../../lib/bridge-api";

interface DossierSection {
  [key: string]: any;
}

interface Dossier {
  metadata: {
    generatedAt: string;
    timeWindow: number;
    profileLabel: string;
    totalFindings: number;
    windowFindings: number;
    classification: string;
  };
  subjectOverview: DossierSection;
  digitalFootprint: DossierSection;
  exposureAssessment: DossierSection;
  socialIntelligence: DossierSection;
  threatAssessment: DossierSection;
  identityCorrelation: DossierSection;
  remediationStatus: DossierSection;
  whatChanged: DossierSection;
}

const PERIODS = [
  { key: 1, label: "1D" },
  { key: 7, label: "7D" },
  { key: 30, label: "30D" },
  { key: 90, label: "90D" },
];

const SECTIONS = [
  { key: "subjectOverview", label: "SUBJECT OVERVIEW", emoji: "👤" },
  { key: "digitalFootprint", label: "DIGITAL FOOTPRINT", emoji: "🌐" },
  { key: "exposureAssessment", label: "EXPOSURE ASSESSMENT", emoji: "🔓" },
  { key: "socialIntelligence", label: "SOCIAL INTELLIGENCE", emoji: "📱" },
  { key: "threatAssessment", label: "THREAT ASSESSMENT", emoji: "⚠️" },
  { key: "identityCorrelation", label: "IDENTITY CORRELATION", emoji: "🔗" },
  { key: "remediationStatus", label: "REMEDIATION STATUS", emoji: "🔧" },
  { key: "whatChanged", label: "WHAT CHANGED", emoji: "📊" },
];

const THREAT_COLORS: Record<string, string> = {
  LOW: "#22C55E",
  MODERATE: "#EAB308",
  HIGH: "#F97316",
  CRITICAL: "#EF4444",
};

interface Props {
  profileId?: number;
}

export function DossierView({ profileId }: Props) {
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["subjectOverview", "digitalFootprint"]));
  const [error, setError] = useState<string | null>(null);

  const fetchDossier = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const endpoint = profileId
        ? `/osint/dossier/${profileId}?days=${days}`
        : `/osint/dossier?days=${days}`;
      const data = await apiFetch(endpoint);
      setDossier(data.dossier);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [profileId, days]);

  useEffect(() => {
    fetchDossier();
  }, [fetchDossier]);

  const toggleSection = (key: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleShare = async () => {
    if (!dossier) return;
    try {
      const endpoint = profileId
        ? `/osint/dossier/${profileId}?days=${days}&format=markdown`
        : `/osint/dossier?days=${days}&format=markdown`;
      const res = await fetch(endpoint);
      const md = await res.text();
      await Share.share({ message: md, title: "Intelligence Dossier" });
    } catch (_) {}
  };

  if (loading) {
    return (
      <View style={{ padding: 40, alignItems: "center" }}>
        <ActivityIndicator color="#06B6D4" />
        <Text style={{ color: "#737373", fontSize: 11, fontFamily: "monospace", marginTop: 8 }}>
          GENERATING DOSSIER...
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ padding: 40, alignItems: "center" }}>
        <Text style={{ color: "#EF4444", fontSize: 12, fontFamily: "monospace" }}>
          {error}
        </Text>
        <Pressable onPress={fetchDossier} style={{ marginTop: 12, padding: 8 }}>
          <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace" }}>RETRY</Text>
        </Pressable>
      </View>
    );
  }

  if (!dossier) return null;

  return (
    <View style={{ gap: 12 }}>
      {/* Classification header */}
      <View style={{ backgroundColor: "#1A0000", borderWidth: 1, borderColor: "#8B0000", borderRadius: 8, padding: 12, alignItems: "center" }}>
        <Text style={{ color: "#EF4444", fontSize: 10, fontFamily: "monospace", letterSpacing: 4, fontWeight: "bold" }}>
          {dossier.metadata.classification}
        </Text>
        <Text style={{ color: "#A3A3A3", fontSize: 14, fontFamily: "monospace", fontWeight: "bold", marginTop: 4 }}>
          INTELLIGENCE DOSSIER
        </Text>
        <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace", marginTop: 2 }}>
          {dossier.metadata.profileLabel} — {new Date(dossier.metadata.generatedAt).toLocaleDateString()}
        </Text>
      </View>

      {/* Period selector */}
      <View style={{ flexDirection: "row", gap: 6, justifyContent: "center" }}>
        {PERIODS.map(p => (
          <Pressable
            key={p.key}
            onPress={() => setDays(p.key)}
            style={{
              backgroundColor: days === p.key ? "#06B6D4" : "#1A1A1A",
              paddingHorizontal: 16, paddingVertical: 6, borderRadius: 6,
              borderWidth: 1, borderColor: days === p.key ? "#06B6D4" : "#333",
            }}
          >
            <Text style={{
              color: days === p.key ? "#000" : "#737373",
              fontSize: 11, fontFamily: "monospace", fontWeight: "bold",
            }}>{p.label}</Text>
          </Pressable>
        ))}
      </View>

      {/* Summary stats bar */}
      <View style={{ flexDirection: "row", gap: 6 }}>
        <StatBox label="FINDINGS" value={dossier.metadata.totalFindings} color="#06B6D4" />
        <StatBox label="ACCOUNTS" value={dossier.digitalFootprint.totalAccounts} color="#22C55E" />
        <StatBox label="EXPOSURE" value={dossier.exposureAssessment.exposureLevel} color={THREAT_COLORS[dossier.exposureAssessment.exposureLevel] || "#6B7280"} small />
        <StatBox label="THREAT" value={dossier.threatAssessment.threatLevel} color={THREAT_COLORS[dossier.threatAssessment.threatLevel] || "#6B7280"} small />
      </View>

      {/* Collapsible sections */}
      {SECTIONS.map(section => {
        const isExpanded = expandedSections.has(section.key);
        const sectionData = (dossier as any)[section.key];
        if (!sectionData) return null;

        return (
          <View key={section.key} style={{ backgroundColor: "#111111", borderRadius: 10, borderWidth: 1, borderColor: "#222" }}>
            <Pressable
              onPress={() => toggleSection(section.key)}
              style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 8 }}
            >
              <Text style={{ fontSize: 16 }}>{section.emoji}</Text>
              <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", flex: 1, letterSpacing: 1 }}>
                {section.label}
              </Text>
              <Text style={{ color: "#525252", fontSize: 10 }}>{isExpanded ? "▲" : "▼"}</Text>
            </Pressable>

            {isExpanded && (
              <View style={{ borderTopWidth: 1, borderTopColor: "#222", padding: 12, gap: 6 }}>
                <SectionContent sectionKey={section.key} data={sectionData} />
              </View>
            )}
          </View>
        );
      })}

      {/* Share button */}
      <Pressable onPress={handleShare} style={{ backgroundColor: "#1A1A1A", borderRadius: 8, padding: 12, alignItems: "center", borderWidth: 1, borderColor: "#333" }}>
        <Text style={{ color: "#06B6D4", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
          EXPORT DOSSIER
        </Text>
      </Pressable>
    </View>
  );
}

function StatBox({ label, value, color, small }: { label: string; value: any; color: string; small?: boolean }) {
  return (
    <View style={{ flex: 1, backgroundColor: "#1A1A1A", borderRadius: 8, padding: 8, alignItems: "center" }}>
      <Text style={{ color, fontSize: small ? 11 : 16, fontFamily: "monospace", fontWeight: "bold" }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </Text>
      <Text style={{ color: "#525252", fontSize: 8, fontFamily: "monospace" }}>{label}</Text>
    </View>
  );
}

function SectionContent({ sectionKey, data }: { sectionKey: string; data: any }) {
  switch (sectionKey) {
    case "subjectOverview":
      return (
        <View style={{ gap: 4 }}>
          <InfoRow label="PRIMARY" value={data.primaryIdentity} />
          {data.names?.length > 0 && <InfoRow label="NAMES" value={data.names.join(", ")} />}
          {data.usernames?.length > 0 && <InfoRow label="USERNAMES" value={data.usernames.slice(0, 10).join(", ")} />}
          {data.emails?.length > 0 && <InfoRow label="EMAILS" value={data.emails.join(", ")} />}
          {data.phones?.length > 0 && <InfoRow label="PHONES" value={data.phones.join(", ")} />}
          {data.locations?.length > 0 && <InfoRow label="LOCATIONS" value={data.locations.map((l: any) => l.text).filter(Boolean).join("; ")} />}
          <InfoRow label="PROFILES" value={String(data.profileCount)} />
        </View>
      );

    case "digitalFootprint":
      return (
        <View style={{ gap: 6 }}>
          <InfoRow label="TOTAL ACCOUNTS" value={String(data.totalAccounts)} />
          {Object.entries(data.byCategory || {}).map(([cat, accounts]: [string, any]) => (
            accounts.length > 0 && (
              <View key={cat} style={{ gap: 2, marginTop: 4 }}>
                <Text style={{ color: "#A3A3A3", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
                  {cat.toUpperCase()} ({accounts.length})
                </Text>
                {accounts.map((a: any, i: number) => (
                  <Text key={i} style={{ color: "#737373", fontSize: 10, fontFamily: "monospace", paddingLeft: 8 }}>
                    {a.platform}: {a.value}{a.followers ? ` (${a.followers.toLocaleString()})` : ""}{a.verified ? " ✓" : ""}
                  </Text>
                ))}
              </View>
            )
          ))}
        </View>
      );

    case "exposureAssessment":
      return (
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <LevelBadge label={data.exposureLevel} color={THREAT_COLORS[data.exposureLevel] || "#6B7280"} />
          </View>
          <InfoRow label="BREACHES" value={String(data.breachCount)} />
          <InfoRow label="DATA BROKERS" value={String(data.dataBrokerCount)} />
          <InfoRow label="PASTE/LEAKS" value={String(data.pasteExposure + data.leakExposure)} />
          {data.breaches?.slice(0, 5).map((b: any, i: number) => (
            <Text key={i} style={{ color: "#737373", fontSize: 10, fontFamily: "monospace", paddingLeft: 8 }}>
              [{b.severity}] {b.title}
            </Text>
          ))}
        </View>
      );

    case "socialIntelligence":
      return (
        <View style={{ gap: 4 }}>
          <InfoRow label="PLATFORMS" value={String(data.platformCount)} />
          {Object.values(data.platforms || {}).map((p: any, i: number) => (
            <View key={i} style={{ paddingLeft: 8, gap: 1, marginTop: 2 }}>
              <Text style={{ color: "#A3A3A3", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
                {p.platform}{p.verified ? " ✓" : ""}: {p.displayName || "?"}
              </Text>
              {p.followers != null && (
                <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>
                  {p.followers.toLocaleString()} followers{p.posts ? ` · ${p.posts.toLocaleString()} posts` : ""}
                </Text>
              )}
              {p.bio && (
                <Text style={{ color: "#404040", fontSize: 9, fontFamily: "monospace" }} numberOfLines={2}>
                  {p.bio.substring(0, 150)}
                </Text>
              )}
            </View>
          ))}
          {data.interests?.length > 0 && (
            <InfoRow label="INTERESTS" value={data.interests.slice(0, 10).join(", ")} />
          )}
        </View>
      );

    case "threatAssessment":
      return (
        <View style={{ gap: 4 }}>
          <LevelBadge label={data.threatLevel} color={THREAT_COLORS[data.threatLevel] || "#6B7280"} />
          <InfoRow label="CRITICAL" value={String(data.criticalCount)} />
          <InfoRow label="HIGH" value={String(data.highCount)} />
          <InfoRow label="VULNERABILITIES" value={String(data.vulnerabilities)} />
          <InfoRow label="DARK WEB" value={String(data.darkWebMentions)} />
          {data.criticalFindings?.map((f: any, i: number) => (
            <Text key={i} style={{ color: "#EF4444", fontSize: 10, fontFamily: "monospace", paddingLeft: 8 }}>
              {f.title}
            </Text>
          ))}
        </View>
      );

    case "identityCorrelation":
      return (
        <View style={{ gap: 4 }}>
          <InfoRow label="ENTITIES" value={String(data.totalEntities)} />
          <InfoRow label="RELATIONSHIPS" value={String(data.totalRelationships)} />
          <InfoRow label="CROSS-PROFILE" value={String(data.crossProfileLinks)} />
          <InfoRow label="FACE MATCHES" value={String(data.faceMatches?.length || 0)} />
          {data.clusters?.map((c: any, i: number) => (
            <Text key={i} style={{ color: "#A855F7", fontSize: 10, fontFamily: "monospace", paddingLeft: 8 }}>
              Cluster: {c.label} ({c.confidence}% conf, {c.entityCount} entities)
            </Text>
          ))}
          {Object.entries(data.entityBreakdown || {}).length > 0 && (
            <View style={{ marginTop: 4 }}>
              <Text style={{ color: "#525252", fontSize: 9, fontFamily: "monospace" }}>
                Types: {Object.entries(data.entityBreakdown).map(([k, v]) => `${k}(${v})`).join(" ")}
              </Text>
            </View>
          )}
        </View>
      );

    case "remediationStatus":
      return (
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(data.statusBreakdown || {}).map(([status, count]: [string, any]) => (
              <Text key={status} style={{ color: "#737373", fontSize: 10, fontFamily: "monospace" }}>
                {status}: {count}
              </Text>
            ))}
          </View>
          <InfoRow label="ACTION NEEDED" value={String(data.actionableCount)} />
          {data.topActions?.slice(0, 5).map((a: any, i: number) => (
            <View key={i} style={{ paddingLeft: 8, marginTop: 2 }}>
              <Text style={{ color: "#F59E0B", fontSize: 10, fontFamily: "monospace" }}>
                [{a.severity}] {a.title}
              </Text>
              {a.remediation && (
                <Text style={{ color: "#404040", fontSize: 9, fontFamily: "monospace" }} numberOfLines={2}>
                  Fix: {a.remediation.substring(0, 120)}
                </Text>
              )}
            </View>
          ))}
        </View>
      );

    case "whatChanged":
      return (
        <View style={{ gap: 4 }}>
          <InfoRow label="PERIOD" value={data.period} />
          <InfoRow label="NEW FINDINGS" value={String(data.newFindingsCount)} />
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {Object.entries(data.bySeverity || {}).map(([sev, count]: [string, any]) => (
              count > 0 && (
                <Text key={sev} style={{ color: "#737373", fontSize: 10, fontFamily: "monospace" }}>
                  {sev}: {count}
                </Text>
              )
            ))}
          </View>
          {data.highlights?.map((h: any, i: number) => (
            <Text key={i} style={{ color: "#A3A3A3", fontSize: 10, fontFamily: "monospace", paddingLeft: 8 }}>
              [{h.severity}] {h.title}
            </Text>
          ))}
        </View>
      );

    default:
      return (
        <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace" }}>
          {JSON.stringify(data, null, 2).substring(0, 500)}
        </Text>
      );
  }
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text style={{ color: "#525252", fontSize: 10, fontFamily: "monospace", width: 80 }}>{label}:</Text>
      <Text style={{ color: "#A3A3A3", fontSize: 10, fontFamily: "monospace", flex: 1 }}>{value}</Text>
    </View>
  );
}

function LevelBadge({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ backgroundColor: `${color}20`, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 4, alignSelf: "flex-start", borderWidth: 1, borderColor: `${color}40` }}>
      <Text style={{ color, fontSize: 11, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 2 }}>{label}</Text>
    </View>
  );
}
