import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Pressable,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import {
  useKnowledgeGraph,
  fetchKgDossier,
  fetchKgDiffs,
  queryKg,
  triggerKgEnrichNow,
  triggerKgDiscover,
  triggerAutoDiscover,
  type KgSubject,
  type KgDossier,
  type KgDiff,
  type KgStats,
  type KgQueryResult,
} from "../../lib/kg-hooks";

const ACCENT = "#F59E0B"; // Amber
const BG = "#0A0A0A";
const CARD = "#111111";
const BORDER = "#1a1a1a";
const TEXT1 = "#f1f5f9";
const TEXT2 = "#94a3b8";
const TEXT3 = "#64748b";

type SubTab = "subjects" | "search" | "pipeline";

export default function InfluenceScreen() {
  const { insets } = usePhoneLayout();
  const { subjects, stats, loading, error, refresh } = useKnowledgeGraph();
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<SubTab>("subjects");
  const [selectedSubject, setSelectedSubject] = useState<KgSubject | null>(null);
  const [dossier, setDossier] = useState<KgDossier | null>(null);
  const [diffs, setDiffs] = useState<KgDiff[]>([]);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KgQueryResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const openDossier = useCallback(async (subject: KgSubject) => {
    setSelectedSubject(subject);
    setDossierLoading(true);
    try {
      const [d, df] = await Promise.all([
        fetchKgDossier(subject.id),
        fetchKgDiffs(subject.id),
      ]);
      setDossier(d);
      setDiffs(df.diffs || []);
    } catch {}
    setDossierLoading(false);
  }, []);

  const runSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    try {
      const r = await queryKg(searchQuery.trim());
      setSearchResults(r);
    } catch {}
    setSearchLoading(false);
  }, [searchQuery]);

  // ── Dossier Detail View ──
  if (selectedSubject) {
    return (
      <View style={{ flex: 1, backgroundColor: BG }}>
        <StatusBar style="light" />
        <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 16 }}>
          <Pressable onPress={() => { setSelectedSubject(null); setDossier(null); setDiffs([]); }}>
            <Text style={{ color: ACCENT, fontSize: 14, fontWeight: "600" }}>← BACK</Text>
          </Pressable>
          <Text style={{ color: TEXT1, fontSize: 20, fontWeight: "800", marginTop: 8, letterSpacing: 1 }}>
            {selectedSubject.name.toUpperCase()}
          </Text>
          <Text style={{ color: TEXT3, fontSize: 11, marginTop: 2 }}>
            {selectedSubject.subject_type} · {selectedSubject.status}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <Pressable
              onPress={async () => {
                try { await triggerAutoDiscover(selectedSubject.id); } catch {}
              }}
              style={{ backgroundColor: "#22c55e20", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}
            >
              <Text style={{ color: "#22c55e", fontSize: 10, fontWeight: "700" }}>⚡ AUTO-DISCOVER</Text>
            </Pressable>
            <Pressable
              onPress={async () => {
                try { await triggerKgDiscover(selectedSubject.id, "following"); } catch {}
              }}
              style={{ backgroundColor: ACCENT + "20", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}
            >
              <Text style={{ color: ACCENT, fontSize: 10, fontWeight: "700" }}>🕸️ FOLLOWING</Text>
            </Pressable>
            <Pressable
              onPress={async () => {
                try { await triggerKgDiscover(selectedSubject.id, "followers"); } catch {}
              }}
              style={{ backgroundColor: ACCENT + "20", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 }}
            >
              <Text style={{ color: ACCENT, fontSize: 10, fontWeight: "700" }}>🕸️ FOLLOWERS</Text>
            </Pressable>
          </View>
        </View>

        {dossierLoading ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
            <ActivityIndicator color={ACCENT} size="large" />
            <Text style={{ color: TEXT3, fontSize: 12, marginTop: 12 }}>Loading dossier...</Text>
          </View>
        ) : dossier ? (
          <ScrollView style={{ flex: 1, marginTop: 12 }} contentContainerStyle={{ paddingBottom: 60, paddingHorizontal: 16 }}>
            {/* Diffs Alert */}
            {diffs.length > 0 && (
              <View style={{ backgroundColor: "#1c1107", borderRadius: 8, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "#4a3000" }}>
                <Text style={{ color: ACCENT, fontSize: 12, fontWeight: "700", marginBottom: 6 }}>⚡ CHANGES DETECTED</Text>
                {diffs.map((d, i) => (
                  <View key={i} style={{ marginBottom: 4 }}>
                    <Text style={{ color: TEXT2, fontSize: 11 }}>
                      <Text style={{ fontWeight: "700", color: TEXT1 }}>{d.field}</Text>
                      {": "}
                      <Text style={{ color: "#ef4444" }}>{String(d.previous ?? "—").slice(0, 40)}</Text>
                      {" → "}
                      <Text style={{ color: "#22c55e" }}>{String(d.current ?? "—").slice(0, 40)}</Text>
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* Anchors */}
            {dossier.anchors.length > 0 && (
              <SectionCard title="ANCHORS" icon="🔗">
                {dossier.anchors.map((a) => (
                  <View key={a.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
                    <Text style={{ color: TEXT3, fontSize: 11, textTransform: "uppercase" }}>{a.anchor_type}</Text>
                    <Text style={{ color: TEXT1, fontSize: 11, fontFamily: "monospace" }}>{a.value}</Text>
                  </View>
                ))}
              </SectionCard>
            )}

            {/* Facts */}
            {dossier.facts.length > 0 && (
              <SectionCard title="FACTS" icon="📋">
                {dossier.facts.slice(0, 20).map((f) => (
                  <View key={f.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: "#1a1a1a" }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: TEXT2, fontSize: 10, textTransform: "uppercase" }}>{f.category}</Text>
                      <Text style={{ color: TEXT1, fontSize: 12 }}>{f.key}: {f.value.slice(0, 60)}</Text>
                    </View>
                    <ConfidenceBadge confidence={f.confidence} />
                  </View>
                ))}
              </SectionCard>
            )}

            {/* Connections */}
            {dossier.connections.length > 0 && (
              <SectionCard title="CONNECTIONS" icon="🔀">
                {dossier.connections.map((c) => (
                  <View key={c.id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4 }}>
                    <Text style={{ color: TEXT1, fontSize: 11, flex: 1 }}>{c.source_name || `#${c.source_id}`}</Text>
                    <View style={{ backgroundColor: "#1e293b", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginHorizontal: 6 }}>
                      <Text style={{ color: ACCENT, fontSize: 9, fontWeight: "700" }}>{c.relationship}</Text>
                    </View>
                    <Text style={{ color: TEXT1, fontSize: 11, flex: 1, textAlign: "right" }}>{c.target_name || `#${c.target_id}`}</Text>
                  </View>
                ))}
              </SectionCard>
            )}

            {/* Observations */}
            {dossier.observations.length > 0 && (
              <SectionCard title={`OBSERVATIONS (${dossier.observations.length})`} icon="👁️">
                {dossier.observations.slice(0, 15).map((o) => (
                  <View key={o.id} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#1a1a1a" }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <PlatformBadge platform={o.platform} />
                        <Text style={{ color: TEXT3, fontSize: 10 }}>{o.observation_type}</Text>
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        {o.nlp_enriched && <Text style={{ color: "#22c55e", fontSize: 8 }}>● NLP</Text>}
                        {o.sentiment && <SentimentBadge sentiment={o.sentiment} />}
                      </View>
                    </View>
                    {o.content && <Text style={{ color: TEXT2, fontSize: 11, marginTop: 2 }} numberOfLines={2}>{o.content}</Text>}
                    {o.nlp_result?.summary && (
                      <Text style={{ color: ACCENT, fontSize: 10, marginTop: 2, fontStyle: "italic" }}>{o.nlp_result.summary}</Text>
                    )}
                    <Text style={{ color: TEXT3, fontSize: 9, marginTop: 2 }}>{new Date(o.observed_at).toLocaleString()}</Text>
                  </View>
                ))}
              </SectionCard>
            )}

            {/* Timeline */}
            {dossier.timeline.length > 0 && (
              <SectionCard title="TIMELINE" icon="📅">
                {dossier.timeline.slice(0, 10).map((t) => (
                  <View key={t.id} style={{ flexDirection: "row", paddingVertical: 4, gap: 8 }}>
                    <View style={{ width: 2, backgroundColor: ACCENT, borderRadius: 1 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: TEXT1, fontSize: 11, fontWeight: "600" }}>{t.title}</Text>
                      {t.description && <Text style={{ color: TEXT3, fontSize: 10 }} numberOfLines={1}>{t.description}</Text>}
                      <Text style={{ color: TEXT3, fontSize: 9 }}>{t.event_date ? new Date(t.event_date).toLocaleDateString() : ""}</Text>
                    </View>
                  </View>
                ))}
              </SectionCard>
            )}
          </ScrollView>
        ) : (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
            <Text style={{ color: TEXT3 }}>No dossier data</Text>
          </View>
        )}
      </View>
    );
  }

  // ── Main List View ──
  return (
    <View style={{ flex: 1, backgroundColor: BG }}>
      <StatusBar style="light" />

      {/* Grid background */}
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0.02 }}>
        {Array.from({ length: 20 }).map((_, i) => (
          <View key={`h${i}`} style={{ position: "absolute", top: i * 40, left: 0, right: 0, height: 1, backgroundColor: ACCENT }} />
        ))}
        {Array.from({ length: 12 }).map((_, i) => (
          <View key={`v${i}`} style={{ position: "absolute", left: i * 40, top: 0, bottom: 0, width: 1, backgroundColor: ACCENT }} />
        ))}
      </View>

      {/* Header */}
      <View style={{ paddingTop: insets.top + 20, paddingHorizontal: 24, paddingBottom: 8 }}>
        <Text style={{ color: TEXT1, fontSize: 20, fontWeight: "800", letterSpacing: 2 }}>
          INTELLIGENCE
        </Text>
        <Text style={{ color: TEXT3, fontSize: 10, marginTop: 2, letterSpacing: 1 }}>
          KNOWLEDGE GRAPH · OSINT PIPELINE
        </Text>
      </View>

      {/* Sub-tabs */}
      <View style={{ flexDirection: "row", paddingHorizontal: 24, gap: 12, marginBottom: 8 }}>
        {(["subjects", "search", "pipeline"] as SubTab[]).map((tab) => (
          <Pressable key={tab} onPress={() => setActiveTab(tab)}>
            <Text style={{
              color: activeTab === tab ? ACCENT : TEXT3,
              fontSize: 11,
              fontWeight: activeTab === tab ? "800" : "500",
              textTransform: "uppercase",
              letterSpacing: 1,
              borderBottomWidth: activeTab === tab ? 2 : 0,
              borderBottomColor: ACCENT,
              paddingBottom: 4,
            }}>
              {tab}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
      >
        {loading && subjects.length === 0 && (
          <View style={{ alignItems: "center", paddingVertical: 100 }}>
            <ActivityIndicator color={ACCENT} size="large" />
          </View>
        )}

        {activeTab === "subjects" && (
          <View style={{ paddingHorizontal: 16 }}>
            {subjects.length === 0 && !loading && (
              <View style={{ alignItems: "center", paddingVertical: 60 }}>
                <Text style={{ color: TEXT3, fontSize: 32 }}>🔍</Text>
                <Text style={{ color: TEXT3, fontSize: 13, marginTop: 8 }}>No subjects in knowledge graph</Text>
              </View>
            )}
            {subjects.map((s) => (
              <SubjectCard key={s.id} subject={s} onPress={() => openDossier(s)} />
            ))}
          </View>
        )}

        {activeTab === "search" && (
          <View style={{ paddingHorizontal: 16 }}>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
              <TextInput
                style={{
                  flex: 1,
                  backgroundColor: CARD,
                  borderRadius: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: TEXT1,
                  fontSize: 13,
                  borderWidth: 1,
                  borderColor: BORDER,
                }}
                placeholder="Search the knowledge graph..."
                placeholderTextColor={TEXT3}
                value={searchQuery}
                onChangeText={setSearchQuery}
                onSubmitEditing={runSearch}
                returnKeyType="search"
              />
              <Pressable
                onPress={runSearch}
                style={{ backgroundColor: ACCENT, borderRadius: 8, paddingHorizontal: 16, justifyContent: "center" }}
              >
                <Text style={{ color: "#000", fontWeight: "700", fontSize: 12 }}>GO</Text>
              </Pressable>
            </View>

            {searchLoading && <ActivityIndicator color={ACCENT} style={{ marginTop: 20 }} />}

            {searchResults && (
              <View>
                <Text style={{ color: TEXT3, fontSize: 10, marginBottom: 8 }}>
                  {searchResults.total} results for "{searchResults.query}"
                </Text>
                {searchResults.results.subjects.map((s) => (
                  <SubjectCard key={`s-${s.id}`} subject={s} onPress={() => openDossier(s)} />
                ))}
                {searchResults.results.facts.map((f: any, i: number) => (
                  <View key={`f-${i}`} style={{ backgroundColor: CARD, borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: BORDER }}>
                    <Text style={{ color: TEXT3, fontSize: 9, textTransform: "uppercase" }}>{f.category} · {f.subject_name}</Text>
                    <Text style={{ color: TEXT1, fontSize: 12 }}>{f.key}: {f.value}</Text>
                  </View>
                ))}
                {searchResults.results.observations.map((o) => (
                  <View key={`o-${o.id}`} style={{ backgroundColor: CARD, borderRadius: 8, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: BORDER }}>
                    <View style={{ flexDirection: "row", gap: 6, marginBottom: 4 }}>
                      <PlatformBadge platform={o.platform} />
                      <Text style={{ color: TEXT3, fontSize: 10 }}>{o.subject_name}</Text>
                    </View>
                    {o.content && <Text style={{ color: TEXT2, fontSize: 11 }} numberOfLines={2}>{o.content}</Text>}
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {activeTab === "pipeline" && stats && (
          <View style={{ paddingHorizontal: 16 }}>
            <PipelineStats stats={stats} />

            <Pressable
              onPress={async () => {
                try { await triggerKgEnrichNow(); } catch {}
                refresh();
              }}
              style={{ backgroundColor: CARD, borderRadius: 8, padding: 14, marginTop: 12, borderWidth: 1, borderColor: BORDER, alignItems: "center" }}
            >
              <Text style={{ color: ACCENT, fontSize: 12, fontWeight: "700" }}>⚡ TRIGGER ENRICHMENT NOW</Text>
              <Text style={{ color: TEXT3, fontSize: 10, marginTop: 2 }}>Process pending observations through KAIROS NLP</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ── Components ──

function SubjectCard({ subject, onPress }: { subject: KgSubject; onPress: () => void }) {
  const typeIcon: Record<string, string> = { person: "👤", organization: "🏢", location: "📍", event: "📅" };
  const statusColor: Record<string, string> = { active: "#22c55e", inactive: "#64748b", archived: "#ef4444" };

  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: CARD,
        borderRadius: 10,
        padding: 14,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: BORDER,
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      <Text style={{ fontSize: 24, marginRight: 12 }}>{typeIcon[subject.subject_type] || "❓"}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: TEXT1, fontSize: 14, fontWeight: "700" }}>{subject.name}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 }}>
          <Text style={{ color: TEXT3, fontSize: 10, textTransform: "uppercase" }}>{subject.subject_type}</Text>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor[subject.status] || TEXT3 }} />
          {subject.last_collected_at && (
            <Text style={{ color: TEXT3, fontSize: 9 }}>
              collected {timeAgo(subject.last_collected_at)}
            </Text>
          )}
        </View>
      </View>
      <Text style={{ color: TEXT3, fontSize: 16 }}>›</Text>
    </Pressable>
  );
}

function SectionCard({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: CARD, borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: BORDER }}>
      <Text style={{ color: ACCENT, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginBottom: 8 }}>
        {icon} {title}
      </Text>
      {children}
    </View>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  const colors: Record<string, string> = {
    twitter: "#1DA1F2", linkedin: "#0077B5", instagram: "#E4405F",
    tiktok: "#00F2EA", reddit: "#FF4500", facebook: "#1877F2",
  };
  return (
    <View style={{ backgroundColor: (colors[platform] || TEXT3) + "20", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 3 }}>
      <Text style={{ color: colors[platform] || TEXT3, fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>{platform}</Text>
    </View>
  );
}

function SentimentBadge({ sentiment }: { sentiment: string }) {
  const config: Record<string, { color: string; label: string }> = {
    positive: { color: "#22c55e", label: "+" },
    negative: { color: "#ef4444", label: "−" },
    neutral: { color: "#94a3b8", label: "~" },
  };
  const s = config[sentiment] || config.neutral;
  return (
    <View style={{ backgroundColor: s.color + "20", paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
      <Text style={{ color: s.color, fontSize: 9, fontWeight: "700" }}>{s.label}</Text>
    </View>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color = confidence >= 80 ? "#22c55e" : confidence >= 50 ? ACCENT : "#ef4444";
  return (
    <Text style={{ color, fontSize: 9, fontWeight: "700", alignSelf: "center" }}>{confidence}%</Text>
  );
}

function PipelineStats({ stats }: { stats: KgStats }) {
  const stages = [
    { label: "COLLECT", value: String(stats.collections_completed), icon: "📡", done: true },
    { label: "NORMALIZE", value: `${stats.observations} obs`, icon: "🧹", done: true },
    { label: "ENRICH", value: `${stats.enriched}/${stats.observations}`, icon: "🧠", done: stats.unenriched === 0 },
    { label: "STORE", value: `${stats.facts} facts`, icon: "💾", done: true },
    { label: "ANALYZE", value: `${stats.connections} links`, icon: "🔍", done: true },
    { label: "ACT", value: `${stats.subjects} subjects`, icon: "⚡", done: true },
  ];

  return (
    <View>
      <Text style={{ color: TEXT1, fontSize: 13, fontWeight: "700", marginBottom: 10 }}>PIPELINE STATUS</Text>
      {stages.map((s, i) => (
        <View key={s.label} style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
          <Text style={{ fontSize: 16, width: 28 }}>{s.icon}</Text>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: s.done ? "#22c55e" : ACCENT, fontSize: 11, fontWeight: "700", width: 80 }}>{s.label}</Text>
            <View style={{ flex: 1, height: 4, backgroundColor: "#1a1a1a", borderRadius: 2 }}>
              <View style={{ height: 4, backgroundColor: s.done ? "#22c55e" : ACCENT, borderRadius: 2, width: s.done ? "100%" : "60%" }} />
            </View>
            <Text style={{ color: TEXT3, fontSize: 10, width: 70, textAlign: "right" }}>{s.value}</Text>
          </View>
          {i < stages.length - 1 && (
            <View style={{ position: "absolute", left: 13, top: 22, width: 2, height: 10, backgroundColor: "#1a1a1a" }} />
          )}
        </View>
      ))}
    </View>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
