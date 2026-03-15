// PositioningCard.tsx — ESP32 nodes + positioning hub status
import { View, Text, Pressable } from "react-native";
import { useState } from "react";
import type { ESP32Node, PositioningHub } from "../../lib/infra-hooks";
import { MetricPill } from "./InfraDeviceCard";

const GREEN = "#22C55E";
const RED = "#EF4444";
const YELLOW = "#EAB308";
const GRAY = "#525252";
const DIM = "#64748B";
const ACCENT = "#06B6D4";

interface Props {
  nodes: ESP32Node[];
  hub: PositioningHub;
}

const ROOM_EMOJI: Record<string, string> = {
  living: "🛋️",
  master: "🛏️",
  office: "💻",
  rooftop: "🌤️",
};

function NodeRow({ node }: { node: ESP32Node }) {
  const isOnline = node.status === "online";
  const notDeployed = node.status === "not_deployed";
  const emoji = ROOM_EMOJI[node.room] || "📦";
  const statusColor = isOnline ? GREEN : notDeployed ? GRAY : RED;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
      <Text style={{ fontSize: 14 }}>{emoji}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: "monospace", fontSize: 10, fontWeight: "700", color: "#CBD5E1" }}>
          Node {node.id} — {node.room.toUpperCase()}
        </Text>
        <Text style={{ fontFamily: "monospace", fontSize: 8, color: DIM }}>{node.ip}{node.mac ? ` (${node.mac})` : ""}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor }} />
        <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "600", color: statusColor }}>
          {notDeployed ? "N/A" : isOnline ? "ONLINE" : "OFFLINE"}
        </Text>
      </View>
    </View>
  );
}

export default function PositioningCard({ nodes, hub }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!nodes && !hub) return null;

  const onlineCount = nodes?.filter(n => n.status === "online").length || 0;
  const deployedCount = nodes?.filter(n => n.status !== "not_deployed").length || 0;
  const hubActive = hub?.service === "active";
  const apActive = hub?.wifiAp === "active";
  const hasIrk = hub?.irkStore && hub.irkStore !== "not_found";

  // Parse last positioning output for location
  let lastLocation = "";
  let lastConf = "";
  if (hub?.lastOutput) {
    const lines = hub.lastOutput.split("\n");
    const infoLine = lines.filter(l => l.includes("INFO: Location:")).pop();
    if (infoLine) {
      const match = infoLine.match(/Location: (\w+) \((\w+), (\d+)% conf/);
      if (match) {
        lastLocation = match[1];
        lastConf = `${match[3]}%`;
      }
    }
  }

  return (
    <Pressable onPress={() => setExpanded(!expanded)} style={{ marginBottom: 8 }}>
      <View
        style={{
          backgroundColor: "rgba(255,255,255,0.03)",
          borderWidth: 1,
          borderColor: hubActive ? "rgba(6,182,212,0.2)" : "rgba(255,255,255,0.08)",
          borderRadius: 10,
          padding: 12,
        }}
      >
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 16 }}>📍</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 12, color: "#E2E8F0", letterSpacing: 0.5 }}>
              POSITIONING
            </Text>
            <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>
              ESP32 mesh + Bayesian fusion
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: hubActive ? GREEN : RED }} />
              <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: hubActive ? GREEN : RED }}>
                {hubActive ? "ACTIVE" : "DOWN"}
              </Text>
            </View>
          </View>
        </View>

        {/* Quick stats */}
        <View style={{ flexDirection: "row", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          <MetricPill label="NODES" value={`${onlineCount}/${deployedCount}`} color={onlineCount === 0 ? RED : undefined} />
          <MetricPill label="AP" value={apActive ? "UP" : "DOWN"} color={apActive ? GREEN : RED} />
          {lastLocation && <MetricPill label="LOCATION" value={lastLocation.toUpperCase()} color={ACCENT} />}
          {lastConf && <MetricPill label="CONFIDENCE" value={lastConf} />}
          <MetricPill label="IRK" value={hasIrk ? "YES" : "NO"} color={hasIrk ? GREEN : YELLOW} />
        </View>

        {/* Expanded */}
        {expanded && (
          <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 10 }}>
            {/* Node list */}
            <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginBottom: 4 }}>
              ESP32 NODES
            </Text>
            {(nodes || []).map(n => <NodeRow key={n.id} node={n} />)}

            {/* Hub details */}
            <View style={{ marginTop: 8 }}>
              <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginBottom: 4 }}>
                HUB STATUS
              </Text>
              <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>
                Service: {hub?.service || "unknown"}
              </Text>
              <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>
                WiFi AP: {hub?.wifiAp || "unknown"}
              </Text>
              <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>
                IRK Store: {hub?.irkStore || "unknown"}
              </Text>
              {hub?.otaFirmware && (
                <Text style={{ fontFamily: "monospace", fontSize: 8, color: GRAY, marginTop: 2 }}>
                  OTA: {hub.otaFirmware}
                </Text>
              )}
            </View>

            {/* Last hub output */}
            {hub?.lastOutput && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginBottom: 4 }}>
                  RECENT LOG
                </Text>
                {hub.lastOutput.split("\n").slice(-3).map((line, i) => {
                  const isWarning = line.includes("WARNING");
                  const isInfo = line.includes("INFO");
                  // Extract just the message part after the timestamp prefix
                  const msgMatch = line.match(/\d{2}:\d{2}:\d{2} .+/);
                  const msg = msgMatch ? msgMatch[0] : line;
                  return (
                    <Text key={i} style={{ fontFamily: "monospace", fontSize: 8, color: isWarning ? YELLOW : isInfo ? DIM : GRAY }} numberOfLines={2}>
                      {msg}
                    </Text>
                  );
                })}
              </View>
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
