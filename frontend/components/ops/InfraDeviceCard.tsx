// InfraDeviceCard.tsx — Expandable device card with services, resources, drill-down
import { View, Text, Pressable } from "react-native";
import { useState } from "react";
import type { InfraDevice, DeviceResources } from "../../lib/infra-hooks";

const ACCENT = "#06B6D4";
const GREEN = "#22C55E";
const RED = "#EF4444";
const YELLOW = "#EAB308";
const GRAY = "#525252";
const DIM = "#64748B";

interface Props {
  id: string;
  device: InfraDevice;
  children?: React.ReactNode;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function ResourceBar({ label, used, total, unit, warnPct = 80 }: {
  label: string; used: number; total: number; unit: string; warnPct?: number;
}) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const color = pct > 90 ? RED : pct > warnPct ? YELLOW : ACCENT;

  return (
    <View style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
        <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM, letterSpacing: 1 }}>{label}</Text>
        <Text style={{ fontFamily: "monospace", fontSize: 9, color: "#CBD5E1" }}>
          {used.toFixed(used < 10 ? 1 : 0)}{unit} / {total.toFixed(total < 10 ? 1 : 0)}{unit}
        </Text>
      </View>
      <View style={{ height: 4, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 2 }}>
        <View style={{ height: 4, width: `${Math.min(pct, 100)}%`, backgroundColor: color, borderRadius: 2 }} />
      </View>
    </View>
  );
}

function ServiceRow({ name, status }: { name: string; status: string }) {
  const isActive = status === "active" || status === "listening" || status === "running";
  const dotColor = isActive ? GREEN : status === "inactive" ? GRAY : RED;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor }} />
      <Text style={{ fontFamily: "monospace", fontSize: 10, color: "#CBD5E1", flex: 1 }}>{name}</Text>
      <Text style={{ fontFamily: "monospace", fontSize: 9, color: isActive ? GREEN : GRAY }}>{status.toUpperCase()}</Text>
    </View>
  );
}

function Resources({ res }: { res: DeviceResources }) {
  const diskUsedGb = parseFloat(res.disk.used) || 0;
  const diskTotalGb = parseFloat(res.disk.size) || 0;
  const memUsedGb = res.memory.usedMb / 1024;
  const memTotalGb = res.memory.totalMb / 1024;

  return (
    <View style={{ marginTop: 8 }}>
      <ResourceBar label="DISK" used={diskUsedGb} total={diskTotalGb} unit="G" />
      <ResourceBar label="MEMORY" used={memUsedGb} total={memTotalGb} unit="G" />
      <View style={{ flexDirection: "row", gap: 16, marginTop: 2 }}>
        <MetricPill label="LOAD 1m" value={res.cpu.load1m} />
        <MetricPill label="LOAD 5m" value={res.cpu.load5m} />
        <MetricPill label="LOAD 15m" value={res.cpu.load15m} />
      </View>
    </View>
  );
}

function MetricPill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View>
      <Text style={{ fontFamily: "monospace", fontSize: 8, color: DIM, letterSpacing: 1 }}>{label}</Text>
      <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 11, color: color || "#CBD5E1" }}>{value}</Text>
    </View>
  );
}

const DEVICE_EMOJI: Record<string, string> = {
  rockpi: "🧊",
  "dev-01": "🖥️",
  gcp: "☁️",
  router: "📡",
};

const DEVICE_BADGES: Record<string, { label: string; color: string }[]> = {
  rockpi: [
    { label: "ESP32 HUB", color: "#06B6D4" },
    { label: "WiFi AP", color: "#8B5CF6" },
  ],
};

