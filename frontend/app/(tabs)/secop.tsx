import { useState, useCallback, useEffect } from "react";
import { View, Text, ScrollView, Pressable, RefreshControl, TextInput, ActivityIndicator } from "react-native";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../../components/StatusBadge";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { TopBar } from "../../components/TopBar";
import { GroupNav } from "../../components/GroupNav";
import { LicitacionCard } from "../../components/secop/LicitacionCard";
import { LicitacionDetailSheet } from "../../components/secop/LicitacionDetailSheet";
import { colors } from "../../lib/design-tokens";
import { formatCOPCompact } from "../../lib/format";
import { categoryStyle, toNum } from "../../lib/secop-format";
import {
  fetchLicitaciones, fetchSecopCategories,
  type Licitacion, type SecopCategory,
} from "../../lib/bridge-api";

const ACCENT = colors.accent;
const SUB_TABS = [
  { key: "relevantes", label: "RELEVANTES" },
  { key: "minima", label: "MÍNIMA CUANTÍA" },
  { key: "todas", label: "TODAS" },
  { key: "categorias", label: "CATEGORÍAS" },
] as const;
type SubTab = typeof SUB_TABS[number]["key"];
type Filter = { kind: "overlay" | "segment"; value: string; label: string } | null;

export default function SecopScreen() {
  const { insets } = usePhoneLayout();
  const [activeTab, setActiveTab] = useState<SubTab>("relevantes");
  const [items, setItems] = useState<Licitacion[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"deadline" | "competitividad" | "value_desc">("deadline");
  const [filter, setFilter] = useState<Filter>(null);
  const [cats, setCats] = useState<{ unspsc: SecopCategory[]; overlay: SecopCategory[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);

  const buildParams = useCallback(() => {
    const p: Record<string, any> = { sort, limit: 100 };
    if (query.trim()) p.q = query.trim();
    if (filter) { p[filter.kind] = filter.value; }
    else if (activeTab === "relevantes") p.relevant = true;
    else if (activeTab === "minima") { p.relevant = true; p.modalidad = "Mínima cuantía"; }
    return p;
  }, [activeTab, query, filter, sort]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchLicitaciones(buildParams());
      setItems(r.items); setTotal(r.total);
    } catch { setItems([]); setTotal(0); }
    setLoading(false);
  }, [buildParams]);

  const loadCats = useCallback(async () => {
    try { setCats(await fetchSecopCategories()); } catch { setCats(null); }
  }, []);

  // Fetch list (debounced on query) whenever the view inputs change.
  useEffect(() => {
    if (activeTab === "categorias" && !filter) { loadCats(); return; }
    const t = setTimeout(loadList, query ? 300 : 0);
    return () => clearTimeout(t);
  }, [activeTab, query, filter, loadList, loadCats]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    if (activeTab === "categorias" && !filter) await loadCats(); else await loadList();
    setRefreshing(false);
  }, [activeTab, filter, loadList, loadCats]);

  const openLic = useCallback((id: string) => { setSelected(id); setDetailVisible(true); }, []);
  const pickCategory = (f: Filter) => { setFilter(f); setActiveTab("relevantes"); };
  const showList = activeTab !== "categorias" || !!filter;

  return (
    <View style={{ flex: 1, backgroundColor: colors.gray[850] }}>
      <TopBar
        background={colors.gray[850]}
        title={<Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 3 }}>LICITACIONES</Text>}
        right={<StatusBadge />}
      />
      <GroupNav group="work" />

      {/* Sub-tabs */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, backgroundColor: colors.gray[850] }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {SUB_TABS.map((tab) => {
              const on = activeTab === tab.key && !(filter && tab.key !== "relevantes");
              return (
                <Pressable
                  key={tab.key}
                  onPress={() => { setFilter(null); setActiveTab(tab.key); }}
                  style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 6, backgroundColor: on ? ACCENT + "22" : "transparent", borderWidth: 1, borderColor: on ? ACCENT + "44" : "transparent" }}
                >
                  <Text style={{ color: on ? ACCENT : colors.gray[400], fontFamily: "monospace", fontSize: 10, fontWeight: "bold", letterSpacing: 1 }}>{tab.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>

      {/* Search (list views only) */}
      {showList && (
        <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Buscar por objeto, entidad…"
            placeholderTextColor={colors.text.disabled}
            style={{ backgroundColor: colors.gray[800], borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, color: colors.gray[50], fontSize: 13, borderWidth: 1, borderColor: colors.border.subtle }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8, flexWrap: "wrap" }}>
            <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 10 }}>
              {loading ? "…" : `${total} oportunidad${total === 1 ? "" : "es"}`}
            </Text>
            {([["deadline", "Cierre"], ["competitividad", "Ganables"], ["value_desc", "Valor"]] as const).map(([k, lbl]) => (
              <Pressable key={k} onPress={() => setSort(k)} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5, backgroundColor: sort === k ? ACCENT + "22" : "transparent", borderWidth: 1, borderColor: sort === k ? ACCENT + "44" : colors.border.subtle }}>
                <Text style={{ color: sort === k ? ACCENT : colors.text.tertiary, fontSize: 10, fontWeight: "600" }}>{lbl}</Text>
              </Pressable>
            ))}
            {filter ? (
              <Pressable onPress={() => setFilter(null)} style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: ACCENT + "1a", borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ color: ACCENT, fontSize: 10, fontWeight: "600" }}>{filter.label}  ✕</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      )}

      {/* Content */}
      {showList ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: insets.bottom + 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.gray[400]} />}
        >
          {loading && items.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 50 }}><ActivityIndicator color={ACCENT} /></View>
          ) : items.length === 0 ? (
            <View style={{ alignItems: "center", paddingVertical: 60 }}>
              <Text style={{ fontSize: 44, marginBottom: 14 }}>🗂️</Text>
              <Text style={{ color: colors.gray[300], fontSize: 14 }}>Sin oportunidades abiertas</Text>
              <Text style={{ color: colors.gray[400], fontSize: 12, marginTop: 4, textAlign: "center", paddingHorizontal: 40 }}>
                Ajusta la búsqueda o el filtro. El índice se refresca cada 6 horas.
              </Text>
            </View>
          ) : (
            items.map((lic) => <LicitacionCard key={lic.id_proceso} lic={lic} onPress={() => openLic(lic.id_proceso)} />)
          )}
        </ScrollView>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.gray[400]} />}
        >
          <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 10, letterSpacing: 2, marginBottom: 10 }}>RELEVANTES PARA NOSOTROS</Text>
          {(cats?.overlay || []).map((c) => {
            const st = categoryStyle([c.name!]);
            return (
              <Pressable
                key={c.name}
                onPress={() => pickCategory({ kind: "overlay", value: c.name!, label: c.name! })}
                style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.gray[800], borderRadius: 12, borderLeftWidth: 3, borderLeftColor: st.color, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
                  <Text style={{ fontSize: 22 }}>{st.emoji}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.gray[50], fontSize: 14, fontWeight: "600" }}>{c.name}</Text>
                    <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 10, marginTop: 2 }}>{formatCOPCompact(toNum(c.total_value))} en juego</Text>
                  </View>
                  <Text style={{ color: st.color, fontFamily: "monospace", fontSize: 20, fontWeight: "800" }}>{c.count}</Text>
                </View>
              </Pressable>
            );
          })}

          <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 10, letterSpacing: 2, marginTop: 16, marginBottom: 10 }}>TODAS LAS CATEGORÍAS (UNSPSC)</Text>
          {(cats?.unspsc || []).slice(0, 20).map((c) => (
            <Pressable
              key={c.segment_code}
              onPress={() => pickCategory({ kind: "segment", value: c.segment_code!, label: c.segment_name! })}
              style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 11, borderBottomWidth: 0.5, borderBottomColor: colors.border.subtle }}>
                <Text style={{ color: colors.gray[200], fontSize: 13, flex: 1 }} numberOfLines={1}>{c.segment_name}</Text>
                <Text style={{ color: colors.text.secondary, fontFamily: "monospace", fontSize: 12, fontWeight: "700", marginLeft: 10 }}>{c.count}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <LicitacionDetailSheet
        licId={selected}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        onChanged={loadList}
      />
      <StatusBar style="light" />
    </View>
  );
}
