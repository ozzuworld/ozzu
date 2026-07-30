import { useState, useCallback, useEffect } from "react";
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Pressable, LayoutAnimation, Platform, UIManager } from "react-native";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../../components/StatusBadge";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { TopBar } from "../../components/TopBar";
import { GroupNav } from "../../components/GroupNav";
import { JobCard } from "../../components/jobs/JobCard";
import { colors } from "../../lib/design-tokens";
import { fetchJobs, fetchJobsStats, decideJob, refreshJobs, type Job, type JobsStats, type JobDecision } from "../../lib/bridge-api";

const ACCENT = colors.accent;
if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type FilterKey = "inbox" | "latam" | "saved" | "all";
const FILTERS: { key: FilterKey; label: string; params: Record<string, any> }[] = [
  { key: "inbox", label: "Bandeja", params: { inbox: true, sort: "best" } },
  { key: "latam", label: "LatAm", params: { relevant: true, latam: true, sort: "best" } },
  { key: "saved", label: "Guardados", params: { decision: "saved", all: true, sort: "best" } },
  { key: "all", label: "Todos", params: { relevant: true, sort: "newest" } },
];

// EMPLEOS tab — a triage inbox for remote software-engineering roles pulled from
// Himalayas + RemoteOK (dir_1785424018953). Cards land relevant + scored; tapping opens
// the listing, and Descartar / Guardar / Apliqué move it through the pipeline.
export default function JobsScreen() {
  const { insets } = usePhoneLayout();
  const [filter, setFilter] = useState<FilterKey>("inbox");
  const [items, setItems] = useState<Job[]>([]);
  const [stats, setStats] = useState<JobsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (f: FilterKey) => {
    const def = FILTERS.find((x) => x.key === f)!;
    try {
      const [r, s] = await Promise.all([fetchJobs({ ...def.params, limit: 100 }), fetchJobsStats().catch(() => null)]);
      setItems(r.items);
      if (s) setStats(s);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { setLoading(true); load(filter); }, [filter, load]);

  // Pull-to-refresh triggers a fresh ingest, gives it a moment to write, then reloads.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await refreshJobs(); } catch {}
    await new Promise((r) => setTimeout(r, 1500));
    await load(filter);
    setRefreshing(false);
  }, [filter, load]);

  // Optimistic: pull the card immediately; backend records the decision.
  const removeAndDecide = useCallback((id: string, decision: JobDecision) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setItems((prev) => prev.filter((x) => x.id !== id));
    setStats((s) => (s ? adjustStats(s, decision) : s));
    decideJob(id, decision).catch(() => {});
  }, []);

  const countLabel = () => {
    if (loading) return "…";
    const n = items.length;
    if (filter === "inbox") return `${n} empleo${n === 1 ? "" : "s"} por revisar`;
    if (filter === "saved") return `${n} guardado${n === 1 ? "" : "s"}`;
    if (filter === "latam") return `${n} alcanzable${n === 1 ? "" : "s"} desde LatAm`;
    return `${n} relevante${n === 1 ? "" : "s"}`;
  };

  const badgeFor = (k: FilterKey): number | undefined => {
    if (!stats) return undefined;
    if (k === "inbox") return stats.inbox_count;
    if (k === "saved") return stats.saved_count;
    if (k === "all") return stats.relevant_count;
    return undefined; // latam count isn't in stats — keep the chip clean
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.gray[850] }}>
      <TopBar
        background={colors.gray[850]}
        title={<Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 3 }}>EMPLEOS</Text>}
        right={<StatusBadge />}
      />
      <GroupNav group="work" />

      {/* Filter chips with live counts */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 2 }}>
        {FILTERS.map((f) => {
          const on = f.key === filter;
          const badge = badgeFor(f.key);
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: 6,
                paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
                backgroundColor: on ? ACCENT + "1e" : colors.gray[800],
                borderWidth: 1, borderColor: on ? ACCENT + "55" : "rgba(255,255,255,0.04)",
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ color: on ? colors.accentLight : colors.text.secondary, fontSize: 12, fontWeight: on ? "700" : "500" }}>{f.label}</Text>
              {badge != null && badge > 0 ? (
                <Text style={{ color: on ? colors.accentLight : colors.text.tertiary, fontSize: 11, fontWeight: "700", fontFamily: "monospace" }}>{badge}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
        <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 10, letterSpacing: 1 }}>{countLabel()}</Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.gray[400]} />}
      >
        {loading ? (
          <View style={{ alignItems: "center", paddingVertical: 60 }}><ActivityIndicator color={ACCENT} /></View>
        ) : items.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          items.map((job) => <JobCard key={job.id} job={job} onDecide={(d) => removeAndDecide(job.id, d)} />)
        )}
      </ScrollView>
      <StatusBar style="light" />
    </View>
  );
}

function adjustStats(s: JobsStats, d: JobDecision): JobsStats {
  const next = { ...s };
  if (next.inbox_count > 0) next.inbox_count -= 1;
  if (d === "saved") next.saved_count += 1;
  if (d === "applied") next.applied_count += 1;
  if (d === "dismissed") next.dismissed_count += 1;
  return next;
}

function EmptyState({ filter }: { filter: FilterKey }) {
  const map: Record<FilterKey, { emoji: string; title: string; sub: string }> = {
    inbox: { emoji: "✅", title: "Bandeja al día", sub: "No hay empleos por revisar. Llegan nuevos a medida que se publican." },
    latam: { emoji: "🌎", title: "Nada para LatAm ahora", sub: "Vuelve más tarde o revisa Todos. Desliza para actualizar." },
    saved: { emoji: "🔖", title: "Nada guardado aún", sub: "Guarda empleos de la bandeja para revisarlos y aplicar después." },
    all: { emoji: "💼", title: "Sin resultados", sub: "Desliza hacia abajo para traer empleos nuevos." },
  };
  const e = map[filter];
  return (
    <View style={{ alignItems: "center", paddingVertical: 70 }}>
      <Text style={{ fontSize: 46, marginBottom: 14 }}>{e.emoji}</Text>
      <Text style={{ color: colors.gray[300], fontSize: 15 }}>{e.title}</Text>
      <Text style={{ color: colors.gray[400], fontSize: 12, marginTop: 4, textAlign: "center", paddingHorizontal: 40 }}>{e.sub}</Text>
    </View>
  );
}
