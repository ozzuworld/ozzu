import { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, Pressable, Modal, ActivityIndicator, Linking, Alert } from "react-native";
import { useRouter } from "expo-router";
import { colors } from "../../lib/design-tokens";
import { formatCOP } from "../../lib/format";
import { categoryStyle, deadlineInfo, toNum, compColor } from "../../lib/secop-format";
import { fetchLicitacion, createVentureFromLicitacion, fetchTenderDetail, type Licitacion, type TenderDetail } from "../../lib/bridge-api";

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

function SecLabel({ children }: { children: string }) {
  return <Text style={{ color: colors.accentLight, fontFamily: "monospace", fontSize: 10, letterSpacing: 1.5, marginBottom: 8 }}>{children}</Text>;
}

function Bullets({ items, max }: { items: string[]; max?: number }) {
  const list = max ? items.slice(0, max) : items;
  return (
    <View style={{ gap: 5 }}>
      {list.map((t, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 7 }}>
          <Text style={{ color: colors.text.tertiary, fontSize: 12 }}>•</Text>
          <Text style={{ color: colors.gray[300], fontSize: 12.5, lineHeight: 18, flex: 1 }}>{String(t)}</Text>
        </View>
      ))}
      {max && items.length > max ? (
        <Text style={{ color: colors.text.tertiary, fontSize: 11, marginLeft: 14, fontStyle: "italic" }}>+{items.length - max} más</Text>
      ) : null}
    </View>
  );
}

