import { View, Text, Pressable } from "react-native";
import { useState } from "react";
import { colors } from "../../lib/design-tokens";
import { formatBytes, formatRelativeTime } from "../../lib/format";
import type { FleetDevice, DeviceInventory } from "../../lib/fleet-hooks";

const ACCENT = colors.accent;
const GREEN = colors.success;
const RED = colors.error;
const YELLOW = colors.brand.amberDeep;
const DIM = colors.text.tertiary;

const DEVICE_META: Record<string, { emoji: string; label: string; color: string }> = {
  "tablet-p610": { emoji: "📱", label: "PENTEST BRIDGE", color: "#8B5CF6" },
  "gcp-bridge-host": { emoji: "☁️", label: "GCP BRIDGE", color: ACCENT },
  "dev-01": { emoji: "🖥️", label: "DEV SERVER", color: "#F59E0B" },
  "orangepi-gsc": { emoji: "📡", label: "GROUND STATION", color: "#22C55E" },
  "rockpi": { emoji: "🧊", label: "ROCK PI", color: "#3B82F6" },
};

function Bar({ label, value, max, unit, warnPct = 80 }: {
  label: string; value: number; max: number; unit: string; warnPct?: number;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const barColor = pct > 90 ? RED : pct > warnPct ? YELLOW : ACCENT;
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 3 }}>
        <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM, letterSpacing: 1 }}>{label}</Text>
        <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.secondary }}>
          {value < 10 ? value.toFixed(1) : Math.round(value)}{unit} / {max < 10 ? max.toFixed(1) : Math.round(max)}{unit}
        </Text>
      </View>
      <View style={{ height: 4, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 2 }}>
        <View style={{ height: 4, width: `${Math.min(pct, 100)}%`, backgroundColor: barColor, borderRadius: 2 }} />
      </View>
    </View>
  );
}

function Pill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ marginRight: 14 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 8, color: DIM, letterSpacing: 1 }}>{label}</Text>
      <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 11, color: color || colors.text.primary }}>{value}</Text>
    </View>
  );
}

