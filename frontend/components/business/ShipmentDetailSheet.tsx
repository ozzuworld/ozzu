import { useState, useEffect, useCallback } from "react";
import { View, Text, Modal, ScrollView, Pressable, TextInput } from "react-native";
import { fetchBusinessShipment, updateBusinessShipment, updateShipmentStatus, formatCurrency, type BusinessShipment } from "../../lib/bridge-api";

import { colors } from "../../lib/design-tokens";
const ACCENT = colors.accent;
const STAGES = ["preparing", "customs_clearance", "in_transit", "arrived", "delivered", "paid"] as const;
const STAGE_LABELS: Record<string, string> = {
  preparing: "Preparing", customs_clearance: "Customs", in_transit: "In Transit",
  arrived: "Arrived", delivered: "Delivered", paid: "Paid",
};
const STAGE_COLORS: Record<string, string> = {
  preparing: colors.gray[300], customs_clearance: colors.brand.amber, in_transit: colors.brand.blue,
  arrived: "#8B5CF6", delivered: colors.success, paid: colors.accent,
};

interface Props {
  shipmentId: number | null;
  visible: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

export function ShipmentDetailSheet({ shipmentId, visible, onClose, onRefresh }: Props) {
  const [shipment, setShipment] = useState<BusinessShipment | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!shipmentId) return;
    try {
      const s = await fetchBusinessShipment(shipmentId);
      setShipment(s);
      setNotes(s.notes || "");
    } catch {}
  }, [shipmentId]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  const advance = async (status: string) => {
    if (!shipmentId) return;
    setSaving(true);
    try {
      await updateShipmentStatus(shipmentId, status);
      await load();
      onRefresh();
    } catch {} finally { setSaving(false); }
  };

  const saveNotes = async () => {
    if (!shipmentId) return;
    setSaving(true);
    try {
      await updateBusinessShipment(shipmentId, { notes } as any);
      onRefresh();
    } catch {} finally { setSaving(false); }
  };

  if (!visible) return null;
  const s = shipment;
  const currentIdx = STAGES.indexOf(s?.status as any);
  const nextStatus = currentIdx >= 0 && currentIdx < STAGES.length - 1 ? STAGES[currentIdx + 1] : null;

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: colors.gray[850], borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "85%", minHeight: 300 }}>
          {/* Header */}
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" }}>
            <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 15, fontWeight: "bold" }}>
              {s?.reference || `Shipment #${shipmentId}`}
            </Text>
            <Pressable onPress={onClose}>
              <Text style={{ color: colors.gray[400], fontSize: 22 }}>×</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            {!s ? (
              <Text style={{ color: colors.gray[400], fontFamily: "monospace" }}>Loading...</Text>
            ) : (
              <>
                {/* Status pipeline */}
                <View style={{ flexDirection: "row", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
                  {STAGES.map((st, i) => {
                    const isActive = st === s.status;
                    const isPast = i < currentIdx;
                    const color = STAGE_COLORS[st];
                    return (
                      <View key={st} style={{
                        paddingHorizontal: 10, paddingVertical: 5, borderRadius: 4,
                        backgroundColor: isActive ? color + "33" : isPast ? color + "11" : colors.gray[800],
                        borderWidth: isActive ? 1 : 0, borderColor: color,
                      }}>
                        <Text style={{ color: isActive || isPast ? color : colors.gray[500], fontFamily: "monospace", fontSize: 8, fontWeight: "bold" }}>
                          {STAGE_LABELS[st]}
                        </Text>
                      </View>
                    );
                  })}
                </View>

                {/* Advance button */}
                {nextStatus && (
                  <Pressable
                    onPress={() => advance(nextStatus)}
                    disabled={saving}
                    style={{
                      backgroundColor: STAGE_COLORS[nextStatus] + "22",
                      borderRadius: 8, padding: 12, marginBottom: 16, alignItems: "center",
                      borderWidth: 1, borderColor: STAGE_COLORS[nextStatus] + "44",
                    }}
                  >
                    <Text style={{ color: STAGE_COLORS[nextStatus], fontFamily: "monospace", fontSize: 12, fontWeight: "bold" }}>
                      {saving ? "..." : `ADVANCE TO ${STAGE_LABELS[nextStatus].toUpperCase()}`}
                    </Text>
                  </Pressable>
                )}

                {/* Details grid */}
                <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 12 }}>
                  <DetailRow label="Coffee Type" value={s.coffee_type} />
                  <DetailRow label="Quantity" value={s.quantity_kg != null ? `${s.quantity_kg} kg (${s.bags_count || "?"} bags)` : null} />
                  <DetailRow label="Price/kg" value={s.price_per_kg != null ? formatCurrency(s.price_per_kg, s.currency) : null} />
                  <DetailRow label="Total Value" value={s.total_value != null ? formatCurrency(s.total_value, s.currency) : null} />
                  <DetailRow label="Buyer" value={s.buyer_name} />
                  <DetailRow label="Route" value={`${s.origin_port} → ${s.destination_port}`} />
                  <DetailRow label="Ship Date" value={s.ship_date} />
                  <DetailRow label="ETA" value={s.estimated_arrival} />
                  {s.actual_arrival && <DetailRow label="Arrived" value={s.actual_arrival} />}
                  {s.tracking_number && <DetailRow label="Tracking" value={s.tracking_number} />}
                  {s.vessel_name && <DetailRow label="Vessel" value={s.vessel_name} />}
                </View>

                {/* Cost breakdown */}
                {(s.shipping_cost > 0 || s.insurance_cost > 0 || s.customs_fees > 0) && (
                  <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 12 }}>
                    <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>COSTS</Text>
                    {s.shipping_cost > 0 && <DetailRow label="Shipping" value={formatCurrency(s.shipping_cost, s.currency)} />}
                    {s.insurance_cost > 0 && <DetailRow label="Insurance" value={formatCurrency(s.insurance_cost, s.currency)} />}
                    {s.customs_fees > 0 && <DetailRow label="Customs" value={formatCurrency(s.customs_fees, s.currency)} />}
                  </View>
                )}

                {/* Invoices */}
                {s.invoices && s.invoices.length > 0 && (
                  <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14, marginBottom: 12 }}>
                    <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>INVOICES</Text>
                    {s.invoices.map(inv => (
                      <View key={inv.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.04)" }}>
                        <Text style={{ color: colors.gray[200], fontFamily: "monospace", fontSize: 11 }}>{inv.invoice_number || `INV-${inv.id}`}</Text>
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          <Text style={{ color: inv.status === "paid" ? colors.success : colors.brand.amber, fontFamily: "monospace", fontSize: 9, textTransform: "uppercase" }}>{inv.status}</Text>
                          <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 11 }}>{formatCurrency(inv.amount, inv.currency)}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {/* Notes */}
                <View style={{ backgroundColor: colors.gray[800], borderRadius: 10, padding: 14 }}>
                  <Text style={{ color: colors.gray[400], fontFamily: "monospace", fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>NOTES</Text>
                  <TextInput
                    value={notes}
                    onChangeText={setNotes}
                    onBlur={saveNotes}
                    placeholder="Add notes..."
                    placeholderTextColor={colors.gray[500]}
                    multiline
                    style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 12, minHeight: 60 }}
                  />
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
      <Text style={{ color: colors.gray[300], fontFamily: "monospace", fontSize: 11 }}>{label}</Text>
      <Text style={{ color: colors.gray[50], fontFamily: "monospace", fontSize: 11, maxWidth: "60%", textAlign: "right" }}>{value}</Text>
    </View>
  );
}
