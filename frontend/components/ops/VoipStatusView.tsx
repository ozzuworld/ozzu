import { View, Text } from "react-native";
import { colors, withAlpha, radius } from "../../lib/design-tokens";
import { formatRelativeTime } from "../../lib/format";
import type { VoipStatus, VoipEndpoint } from "../../lib/voip-hooks";

const MONO = "monospace";

function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

function StatChip({ emoji, label, value, color }: { emoji: string; label: string; value: string; color: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.elevated, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border.subtle, padding: 10, gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <Text style={{ fontSize: 12 }}>{emoji}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 9, color: colors.text.tertiary, letterSpacing: 0.5 }}>{label}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Dot color={color} />
        <Text style={{ fontFamily: MONO, fontSize: 12, fontWeight: "700", color: colors.text.primary }}>{value}</Text>
      </View>
    </View>
  );
}

const EP_EMOJI: Record<string, string> = { "ozzu-iphone": "📱", "ozzu-gateway": "📡" };

function EndpointCard({ e }: { e: VoipEndpoint }) {
  // The gateway is an IP-identified static trunk — an "Unavailable" endpoint state is
  // normal (no registration/qualify), so it's not "down", it's configured.
  const isTrunk = e.id === "ozzu-gateway";
  const color = e.registered ? colors.success : isTrunk ? colors.info : colors.error;
  const statusLabel = e.registered ? "REGISTERED" : isTrunk ? "STATIC TRUNK" : "OFFLINE";
  return (
    <View style={{ backgroundColor: colors.bg.elevated, borderRadius: radius.md, borderWidth: 1, borderLeftWidth: 3, borderColor: colors.border.subtle, borderLeftColor: color, padding: 12, marginBottom: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Text style={{ fontSize: 16 }}>{EP_EMOJI[e.id] || "🔌"}</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: "700", color: colors.text.primary }}>{e.id}</Text>
          <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.text.tertiary }}>{e.role}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: withAlpha(color, 0.12), borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
          <Dot color={color} />
          <Text style={{ fontFamily: MONO, fontSize: 9, fontWeight: "700", color, letterSpacing: 0.5 }}>{statusLabel}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: colors.border.subtle, paddingTop: 6 }}>
        <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.text.secondary }}>{e.state}</Text>
        {e.rttMs != null && <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.text.tertiary }}>RTT {e.rttMs}ms</Text>}
        {e.channels > 0 && <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.accent }}>{e.channels} on call</Text>}
      </View>
    </View>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <Text style={{ fontFamily: MONO, fontSize: 10, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1.5, marginTop: 16, marginBottom: 8 }}>{title}</Text>;
}

function ConfigRow({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, gap: 12 }}>
      <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.text.tertiary }}>{k}</Text>
      <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.text.secondary, flex: 1, textAlign: "right" }}>{v}</Text>
    </View>
  );
}

const EVENT_LABEL: Record<string, string> = {
  call_start: "📞 call", transfer: "➡️ transfer", hangup: "🔚 hangup", duration_limit: "⏱ timeout",
};

export default function VoipStatusView({ status }: { status: VoipStatus | null }) {
  if (!status) return null;
  const app = status.app;
  const flow = ["Caller", "Gateway", "Asterisk", "June", "▸ App"];

  return (
    <View>
      {/* Summary chips */}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <StatChip emoji="🎙️" label="JUNE" value={status.june.running ? "LIVE" : "DOWN"} color={status.june.running ? colors.success : colors.error} />
        <StatChip emoji="☎️" label="ASTERISK" value={status.asteriskUp ? "UP" : "DOWN"} color={status.asteriskUp ? colors.success : colors.error} />
        <StatChip emoji="📶" label="ACTIVE" value={String(status.activeCalls)} color={status.activeCalls > 0 ? colors.accent : colors.text.tertiary} />
        <StatChip emoji="📱" label="APP" value={app.registered ? "READY" : "CLOSED"} color={app.registered ? colors.success : colors.warning} />
      </View>

      {/* Hand-off path */}
      <SectionHeader title="HAND-OFF PATH" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
        {flow.map((step, i) => (
          <View key={i} style={{ backgroundColor: colors.bg.surface, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4 }}>
            <Text style={{ fontFamily: MONO, fontSize: 10, color: i === flow.length - 1 ? colors.accent : colors.text.secondary }}>{step}</Text>
          </View>
        ))}
      </View>

      {/* SIP endpoints */}
      <SectionHeader title="SIP ENDPOINTS" />
      {status.endpoints.map((e) => <EndpointCard key={e.id} e={e} />)}

      {/* Configuration */}
      <SectionHeader title="CONFIGURATION" />
      <View style={{ backgroundColor: colors.bg.elevated, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border.subtle, padding: 12 }}>
        <ConfigRow k="transport" v={status.config.publicWss || "—"} />
        <ConfigRow k="media" v={status.config.media || "—"} />
        <ConfigRow k="receptionist" v={status.config.receptionist || "—"} />
        <ConfigRow k="transfer →" v={status.config.transferTarget || "—"} />
        <ConfigRow k="background ring" v={status.config.pushkit ? "PushKit ON" : "foreground only (no PushKit)"} />
      </View>

      {/* Recent activity */}
      <SectionHeader title="RECENT ACTIVITY" />
      {status.recentEvents.length === 0 ? (
        <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.text.tertiary, paddingHorizontal: 8, paddingVertical: 6 }}>No recent calls</Text>
      ) : (
        <View style={{ backgroundColor: colors.bg.elevated, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border.subtle, paddingVertical: 4 }}>
          {status.recentEvents.slice(0, 10).map((ev, i) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 5, paddingHorizontal: 10, gap: 8 }}>
              <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.text.secondary, width: 90 }}>{EVENT_LABEL[ev.event] || ev.event}</Text>
              <Text style={{ fontFamily: MONO, fontSize: 10, color: colors.text.tertiary, flex: 1 }} numberOfLines={1}>{ev.caller_number || "—"}</Text>
              <Text style={{ fontFamily: MONO, fontSize: 9, color: colors.text.disabled }}>{formatRelativeTime(ev.created_at)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