function ThermalRow({ zones }: { zones: { zone: string; temp_c: number }[] }) {
  if (!zones?.length) return null;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 6 }}>
        THERMAL ZONES
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {zones.map((z) => {
          const c = z.temp_c > 70 ? RED : z.temp_c > 55 ? YELLOW : z.temp_c > 40 ? colors.text.secondary : GREEN;
          return (
            <View key={z.zone} style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
              <Text style={{ fontFamily: "monospace", fontSize: 8, color: DIM }}>{z.zone}</Text>
              <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 11, color: c }}>{z.temp_c}°C</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function TrafficRow({ traffic }: { traffic: Record<string, { rx_bytes: number; tx_bytes: number }> }) {
  if (!traffic) return null;
  const entries = Object.entries(traffic);
  if (!entries.length) return null;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 4 }}>
        NETWORK I/O
      </Text>
      {entries.map(([iface, io]) => (
        <View key={iface} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 }}>
          <Text style={{ fontFamily: "monospace", fontSize: 10, color: colors.text.primary }}>{iface}</Text>
          <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>
            ↓ {formatBytes(io.rx_bytes)}  ↑ {formatBytes(io.tx_bytes)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function WifiSection({ wifi, scan }: { wifi: any; scan: any[] | undefined }) {
  if (!wifi) return null;
  const signalColor = (dbm: number) => dbm > -50 ? GREEN : dbm > -70 ? YELLOW : RED;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 4 }}>
        WIFI
      </Text>
      <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontFamily: "monospace", fontSize: 10, color: colors.text.primary }}>{wifi.ssid}</Text>
          {wifi.freq_mhz && (
            <View style={{ backgroundColor: `${ACCENT}20`, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
              <Text style={{ fontFamily: "monospace", fontSize: 7, fontWeight: "700", color: ACCENT }}>
                {wifi.freq_mhz > 5000 ? "5 GHz" : "2.4 GHz"}
              </Text>
            </View>
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {wifi.signal_dbm != null && (
            <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: signalColor(wifi.signal_dbm) }}>
              {wifi.signal_dbm} dBm
            </Text>
          )}
          {wifi.tx_bitrate_mbps != null && (
            <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>{wifi.tx_bitrate_mbps} Mbps</Text>
          )}
        </View>
      </View>
      {wifi.bssid && (
        <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled, marginTop: 2 }}>
          BSSID {wifi.bssid}
        </Text>
      )}
      {scan && scan.length > 0 && (
        <View style={{ marginTop: 8 }}>
          <Text style={{ fontFamily: "monospace", fontSize: 8, color: DIM, letterSpacing: 1, marginBottom: 3 }}>
            NEARBY APs ({scan.length})
          </Text>
          {scan.slice(0, 8).map((ap: any, i: number) => (
            <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 }}>
              <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.secondary, flex: 1 }} numberOfLines={1}>
                {ap.ssid || "(hidden)"}
              </Text>
              <Text style={{ fontFamily: "monospace", fontSize: 8, color: signalColor(ap.signal_dbm) }}>
                {ap.signal_dbm} dBm
              </Text>
            </View>
          ))}
          {scan.length > 8 && (
            <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled, marginTop: 2 }}>
              +{scan.length - 8} more
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function BatteryIndicator({ battery }: { battery: any }) {
  if (!battery) return null;
  const pct = battery.pct ?? 0;
  const charging = battery.status === "Charging" || battery.status === "Full";
  const barColor = charging ? GREEN : pct < 15 ? RED : pct < 30 ? YELLOW : ACCENT;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 28, height: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", borderRadius: 3, overflow: "hidden", justifyContent: "center" }}>
        <View style={{ position: "absolute", right: -3, width: 3, height: 5, backgroundColor: "rgba(255,255,255,0.2)", borderTopRightRadius: 1, borderBottomRightRadius: 1 }} />
        <View style={{ height: "100%", width: `${pct}%`, backgroundColor: barColor, borderRadius: 2 }} />
      </View>
      <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 10, color: barColor }}>
        {pct}%{charging ? " ⚡" : ""}
      </Text>
    </View>
  );
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function IdentitySection({ inv }: { inv: DeviceInventory }) {
  const hw = inv.hardware || {};
  const os = inv.os || {};
  const sec = inv.security || {};
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 6 }}>
        DEVICE IDENTITY
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        {hw.model && <Pill label="MODEL" value={hw.model} />}
        {hw.manufacturer && <Pill label="MFG" value={hw.manufacturer} />}
        {hw.serial && <Pill label="SERIAL" value={hw.serial} />}
        {hw.cpu_cores && <Pill label="CORES" value={`${hw.cpu_cores}`} />}
        {hw.cpu_abi && <Pill label="ABI" value={hw.cpu_abi} />}
        {os.version && <Pill label="OS" value={os.version} />}
        {os.sdk && <Pill label="SDK" value={`${os.sdk}`} />}
        {os.kernel && <Pill label="KERNEL" value={os.kernel.split("-")[0]} />}
        {os.security_patch && <Pill label="PATCH" value={os.security_patch} />}
      </View>
      {/* Security posture */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {sec.selinux && (
          <View style={{ backgroundColor: sec.selinux === "Enforcing" ? `${GREEN}15` : `${YELLOW}15`, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
            <Text style={{ fontFamily: "monospace", fontSize: 8, fontWeight: "700", color: sec.selinux === "Enforcing" ? GREEN : YELLOW }}>
              SE:{sec.selinux.toUpperCase()}
            </Text>
          </View>
        )}
        {sec.encryption && (
          <View style={{ backgroundColor: sec.encryption.includes("encrypted") ? `${GREEN}15` : `${RED}15`, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
            <Text style={{ fontFamily: "monospace", fontSize: 8, fontWeight: "700", color: sec.encryption.includes("encrypted") ? GREEN : RED }}>
              {sec.encryption.includes("encrypted") ? "ENCRYPTED" : "UNENCRYPTED"}
            </Text>
          </View>
        )}
        {sec.magisk_version && (
          <View style={{ backgroundColor: `${ACCENT}15`, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
            <Text style={{ fontFamily: "monospace", fontSize: 8, fontWeight: "700", color: ACCENT }}>
              MAGISK {sec.magisk_version}
            </Text>
          </View>
        )}
      </View>
      {/* Magisk modules */}
      {sec.magisk_modules && sec.magisk_modules.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled, letterSpacing: 1, marginBottom: 3 }}>
            MODULES ({sec.magisk_modules.length})
          </Text>
          {sec.magisk_modules.map((m: any, i: number) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 1 }}>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: m.disabled ? colors.text.disabled : GREEN }} />
              <Text style={{ fontFamily: "monospace", fontSize: 9, color: m.disabled ? colors.text.disabled : colors.text.secondary }}>
                {m.name || m.id}
              </Text>
            </View>
          ))}
        </View>
      )}
      {/* Screen + sensors */}
      {hw.screen && (
        <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled, marginTop: 4 }}>
          Screen: {hw.screen}
        </Text>
      )}
      {hw.sensors && hw.sensors.length > 0 && (
        <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled, marginTop: 2 }}>
          Sensors: {hw.sensors.join(", ")}
        </Text>
      )}
    </View>
  );
}

