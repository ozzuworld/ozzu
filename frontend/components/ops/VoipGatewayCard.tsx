import { View, Text } from "react-native";
import { colors } from "../../lib/design-tokens";
import type { VoipStatus } from "../../lib/voip-hooks";

// Matches FleetDeviceCard's visual grammar so the VoIP gateway sits naturally among the
// other fleet devices: bg.elevated / radius 10 / padding 14, left-accent in the device
// color, header (emoji + id + colored label pill + UP/DOWN), and the same Pill stats row.
const GREEN = colors.success;
const RED = colors.error;
const YELLOW = colors.brand.amberDeep;
const ACCENT = colors.accent;
const DIM = colors.text.tertiary;
const COLOR = ACCENT; // VoIP gateway accent (cyan)

function Pill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ marginRight: 14 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 8, color: DIM, letterSpacing: 1 }}>{label}</Text>
      <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 11, color: color || colors.text.primary }}>{value}</Text>
    </View>
  );
}

export default function VoipGatewayCard({ status }: { status: VoipStatus }) {
  const june = status.june.running;
  const ast = status.asteriskUp;
  const appReg = status.app.registered;
  const online = june && ast;
  const borderColor = online ? "rgba(255,255,255,0.08)" : "rgba(239,68,68,0.3)";

  return (
    <View style={{
      backgroundColor: colors.bg.elevated,
      borderWidth: 1,
      borderColor,
      borderLeftWidth: 3,
      borderLeftColor: online ? COLOR : RED,
      borderRadius: 10,
      padding: 14,
      marginBottom: 10,
    }}>
      {/* ── Header (mirrors FleetDeviceCard) ── */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ fontSize: 20 }}>📡</Text>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 13, color: colors.text.primary, letterSpacing: 0.5 }}>
              voip-gateway
            </Text>
            <View style={{ backgroundColor: `${COLOR}20`, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
              <Text style={{ fontFamily: "monospace", fontSize: 7, fontWeight: "700", color: COLOR, letterSpacing: 0.5 }}>
                VOIP GATEWAY
              </Text>
            </View>
          </View>
          <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM, marginTop: 2 }}>
            June receptionist · Asterisk PBX · GSM/SIP trunk
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? GREEN : RED }} />
            <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: online ? GREEN : RED }}>
              {online ? "UP" : "DEGRADED"}
            </Text>
          </View>
          {status.activeCalls > 0 && (
            <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: ACCENT }}>
              {status.activeCalls} live
            </Text>
          )}
        </View>
      </View>

      {/* ── Quick stats — identical Pill row to FleetDeviceCard ── */}
      <View style={{ flexDirection: "row", marginTop: 10, flexWrap: "wrap" }}>
        <Pill label="JUNE" value={june ? "UP" : "DOWN"} color={june ? GREEN : RED} />
        <Pill label="ASTERISK" value={ast ? "UP" : "DOWN"} color={ast ? GREEN : RED} />
        <Pill label="APP" value={appReg ? "READY" : "CLOSED"} color={appReg ? GREEN : YELLOW} />
        <Pill label="CALLS" value={`${status.activeCalls}`} color={status.activeCalls > 0 ? ACCENT : undefined} />
      </View>
    </View>
  );
}
