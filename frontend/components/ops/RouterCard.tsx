// RouterCard.tsx — ER605 router card with DHCP leases, WAN, VPN
import { View, Text, Pressable } from "react-native";
import { useState } from "react";
import type { RouterState } from "../../lib/infra-hooks";
import { MetricPill } from "./InfraDeviceCard";

const GREEN = "#22C55E";
const RED = "#EF4444";
const YELLOW = "#EAB308";
const GRAY = "#525252";
const DIM = "#64748B";
const ACCENT = "#06B6D4";

interface Props {
  router: RouterState;
}

function DhcpRow({ client }: { client: any }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: GREEN }} />
      <Text style={{ fontFamily: "monospace", fontSize: 10, color: "#CBD5E1", width: 110 }} numberOfLines={1}>
        {client.name || client.hostname || "Unknown"}
      </Text>
      <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM, flex: 1 }}>{client.ip || client.ipaddr}</Text>
      <Text style={{ fontFamily: "monospace", fontSize: 8, color: GRAY }} numberOfLines={1}>{client.mac || client.macaddr}</Text>
    </View>
  );
}

function WanInterface({ name, data }: { name: string; data: any }) {
  const isUp = data?.enable === "1" || data?.status === "1" || data?.state === "connected";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: isUp ? GREEN : GRAY }} />
      <Text style={{ fontFamily: "monospace", fontSize: 10, color: "#CBD5E1", flex: 1 }}>{name}</Text>
      <Text style={{ fontFamily: "monospace", fontSize: 9, color: isUp ? GREEN : GRAY }}>
        {data?.ipaddr || data?.ip || (isUp ? "UP" : "DOWN")}
      </Text>
    </View>
  );
}

export default function RouterCard({ router }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!router) return null;

  // Decommissioned device — render tombstone
  if ((router as any).decommissioned) {
    return (
      <View style={{ backgroundColor: "rgba(255,255,255,0.02)", borderWidth: 1, borderColor: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 12, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ fontSize: 16, opacity: 0.4 }}>📡</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 12, color: "#3f3f46", letterSpacing: 0.5 }}>
            {(router as any).model || "Router"}
          </Text>
          <Text style={{ fontFamily: "monospace", fontSize: 9, color: "#27272a" }}>{(router as any).reason}</Text>
        </View>
        <View style={{ backgroundColor: "rgba(239,68,68,0.08)", borderWidth: 1, borderColor: "rgba(239,68,68,0.15)", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
          <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: "#7f1d1d", letterSpacing: 1 }}>DECOMM</Text>
        </View>
      </View>
    );
  }

  const hasData = !!router.model;
  const clientCount = router.dhcp?.clients?.length || 0;
  const hasError = !!router.error;

  // Parse uptime from ER605 format [dateStr, "days hours mins secs"]
  let uptimeStr = "?";
  if (Array.isArray(router.uptime) && router.uptime[1]) {
    const parts = router.uptime[1].trim().split(" ").map(Number);
    if (parts.length >= 4) {
      const [d, h, m] = parts;
      uptimeStr = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
  }

  const borderColor = hasError ? "rgba(234,179,8,0.3)" : "rgba(255,255,255,0.08)";

  return (
    <Pressable onPress={() => setExpanded(!expanded)} style={{ marginBottom: 8 }}>
      <View
        style={{
          backgroundColor: "rgba(255,255,255,0.03)",
          borderWidth: 1,
          borderColor,
          borderRadius: 10,
          padding: 12,
        }}
      >
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 16 }}>📡</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 12, color: "#E2E8F0", letterSpacing: 0.5 }}>
              {router.model || "ER605 Router"}
            </Text>
            <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>172.168.0.1</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: hasData ? GREEN : hasError ? YELLOW : GRAY }} />
              <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: hasData ? GREEN : hasError ? YELLOW : GRAY }}>
                {hasData ? "UP" : hasError ? "TIMEOUT" : "PROBING"}
              </Text>
            </View>
          </View>
        </View>

        {/* Quick stats */}
        <View style={{ flexDirection: "row", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          {hasData && <MetricPill label="UPTIME" value={uptimeStr} />}
          <MetricPill label="DHCP" value={`${clientCount} clients`} />
          {router.firmware && <MetricPill label="FW" value={router.firmware.split(" ")[0]} />}
          {router.cpu?.cpu_num && <MetricPill label="CORES" value={router.cpu.cpu_num.toString().trim()} />}
        </View>

        {/* Expanded */}
        {expanded && (
          <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 10 }}>
            {/* WAN Interfaces */}
            {router.wan?.interfaces && (
              <View style={{ marginBottom: 8 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginBottom: 4 }}>
                  WAN INTERFACES
                </Text>
                {Object.entries(router.wan.interfaces).map(([name, data]: [string, any]) => (
                  <WanInterface key={name} name={name} data={data} />
                ))}
              </View>
            )}

            {/* VPN */}
            {router.vpn && (router.vpn.openvpnClient || router.vpn.openvpnServer) && (
              <View style={{ marginBottom: 8 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginBottom: 4 }}>
                  VPN TUNNELS
                </Text>
                {router.vpn.openvpnClient && (
                  <View style={{ paddingVertical: 2 }}>
                    <Text style={{ fontFamily: "monospace", fontSize: 10, color: "#CBD5E1" }}>OpenVPN Client</Text>
                    {Array.isArray(router.vpn.openvpnClient) ? (
                      router.vpn.openvpnClient.map((c: any, i: number) => (
                        <Text key={i} style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>
                          {c.name || `tunnel-${i}`}: {c.enable === "1" ? "enabled" : "disabled"}
                        </Text>
                      ))
                    ) : (
                      <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>Connected</Text>
                    )}
                  </View>
                )}
              </View>
            )}

            {/* DHCP Leases */}
            {clientCount > 0 && (
              <View>
                <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginBottom: 4 }}>
                  DHCP LEASES ({clientCount})
                </Text>
                {router.dhcp!.clients!.map((c: any, i: number) => (
                  <DhcpRow key={i} client={c} />
                ))}
              </View>
            )}

            {/* Firmware info */}
            {router.firmware && (
              <Text style={{ fontFamily: "monospace", fontSize: 8, color: GRAY, marginTop: 8 }}>
                FW: {router.firmware}
              </Text>
            )}
          </View>
        )}

        <Text style={{ fontFamily: "monospace", fontSize: 9, color: GRAY, textAlign: "center", marginTop: 6 }}>
          {expanded ? "▲ COLLAPSE" : "▼ TAP TO EXPAND"}
        </Text>
      </View>
    </Pressable>
  );
}
