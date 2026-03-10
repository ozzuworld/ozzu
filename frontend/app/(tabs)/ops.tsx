import { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOpsStatus, useOpsIncidents } from "../../lib/ops-hooks";
import SystemBanner from "../../components/ops/SystemBanner";
import ServiceCard from "../../components/ops/ServiceCard";
import GpuCard from "../../components/ops/GpuCard";
import DeviceRow from "../../components/ops/DeviceRow";
import IncidentList from "../../components/ops/IncidentList";

const ACCENT = "#06B6D4";

export default function OpsScreen() {
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  const { services, loading, lastUpdate, forceCheck } = useOpsStatus();
  const { incidents, loading: incidentsLoading, refresh: refreshIncidents } = useOpsIncidents(20);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([forceCheck(), refreshIncidents()]);
    setRefreshing(false);
  }, [forceCheck, refreshIncidents]);

  // Service entries for grid (exclude vast-gpu, shown separately)
  const gridServices = Object.entries(services).filter(([name]) => name !== "vast-gpu");
  const gpuStatus = services["vast-gpu"];

  // Count down services for header badge
  const downCount = Object.values(services).filter((s) => s.status === "down").length;

  return (
    <View style={{ flex: 1, backgroundColor: "#111", paddingTop: insets.top }}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: "rgba(255,255,255,0.06)",
        }}
      >
        <Text style={{ fontSize: 16, marginRight: 8 }}>📡</Text>
        <Text
          style={{
            fontFamily: "monospace",
            fontWeight: "700",
            fontSize: 16,
            color: "#E2E8F0",
            letterSpacing: 2,
            flex: 1,
          }}
        >
          OPS
        </Text>
        {downCount > 0 && (
          <View
            style={{
              backgroundColor: "#EF4444",
              borderRadius: 10,
              paddingHorizontal: 8,
              paddingVertical: 2,
              marginRight: 8,
            }}
          >
            <Text style={{ fontFamily: "monospace", fontWeight: "700", fontSize: 10, color: "#FFF" }}>
              {downCount} DOWN
            </Text>
          </View>
        )}
        <Pressable onPress={onRefresh}>
          <Text style={{ fontFamily: "monospace", fontSize: 11, color: ACCENT, fontWeight: "700" }}>
            REFRESH
          </Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator color={ACCENT} size="large" />
          <Text style={{ fontFamily: "monospace", fontSize: 11, color: "#525252", marginTop: 12 }}>
            Checking services...
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />
          }
          showsVerticalScrollIndicator={false}
        >
          {/* System Banner */}
          <SystemBanner services={services} />

          {/* Service Grid */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {gridServices.map(([name, status]) => (
              <View key={name} style={{ width: "48%" }}>
                <ServiceCard name={name} status={status} />
              </View>
            ))}
          </View>

          {/* GPU Card */}
          <GpuCard gpu={gpuStatus} />

          {/* Device Row */}
          <DeviceRow openvpn={services.openvpn} />

          {/* Recent Incidents */}
          <IncidentList incidents={incidents} loading={incidentsLoading} />

          {/* Last update footer */}
          {lastUpdate && (
            <Text
              style={{
                fontFamily: "monospace",
                fontSize: 9,
                color: "#525252",
                textAlign: "center",
                marginTop: 12,
              }}
            >
              Last check: {new Date(lastUpdate).toLocaleTimeString()}
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}
