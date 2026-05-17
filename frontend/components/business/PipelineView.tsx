import { useState, useCallback } from "react";
import { View, Text, ScrollView, Pressable, RefreshControl } from "react-native";
import { useShipments } from "../../lib/business-hooks";
import { formatCurrency, type BusinessShipment } from "../../lib/bridge-api";
import { ShipmentDetailSheet } from "./ShipmentDetailSheet";
import { AddShipmentModal } from "./AddShipmentModal";

import { colors } from "../../lib/design-tokens";
const ACCENT = colors.accent;

const STAGES = [
  { key: "preparing", label: "PREPARING", color: colors.gray[300] },
  { key: "customs_clearance", label: "CUSTOMS", color: colors.brand.amber },
  { key: "in_transit", label: "IN TRANSIT", color: colors.brand.blue },
  { key: "arrived", label: "ARRIVED", color: "#8B5CF6" },
  { key: "delivered", label: "DELIVERED", color: colors.success },
  { key: "paid", label: "PAID", color: colors.accent },
] as const;

export function PipelineView() {
  const { shipments, loading, reload } = useShipments();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const openShipment = (id: number) => { setSelectedId(id); setDetailVisible(true); };

  const grouped = STAGES.map(s => ({
    ...s,
    items: shipments.filter(sh => sh.status === s.key),
  }));

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor=colors.gray[400] />}
      >
        {/* Add button */}
        <Pressable
          onPress={() => setAddVisible(true)}
          style={{
            backgroundColor: ACCENT + "15",
            borderRadius: 10,
            padding: 12,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: ACCENT + "33",
            alignItems: "center",
          }}
        >
          <Text style={{ color: ACCENT, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>+ NEW SHIPMENT</Text>
        </Pressable>

        {/* Pipeline stages */}
        {grouped.map((stage) => (
          <View key={stage.key} style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: stage.color }} />
              <Text style={{ color: stage.color, fontFamily: "monospace", fontSize: 10, fontWeight: "bold", letterSpacing: 2 }}>
                {stage.label}
              </Text>
              <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10 }}>({stage.items.length})</Text>
            </View>
            {stage.items.length === 0 ? (
              <View style={{ backgroundColor: colors.gray[800], borderRadius: 8, padding: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
                <Text style={{ color: colors.gray[500], fontFamily: "monospace", fontSize: 11, textAlign: "center" }}>No shipments</Text>
              </View>
            ) : (
              stage.items.map((sh) => (
                <ShipmentCard key={sh.id} shipment={sh} onPress={() => openShipment(sh.id)} />
              ))
            )}
          </View>
        ))}

        {shipments.length === 0 && !loading && (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>🚢</Text>
            <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 13 }}>No shipments yet</Text>
            <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 11, marginTop: 4 }}>Add your first coffee shipment</Text>
          </View>
        )}
      </ScrollView>

      <ShipmentDetailSheet
        shipmentId={selectedId}
        visible={detailVisible}
        onClose={() => setDetailVisible(false)}
        onRefresh={reload}
      />
      <AddShipmentModal visible={addVisible} onClose={() => setAddVisible(false)} onCreated={reload} />
    </View>
  );
}

function ShipmentCard({ shipment, onPress }: { shipment: BusinessShipment; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? "#222" : colors.gray[800],
        borderRadius: 10,
        padding: 14,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: "rgba(255,255,255,0.06)",
      })}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 13, fontWeight: "bold" }}>
          {shipment.reference || `SH-${shipment.id}`}
        </Text>
        {shipment.total_value != null && (
          <Text style={{ color: colors.success, fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
            {formatCurrency(shipment.total_value, shipment.currency)}
          </Text>
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 12 }}>
        {shipment.coffee_type && (
          <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 10 }}>{shipment.coffee_type}</Text>
        )}
        {shipment.quantity_kg != null && (
          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10 }}>{shipment.quantity_kg}kg</Text>
        )}
        {shipment.bags_count != null && (
          <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 10 }}>{shipment.bags_count} bags</Text>
        )}
      </View>
      {shipment.buyer_name && (
        <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 10, marginTop: 4 }}>Buyer: {shipment.buyer_name}</Text>
      )}
      {(shipment.ship_date || shipment.estimated_arrival) && (
        <Text style={{ color: colors.gray[500], fontFamily: "monospace", fontSize: 9, marginTop: 4 }}>
          {shipment.ship_date ? `Ship: ${shipment.ship_date}` : ""}{shipment.ship_date && shipment.estimated_arrival ? " → " : ""}{shipment.estimated_arrival ? `ETA: ${shipment.estimated_arrival}` : ""}
        </Text>
      )}
    </Pressable>
  );
}
