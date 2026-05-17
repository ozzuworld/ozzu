// GcpCard.tsx — GCP VM card with Docker containers, resources
import { View, Text, Pressable } from "react-native";
import { useState } from "react";
import type { InfraState, DockerContainer, DeviceResources } from "../../lib/infra-hooks";
import { ResourceBar, MetricPill } from "./InfraDeviceCard";

import { colors } from "../../lib/design-tokens";
const GREEN = colors.success;
const RED = colors.error;
const YELLOW = colors.brand.amberDeep;
const GRAY = colors.gray[400];
const DIM = "#64748B";
const ACCENT = colors.accent;

interface Props {
  gcp: InfraState["gcp"];
}

function DockerRow({ c }: { c: DockerContainer }) {
  const running = c.state === "running";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: running ? GREEN : RED }} />
      <Text style={{ fontFamily: "monospace", fontSize: 10, color: colors.gray[100], flex: 1 }} numberOfLines={1}>{c.name}</Text>
      <Text style={{ fontFamily: "monospace", fontSize: 8, color: DIM }} numberOfLines={1}>{c.image}</Text>
      <Text style={{ fontFamily: "monospace", fontSize: 8, color: GRAY }}>{c.status}</Text>
    </View>
  );
}

export default function GcpCard({ gcp }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!gcp) return null;

  const runningCount = gcp.docker?.filter(c => c.state === "running").length || 0;
  const totalCount = gcp.docker?.length || 0;
  const diskPct = parseInt(gcp.resources?.disk?.pct || "0");

  return (
    <Pressable onPress={() => setExpanded(!expanded)} style={{ marginBottom: 8 }}>
      <View
        style={{
          backgroundColor: "rgba(255,255,255,0.03)",
          borderWidth: 1,
          borderColor: diskPct > 90 ? "rgba(239,68,68,0.3)" : "rgba(255,255,255,0.08)",
          borderRadius: 10,
          padding: 12,
        }}
      >
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 16 }}>☁️</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 12, color: "#E2E8F0", letterSpacing: 0.5 }}>
              GCP VM
            </Text>
            <Text style={{ fontFamily: "monospace", fontSize: 8, color: DIM }} numberOfLines={1}>
              {gcp.hostname?.split(".")[0] || "ozzu-vm"}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: GREEN }} />
              <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GREEN }}>UP</Text>
            </View>
          </View>
        </View>

        {/* Quick stats */}
        <View style={{ flexDirection: "row", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          <MetricPill label="CONTAINERS" value={`${runningCount}/${totalCount}`} />
          <MetricPill label="DISK" value={gcp.resources?.disk?.pct || "?"} color={diskPct > 90 ? RED : diskPct > 80 ? YELLOW : undefined} />
          <MetricPill label="MEM" value={`${((gcp.resources?.memory?.usedMb || 0) / 1024).toFixed(1)}G`} />
          <MetricPill label="LOAD" value={gcp.resources?.cpu?.load1m || "?"} />
        </View>

        {/* Expanded */}
        {expanded && (
          <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 10 }}>
            {/* Resources */}
            {gcp.resources && <ResourceBar label="DISK" used={parseFloat(gcp.resources.disk.used)} total={parseFloat(gcp.resources.disk.size)} unit="G" />}
            {gcp.resources && <ResourceBar label="MEMORY" used={gcp.resources.memory.usedMb / 1024} total={gcp.resources.memory.totalMb / 1024} unit="G" />}

            {/* Docker containers */}
            <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginTop: 4, marginBottom: 4 }}>
              DOCKER CONTAINERS ({runningCount}/{totalCount})
            </Text>
            {(gcp.docker || []).map(c => <DockerRow key={c.name} c={c} />)}
          </View>
        )}

        <Text style={{ fontFamily: "monospace", fontSize: 9, color: GRAY, textAlign: "center", marginTop: 6 }}>
          {expanded ? "▲ COLLAPSE" : "▼ TAP TO EXPAND"}
        </Text>
      </View>
    </Pressable>
  );
}
