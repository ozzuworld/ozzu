import { View, Text, Pressable } from "react-native";
import { colors } from "../../lib/design-tokens";
import { formatCOPCompact } from "../../lib/format";
import { categoryStyle, deadlineInfo, toNum, compColor } from "../../lib/secop-format";
import type { Licitacion } from "../../lib/bridge-api";

function Pill({ text, color, bg }: { text: string; color: string; bg?: string }) {
  return (
    <View style={{ backgroundColor: bg ?? color + "1a", borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 }}>
      <Text style={{ color, fontSize: 10, fontWeight: "600" }} numberOfLines={1}>{text}</Text>
    </View>
  );
}

export function LicitacionCard({ lic, onPress }: { lic: Licitacion; onPress: () => void }) {
  const style = categoryStyle(lic.overlay_categories);
  const dl = deadlineInfo(lic.fecha_recepcion);
  const overlay = lic.overlay_categories?.[0] || lic.family_display;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] })}
    >
      <View
        style={{
          backgroundColor: colors.gray[800],
          borderRadius: 12,
          borderLeftWidth: 3,
          borderLeftColor: style.color,
          marginBottom: 10,
          padding: 14,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.04)",
        }}
      >
        {/* Header: category emoji + entity + deadline pill (focal) */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Text style={{ fontSize: 18 }}>{style.emoji}</Text>
          <Text style={{ color: colors.gray[50], fontSize: 13, fontWeight: "600", flex: 1 }} numberOfLines={1}>
            {lic.entidad || "—"}
          </Text>
          <Pill text={dl.label} color={dl.color} />
        </View>

        {/* Title */}
        <Text style={{ color: colors.gray[300], fontSize: 12.5, lineHeight: 17, marginBottom: 10 }} numberOfLines={2}>
          {lic.nombre || lic.referencia || lic.id_proceso}
        </Text>

        {/* Metadata row */}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <Text style={{ color: colors.accentLight, fontFamily: "monospace", fontSize: 12, fontWeight: "700" }}>
            {formatCOPCompact(toNum(lic.precio_base))}
          </Text>
          {lic.competitividad ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: compColor(lic.competitividad.label) + "1a", borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: compColor(lic.competitividad.label) }} />
              <Text style={{ color: compColor(lic.competitividad.label), fontSize: 10, fontWeight: "600" }}>{lic.competitividad.label}</Text>
            </View>
          ) : null}
          {lic.departamento ? <Pill text={lic.departamento} color={colors.text.secondary} bg={colors.gray[700]} /> : null}
          {overlay ? <Pill text={overlay} color={style.color} /> : null}
          <View style={{ flex: 1 }} />
          {lic.linked_venture_id ? <Pill text="✓ Venture" color={colors.success} /> : null}
        </View>
      </View>
    </Pressable>
  );
}
