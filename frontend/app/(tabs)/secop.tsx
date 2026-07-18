import { useState, useCallback, useEffect } from "react";
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, LayoutAnimation, Platform, UIManager } from "react-native";
import { StatusBar } from "expo-status-bar";
import { StatusBadge } from "../../components/StatusBadge";
import { usePhoneLayout } from "../../lib/usePhoneLayout";
import { TopBar } from "../../components/TopBar";
import { GroupNav } from "../../components/GroupNav";
import { OfferCard } from "../../components/secop/OfferCard";
import { ProposalDocument } from "../../components/secop/ProposalDocument";
import { colors } from "../../lib/design-tokens";
import { fetchLicitaciones, decideOffer, type Licitacion } from "../../lib/bridge-api";

const ACCENT = colors.accent;
if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// The Licitaciones tab is now a DECISION INBOX: relevant tenders land as offers,
// each with Aceptar/Rechazar. Rechazar removes it forever (backend decision).
export default function OfertasScreen() {
  const { insets } = usePhoneLayout();
  const [items, setItems] = useState<Licitacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetchLicitaciones({ relevant: true, inbox: true, sort: "competitividad", limit: 100 });
      setItems(r.items);
    } catch { setItems([]); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  // Optimistic: pull the card out immediately; the backend records the decision.
  const removeAndDecide = useCallback((id: string, decision: "accepted" | "rejected") => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setItems((prev) => prev.filter((x) => x.id_proceso !== id));
    decideOffer(id, decision).catch(() => {});
  }, []);

  const openOffer = useCallback((id: string) => { setSelected(id); setDetailVisible(true); }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.gray[850] }}>
      <TopBar
        background={colors.gray[850]}
        title={<Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 14, fontWeight: "bold", letterSpacing: 3 }}>OFERTAS</Text>}
        right={<StatusBadge />}
      />
      <GroupNav group="work" />

      <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
        <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 10, letterSpacing: 1 }}>
          {loading ? "…" : `${items.length} oportunidad${items.length === 1 ? "" : "es"} por revisar`}
        </Text>
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
          <View style={{ alignItems: "center", paddingVertical: 70 }}>
            <Text style={{ fontSize: 46, marginBottom: 14 }}>✅</Text>
            <Text style={{ color: colors.gray[300], fontSize: 15 }}>Bandeja al día</Text>
            <Text style={{ color: colors.gray[400], fontSize: 12, marginTop: 4, textAlign: "center", paddingHorizontal: 40 }}>
              No hay ofertas pendientes. Llegan nuevas a medida que se publican en SECOP.
            </Text>
          </View>
        ) : (
          items.map((lic) => (
            <OfferCard
              key={lic.id_proceso}
              lic={lic}
              onOpen={() => openOffer(lic.id_proceso)}
              onDecide={(d) => removeAndDecide(lic.id_proceso, d)}
            />
          ))
        )}
      </ScrollView>

      <ProposalDocument
        licId={selected}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        onDecided={(id, d) => removeAndDecide(id, d)}
      />
      <StatusBar style="light" />
    </View>
  );
}
