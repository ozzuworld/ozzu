import { View, Text } from "react-native";
import type { ServiceStatus } from "../../lib/ops-hooks";

import { colors } from "../../lib/design-tokens";
interface Props {
  gpu: ServiceStatus | undefined;
}

export default function GpuCard({ gpu }: Props) {
  if (!gpu) return null;

  const d = gpu.details || {};
  const isRunning = d.status === "running";
  const isIdle = gpu.status === "degraded" || (d.gpuUtil != null && d.gpuUtil < 5);
  const noInstances = d.status === "no_instances" || d.noKey;

  const borderColor = noInstances
    ? "rgba(255,255,255,0.08)"
    : isIdle
    ? "rgba(234,179,8,0.4)"
    : isRunning
    ? "rgba(34,197,94,0.3)"
    : "rgba(239,68,68,0.3)";

  const statusText = noInstances
    ? "NO ACTIVE INSTANCE"
    : isIdle
    ? "GPU IDLE"
    : isRunning
    ? "RUNNING"
    : (d.status || "OFFLINE").toUpperCase();

  const statusColor = noInstances ? colors.gray[400] : isIdle ? colors.brand.amberDeep : isRunning ? colors.success : colors.error;

  return (
    <View
      style={{
        backgroundColor: "rgba(255,255,255,0.03)",
        borderWidth: 1,
        borderColor,
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Text style={{ fontSize: 14 }}>⚡</Text>
        <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 12, color: "#E2E8F0", letterSpacing: 1 }}>
          VAST.AI GPU
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 10, color: statusColor }}>
          {statusText}
        </Text>
      </View>

      {!noInstances && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {d.gpuName && (
            <MetricItem label="GPU" value={d.gpuName} />
          )}
          {d.gpuUtil != null && (
            <MetricItem label="UTIL" value={`${d.gpuUtil}%`} warn={d.gpuUtil < 5} />
          )}
          {d.gpuTemp != null && (
            <MetricItem label="TEMP" value={`${d.gpuTemp}°C`} warn={d.gpuTemp > 85} />
          )}
          {d.vramUsed != null && (
            <MetricItem label="VRAM" value={`${(d.vramUsed / 1024).toFixed(1)} GB`} />
          )}
          {d.costPerHr != null && (
            <MetricItem label="COST" value={`$${d.costPerHr.toFixed(3)}/hr`} />
          )}
        </View>
      )}
    </View>
  );
}

function MetricItem({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <View>
      <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.gray[400], letterSpacing: 1 }}>{label}</Text>
      <Text
        style={{
          fontFamily: "monospace",
          fontWeight: "700",
          fontSize: 12,
          color: warn ? colors.brand.amberDeep : colors.gray[100],
        }}
      >
        {value}
      </Text>
    </View>
  );
}
