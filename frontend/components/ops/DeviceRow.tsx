import { View, Text } from "react-native";
import type { ServiceStatus } from "../../lib/ops-hooks";

const DEVICES = [
  { id: "tab-roaming", label: "TAB-R", emoji: "📱" },
  { id: "tab-lroom", label: "TAB-L", emoji: "📱" },
  { id: "tv-lroom", label: "TV", emoji: "📺" },
  { id: "dev-01", label: "DEV", emoji: "🖥️" },
];

interface Props {
  openvpn: ServiceStatus | undefined;
}

export default function DeviceRow({ openvpn }: Props) {
  const vpnUp = openvpn?.status === "healthy";
  const routerReachable = openvpn?.details?.routerReachable === true;

  return (
    <View
      style={{
        backgroundColor: "rgba(255,255,255,0.03)",
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.08)",
        borderRadius: 8,
        padding: 10,
        marginBottom: 12,
      }}
    >
      <Text
        style={{
          fontFamily: "monospace",
          fontWeight: "700",
          fontSize: 10,
          color: "#525252",
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        HOME LAN DEVICES
      </Text>
      <View style={{ flexDirection: "row", gap: 12, justifyContent: "space-around" }}>
        {DEVICES.map((dev) => {
          // Devices reachable only if VPN + router are up
          const reachable = vpnUp && routerReachable;
          return (
            <View key={dev.id} style={{ alignItems: "center", gap: 4 }}>
              <Text style={{ fontSize: 16 }}>{dev.emoji}</Text>
              <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 9, color: "#CBD5E1" }}>
                {dev.label}
              </Text>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: reachable ? "#22C55E" : "#525252",
                }}
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}
