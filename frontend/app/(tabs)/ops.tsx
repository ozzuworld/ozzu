import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useOpsStatus, useOpsIncidents } from "../../lib/ops-hooks";
import { useInfraState } from "../../lib/infra-hooks";
import SystemBanner from "../../components/ops/SystemBanner";
import ServiceCard from "../../components/ops/ServiceCard";
import GpuCard from "../../components/ops/GpuCard";
import IncidentList from "../../components/ops/IncidentList";
import NetworkBanner from "../../components/ops/NetworkBanner";
import InfraDeviceCard from "../../components/ops/InfraDeviceCard";
import GcpCard from "../../components/ops/GcpCard";
import RouterCard from "../../components/ops/RouterCard";
import PositioningCard from "../../components/ops/PositioningCard";
import FleetDeviceCard from "../../components/ops/FleetDeviceCard";
import { GroupNav } from "../../components/GroupNav";
import { TopBar } from "../../components/TopBar";
import { useFleetDevices } from "../../lib/fleet-hooks";

import { colors } from "../../lib/design-tokens";
const ACCENT = colors.accent;

type Tab = "fleet" | "infra" | "services";

export default function OpsScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("fleet");

  const { services, loading: svcLoading, lastUpdate, forceCheck } = useOpsStatus();
  const { incidents, loading: incidentsLoading, refresh: refreshIncidents } = useOpsIncidents(20);
  const { state: infra, loading: infraLoading, refresh: refreshInfra } = useInfraState();
  const { devices: fleetDevices, loading: fleetLoading, refresh: refreshFleet } = useFleetDevices();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([forceCheck(), refreshIncidents(), refreshInfra(), refreshFleet()]);
    setRefreshing(false);
  }, [forceCheck, refreshIncidents, refreshInfra, refreshFleet]);

  const gridServices = Object.entries(services).filter(([name]) => name !== "vast-gpu");
  const gpuStatus = services["vast-gpu"];
  const downCount = Object.values(services).filter((s) => s.status === "down").length;

  const loading = activeTab === "fleet" ? fleetLoading : activeTab === "services" ? svcLoading : infraLoading;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      <TopBar
        borderBottom
        left={
          <>
            <Text style={{ fontSize: 16, marginRight: 8 }}>📡</Text>
            <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 16, color: colors.text.primary, letterSpacing: 2 }}>
              OPS
            </Text>
          </>
        }
        right={
          <>
            {downCount > 0 && (
              <View style={{ backgroundColor: colors.error, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
                <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 10, color: colors.text.primary }}>
                  {downCount} DOWN
                </Text>
              </View>
            )}
            <Pressable onPress={onRefresh}>
              <Text style={{ fontFamily: "monospace", fontSize: 11, color: ACCENT, fontWeight: "700" }}>
                REFRESH
              </Text>
            </Pressable>
          </>
        }
      />

      <GroupNav group="ops" />

      {/* Tab bar */}
      <View
        style={{
          flexDirection: "row",
          borderBottomWidth: 1,
          borderBottomColor: "rgba(255,255,255,0.06)",
        }}
      >
        {(["fleet", "infra", "services"] as Tab[]).map((tab) => (
          <Pressable
            key={tab}
            onPress={() => setActiveTab(tab)}
            style={{
              flex: 1,
              paddingVertical: 8,
              borderBottomWidth: 2,
              borderBottomColor: activeTab === tab ? ACCENT : "transparent",
              alignItems: "center",
            }}
          >
            <Text
              style={{
                fontFamily: "monospace",
                fontWeight: "700",
                fontSize: 11,
                letterSpacing: 1,
                color: activeTab === tab ? ACCENT : colors.gray[400],
              }}
            >
              {tab === "fleet" ? "FLEET" : tab === "infra" ? "INFRASTRUCTURE" : "SERVICES"}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator color={ACCENT} size="large" />
          <Text style={{ fontFamily: "monospace", fontSize: 11, color: colors.gray[400], marginTop: 12 }}>
            {activeTab === "fleet" ? "Loading fleet..." : activeTab === "infra" ? "Probing infrastructure..." : "Checking services..."}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 12, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />
          }
          showsVerticalScrollIndicator={false}
        >
          {activeTab === "fleet" ? (
            /* ── FLEET TAB ── */
            <>
              {fleetDevices.length === 0 ? (
                <View style={{ padding: 24, alignItems: "center" }}>
                  <Text style={{ fontFamily: "monospace", fontSize: 11, color: colors.gray[400] }}>
                    No devices reporting
                  </Text>
                </View>
              ) : (
                fleetDevices.map((dev) => (
                  <FleetDeviceCard key={dev.device_id} device={dev} />
                ))
              )}
            </>
          ) : activeTab === "infra" ? (
            /* ── INFRASTRUCTURE TAB ── */
            <>
              {/* Network banner */}
              {infra?.network && (
                <NetworkBanner network={infra.network} probeTimeMs={infra.probeTimeMs || 0} />
              )}

              {/* GCP VM */}
              {infra?.gcp && <GcpCard gcp={infra.gcp} />}

              {/* Physical devices */}
              {infra?.devices && Object.entries(infra.devices).map(([id, dev]) => (
                <InfraDeviceCard key={id} id={id} device={dev} />
              ))}

              {/* Router */}
              {infra?.router && <RouterCard router={infra.router} />}

              {/* Positioning */}
              {(infra?.esp32Nodes || infra?.positioningHub) && (
                <PositioningCard
                  nodes={infra.esp32Nodes || []}
                  hub={infra.positioningHub || { service: "unknown" }}
                />
              )}

              {/* GPU */}
              <GpuCard gpu={gpuStatus} />

              {/* Timestamp */}
              {infra?.timestamp && (
                <Text
                  style={{
                    fontFamily: "monospace",
                    fontSize: 9,
                    color: colors.gray[400],
                    textAlign: "center",
                    marginTop: 8,
                  }}
                >
                  Last probe: {new Date(infra.timestamp).toLocaleTimeString()}
                </Text>
              )}
            </>
          ) : (
            /* ── SERVICES TAB ── */
            <>
              <SystemBanner services={services} />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                {gridServices.map(([name, status]) => (
                  <View key={name} style={{ width: "48%" }}>
                    <ServiceCard name={name} status={status} />
                  </View>
                ))}
              </View>
              <GpuCard gpu={gpuStatus} />
              <IncidentList incidents={incidents} loading={incidentsLoading} />
              {lastUpdate && (
                <Text
                  style={{
                    fontFamily: "monospace",
                    fontSize: 9,
                    color: colors.gray[400],
                    textAlign: "center",
                    marginTop: 12,
                  }}
                >
                  Last check: {new Date(lastUpdate).toLocaleTimeString()}
                </Text>
              )}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}
