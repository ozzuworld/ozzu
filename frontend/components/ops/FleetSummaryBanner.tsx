import { View, Text } from "react-native";
import { colors } from "../../lib/design-tokens";
import type { FleetDevice, DeviceInventory } from "../../lib/fleet-hooks";

const GREEN = colors.success;
const RED = colors.error;
const YELLOW = colors.brand.amberDeep;
const ACCENT = colors.accent;

interface Alert {
  device: string;
  type: string;
  label: string;
  color: string;
}

function getAlerts(devices: FleetDevice[]): Alert[] {
  const alerts: Alert[] = [];
  for (const d of devices) {
    if (d.effective_status !== "online") {
      alerts.push({ device: d.device_id, type: "offline", label: `${d.device_id} OFFLINE`, color: RED });
      continue;
    }
    const t = d.telemetry || {};
    const bat = t.battery;
    if (bat?.pct != null && bat.pct < 15 && bat.status !== "Charging") {
      alerts.push({ device: d.device_id, type: "battery", label: `${d.device_id} battery ${bat.pct}%`, color: RED });
    } else if (bat?.pct != null && bat.pct < 30 && bat.status !== "Charging") {
      alerts.push({ device: d.device_id, type: "battery", label: `${d.device_id} battery ${bat.pct}%`, color: YELLOW });
    }
    const mem = t.memory;
    if (mem?.used_pct != null && mem.used_pct > 90) {
      alerts.push({ device: d.device_id, type: "ram", label: `${d.device_id} RAM ${mem.used_pct.toFixed(0)}%`, color: RED });
    }
    const thermal = t.thermal;
    if (thermal?.length) {
      const maxTemp = Math.max(...thermal.map((z: any) => z.temp_c || 0));
      if (maxTemp > 75) {
        alerts.push({ device: d.device_id, type: "thermal", label: `${d.device_id} ${maxTemp}°C`, color: RED });
      }
    }
    if (t.disk?.length) {
      for (const dk of t.disk) {
        if (dk.total_mb && dk.used_mb && (dk.used_mb / dk.total_mb) > 0.9) {
          alerts.push({ device: d.device_id, type: "disk", label: `${d.device_id} disk ${Math.round(dk.used_mb / dk.total_mb * 100)}%`, color: YELLOW });
        }
      }
    }
  }
  return alerts;
}

export default function FleetSummaryBanner({ devices, inventory }: {
  devices: FleetDevice[];
  inventory: Record<string, DeviceInventory>;
}) {
  const online = devices.filter(d => d.effective_status === "online").length;
  const offline = devices.length - online;
  const v2Count = devices.filter(d => d.source === "telemetry-v2").length;

  const batteries = devices
    .map(d => d.telemetry?.battery?.pct)
    .filter((p): p is number => p != null);
  const avgBattery = batteries.length > 0 ? Math.round(batteries.reduce((a, b) => a + b, 0) / batteries.length) : null;

  const alerts = getAlerts(devices);
  const inventoryCount = Object.keys(inventory).length;

  return (
    <View style={{
      backgroundColor: colors.bg.elevated,
      borderWidth: 1,
      borderColor: alerts.some(a => a.color === RED) ? "rgba(239,68,68,0.3)" : "rgba(255,255,255,0.06)",
      borderRadius: 10,
      padding: 14,
      marginBottom: 12,
    }}>
      {/* Top row — stats */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          {/* Online/Offline */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: GREEN }} />
            <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 14, color: colors.text.primary }}>
              {online}
            </Text>
            {offline > 0 && (
              <>
                <Text style={{ fontFamily: "monospace", fontSize: 10, color: colors.text.disabled }}>/</Text>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: RED }} />
                <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 14, color: RED }}>
                  {offline}
                </Text>
              </>
            )}
            <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.tertiary, marginLeft: 2 }}>
              {devices.length === 1 ? "DEVICE" : "DEVICES"}
            </Text>
          </View>

          {/* Average battery */}
          {avgBattery != null && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Text style={{ fontSize: 10 }}>🔋</Text>
              <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 11, color: avgBattery < 20 ? RED : avgBattery < 40 ? YELLOW : colors.text.primary }}>
                {avgBattery}%
              </Text>
              <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled }}>AVG</Text>
            </View>
          )}

          {/* Telemetry v2 coverage */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={{ fontFamily: "monospace", fontSize: 9, color: v2Count === devices.length ? GREEN : ACCENT }}>
              {v2Count}/{devices.length}
            </Text>
            <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled }}>V2</Text>
          </View>

          {/* Inventory coverage */}
          {inventoryCount > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.secondary }}>
                {inventoryCount}
              </Text>
              <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled }}>INV</Text>
            </View>
          )}
        </View>

        {/* Alert count badge */}
        {alerts.length > 0 && (
          <View style={{
            backgroundColor: alerts.some(a => a.color === RED) ? `${RED}20` : `${YELLOW}20`,
            borderRadius: 10,
            paddingHorizontal: 8,
            paddingVertical: 3,
          }}>
            <Text style={{
              fontFamily: "monospace",
              fontWeight: "700",
              fontSize: 9,
              color: alerts.some(a => a.color === RED) ? RED : YELLOW,
            }}>
              {alerts.length} ALERT{alerts.length > 1 ? "S" : ""}
            </Text>
          </View>
        )}
      </View>

      {/* Alert list */}
      {alerts.length > 0 && (
        <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.04)", paddingTop: 6 }}>
          {alerts.slice(0, 4).map((a, i) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: a.color }} />
              <Text style={{ fontFamily: "monospace", fontSize: 9, color: a.color }}>{a.label}</Text>
            </View>
          ))}
          {alerts.length > 4 && (
            <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled, marginTop: 2 }}>
              +{alerts.length - 4} more
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