// The AI-extracted tender structure, rendered natively (no PDF, no portal).
function TenderDetailView({ d }: { d: TenderDetail }) {
  const h = d.habilitantes || {};
  const habGroups: [string, string[]][] = [
    ["Jurídicos", h.juridicos || []], ["Financieros", h.financieros || []],
    ["Técnicos", h.tecnicos || []], ["Experiencia", h.experiencia || []],
  ];
  return (
    <View style={{ gap: 18 }}>
      {d.cronograma?.length ? (
        <View>
          <SecLabel>CRONOGRAMA</SecLabel>
          <View style={{ gap: 6 }}>
            {d.cronograma.map((c, i) => (
              <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <Text style={{ color: colors.gray[300], fontSize: 12.5, flex: 1 }}>{c.hito}</Text>
                <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 11.5 }}>{String(c.fecha || "").slice(0, 16)}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {habGroups.some(([, v]) => v.length) ? (
        <View>
          <SecLabel>REQUISITOS HABILITANTES</SecLabel>
          <View style={{ gap: 12 }}>
            {habGroups.filter(([, v]) => v.length).map(([name, items]) => (
              <View key={name}>
                <Text style={{ color: colors.text.secondary, fontSize: 11, fontWeight: "700", marginBottom: 5 }}>{name}</Text>
                <Bullets items={items} max={6} />
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {d.evaluacion?.length ? (
        <View>
          <SecLabel>EVALUACIÓN</SecLabel>
          <View style={{ gap: 6 }}>
            {d.evaluacion.map((c, i) => (
              <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
                <Text style={{ color: colors.gray[300], fontSize: 12.5, flex: 1 }}>{c.factor}</Text>
                <Text style={{ color: colors.accentLight, fontFamily: "monospace", fontSize: 11.5, fontWeight: "700" }}>{String(c.puntaje)}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {d.garantias?.length ? (
        <View>
          <SecLabel>GARANTÍAS</SecLabel>
          <View style={{ gap: 8 }}>
            {d.garantias.map((g, i) => (
              <View key={i} style={{ backgroundColor: colors.gray[800], borderRadius: 8, padding: 10 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ color: colors.gray[50], fontSize: 12.5, fontWeight: "600", flex: 1 }}>{g.tipo}</Text>
                  {g.porcentaje ? <Text style={{ color: colors.accentLight, fontFamily: "monospace", fontSize: 12, fontWeight: "700" }}>{g.porcentaje}</Text> : null}
                </View>
                {g.vigencia ? <Text style={{ color: colors.text.tertiary, fontSize: 11, marginTop: 3 }}>Vigencia: {g.vigencia}</Text> : null}
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {d.especificaciones?.length ? (
        <View>
          <SecLabel>ESPECIFICACIONES TÉCNICAS</SecLabel>
          <Bullets items={d.especificaciones} max={10} />
        </View>
      ) : null}

      {d.documentos?.length ? (
        <View>
          <SecLabel>{`DOCUMENTOS (${d.documentos.length})`}</SecLabel>
          <View style={{ gap: 4 }}>
            {d.documentos.slice(0, 12).map((doc, i) => (
              <Pressable key={i} onPress={() => doc.url && Linking.openURL(doc.url)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}>
                <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 9, width: 30 }}>{(doc.ext || "").toUpperCase()}</Text>
                <Text style={{ color: colors.accentLight, fontSize: 12, flex: 1 }} numberOfLines={1}>{doc.name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
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
  const [detail, setDetail] = useState<TenderDetail | null>(null);
  const [detailStatus, setDetailStatus] = useState<"idle" | "building" | "ready" | "error">("idle");

  // Lazy-build + poll the AI-extracted tender detail while the sheet is open.
  useEffect(() => {
    if (!visible || !licId) { setDetail(null); setDetailStatus("idle"); return; }
    let alive = true, tries = 0, timer: any;
    const poll = async () => {
      try {
        const r = await fetchTenderDetail(licId);
        if (!alive) return;
        if (r.status === "ready" && r.detail) { setDetail(r.detail); setDetailStatus("ready"); return; }
        setDetailStatus("building");
        if (tries++ < 45) timer = setTimeout(poll, 6000);
        else setDetailStatus("error");
      } catch { if (alive) setDetailStatus("error"); }
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [visible, licId]);

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

                {/* Competitiveness / amarrado-risk */}
                {lic.competitividad ? (
                  <View style={{ backgroundColor: compColor(lic.competitividad.label) + "14", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: compColor(lic.competitividad.label) + "33" }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <View>
                        <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 9, letterSpacing: 1 }}>COMPETENCIA</Text>
                        <Text style={{ color: compColor(lic.competitividad.label), fontSize: 15, fontWeight: "800", marginTop: 2 }}>{lic.competitividad.label}</Text>
                      </View>
                      <Text style={{ color: compColor(lic.competitividad.label), fontFamily: "monospace", fontSize: 24, fontWeight: "800" }}>{lic.competitividad.score}</Text>
                    </View>
                    <Text style={{ color: colors.gray[300], fontSize: 12, marginTop: 8, lineHeight: 17 }}>
                      {lic.competitividad.basis === "entidad"
                        ? `Esta entidad ha adjudicado ${lic.competitividad.adjudicated_total} procesos con ${lic.competitividad.avg_bidders ?? "—"} oferentes en promedio; ${lic.competitividad.single_rate}% tuvieron un solo oferente.`
                        : `Sin historial suficiente de esta entidad — estimado por modalidad: ~${lic.competitividad.single_rate}% de estos procesos tienen un solo oferente.`}
                    </Text>
                    <Text style={{ color: colors.text.tertiary, fontSize: 10.5, marginTop: 5, fontStyle: "italic" }}>
                      Un solo oferente sugiere posible pliego a la medida — señal, no prueba.
                    </Text>
                  </View>
                ) : null}

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

                {/* AI-extracted tender detail (native — no PDF, no portal) */}
                {detailStatus === "building" ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 14, backgroundColor: colors.gray[800], borderRadius: 10 }}>
                    <ActivityIndicator color={colors.accent} size="small" />
                    <Text style={{ color: colors.text.secondary, fontSize: 12.5 }}>Analizando pliegos con IA… (puede tardar 1–2 min)</Text>
                  </View>
                ) : detailStatus === "ready" && detail ? (
                  <TenderDetailView d={detail} />
                ) : detailStatus === "error" ? (
                  <Text style={{ color: colors.text.tertiary, fontSize: 11.5, fontStyle: "italic" }}>No se pudo extraer el detalle de los pliegos automáticamente.</Text>
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
