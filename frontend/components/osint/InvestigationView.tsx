import { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import {
  fetchOsintInvestigations,
  fetchOsintInvestigation,
  type OsintInvestigation,
  type OsintProfile,
} from "../../lib/bridge-api";
import { PROFILE_TYPE_EMOJI } from "../../lib/osint-constants";

export function InvestigationView() {
  const [investigations, setInvestigations] = useState<OsintInvestigation[]>([]);
  const [selected, setSelected] = useState<{ investigation: OsintInvestigation; profiles: OsintProfile[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchOsintInvestigations();
      setInvestigations(data);
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectInv = useCallback(async (id: number) => {
    try {
      const data = await fetchOsintInvestigation(id);
      setSelected(data);
    } catch {}
  }, []);

  if (loading) return <ActivityIndicator color="#00e5ff" style={{ marginTop: 40 }} />;

  if (selected) {
    const inv = selected.investigation;
    const profiles = selected.profiles || [];
    const byDepth: Record<number, OsintProfile[]> = {};
    for (const p of profiles) {
      const d = (p as any).pivot_depth || 0;
      if (!byDepth[d]) byDepth[d] = [];
      byDepth[d].push(p);
    }

    return (
      <ScrollView style={{ flex: 1 }}>
        <Pressable onPress={() => setSelected(null)} style={{ padding: 12 }}>
          <Text style={{ color: "#00e5ff", fontFamily: "SpaceMono" }}>{"< BACK"}</Text>
        </Pressable>

        <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: "#222" }}>
          <Text style={{ color: "#fff", fontSize: 18, fontFamily: "SpaceMono", fontWeight: "bold" }}>
            {inv.name}
          </Text>
          <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 11, marginTop: 4 }}>
            Status: {inv.status} | Depth: {inv.max_depth} | Pivots: {inv.pivot_count}
          </Text>
          <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 10, marginTop: 2 }}>
            Created: {new Date(inv.created_at).toLocaleDateString()}
          </Text>
        </View>

        {Object.entries(byDepth).sort(([a], [b]) => Number(a) - Number(b)).map(([depth, profs]) => (
          <View key={depth} style={{ padding: 12 }}>
            <Text style={{ color: "#00e5ff", fontFamily: "SpaceMono", fontSize: 12, marginBottom: 8 }}>
              DEPTH {depth} {depth === "0" ? "(SEED)" : `(${profs.length} pivots)`}
            </Text>
            {profs.map(p => (
              <View key={p.id} style={{ backgroundColor: "#1a1a1a", borderRadius: 8, padding: 10, marginBottom: 6, borderLeftWidth: 3, borderLeftColor: depth === "0" ? "#00e5ff" : "#ffab00" }}>
                <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 13 }}>
                  {PROFILE_TYPE_EMOJI[p.profile_type] || "?"} {p.label}
                </Text>
                <Text style={{ color: "#666", fontFamily: "SpaceMono", fontSize: 10 }}>
                  {p.profile_type}: {p.value}
                  {(p as any).pivot_source ? ` | via ${(p as any).pivot_source}` : ""}
                </Text>
              </View>
            ))}
          </View>
        ))}

        {profiles.length === 0 && (
          <Text style={{ color: "#666", fontFamily: "SpaceMono", textAlign: "center", padding: 40 }}>
            No profiles linked yet. Run a scan on the seed image.
          </Text>
        )}
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#00e5ff" />}
    >
      <View style={{ padding: 16 }}>
        <Text style={{ color: "#00e5ff", fontFamily: "SpaceMono", fontSize: 14, marginBottom: 12 }}>
          INVESTIGATIONS
        </Text>

        {investigations.length === 0 && (
          <Text style={{ color: "#666", fontFamily: "SpaceMono", textAlign: "center", padding: 40, fontSize: 12 }}>
            No investigations yet. Upload a photo and start a scan to create one.
          </Text>
        )}

        {investigations.map(inv => (
          <Pressable
            key={inv.id}
            onPress={() => selectInv(inv.id)}
            style={{ backgroundColor: "#1a1a1a", borderRadius: 8, padding: 14, marginBottom: 8, borderLeftWidth: 3, borderLeftColor: inv.status === "active" ? "#00e5ff" : "#555" }}
          >
            <Text style={{ color: "#fff", fontFamily: "SpaceMono", fontSize: 14, fontWeight: "bold" }}>
              {inv.name}
            </Text>
            <Text style={{ color: "#888", fontFamily: "SpaceMono", fontSize: 11, marginTop: 4 }}>
              {inv.seed_label || "No seed"} | {inv.pivot_count} pivots | depth {inv.max_depth}
            </Text>
            <Text style={{ color: "#555", fontFamily: "SpaceMono", fontSize: 10, marginTop: 2 }}>
              {new Date(inv.created_at).toLocaleDateString()} | {inv.status}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
