import { View, Text, Pressable } from "react-native";
import { colors } from "../../lib/design-tokens";
import { formatCOPCompact } from "../../lib/format";
import { categoryStyle, deadlineInfo, compColor, toNum } from "../../lib/secop-format";
import type { Licitacion } from "../../lib/bridge-api";

export function OfferCard({
  lic, onOpen, onDecide,
}: { lic: Licitacion; onOpen: () => void; onDecide: (d: "accepted" | "rejected") => void }) {
  const style = categoryStyle(lic.overlay_categories);
  const dl = deadlineInfo(lic.fecha_recepcion);
  const comp = lic.competitividad;
  const cat = lic.overlay_categories?.[0] || lic.family_display;

  return (
    <View style={{ backgroundColor: colors.gray[800], borderRadius: 12, borderLeftWidth: 3, borderLeftColor: comp ? compColor(comp.label) : style.color, marginBottom: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
      <Pressable onPress={onOpen} style={({ pressed }) => ({ padding: 14, opacity: pressed ? 0.9 : 1 })}>
        {/* Header: category + entity + deadline */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Text style={{ fontSize: 17 }}>{style.emoji}</Text>
          <Text style={{ color: colors.gray[50], fontSize: 13, fontWeight: "600", flex: 1 }} numberOfLines={1}>{lic.entidad || "—"}</Text>
          <Text style={{ color: dl.color, fontSize: 10.5, fontWeight: "700" }}>{dl.label}</Text>
        </View>

        {/* Objeto */}
        <Text style={{ color: colors.gray[300], fontSize: 12.5, lineHeight: 17, marginBottom: 10 }} numberOfLines={2}>
          {lic.nombre || lic.referencia || lic.id_proceso}
        </Text>

        {/* Metadata */}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Text style={{ color: colors.accentLight, fontFamily: "monospace", fontSize: 12, fontWeight: "700" }}>{formatCOPCompact(toNum(lic.precio_base))}</Text>
          {comp ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: compColor(comp.label) }} />
              <Text style={{ color: compColor(comp.label), fontSize: 10.5, fontWeight: "600" }}>{comp.label}</Text>
            </View>
          ) : null}
          {cat ? <Text style={{ color: colors.text.tertiary, fontSize: 10.5 }}>· {cat}</Text> : null}
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
