// NetworkBanner.tsx — VPN + network topology overview
import { View, Text } from "react-native";
import type { InfraState } from "../../lib/infra-hooks";

import { colors } from "../../lib/design-tokens";
const GREEN = colors.success;
const RED = colors.error;
const GRAY = colors.gray[400];
const DIM = "#64748B";

interface Props {
  network: InfraState["network"];
  probeTimeMs: number;
}

export default function NetworkBanner({ network, probeTimeMs }: Props) {
  if (!network) return null;

  const vpnUp = network.vpn?.status === "up";
  const subnets = network.routes?.length || 0;

  return (
    <View
      style={{
        backgroundColor: vpnUp ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.12)",
        borderWidth: 1,
        borderColor: vpnUp ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.3)",
        borderRadius: 8,
        paddingVertical: 8,
        paddingHorizontal: 12,
        marginBottom: 10,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: vpnUp ? GREEN : RED }} />
        <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 11, color: vpnUp ? GREEN : RED, letterSpacing: 1 }}>
          VPN {vpnUp ? "UP" : "DOWN"}
        </Text>
        {vpnUp && network.vpn?.peerIp && (
          <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>peer: {network.vpn.peerIp}</Text>
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>{subnets} routes</Text>
        <Text style={{ fontFamily: "monospace", fontSize: 9, color: GRAY }}>{(probeTimeMs / 1000).toFixed(1)}s probe</Text>
      </View>
    </View>
  );
}
