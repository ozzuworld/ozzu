import { View, Text } from "react-native";
import { colors, withAlpha, radius } from "../../lib/design-tokens";
import type { VoipStatus } from "../../lib/voip-hooks";

const MONO = "monospace";

// The VoIP gateway as a Fleet "device": June receptionist + Asterisk PBX + GSM/SIP
// trunk, the stack that receives calls and hands them to the iPhone app.
export default function VoipGatewayCard({ status }: { status: VoipStatus }) {
  const june = status.june.running;
  const ast = status.asteriskUp;
  const appReg = status.app.registered;
  const healthy = june && ast;
  const color = healthy ? colors.success : colors.error;

  const pills = [
    { label: "JUNE", ok: june },
    { label: "ASTERISK", ok: ast },
    { label: "APP", ok: appReg, warn: !appReg },
  ];

  return (
    <View style={{ backgroundColor: colors.bg.elevated, borderRadius: radius.md, borderWidth: 1, borderLeftWidth: 3, borderColor: colors.border.subtle, borderLeftColor: color, padding: 14, marginBottom: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <Text style={{ fontSize: 22 }}>📡</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: MONO, fontSize: 14, fontWeight: "700", color: colors.text.primary }}>VoIP Gateway</Text>
          <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.text.tertiary }}>June · Asterisk PBX · GSM/SIP trunk</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: withAlpha(color, 0.12), borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
          <Text style={{ fontFamily: MONO, fontSize: 9, fontWeight: "700", color, letterSpacing: 0.5 }}>{healthy ? "ONLINE" : "DEGRADED"}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {pills.map((s) => (
          <View key={s.label} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.bg.surface, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 6 }}>
            <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: s.ok ? colors.success : s.warn ? colors.warning : colors.error }} />
            <Text style={{ fontFamily: MONO, fontSize: 9, color: colors.text.secondary }}>{s.label}</Text>
          </View>
        ))}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: colors.bg.surface, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 6 }}>
          <Text style={{ fontFamily: MONO, fontSize: 9, fontWeight: "700", color: status.activeCalls > 0 ? colors.accent : colors.text.tertiary }}>
            {status.activeCalls} live
          </Text>
        </View>
      </View>
    </View>
  );
}
