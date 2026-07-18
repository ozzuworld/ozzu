import { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, Pressable, Modal, ActivityIndicator, Linking, Alert } from "react-native";
import { useRouter } from "expo-router";
import { colors } from "../../lib/design-tokens";
import { formatCOP } from "../../lib/format";
import { categoryStyle, deadlineInfo, toNum } from "../../lib/secop-format";
import { fetchLicitacion, createVentureFromLicitacion, type Licitacion } from "../../lib/bridge-api";

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function Fact({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1, minWidth: 130 }}>
      <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 9, letterSpacing: 1, marginBottom: 3 }}>{label}</Text>
      <Text style={{ color: color || colors.gray[50], fontSize: 13, fontWeight: "600" }}>{value}</Text>
    </View>
  );
}

export function LicitacionDetailSheet({
  licId, visible, onClose, onChanged,
}: { licId: string | null; visible: boolean; onClose: () => void; onChanged: () => void }) {
  const router = useRouter();
  const [lic, setLic] = useState<Licitacion | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!visible || !licId) { setLic(null); return; }
    let alive = true;
    setLoading(true);
    fetchLicitacion(licId)
      .then((d) => { if (alive) setLic(d); })
      .catch(() => { if (alive) setLic(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [visible, licId]);

  const goToVentures = useCallback(() => { onClose(); router.replace("/business"); }, [onClose, router]);

  const handleCreate = useCallback(async () => {
    if (!lic) return;
    setCreating(true);
    try {
      const r = await createVentureFromLicitacion(lic.id_proceso);
      onChanged();
      setCreating(false);
      Alert.alert(
        r.created ? "Venture creada ✓" : "Ya existía una venture",
        r.created ? `Se creó con ${r.task_count} tareas del pipeline de licitación.` : "Esta licitación ya está vinculada a una venture.",
        [{ text: "Seguir aquí", style: "cancel" }, { text: "Ver en Ventures", onPress: goToVentures }]
      );
    } catch (e: any) {
      setCreating(false);
      Alert.alert("Error", e?.message || "No se pudo crear la venture");
    }
  }, [lic, onChanged, goToVentures]);

  const style = lic ? categoryStyle(lic.overlay_categories) : { emoji: "📋", color: colors.accent };
  const dl = deadlineInfo(lic?.fecha_recepcion);
  const url = lic?.url_proceso || null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={{ backgroundColor: colors.bg.base, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "90%", borderTopWidth: 3, borderTopColor: style.color }}>
          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 16, borderBottomWidth: 0.5, borderBottomColor: "rgba(255,255,255,0.06)" }}>
            <Text style={{ fontSize: 22 }}>{style.emoji}</Text>
            <Text style={{ color: colors.gray[50], fontSize: 14, fontWeight: "700", flex: 1 }} numberOfLines={1}>
              {lic?.entidad || "Licitación"}
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={{ color: colors.text.tertiary, fontSize: 22, lineHeight: 22 }}>✕</Text>
            </Pressable>
          </View>

          {loading || !lic ? (
            <View style={{ padding: 40, alignItems: "center" }}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : (
            <>
              <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ padding: 16, gap: 16 }} showsVerticalScrollIndicator={false}>
                {/* Title */}
                <Text style={{ color: colors.gray[50], fontSize: 16, fontWeight: "700", lineHeight: 22 }}>
                  {lic.nombre || lic.referencia || lic.id_proceso}
                </Text>

                {/* Deadline banner */}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: dl.color + "14", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: dl.color + "33" }}>
                  <View>
                    <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 9, letterSpacing: 1 }}>CIERRE DE OFERTAS</Text>
                    <Text style={{ color: colors.gray[50], fontSize: 15, fontWeight: "700", marginTop: 2 }}>{fmtDate(lic.fecha_recepcion)}</Text>
                  </View>
                  <Text style={{ color: dl.color, fontSize: 15, fontWeight: "800" }}>{dl.label}</Text>
                </View>

                {/* Facts */}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
                  <Fact label="VALOR BASE" value={formatCOP(toNum(lic.precio_base))} color={colors.accentLight} />
                  <Fact label="MODALIDAD" value={lic.modalidad || "—"} />
                  <Fact label="UBICACIÓN" value={[lic.ciudad, lic.departamento].filter(Boolean).join(", ") || "—"} />
                  <Fact label="ESTADO" value={lic.estado_resumen || "—"} />
                </View>

                {/* Categories */}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {lic.segment_name ? (
                    <View style={{ backgroundColor: colors.gray[800], borderRadius: 6, paddingHorizontal: 9, paddingVertical: 5 }}>
                      <Text style={{ color: colors.text.secondary, fontSize: 11 }}>{lic.segment_name}</Text>
                    </View>
                  ) : null}
                  {(lic.overlay_categories || []).map((c) => (
                    <View key={c} style={{ backgroundColor: style.color + "1a", borderRadius: 6, paddingHorizontal: 9, paddingVertical: 5 }}>
                      <Text style={{ color: style.color, fontSize: 11, fontWeight: "600" }}>{c}</Text>
                    </View>
                  ))}
                </View>

                {/* Description */}
                {lic.descripcion ? (
                  <View>
                    <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 9, letterSpacing: 1, marginBottom: 6 }}>OBJETO</Text>
                    <Text style={{ color: colors.gray[300], fontSize: 13, lineHeight: 19 }}>{lic.descripcion}</Text>
                  </View>
                ) : null}

                {/* Open in SECOP */}
                {url ? (
                  <Pressable
                    onPress={() => Linking.openURL(url)}
                    style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1, alignSelf: "flex-start", borderColor: colors.border.default, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9 })}
                  >
                    <Text style={{ color: colors.text.secondary, fontSize: 12, fontWeight: "600" }}>↗ Abrir en SECOP II</Text>
                  </Pressable>
                ) : null}
              </ScrollView>

              {/* CTA footer */}
              <View style={{ padding: 16, borderTopWidth: 0.5, borderTopColor: "rgba(255,255,255,0.06)" }}>
                {lic.linked_venture_id ? (
                  <Pressable
                    onPress={goToVentures}
                    style={({ pressed }) => ({ backgroundColor: pressed ? colors.gray[700] : colors.gray[800], borderRadius: 12, paddingVertical: 15, alignItems: "center", borderWidth: 1, borderColor: colors.success + "55" })}
                  >
                    <Text style={{ color: colors.success, fontSize: 14, fontWeight: "700" }}>✓ Ver Venture vinculada</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={handleCreate}
                    disabled={creating}
                    style={({ pressed }) => ({ backgroundColor: creating ? colors.gray[700] : pressed ? style.color + "cc" : style.color, borderRadius: 12, paddingVertical: 15, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 })}
                  >
                    {creating ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ fontSize: 15 }}>🚀</Text>}
                    <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>
                      {creating ? "Creando venture…" : "Crear Venture (pipeline de licitación)"}
                    </Text>
                  </Pressable>
                )}
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