export default function InfraDeviceCard({ id, device, children }: Props) {
  const [expanded, setExpanded] = useState(false);
  const emoji = DEVICE_EMOJI[id] || "📦";
  const badges = DEVICE_BADGES[id] || [];
  const reachable = device.reachable;
  const borderColor = reachable ? "rgba(255,255,255,0.08)" : "rgba(239,68,68,0.3)";

  const serviceEntries = Object.entries(device.services || {});

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
          <Text style={{ fontSize: 16 }}>{emoji}</Text>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 12, color: "#E2E8F0", letterSpacing: 0.5 }}>
                {device.name}
              </Text>
              {badges.map(b => (
                <View key={b.label} style={{ backgroundColor: `${b.color}20`, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                  <Text style={{ fontFamily: "monospace", fontSize: 7, fontWeight: "700", color: b.color, letterSpacing: 0.5 }}>{b.label}</Text>
                </View>
              ))}
            </View>
            <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>{device.ip}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: reachable ? GREEN : RED }} />
              <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: reachable ? GREEN : RED }}>
                {reachable ? "UP" : "DOWN"}
              </Text>
            </View>
            {device.latencyMs != null && (
              <Text style={{ fontFamily: "monospace", fontSize: 8, color: GRAY }}>{device.latencyMs}ms</Text>
            )}
          </View>
        </View>

        {/* Quick stats row */}
        <View style={{ flexDirection: "row", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          {device.uptime && <MetricPill label="UPTIME" value={device.uptime.replace("up ", "")} />}
          {device.extended?.temperature != null && (
            <MetricPill
              label="TEMP"
              value={`${device.extended.temperature}°C`}
              color={device.extended.temperature > 70 ? RED : device.extended.temperature > 60 ? YELLOW : undefined}
            />
          )}
          {serviceEntries.length > 0 && (
            <MetricPill
              label="SERVICES"
              value={`${serviceEntries.filter(([, s]) => s === "active" || s === "listening").length}/${serviceEntries.length}`}
            />
          )}
          {id === "rockpi" && device.extended?.hostapdClients != null && (
            <MetricPill
              label="AP CLIENTS"
              value={`${device.extended.hostapdClients.length}`}
              color={device.extended.hostapdClients.length > 0 ? GREEN : GRAY}
            />
          )}
          {id === "rockpi" && (
            <MetricPill label="AP SUBNET" value="10.0.50.0/24" color={ACCENT} />
          )}
        </View>

        {/* Expanded content */}
        {expanded && (
          <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 10 }}>
            {/* Role */}
            <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM, marginBottom: 8 }}>{device.role}</Text>

            {/* Services */}
            {serviceEntries.length > 0 && (
              <View style={{ marginBottom: 8 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginBottom: 4 }}>
                  SERVICES
                </Text>
                {serviceEntries.map(([name, status]) => (
                  <ServiceRow key={name} name={name} status={status} />
                ))}
              </View>
            )}

            {/* Resources */}
            {device.resources && <Resources res={device.resources} />}

            {/* Network I/O (Rock Pi extended) */}
            {device.extended?.networkIo && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginBottom: 4 }}>
                  NETWORK I/O
                </Text>
                {Object.entries(device.extended.networkIo).map(([iface, io]) => (
                  <View key={iface} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 }}>
                    <Text style={{ fontFamily: "monospace", fontSize: 10, color: "#CBD5E1" }}>{iface}</Text>
                    <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>
                      RX {formatBytes(io.rxBytes)} / TX {formatBytes(io.txBytes)}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* AP Clients (Rock Pi) */}
            {device.extended?.hostapdClients && device.extended.hostapdClients.length > 0 && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: GRAY, letterSpacing: 1, marginBottom: 4 }}>
                  AP CLIENTS — ozzu-nodes ({device.extended.hostapdClients.length})
                </Text>
                {device.extended.hostapdClients.map((c: any, i: number) => (
                  <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: GREEN }} />
                    <Text style={{ fontFamily: "monospace", fontSize: 9, color: "#CBD5E1", flex: 1 }}>{c.mac}</Text>
                    {c.signalDbm != null && (
                      <Text style={{ fontFamily: "monospace", fontSize: 8, color: c.signalDbm > -60 ? GREEN : c.signalDbm > -75 ? YELLOW : RED }}>
                        {c.signalDbm} dBm
                      </Text>
                    )}
                    {c.connectedSecs != null && (
                      <Text style={{ fontFamily: "monospace", fontSize: 8, color: GRAY }}>
                        {c.connectedSecs > 3600 ? `${Math.floor(c.connectedSecs / 3600)}h` : `${Math.floor(c.connectedSecs / 60)}m`}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            )}

            {/* Extra children (Docker list, DHCP, etc.) */}
            {children}
          </View>
        )}

        {/* Expand indicator */}
        <Text style={{ fontFamily: "monospace", fontSize: 9, color: GRAY, textAlign: "center", marginTop: 6 }}>
          {expanded ? "▲ COLLAPSE" : "▼ TAP TO EXPAND"}
        </Text>
      </View>
    </Pressable>
  );
}

export { MetricPill, ResourceBar, ServiceRow };
