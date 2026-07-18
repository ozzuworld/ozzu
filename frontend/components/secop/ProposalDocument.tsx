import { useState, useEffect, useCallback } from "react";
import { View, Text, ScrollView, Pressable, Modal, ActivityIndicator, Linking, Alert } from "react-native";
import { useRouter } from "expo-router";
import { colors } from "../../lib/design-tokens";
import { formatCOP } from "../../lib/format";
import { compColor, deadlineInfo, categoryStyle, toNum } from "../../lib/secop-format";
import {
  fetchLicitacion, fetchTenderDetail, decideOffer, createVentureFromLicitacion,
  type Licitacion, type TenderDetail,
} from "../../lib/bridge-api";

const RECO = {
  go: { label: "RECOMENDADO", color: colors.success },
  "no-go": { label: "NO RECOMENDADO", color: colors.error },
  revisar: { label: "REVISAR", color: colors.brand.amber },
} as Record<string, { label: string; color: string }>;

function Block({ label, color, children }: { label: string; color?: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 4 }}>
      <Text style={{ color: color || colors.accentLight, fontFamily: "monospace", fontSize: 10, letterSpacing: 1.5, marginBottom: 7 }}>{label}</Text>
      {children}
    </View>
  );
}
function Bullets({ items, color }: { items?: string[]; color?: string }) {
  if (!items?.length) return null;
  return (
    <View style={{ gap: 5, marginTop: 4 }}>
      {items.map((t, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 7 }}>
          <Text style={{ color: color || colors.text.tertiary, fontSize: 12 }}>•</Text>
          <Text style={{ color: colors.gray[300], fontSize: 12.5, lineHeight: 18, flex: 1 }}>{String(t)}</Text>
        </View>
      ))}
    </View>
  );
}