function ProcessesSection({ processes }: { processes: any }) {
  if (!processes) return null;
  const top = processes.top_cpu || [];
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 4 }}>
        PROCESSES ({processes.count ?? "?"})
      </Text>
      {top.length > 0 && top.map((p: any, i: number) => (
        <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 }}>
          <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.secondary, flex: 1 }} numberOfLines={1}>
            {p.name || p.cmd}
          </Text>
          <Text style={{ fontFamily: "monospace", fontSize: 8, fontWeight: "700", color: p.cpu_pct > 50 ? RED : p.cpu_pct > 20 ? YELLOW : colors.text.disabled }}>
            {p.cpu_pct != null ? `${p.cpu_pct}%` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ConnectionsSection({ connections }: { connections: any }) {
  if (!connections) return null;
  const listening = connections.listening || [];
  return (
    <View style={{ marginTop: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
        <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1 }}>
          CONNECTIONS
        </Text>
        {connections.established_count != null && (
          <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled }}>
            {connections.established_count} established
          </Text>
        )}
      </View>
      {listening.length > 0 && (
        <>
          <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled, marginBottom: 2 }}>
            LISTENING PORTS
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {listening.map((l: any, i: number) => (
              <View key={i} style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 8, color: ACCENT }}>
                  :{l.port}{l.proto ? `/${l.proto}` : ""}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function UsbSection({ usb }: { usb: any[] }) {
  if (!usb || usb.length === 0) return null;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 4 }}>
        USB DEVICES ({usb.length})
      </Text>
      {usb.map((d: any, i: number) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}>
          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: GREEN }} />
          <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.secondary }} numberOfLines={1}>
            {d.product || d.name || `${d.vendor_id}:${d.product_id}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

function PackagesSection({ packages }: { packages: any }) {
  if (!packages) return null;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 2 }}>
        PACKAGES
      </Text>
      <Text style={{ fontFamily: "monospace", fontSize: 10, color: colors.text.secondary }}>
        {packages.count ?? packages.total ?? "?"} installed
      </Text>
    </View>
  );
}

export default function FleetDeviceCard({ device, inventory }: { device: FleetDevice; inventory?: DeviceInventory | null }) {
  const [expanded, setExpanded] = useState(false);
  const t = device.telemetry || {};
  const meta = DEVICE_META[device.device_id] || { emoji: "📦", label: device.device_id.toUpperCase(), color: colors.text.tertiary };
  const online = device.effective_status === "online";
  const borderColor = online ? "rgba(255,255,255,0.08)" : "rgba(239,68,68,0.3)";
  const hasTelemetry = device.source === "telemetry-v2";

  const cpu = t.cpu;
  const mem = t.memory;
  const bat = t.battery;
  const net = t.network;
  const thermal = t.thermal;
  const wifi = net?.wifi;
  const wifiScan = t.wifi_scan;
  const disk = t.disk;
  const processes = t.processes;
  const connections = t.connections;
  const usb = t.usb;
  const packages = t.packages;

  return (
    <Pressable
      onPress={() => setExpanded(!expanded)}
      style={({ pressed }) => ({
        marginBottom: 10,
        transform: [{ scale: pressed ? 0.98 : 1 }],
        opacity: pressed ? 0.92 : 1,
      })}
    >
      <View style={{
        backgroundColor: colors.bg.elevated,
        borderWidth: 1,
        borderColor,
        borderLeftWidth: 3,
        borderLeftColor: online ? meta.color : RED,
        borderRadius: 10,
        padding: 14,
      }}>
        {/* ── Header ── */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ fontSize: 20 }}>{meta.emoji}</Text>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 13, color: colors.text.primary, letterSpacing: 0.5 }}>
                {device.device_id}
              </Text>
              <View style={{ backgroundColor: `${meta.color}20`, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 7, fontWeight: "700", color: meta.color, letterSpacing: 0.5 }}>
                  {meta.label}
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 }}>
              {device.wg_ip && (
                <Text style={{ fontFamily: "monospace", fontSize: 9, color: DIM }}>{device.wg_ip}</Text>
              )}
              {device.lan_ip && device.lan_ip !== device.wg_ip && (
                <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.disabled }}>{device.lan_ip}</Text>
              )}
              {wifi?.ssid && (
                <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.disabled }}>📶 {wifi.ssid}</Text>
              )}
            </View>
          </View>
          <View style={{ alignItems: "flex-end", gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? GREEN : RED }} />
              <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: online ? GREEN : RED }}>
                {online ? "UP" : "DOWN"}
              </Text>
            </View>
            {bat && <BatteryIndicator battery={bat} />}
          </View>
        </View>

        {/* ── Quick stats row ── */}
        {hasTelemetry && (
          <View style={{ flexDirection: "row", marginTop: 10, flexWrap: "wrap" }}>
            {cpu && <Pill label="LOAD" value={`${cpu.load_1m?.toFixed(1) ?? "—"}`} />}
            {mem && <Pill label="RAM" value={`${mem.used_pct?.toFixed(0) ?? "—"}%`} color={mem.used_pct > 85 ? RED : mem.used_pct > 70 ? YELLOW : undefined} />}
            {t.uptime_s != null && <Pill label="UPTIME" value={formatUptime(t.uptime_s)} />}
            {thermal?.[0] && <Pill label="TEMP" value={`${thermal[0].temp_c}°C`} color={thermal[0].temp_c > 70 ? RED : thermal[0].temp_c > 55 ? YELLOW : undefined} />}
            {bat?.temp_c != null && <Pill label="BAT TEMP" value={`${bat.temp_c}°C`} color={bat.temp_c > 40 ? RED : bat.temp_c > 35 ? YELLOW : undefined} />}
            {wifi?.signal_dbm != null && <Pill label="SIGNAL" value={`${wifi.signal_dbm} dBm`} color={wifi.signal_dbm > -50 ? GREEN : wifi.signal_dbm > -70 ? YELLOW : RED} />}
          </View>
        )}

        {!hasTelemetry && (
          <View style={{ marginTop: 8, backgroundColor: "rgba(255,255,255,0.03)", borderRadius: 6, padding: 8 }}>
            <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.disabled }}>
              Legacy heartbeat — telemetry v2 agent not installed
            </Text>
          </View>
        )}

        {/* ── Expanded detail ── */}
        {expanded && hasTelemetry && (
          <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 12 }}>
            {/* Memory bar */}
            {mem && (
              <Bar label="MEMORY" value={mem.total_mb - mem.available_mb} max={mem.total_mb} unit=" MB" />
            )}
            {mem?.swap_total_mb > 0 && (
              <Bar label="SWAP" value={mem.swap_total_mb - mem.swap_free_mb} max={mem.swap_total_mb} unit=" MB" warnPct={50} />
            )}

            {/* Disk */}
            {disk && disk.length > 0 && disk.map((d: any, i: number) => (
              <Bar key={i} label={`DISK ${d.mount || d.filesystem || ""}`} value={d.used_mb || 0} max={d.total_mb || 0} unit=" MB" />
            ))}

            {/* CPU detail */}
            {cpu && (
              <View style={{ marginBottom: 10 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 6 }}>
                  CPU
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
                  <Pill label="1m" value={cpu.load_1m?.toFixed(2) ?? "—"} />
                  <Pill label="5m" value={cpu.load_5m?.toFixed(2) ?? "—"} />
                  <Pill label="15m" value={cpu.load_15m?.toFixed(2) ?? "—"} />
                  {cpu.governor && <Pill label="GOV" value={cpu.governor} />}
                  {cpu.procs_total != null && <Pill label="PROCS" value={`${cpu.procs_total}`} />}
                </View>
                {cpu.freq_mhz && cpu.freq_mhz.length > 0 && (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {cpu.freq_mhz.map((f: number, i: number) => (
                      <View key={i} style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                        <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.secondary }}>
                          C{i}: {f} MHz
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* Battery detail */}
            {bat && (
              <View style={{ marginBottom: 10 }}>
                <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 6 }}>
                  BATTERY
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
                  <Pill label="STATUS" value={bat.status || "—"} color={bat.status === "Charging" ? GREEN : undefined} />
                  <Pill label="HEALTH" value={bat.health || "—"} color={bat.health === "Good" ? GREEN : YELLOW} />
                  <Pill label="TEMP" value={`${bat.temp_c ?? "—"}°C`} />
                  <Pill label="VOLTAGE" value={`${bat.voltage_mv ?? "—"} mV`} />
                  {bat.technology && <Pill label="TYPE" value={bat.technology} />}
                  {bat.charge_full_uah != null && (
                    <Pill label="CAPACITY" value={`${(bat.charge_full_uah / 1000).toFixed(0)} mAh`} />
                  )}
                </View>
              </View>
            )}

            {/* Device identity */}
            {inventory && <IdentitySection inv={inventory} />}

            <ThermalRow zones={thermal} />
            <WifiSection wifi={wifi} scan={wifiScan} />
            <TrafficRow traffic={net?.traffic} />
            <ProcessesSection processes={processes} />
            <ConnectionsSection connections={connections} />
            <UsbSection usb={usb} />
            <PackagesSection packages={packages} />

            {/* IPs */}
            <View style={{ marginTop: 10 }}>
              <Text style={{ fontFamily: "monospace", fontSize: 9, fontWeight: "700", color: colors.text.tertiary, letterSpacing: 1, marginBottom: 4 }}>
                NETWORK
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
                {net?.lan_ip && <Pill label="LAN" value={net.lan_ip} />}
                {net?.wg_ip && <Pill label="WG" value={net.wg_ip} />}
                {net?.public_ip && <Pill label="PUBLIC" value={net.public_ip} />}
              </View>
            </View>

            {/* Last seen */}
            <Text style={{ fontFamily: "monospace", fontSize: 8, color: colors.text.disabled, marginTop: 10, textAlign: "right" }}>
              Last report {formatRelativeTime(device.last_seen)}
            </Text>
          </View>
        )}

        {/* Expand indicator */}
        {hasTelemetry && (
          <Text style={{ fontFamily: "monospace", fontSize: 9, color: colors.text.disabled, textAlign: "center", marginTop: 8 }}>
            {expanded ? "▲ COLLAPSE" : "▼ DETAILS"}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
