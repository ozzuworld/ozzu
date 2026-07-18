import { View, Text, Pressable } from "react-native";
import { colors } from "../../lib/design-tokens";
import { formatCOPCompact } from "../../lib/format";
import { categoryStyle, deadlineInfo, compColor, toNum } from "../../lib/secop-format";
import type { Licitacion } from "../../lib/bridge-api";

const RECO = {
  go: { label: "Recomendado", color: colors.success },
  "no-go": { label: "No apto", color: colors.error },
  revisar: { label: "Revisar", color: colors.brand.amber },
} as Record<string, { label: string; color: string }>;

export function OfferCard({
  lic, onOpen, onDecide,
}: { lic: Licitacion; onOpen: () => void; onDecide: (d: "accepted" | "rejected") => void }) {
  const style = categoryStyle(lic.overlay_categories);
  const dl = deadlineInfo(lic.fecha_recepcion);
  const comp = lic.competitividad;
  const reco = lic.reco ? RECO[lic.reco] : null;
  const emoji = lic.card?.emoji || style.emoji;
  const titulo = lic.card?.titulo || lic.entidad || "—";
  const contexto = lic.card?.contexto || lic.nombre || lic.referencia || lic.id_proceso;
  const borderColor = reco ? reco.color : comp ? compColor(comp.label) : style.color;

  return (
    <View style={{ backgroundColor: colors.gray[800], borderRadius: 12, borderLeftWidth: 3, borderLeftColor: borderColor, marginBottom: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
      <Pressable onPress={onOpen} style={({ pressed }) => ({ padding: 14, opacity: pressed ? 0.9 : 1 })}>
        {/* Header: emoji + AI title + entity + deadline */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 8 }}>
          <Text style={{ fontSize: 20 }}>{emoji}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.gray[50], fontSize: 14, fontWeight: "600" }} numberOfLines={1}>{titulo}</Text>
            <Text style={{ color: colors.text.tertiary, fontSize: 10.5 }} numberOfLines={1}>{lic.entidad}</Text>
          </View>
          <Text style={{ color: dl.color, fontSize: 10.5, fontWeight: "700" }}>{dl.label}</Text>
        </View>

        {/* AI context line */}
        <Text style={{ color: colors.gray[300], fontSize: 12.5, lineHeight: 17, marginBottom: 10 }} numberOfLines={2}>{contexto}</Text>

        {/* Metadata: value · recommendation · competitiveness */}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Text style={{ color: colors.accentLight, fontFamily: "monospace", fontSize: 12, fontWeight: "700" }}>{formatCOPCompact(toNum(lic.precio_base))}</Text>
          {reco ? (
            <View style={{ backgroundColor: reco.color + "1a", borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 }}>
              <Text style={{ color: reco.color, fontSize: 10, fontWeight: "700" }}>{reco.label}</Text>
            </View>
          ) : null}
          {comp ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: compColor(comp.label) }} />
              <Text style={{ color: compColor(comp.label), fontSize: 10.5, fontWeight: "600" }}>{comp.label}</Text>
            </View>
          ) : null}
        </View>
      </Pressable>

      {/* Decision buttons */}
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}>
        <Pressable onPress={() => onDecide("rejected")} style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? colors.error + "22" : "transparent", borderColor: colors.error + "55", borderWidth: 1, borderRadius: 9, paddingVertical: 8, alignItems: "center" })}>
          <Text style={{ color: colors.error, fontSize: 12, fontWeight: "700" }}>Rechazar</Text>
        </Pressable>
        <Pressable onPress={() => onDecide("accepted")} style={({ pressed }) => ({ flex: 1, backgroundColor: pressed ? colors.success + "33" : colors.success + "18", borderColor: colors.success + "66", borderWidth: 1, borderRadius: 9, paddingVertical: 8, alignItems: "center" })}>
          <Text style={{ color: colors.success, fontSize: 12, fontWeight: "700" }}>Aceptar</Text>
        </Pressable>
      </View>
    </View>
  );
}