export function ProposalDocument({
  licId, visible, onClose, onDecided,
}: { licId: string | null; visible: boolean; onClose: () => void; onDecided: (id: string, d: "accepted" | "rejected") => void }) {
  const router = useRouter();
  const [lic, setLic] = useState<Licitacion | null>(null);
  const [detail, setDetail] = useState<TenderDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "building" | "ready" | "error">("loading");
  const [deciding, setDeciding] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (!visible || !licId) { setLic(null); setDetail(null); setStatus("loading"); return; }
    let alive = true, tries = 0, timer: any;
    setStatus("loading");
    fetchLicitacion(licId).then((d) => alive && setLic(d)).catch(() => {});
    const poll = async () => {
      try {
        const r = await fetchTenderDetail(licId);
        if (!alive) return;
        if (r.status === "ready" && r.detail) { setDetail(r.detail); setStatus("ready"); return; }
        setStatus("building");
        if (tries++ < 45) timer = setTimeout(poll, 6000); else setStatus("error");
      } catch { if (alive) setStatus("error"); }
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [visible, licId]);

  const decide = useCallback(async (decision: "accepted" | "rejected") => {
    if (!licId) return;
    setDeciding(true);
    try {
      await decideOffer(licId, decision);
      onDecided(licId, decision);
      onClose();
    } catch (e: any) { Alert.alert("Error", e?.message || "No se pudo registrar la decisión"); }
    finally { setDeciding(false); }
  }, [licId, onDecided, onClose]);

  const style = lic ? categoryStyle(lic.overlay_categories) : { emoji: "📄", color: colors.accent };
  const dl = deadlineInfo(lic?.fecha_recepcion);
  const comp = lic?.competitividad;
  const brief = detail?.brief;
  const reco = brief?.recomendacion?.decision ? RECO[brief.recomendacion.decision] : null;
  const tec = brief?.implicaciones_tecnicas;
  const fin = brief?.implicaciones_financieras;
  const url = lic?.url_proceso || null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={{ backgroundColor: colors.bg.base, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "92%", borderTopWidth: 3, borderTopColor: style.color }}>
          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 16, borderBottomWidth: 0.5, borderBottomColor: "rgba(255,255,255,0.06)" }}>
            <Text style={{ fontSize: 20 }}>{style.emoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text.tertiary, fontFamily: "monospace", fontSize: 9, letterSpacing: 1 }}>PROPUESTA</Text>
              <Text style={{ color: colors.gray[50], fontSize: 13, fontWeight: "700" }} numberOfLines={1}>{lic?.entidad || "…"}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}><Text style={{ color: colors.text.tertiary, fontSize: 22 }}>✕</Text></Pressable>
          </View>

          {status !== "ready" || !lic ? (
            <View style={{ padding: 40, alignItems: "center", gap: 12 }}>
              <ActivityIndicator color={colors.accent} />
              <Text style={{ color: colors.text.secondary, fontSize: 12.5, textAlign: "center" }}>
                {status === "building" ? "Analizando pliegos y redactando la propuesta… (puede tardar 1–2 min)" : status === "error" ? "No se pudo generar la propuesta." : "Cargando…"}
              </Text>
            </View>
          ) : (
            <>
              <ScrollView style={{ maxHeight: 500 }} contentContainerStyle={{ padding: 16, gap: 20 }} showsVerticalScrollIndicator={false}>
                {/* Title + key facts */}
                <View>
                  <Text style={{ color: colors.gray[50], fontSize: 16, fontWeight: "700", lineHeight: 22 }}>{lic.nombre || lic.referencia}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                    <Text style={{ color: colors.accentLight, fontFamily: "monospace", fontSize: 13, fontWeight: "700" }}>{formatCOP(toNum(lic.precio_base))}</Text>
                    <Text style={{ color: dl.color, fontSize: 12, fontWeight: "700" }}>{dl.label}</Text>
                    {comp ? <Text style={{ color: compColor(comp.label), fontSize: 12, fontWeight: "700" }}>· {comp.label} ({comp.score})</Text> : null}
                  </View>
                </View>

                {/* Recomendación banner */}
                {reco ? (
                  <View style={{ backgroundColor: reco.color + "14", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: reco.color + "40" }}>
                    <Text style={{ color: reco.color, fontSize: 14, fontWeight: "800" }}>{reco.label}</Text>
                    {brief?.recomendacion?.razon ? <Text style={{ color: colors.gray[200], fontSize: 12.5, lineHeight: 18, marginTop: 4 }}>{brief.recomendacion.razon}</Text> : null}
                  </View>
                ) : null}

                {/* Qué es */}
                {brief?.que_es ? (
                  <Block label="QUÉ ES"><Text style={{ color: colors.gray[200], fontSize: 13.5, lineHeight: 20 }}>{brief.que_es}</Text></Block>
                ) : null}

                {/* Implicaciones técnicas */}
                {tec ? (
                  <Block label="IMPLICACIONES TÉCNICAS" color={colors.brand.blue}>
                    {tec.resumen ? <Text style={{ color: colors.gray[200], fontSize: 13, lineHeight: 19 }}>{tec.resumen}</Text> : null}
                    {tec.requiere?.length ? <><Text style={{ color: colors.text.tertiary, fontSize: 11, marginTop: 8, fontWeight: "700" }}>Requiere</Text><Bullets items={tec.requiere} color={colors.brand.blue} /></> : null}
                    {tec.riesgos?.length ? <><Text style={{ color: colors.text.tertiary, fontSize: 11, marginTop: 8, fontWeight: "700" }}>Riesgos</Text><Bullets items={tec.riesgos} color={colors.error} /></> : null}
                  </Block>
                ) : null}

                {/* Implicaciones financieras */}
                {fin ? (
                  <Block label="IMPLICACIONES FINANCIERAS" color={colors.success}>
                    {fin.resumen ? <Text style={{ color: colors.gray[200], fontSize: 13, lineHeight: 19 }}>{fin.resumen}</Text> : null}
                    {fin.costos_clave?.length ? <><Text style={{ color: colors.text.tertiary, fontSize: 11, marginTop: 8, fontWeight: "700" }}>Costos / compromisos</Text><Bullets items={fin.costos_clave} color={colors.brand.amber} /></> : null}
                    {fin.consideracion ? <Text style={{ color: colors.text.secondary, fontSize: 12, fontStyle: "italic", marginTop: 8 }}>{fin.consideracion}</Text> : null}
                  </Block>
                ) : null}

                {/* Supporting detail — collapsed so the brief IS the document */}
                {(() => {
                  const h = detail?.habilitantes || {};
                  const all = [...(h.juridicos || []), ...(h.financieros || []), ...(h.tecnicos || []), ...(h.experiencia || [])];
                  if (!all.length && !detail?.cronograma?.length) return null;
                  return (
                    <View style={{ borderTopWidth: 0.5, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 14 }}>
                      <Pressable onPress={() => setShowDetails((v) => !v)} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
                        <Text style={{ color: colors.text.secondary, fontSize: 12, fontWeight: "600" }}>
                          {showDetails ? "▾ Ocultar detalles del proceso" : "▸ Ver detalles del proceso (requisitos, cronograma)"}
                        </Text>
                      </Pressable>
                      {showDetails ? (
                        <View style={{ gap: 16, marginTop: 12 }}>
                          {all.length ? <Block label={`REQUISITOS HABILITANTES (${all.length})`}><Bullets items={all} /></Block> : null}
                          {detail?.cronograma?.length ? (
                            <Block label="CRONOGRAMA">
                              <View style={{ gap: 5 }}>
                                {detail.cronograma.slice(0, 8).map((c, i) => (
                                  <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
                                    <Text style={{ color: colors.gray[300], fontSize: 12.5, flex: 1 }}>{c.hito}</Text>
                                    <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 11.5 }}>{String(c.fecha || "").slice(0, 10)}</Text>
                                  </View>
                                ))}
                              </View>
                            </Block>
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  );
                })()}

                {url ? (
                  <Pressable onPress={() => Linking.openURL(url)} style={({ pressed }) => ({ alignSelf: "flex-start", opacity: pressed ? 0.7 : 1, borderColor: colors.border.default, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 })}>
                    <Text style={{ color: colors.text.secondary, fontSize: 12 }}>↗ Ver documentos en SECOP II</Text>
                  </Pressable>
                ) : null}
              </ScrollView>

              {/* Decision footer */}
              <View style={{ flexDirection: "row", gap: 10, padding: 16, borderTopWidth: 0.5, borderTopColor: "rgba(255,255,255,0.06)" }}>
                <Pressable onPress={() => decide("rejected")} disabled={deciding} style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? colors.error + "22" : "transparent", borderColor: colors.error + "77", borderWidth: 1, borderRadius: 12, paddingVertical: 14, alignItems: "center" })}>
                  <Text style={{ color: colors.error, fontSize: 14, fontWeight: "700" }}>✕ Rechazar</Text>
                </Pressable>
                <Pressable onPress={() => decide("accepted")} disabled={deciding} style={({ pressed }) => ({ flex: 1.4, backgroundColor: deciding ? colors.gray[700] : pressed ? colors.success + "cc" : colors.success, borderRadius: 12, paddingVertical: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 })}>
                  {deciding ? <ActivityIndicator color="#fff" size="small" /> : null}
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "800" }}>✓ Aceptar</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
